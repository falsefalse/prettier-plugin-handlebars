import type { AstPath, Doc, ParserOptions, Printer } from 'prettier';
import { builders } from 'prettier/doc';
import { stripCommonIndent, voidElements } from 'template-format-core';
import { handlebarsDialect as templateDialect } from './dialects/handlebars/tokens';
import type {
  AttributeValue,
  BlockStatement,
  Call,
  CommentStatement,
  DecoratorStatement,
  ElementAttribute,
  ElementNode,
  Expression,
  MustacheStatement,
  Node,
  PartialStatement,
  TextNode,
  UnmatchedNode,
} from './types';

const { dedent, fill, group, hardline, ifBreak, indent, join, line, literalline, softline } = builders;

/* A run of blank lines collapses to one: two hardlines, never more. */
const MAX_CONSECUTIVE_NEWLINES = 2;

/** Only prettier's core options reach the printer; this formatter is opinionated. */
export type PrintOptions = Pick<ParserOptions<Node>, 'printWidth' | 'tabWidth' | 'useTabs' | 'singleQuote'>;

/** The `~` of `{{~foo~}}`, which strips the whitespace next to the delimiter it sits on. */
const trim = (marker: boolean | undefined): string => (marker ? '~' : '');

const hardlines = (count: number): Doc[] => Array.from({ length: count }, () => hardline);

/* Sibling whitespace is laid out as pieces so a hard break can end the run it sits in, rather
 * than forcing every other gap in the same program to break with it. */
type Piece = { kind: 'break'; count: number } | { kind: 'space' } | { kind: 'doc'; doc: Doc };

const isGap = (piece: Piece): boolean => piece.kind !== 'doc';

/**
 * The governing rule: whitespace between siblings renders, so it is reproduced, never invented.
 * A run holding a newline stays a newline, which keeps apart what the author put on separate
 * lines. A run of plain spaces becomes a `line`, free to collapse or wrap by width.
 */
function whitespacePiece(text: string): Piece {
  const newlines = text.split('\n').length - 1;
  return newlines === 0 ? { kind: 'space' } : { kind: 'break', count: Math.min(newlines, MAX_CONSECUTIVE_NEWLINES) };
}

/**
 * A text run decomposes into the same pieces as a sibling list: words, and the gaps between
 * them. Treating a run's interior differently from the gaps between nodes would make layout
 * depend on where the parser happened to put a node boundary - which is how a newline the
 * author wrote inside a text run used to come back as a space.
 */
function textPieces(node: TextNode): Piece[] {
  /* Raw text and ignored regions are copied through; literalline keeps them off the indent. */
  if (node.verbatim || node.preserveWhitespace) {
    return [{ kind: 'doc', doc: join(literalline, node.chars.split('\n')) }];
  }

  return node.chars
    .split(/(\s+)/u)
    .filter(Boolean)
    .map((part) => (/^\s+$/u.test(part) ? whitespacePiece(part) : { kind: 'doc' as const, doc: part }));
}

/* Recovered text is copied through, but its trailing whitespace belongs to the surrounding
 * program: left inside the raw it would be reprinted *and* re-added as a line ending, growing
 * the file by a newline on every pass. */
function unmatchedPieces(node: UnmatchedNode): Piece[] {
  const trailing = /\s+$/u.exec(node.raw)?.[0] ?? '';
  const body = trailing ? node.raw.slice(0, -trailing.length) : node.raw;

  return [
    ...(body ? [{ kind: 'doc' as const, doc: join(literalline, body.split('\n')) }] : []),
    ...(trailing ? [whitespacePiece(trailing)] : []),
  ];
}

/**
 * Each run between hard breaks wraps on its own. `fill` rather than `group`, so a run that does
 * not fit breaks only where it must - all-or-nothing is for attributes and call params, where
 * the whitespace is the formatter's; content wraps like prose.
 *
 * Adjacent pieces with no gap between them are glued in the source, so they merge into one fill
 * item: nothing may come between them.
 */
