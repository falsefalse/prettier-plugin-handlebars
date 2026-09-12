import type { Expression, Node, Program, SourceRange } from '../../src/types';

type ViolationKind =
  | 'gap'
  | 'overlap'
  | 'missing-range'
  | 'uncovered-head'
  | 'uncovered-tail'
  | 'escapes-call'
  | 'out-of-order'
  | 'lossy-close-tag';

export interface TilingViolation {
  kind: ViolationKind;
  container: string;
  start: number;
  end: number;
  text: string;
}

interface ChildList {
  container: string;
  nodes: Array<Node | SourceRange>;
  span: [number, number] | undefined;
  /** Whitespace between attributes is the formatter's, so only a gap holding more is a fault. */
  whitespaceGaps?: boolean;
  /** Attributes are not `Node`s; their contents reach `walk` through the lists below them. */
  descend?: boolean;
}

function childListsOf(node: Node): ChildList[] {
  switch (node.type) {
    case 'Program':
      return [{ container: 'Program', nodes: node.body, span: node.range }];

    case 'ElementNode': {
      const lists: ChildList[] = [
        { container: 'ElementNode', nodes: node.children, span: node.contentRange },
        /* The attribute list has to account for the whole tag head. Leaving it out lets
         * `parseTag` step over a character it cannot read - turning `@click` into `click` -
         * while this gate goes on reporting that every case tiles. */
        {
          container: `<${node.tag}> attributes`,
          nodes: node.attributes,
          span: node.attributesRange,
          whitespaceGaps: true,
          descend: false,
        },
      ];

      for (const attribute of node.attributes) {
        if (attribute.type === 'Attribute' && attribute.value) {
          lists.push({
            container: `Attribute(${attribute.name})`,
            nodes: attribute.value.parts,
            span: attribute.value.range,
          });
        }
      }

      return lists;
    }

    case 'BlockStatement': {
      const lists: ChildList[] = [{ container: 'BlockStatement', nodes: node.program.body, span: node.program.range }];

      for (const branch of node.inverseChain ?? []) {
        lists.push({ container: 'ElseBranch', nodes: branch.program.body, span: branch.program.range });
      }

      lists.push({ container: 'Inverse', nodes: node.inverse.body, span: node.inverse.range });

      return lists;
    }

    default:
      return [];
  }
}

/**
 * Everything `walk` has to descend into. Wider than `childListsOf`, which only names the lists
 * that must *tile*: an `{{#if}}` sitting in attribute position is not part of any tiled span -
 * whitespace between attributes is the formatter's - but its own body still is, and its params
 * still have to sit inside it.
 */
function childrenOf(node: Node): Node[] {
  const children = childListsOf(node)
    .filter((list) => list.descend !== false)
    .flatMap((list) => list.nodes.flatMap((child) => ('type' in child ? [child] : [])));

  if (node.type === 'ElementNode') {
    const blocks = node.attributes.flatMap((attribute) =>
      attribute.type === 'AttributeBlock' ? [attribute.block] : [],
    );
    children.push(...blocks);
  }

  return children;
}

/** Every node under this one, attribute values and blocks in attribute position included. */
export function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);

  for (const child of childrenOf(node)) {
    walk(child, visit);
  }
}

const withoutWhitespace = (text: string) => text.replace(/[\t\n\f\r ]/gu, '');

/**
 * The parser must not drop source. Every child list has to tile its container's span with no
 * gaps and no overlaps, which is exactly what fails when whitespace-only runs are discarded.
 */
