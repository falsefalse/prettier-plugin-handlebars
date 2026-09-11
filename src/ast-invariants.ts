import type { Expression, Node, Program, SourceRange } from './types';

export interface TilingViolation {
  kind: 'gap' | 'overlap' | 'missing-range' | 'uncovered-head' | 'uncovered-tail' | 'escapes-call' | 'out-of-order';
  /** What kind of container has the broken child list. */
  container: string;
  /** Source span the violation covers, and the text sitting in it. */
  start: number;
  end: number;
  text: string;
}

interface ChildList {
  container: string;
  nodes: Array<Node | SourceRange>;
  span: [number, number] | undefined;
}

function childListsOf(node: Node): ChildList[] {
  switch (node.type) {
    case 'Program':
      return [{ container: 'Program', nodes: node.body, span: node.range }];

    case 'ElementNode': {
      const lists: ChildList[] = [
        { container: 'ElementNode', nodes: node.children, span: node.contentRange },
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
      const lists: ChildList[] = [
        { container: 'BlockStatement', nodes: node.program.body, span: node.program.range },
      ];

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
  const children = childListsOf(node).flatMap((list) =>
    list.nodes.flatMap((child) => ('type' in child ? [child] : [])),
  );

  if (node.type === 'ElementNode') {
    const blocks = node.attributes.flatMap((attribute) =>
      attribute.type === 'AttributeBlock' ? [attribute.block] : [],
    );
    children.push(...blocks);
  }

  return children;
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);

  for (const child of childrenOf(node)) {
    walk(child, visit);
  }
}

/**
 * The parser must not drop source. Every child list has to tile its container's span with no
 * gaps and no overlaps, which is exactly what fails when whitespace-only runs are discarded.
 */
export function findTilingViolations(program: Program, source: string): TilingViolation[] {
  const violations: TilingViolation[] = [];

  const record = (kind: TilingViolation['kind'], container: string, start: number, end: number) => {
    violations.push({ kind, container, start, end, text: source.slice(start, end) });
  };

  walk(program, (node) => {
    for (const { container, nodes, span } of childListsOf(node)) {
      if (nodes.length === 0) {
        continue;
      }

      let previousEnd = span?.[0];

      for (const child of nodes) {
        const range = child.range;

        if (!range) {
          record('missing-range', container, span?.[0] ?? 0, span?.[1] ?? 0);
          previousEnd = undefined;
          continue;
        }

        if (previousEnd !== undefined && range[0] > previousEnd) {
          record(previousEnd === span?.[0] ? 'uncovered-head' : 'gap', container, previousEnd, range[0]);
        } else if (previousEnd !== undefined && range[0] < previousEnd) {
          record('overlap', container, range[0], previousEnd);
        }

        previousEnd = range[1];
      }

      const spanEnd = span?.[1];
      if (previousEnd !== undefined && spanEnd !== undefined && previousEnd < spanEnd) {
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

  const record = (kind: TilingViolation['kind'], container: string, start: number, end: number) => {
    violations.push({ kind, container, start, end, text: source.slice(start, end) });
  };

  const checkExpression = (expression: Expression, outer: [number, number] | undefined, container: string): void => {
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

  const checkParts = (call: CallLike, container: string): void => {
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