function assemble(pieces: Piece[]): Doc[] {
  const docs: Doc[] = [];
  const run: Doc[] = [];
  let glued: Doc[] = [];

  const flushGlued = () => {
    if (glued.length > 0) {
      run.push(glued.length === 1 ? glued[0] : glued);
      glued = [];
    }
  };

  const flushRun = () => {
    flushGlued();
    if (run.length === 0) {
      return;
    }

    /* `fill` only means anything with separators to wrap at. Wrapping a lone item in one hides
     * its own groups from the width check, so a call that should break stays long. */
    docs.push(run.length === 1 ? run[0] : fill([...run]));
    run.length = 0;
  };

  for (const piece of pieces) {
    if (piece.kind === 'break') {
      flushRun();
      docs.push(...hardlines(piece.count));
      continue;
    }

    if (piece.kind === 'space') {
      flushGlued();
      /* fill reads even positions as content; keep separators on the odd ones. */
      if (run.length % 2 === 0) run.push('');
      run.push(line);
      continue;
    }

    glued.push(piece.doc);
  }

  flushRun();
  return docs;
}

/** Gaps outside a content run have nothing to wrap, so they print as themselves. */
function gapDocs(gaps: Piece[]): Doc[] {
  return gaps.flatMap((gap) => (gap.kind === 'break' ? hardlines(gap.count) : gap.kind === 'space' ? [line] : []));
}

/** The half-open span of `pieces` with the whitespace at either end excluded. */
function contentSpan(pieces: Piece[]): [number, number] {
  let start = 0;
  let end = pieces.length;

  while (start < end && isGap(pieces[start])) start += 1;
  while (end > start && isGap(pieces[end - 1])) end -= 1;

  return [start, end];
}

function printExpression(expression: Expression, breakable: boolean): Doc {
  return expression.type === 'SubExpression' ? printCall(expression, '(', ')', breakable) : expression.source;
}

function printCallParts(call: Call, breakable: boolean): Doc[] {
  const parts: Doc[] = call.params.map((param) => printExpression(param, breakable));

  for (const pair of call.hash) {
    parts.push([pair.key, '=', printExpression(pair.value, breakable)]);
  }

  if (call.blockParams && call.blockParams.length > 0) {
    parts.push(['as |', call.blockParams.join(' '), '|']);
  }

  return parts;
}

/** Whitespace inside a mustache does not render, so it is the formatter's: all-or-nothing. */
function printCall(call: Call, open: Doc, close: Doc, breakable = true): Doc {
  const parts = printCallParts(call, breakable);
  if (parts.length === 0) {
    return [open, printExpression(call.path, breakable), close];
  }

  if (!breakable) {
    return [open, printExpression(call.path, false), ' ', join(' ', parts), close];
  }

  /* One group, so a call that does not fit breaks every one of its parts. */
  return group([open, indent([printExpression(call.path, true), line, join(line, parts)]), softline, close]);
}

/* The three inline statements are one call in different delimiters: a mustache in `{{}}` (or
 * `{{{}}}` when unescaped), a partial in `{{> }}`, a decorator in `{{*}}`. */
function printStatement(node: MustacheStatement | PartialStatement | DecoratorStatement, prefix: string): Doc {
  const triple = node.type === 'MustacheStatement' && node.triple;

  return printCall(
    node,
    [triple ? '{{{' : '{{', trim(node.trimOpen), prefix],
    [trim(node.trimClose), triple ? '}}}' : '}}'],
  );
}

function printComment(node: CommentStatement): Doc {
  const [open, close] = node.block || node.multiline ? ['{{!--', '--}}'] : ['{{!', '}}'];
  const body = node.value;

  /* A body the author started on its own line is re-indented under the comment, so it follows
   * the surrounding structure instead of staying frozen at the column it was written at.
   * Common indentation is stripped and re-applied, which keeps the body's *relative* shape. */
  if (/^\n/u.test(body)) {
    const lines = stripCommonIndent(body.replace(/^\n/u, '').replace(/\s+$/u, '').split('\n'));

    return lines.every((line) => line === '')
      ? [open, hardline, close]
      : [open, indent([hardline, join(hardline, lines)]), hardline, close];
  }

  /* Otherwise pad only where the body is not already spaced away from the delimiter: padding
   * regardless puts trailing whitespace on the opening line, which re-parses differently on the
   * next pass. Continuation lines keep their own indentation, having nothing to hang from. */
  const lead = body === '' || /^\s/u.test(body) ? '' : ' ';
  const tail = body === '' || /\s$/u.test(body) ? '' : ' ';

  return [open, lead, join(literalline, body.split('\n')), tail, close];
}