export function findTilingViolations(program: Program, source: string): TilingViolation[] {
  const violations: TilingViolation[] = [];

  const record = (kind: ViolationKind, container: string, start: number, end: number) => {
    violations.push({ kind, container, start, end, text: source.slice(start, end) });
  };

  walk(program, (node) => {
    /* The close tag belongs to no child list, so nothing below covers it: `</h{{level}}>` can
     * come back as `</h>` with every span still tiling perfectly.
     *
     * Whitespace comes out of both sides rather than being normalised the way the parser
     * normalises it. Restating the parser's rule here would make the check agree with it by
     * construction, so the two would drift together; what this has to catch is a character
     * going missing, and only whitespace inside a close tag is the formatter's to move. */
    if (node.type === 'ElementNode' && !node.selfClosing && node.contentRange && node.range) {
      const [start, end] = [node.contentRange[1], node.range[1]];
      const written = source.slice(start + 2, end - 1);

      if (withoutWhitespace(written) !== withoutWhitespace(node.closeTag ?? node.tag)) {
        record('lossy-close-tag', `<${node.tag}>`, start, end);
      }
    }

    for (const { container, nodes, span, whitespaceGaps } of childListsOf(node)) {
      if (nodes.length === 0) {
        continue;
      }

      const uncovered = (start: number, end: number) => !whitespaceGaps || source.slice(start, end).trim() !== '';
      let previousEnd = span?.[0];

      for (const child of nodes) {
        const range = child.range;

        if (!range) {
          record('missing-range', container, span?.[0] ?? 0, span?.[1] ?? 0);
          previousEnd = undefined;
          continue;
        }

        if (previousEnd !== undefined && range[0] > previousEnd && uncovered(previousEnd, range[0])) {
          record(previousEnd === span?.[0] ? 'uncovered-head' : 'gap', container, previousEnd, range[0]);
        } else if (previousEnd !== undefined && range[0] < previousEnd) {
          record('overlap', container, range[0], previousEnd);
        }

        previousEnd = range[1];
      }

      const spanEnd = span?.[1];
      if (previousEnd !== undefined && spanEnd !== undefined && previousEnd < spanEnd && uncovered(previousEnd, spanEnd)) {
        record('uncovered-tail', container, previousEnd, spanEnd);
      }
    }
  });

  return violations;
}

interface CallLike {
  path: Expression;
  params: Expression[];
  hash: Array<{ value: Expression; range?: [number, number] }>;
  range?: [number, number];
}

function asCall(node: Node): CallLike | null {
  switch (node.type) {
    case 'MustacheStatement':
    case 'BlockStatement':
    case 'PartialStatement':
    case 'DecoratorStatement':
      return node;
    default:
      return null;
  }
}

function expressionsOf(call: CallLike): Expression[] {
  return [call.path, ...call.params, ...call.hash.map((pair) => pair.value)];
}

/**
 * Tiling stops at a call's edge: whitespace between params is the formatter's to set, so gaps
 * there are expected. What must still hold is that every part sits inside the call, in order,
 * without overlapping - enough to catch a dropped or misplaced param.
 */
export function findExpressionViolations(program: Program, source: string): TilingViolation[] {
  const violations: TilingViolation[] = [];

  const record = (kind: ViolationKind, container: string, start: number, end: number) => {
    violations.push({ kind, container, start, end, text: source.slice(start, end) });
  };

  const checkExpression = (
    expression: Expression,
    outer: [number, number] | undefined,
    container: string,
  ) => {
    const range = expression.range;

    if (!range) {
      record('missing-range', container, outer?.[0] ?? 0, outer?.[1] ?? 0);
      return;
    }

    if (outer && (range[0] < outer[0] || range[1] > outer[1])) {
      record('escapes-call', container, range[0], range[1]);
    }

    if (expression.type === 'SubExpression') {
      checkParts(expression, 'SubExpression');
    }
  };

  const checkParts = (call: CallLike, container: string) => {
    let previousEnd: number | undefined;

    for (const expression of expressionsOf(call)) {
      checkExpression(expression, call.range, container);

      const range = expression.range;
      if (range && previousEnd !== undefined && range[0] < previousEnd) {
        record('out-of-order', container, range[0], previousEnd);
      }

      previousEnd = range?.[1] ?? previousEnd;
    }
  };

  walk(program, (node) => {
    const call = asCall(node);
    if (call) {
      checkParts(call, node.type);
    }

    if (node.type === 'BlockStatement') {
      for (const branch of node.inverseChain ?? []) {
        checkParts(branch, 'ElseBranch');
      }
    }
  });

  return violations;
}