/** The quote that needs no escaping; `singleQuote` decides only when either would do. */
function chooseQuote(parts: AttributeValue['parts'], preferSingle: boolean): '"' | "'" {
  const text = parts.map((part) => (part.type === 'TextNode' ? part.chars : '')).join('');
  const preferred = preferSingle ? "'" : '"';

  return text.includes(preferred) ? (preferSingle ? '"' : "'") : preferred;
}

function printAttribute(attribute: ElementAttribute, options: PrintOptions): Doc {
  if (attribute.type === 'RawAttribute') {
    return attribute.raw;
  }

  if (attribute.type === 'AttributeBlock') {
    return printAny(attribute.block, options);
  }

  if (!attribute.value) {
    return attribute.name;
  }

  /* An attribute value is content: every space in it renders, so it is reproduced exactly. Only
   * the calls inside it may be reflowed, since whitespace within a mustache never reaches the
   * rendered value. The parser marks the value's text as whitespace-significant, which is what
   * keeps a block's body from being laid out at the printer's indent level instead of the
   * author's - and what lets prettier see where the value's own lines end. */
  const { parts } = attribute.value;
  const quote = chooseQuote(parts, options.singleQuote === true);

  return [attribute.name, '=', quote, ...parts.map((part) => printAny(part, options)), quote];
}

/**
 * One group for the whole tag, with no inner group around the attributes. Grouping them
 * separately lets the attributes fit while the `>` alone drops to the next line, which reads as
 * a stray bracket rather than a break.
 */
function printOpenTag(node: ElementNode, options: PrintOptions): Doc {
  const marker = node.selfClosing && !voidElements.has(node.tag.toLowerCase()) ? ' />' : '>';

  if (node.attributes.length === 0) {
    return ['<', node.tag, marker];
  }

  const attributes = node.attributes.map((attribute) => printAttribute(attribute, options));

  return group([
    '<',
    node.tag,
    indent([line, join(line, attributes)]),
    ifBreak([softline, marker.trimStart()], marker),
  ]);
}

/**
 * The content between two markers - a tag's brackets, or a block's open and close. The trailing
 * gap sits inside the indent and is dedented from there, which lands the following marker back
 * at the container's own level; dedenting outside the indent overshoots, and the overshoot
 * compounds with nesting depth.
 */
function printBody(pieces: Piece[]): Doc[] {
  if (pieces.length === 0) {
    return [];
  }

  const [start, end] = contentSpan(pieces);

  /* Nothing but whitespace inside: emit it once rather than as both edges. */
  if (start >= end) {
    return gapDocs(pieces.slice(0, 1));
  }

  return [
    indent([
      ...gapDocs(pieces.slice(0, start)),
      ...assemble(pieces.slice(start, end)),
      ...gapDocs(pieces.slice(end)).map((doc) => dedent(doc)),
    ]),
  ];
}

function printElement(node: ElementNode, options: PrintOptions): Doc {
  const openTag = printOpenTag(node, options);

  if (node.selfClosing) {
    return openTag;
  }

  return group([openTag, ...printBody(childPieces(node.children, options)), '</', node.tag, '>']);
}

function printBlock(node: BlockStatement, options: PrintOptions): Doc {
  const branches = node.inverseChain ?? [];
  const sections = [node.program, ...branches.map((branch) => branch.program), node.inverse].map((program) =>
    childPieces(program.body, options),
  );

  /* A block the author kept on one line is an atom: splitting `{{else if` from its condition to
   * save a few columns is never an improvement. Once the body breaks, the markers already sit on
   * their own lines and are free to wrap. */
  const breakable = sections.some((pieces) => pieces.some((piece) => piece.kind === 'break'));

  const prefix = templateDialect.getPrintedBlockPrefix(node.blockPrefix ?? '#');
  const parts: Doc[] = [
    printCall(node, ['{{', trim(node.trimOpen), prefix], [trim(node.trimClose), '}}'], breakable),
    ...printBody(sections[0]),
  ];

  branches.forEach((branch, index) => {
    const open = ['{{', trim(branch.trimOpen), `${templateDialect.getElseKeyword()} `];
    parts.push(printCall(branch, open, [trim(branch.trimClose), '}}'], breakable), ...printBody(sections[index + 1]));
  });

  if (node.inverse.body.length > 0) {
    const open = ['{{', trim(node.inverseTrimOpen), templateDialect.getElseKeyword(), trim(node.inverseTrimClose), '}}'];
    parts.push(open, ...printBody(sections[sections.length - 1]));
  }

  parts.push([
    '{{',
    trim(node.closeTrimOpen),
    templateDialect.getBlockClosePrefix(node.path.source),
    trim(node.closeTrimClose),
    '}}',
  ]);

  return group(parts);
}

/**
 * Children need no separators: the whitespace between them is already in the tree, so the
 * printer cannot add a gap the author did not write, nor drop one they did.
 */
function childPieces(nodes: Node[], options: PrintOptions): Piece[] {
  const pieces: Piece[] = [];

  for (const child of nodes) {
    if (child.type === 'TextNode') {
      pieces.push(...textPieces(child));
    } else if (child.type === 'UnmatchedNode') {
      pieces.push(...unmatchedPieces(child));
    } else {
      pieces.push({ kind: 'doc', doc: printAny(child, options) });
    }
  }

  return pieces;
}

/**
 * A template's own leading and trailing whitespace is not content: the file ends in exactly one
 * newline whatever the author left behind.
 */
function printRoot(nodes: Node[], options: PrintOptions): Doc {
  const pieces = childPieces(nodes, options);
  const [start, end] = contentSpan(pieces);

  return start >= end ? '' : [...assemble(pieces.slice(start, end)), hardline];
}

/**
 * The printer recurses over nodes directly rather than through prettier's AstPath. It makes no
 * parent-dependent decisions - a node's shape is a function of the node alone - so the path
 * buys nothing, and dropping it keeps every signature free of casts.
 */
function printAny(node: Node, options: PrintOptions): Doc {
  switch (node.type) {
    case 'Program':
      return assemble(childPieces(node.body, options));

    case 'TextNode':
      return assemble(textPieces(node));

    case 'MustacheStatement':
      return printStatement(node, '');

    case 'PartialStatement':
      return printStatement(node, '> ');

    case 'DecoratorStatement':
      return printStatement(node, '*');

    case 'CommentStatement':
      return printComment(node);

    case 'UnmatchedNode':
      return join(literalline, node.raw.split('\n'));

    case 'ElementNode':
      return printElement(node, options);

    case 'BlockStatement':
      return printBlock(node, options);
  }
}

/* Prettier walks the tree itself to track a cursor offset; the printer's own recursion does not
 * use these. */
const visitorKeys: Record<string, string[]> = {
  Program: ['body'],
  ElementNode: ['attributes', 'children'],
  Attribute: ['value'],
  AttributeValue: ['parts'],
  AttributeBlock: ['block'],
  BlockStatement: ['program', 'inverseChain', 'inverse'],
  ElseBranch: ['program'],
};

export const printer: Printer<Node> = {
  /* Only the root reaches this: everything below recurses through printAny. */
  print(path: AstPath<Node>, options: ParserOptions<Node>): Doc {
    const node = path.node;
    return node.type === 'Program' && path.parent === null ? printRoot(node.body, options) : printAny(node, options);
  },
  getVisitorKeys(node, nonTraversableKeys) {
    const type = typeof node === 'object' && node !== null && 'type' in node ? String(node.type) : '';
    return (visitorKeys[type] ?? []).filter((key) => !nonTraversableKeys.has(key));
  },
};
