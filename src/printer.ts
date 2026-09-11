import type { AstPath, Doc, ParserOptions, Printer } from 'prettier';
import { builders } from 'prettier/doc';
import { voidElements } from 'template-format-core';
import type {
  AttributeValue,
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

/**
 * Phase 4 of REWRITE-PLAN.md. Handles programs, text, mustaches and comments; anything else
 * throws by design, so the corpus gate can report honest coverage while the printer grows.
 */
export class UnsupportedNodeError extends Error {
  constructor(readonly nodeType: string) {
    super(`printer v2 does not handle ${nodeType} yet`);
    this.name = 'UnsupportedNodeError';
  }
}

function countNewlines(text: string): number {
  let count = 0;
  for (const char of text) {
    if (char === '\n') count += 1;
  }
  return count;
}

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
  const newlines = countNewlines(text);
  return newlines === 0 ? { kind: 'space' } : { kind: 'break', count: Math.min(newlines, MAX_CONSECUTIVE_NEWLINES) };
}

const leadingWhitespacePattern = /^\s+/u;
const trailingWhitespacePattern = /\s+$/u;

/** Words split apart so `fill` wraps prose at printWidth without changing whitespace count. */
function printWords(text: string): Doc {
  const parts: Doc[] = [];

  text
    .split(/\s+/u)
    .filter(Boolean)
    .forEach((word, index) => {
      if (index > 0) parts.push(line);
      parts.push(word);
    });

  return fill(parts);
}

function textPieces(node: TextNode): Piece[] {
  /* Raw text and ignored regions are copied through; literalline keeps them off the indent. */
  if (node.verbatim || node.preserveWhitespace) {
    return [{ kind: 'doc', doc: join(literalline, node.chars.split('\n')) }];
  }

  if (node.chars.trim() === '') {
    return [whitespacePiece(node.chars)];
  }

  const leading = leadingWhitespacePattern.exec(node.chars)?.[0] ?? '';
  const trailing = trailingWhitespacePattern.exec(node.chars)?.[0] ?? '';
  const body = node.chars.slice(leading.length, node.chars.length - trailing.length);

  return [
    ...(leading ? [whitespacePiece(leading)] : []),
    { kind: 'doc', doc: printWords(body) },
    ...(trailing ? [whitespacePiece(trailing)] : []),
  ];
}

/* Recovered text is copied through, but its trailing whitespace belongs to the surrounding
 * program: left inside the raw it would be reprinted *and* re-added as a line ending, growing
 * the file by a newline on every pass. */
function unmatchedPieces(node: UnmatchedNode): Piece[] {
  const trailing = trailingWhitespacePattern.exec(node.raw)?.[0] ?? '';
  const body = trailing ? node.raw.slice(0, -trailing.length) : node.raw;

  return [
    ...(body ? [{ kind: 'doc' as const, doc: join(literalline, body.split('\n')) }] : []),
    ...(trailing ? [whitespacePiece(trailing)] : []),
  ];
}

/** Each run between hard breaks is its own group, so width decisions stay local. */
function assemble(pieces: Piece[]): Doc[] {
  const docs: Doc[] = [];
  let run: Doc[] = [];

  const flush = () => {
    if (run.length > 0) {
      docs.push(group(run));
      run = [];
    }
  };

  for (const piece of pieces) {
    if (piece.kind === 'break') {
      flush();
      for (let index = 0; index < piece.count; index += 1) {
        docs.push(hardline);
      }
      continue;
    }

    run.push(piece.kind === 'space' ? line : piece.doc);
  }

  flush();
  return docs;
}

function printExpression(expression: Expression): Doc {
  if (expression.type !== 'SubExpression') {
    return expression.source;
  }

  const parts = printCallParts(expression);
  if (parts.length === 0) {
    return ['(', printExpression(expression.path), ')'];
  }

  /* One group, so a subexpression that does not fit breaks every one of its parts. */
  return group(['(', indent([printExpression(expression.path), line, join(line, parts)]), softline, ')']);
}

interface CallLike {
  path: Expression;
  params: Expression[];
  hash: Array<{ key: string; value: Expression }>;
  blockParams?: string[];
}

function printCallParts(call: CallLike): Doc[] {
  const parts: Doc[] = call.params.map(printExpression);

  for (const pair of call.hash) {
    parts.push([pair.key, '=', printExpression(pair.value)]);
  }

  if (call.blockParams && call.blockParams.length > 0) {
    parts.push(['as |', call.blockParams.join(' '), '|']);
  }

  return parts;
}

/** Whitespace inside a mustache does not render, so it is the formatter's: all-or-nothing. */
function printCall(call: CallLike, open: Doc, close: Doc): Doc {
  const parts = printCallParts(call);
  if (parts.length === 0) {
    return [open, printExpression(call.path), close];
  }

  return group([open, indent([printExpression(call.path), line, join(line, parts)]), softline, close]);
}

function printMustache(node: MustacheStatement): Doc {
  const [openDelimiter, closeDelimiter] = node.triple ? ['{{{', '}}}'] : ['{{', '}}'];

  return printCall(node, [openDelimiter, node.trimOpen ? '~' : ''], [node.trimClose ? '~' : '', closeDelimiter]);
}

function printPartial(node: PartialStatement): Doc {
  return printCall(node, ['{{', node.trimOpen ? '~' : '', '> '], [node.trimClose ? '~' : '', '}}']);
}

function printDecorator(node: DecoratorStatement): Doc {
  return printCall(node, ['{{', node.trimOpen ? '~' : '', '*'], [node.trimClose ? '~' : '', '}}']);
}

function printComment(node: CommentStatement): Doc {
  /* A multi-line body already carries its own layout; padding it would put trailing whitespace
   * on the opening line and re-parse differently next pass. */
  if (node.multiline) {
    return join(literalline, `{{!--${node.value}--}}`.split('\n'));
  }

  const padded = node.value === '' ? '' : ` ${node.value} `;
  return node.block ? `{{!--${padded}--}}` : `{{!${padded}}}`;
}

/** Nodes reachable outside the child traversal: attribute values and attribute blocks. */
function printStandalone(node: Node): Doc {
  switch (node.type) {
    case 'TextNode':
      return node.chars;
    case 'MustacheStatement':
      return printMustache(node);
    case 'PartialStatement':
      return printPartial(node);
    case 'DecoratorStatement':
      return printDecorator(node);
    case 'CommentStatement':
      return printComment(node);
    case 'UnmatchedNode':
      return join(literalline, node.raw.split('\n'));
    default:
      throw new UnsupportedNodeError(node.type);
  }
}

/* An attribute value is content: its text is reproduced exactly. Only the mustaches inside it
 * may be reflowed, since whitespace within a mustache never reaches the rendered value. */
function printAttributeValue(value: AttributeValue): Doc[] {
  return value.parts.map((part) => (part.type === 'TextNode' ? part.chars : printStandalone(part)));
}

function chooseQuote(value: AttributeValue, preferSingle: boolean): '"' | "'" {
  const text = value.parts.map((part) => (part.type === 'TextNode' ? part.chars : '')).join('');
  const preferred = preferSingle ? "'" : '"';
  const fallback = preferSingle ? '"' : "'";

  return text.includes(preferred) ? fallback : preferred;
}

function printAttribute(attribute: ElementAttribute, preferSingle: boolean): Doc {
  if (attribute.type === 'RawAttribute') {
    return attribute.raw;
  }

  if (attribute.type === 'AttributeBlock') {
    return printStandalone(attribute.block);
  }

  if (!attribute.value) {
    return attribute.name;
  }

  const quote = chooseQuote(attribute.value, preferSingle);
  return [attribute.name, '=', quote, ...printAttributeValue(attribute.value), quote];
}

/**
 * One group for the whole tag, with no inner group around the attributes. Grouping them
 * separately lets the attributes fit while the `>` alone drops to the next line, which reads as
 * a stray bracket rather than a break.
 */
function printOpenTag(node: ElementNode, preferSingle: boolean): Doc {
  const marker = node.selfClosing && !voidElements.has(node.tag.toLowerCase()) ? ' />' : '>';

  if (node.attributes.length === 0) {
    return ['<', node.tag, marker];
  }

  const attributes = node.attributes.map((attribute) => printAttribute(attribute, preferSingle));

  return group([
    '<',
    node.tag,
    indent([line, join(line, attributes)]),
    ifBreak([softline, marker.trimStart()], marker),
  ]);
}

function gapDocs(gaps: Piece[]): Doc[] {
  const docs: Doc[] = [];

  for (const gap of gaps) {
    if (gap.kind === 'break') {
      for (let index = 0; index < gap.count; index += 1) docs.push(hardline);
    } else if (gap.kind === 'space') {
      docs.push(line);
    }
  }

  return docs;
}

function printElement(path: AstPath<Node>, print: (path: AstPath<Node>) => Doc, node: ElementNode, preferSingle: boolean): Doc {
  const openTag = printOpenTag(node, preferSingle);

  if (node.selfClosing) {
    return openTag;
  }

  const closeTag = ['</', node.tag, '>'];
  const pieces = childPieces(path, print, node.children, 'children');

  if (pieces.length === 0) {
    return [openTag, closeTag];
  }

  let start = 0;
  let end = pieces.length;
  while (start < end && isGap(pieces[start])) start += 1;
  while (end > start && isGap(pieces[end - 1])) end -= 1;

  /* Nothing but whitespace inside: emit it once rather than as both edges. */
  if (start >= end) {
    return group([openTag, ...gapDocs(pieces.slice(0, 1)), closeTag]);
  }

  const leading = gapDocs(pieces.slice(0, start));
  const trailing = gapDocs(pieces.slice(end));

  /* The trailing gap sits inside the indent and is dedented from there, which lands the closing
   * tag back at the element's own level. Dedenting outside the indent would overshoot, and the
   * overshoot compounds with nesting depth. */
  return group([
    openTag,
    indent([...leading, ...assemble(pieces.slice(start, end)), ...trailing.map((doc) => dedent(doc))]),
    closeTag,
  ]);
}

/**
 * Children need no separators: the whitespace between them is already in the tree, so the
 * printer cannot add a gap the author did not write, nor drop one they did.
 */
function childPieces(
  path: AstPath<Node>,
  print: (path: AstPath<Node>) => Doc,
  nodes: Node[],
  key: 'body' | 'children',
): Piece[] {
  const pieces: Piece[] = [];

  path.each((childPath, index) => {
    const child = nodes[index];
    if (child.type === 'TextNode') {
      pieces.push(...textPieces(child));
      return;
    }

    if (child.type === 'UnmatchedNode') {
      pieces.push(...unmatchedPieces(child));
      return;
    }

    pieces.push({ kind: 'doc', doc: print(childPath) });
  }, key);

  return pieces;
}

function printProgram(path: AstPath<Node>, print: (path: AstPath<Node>) => Doc, nodes: Node[], isRoot: boolean): Doc {
  const pieces = childPieces(path, print, nodes, 'body');

  if (!isRoot) {
    return assemble(pieces);
  }

  /* A template's own leading and trailing whitespace is not content; the file ends in exactly
   * one newline whatever the author left behind. */
  let first = 0;
  let last = pieces.length;
  while (first < last && isGap(pieces[first])) first += 1;
  while (last > first && isGap(pieces[last - 1])) last -= 1;

  return first >= last ? '' : [...assemble(pieces.slice(first, last)), hardline];
}

function printNode(path: AstPath<Node>, options: ParserOptions<Node>, print: (path: AstPath<Node>) => Doc): Doc {
  const node = path.node;

  switch (node.type) {
    case 'Program':
      return printProgram(path, print, node.body, path.parent === null);

    case 'TextNode':
      return assemble(textPieces(node));

    case 'MustacheStatement':
      return printMustache(node);

    case 'CommentStatement':
      return printComment(node);

    case 'PartialStatement':
      return printPartial(node);

    case 'DecoratorStatement':
      return printDecorator(node);

    case 'UnmatchedNode':
      return join(literalline, node.raw.split('\n'));

    case 'ElementNode':
      return printElement(path, print, node, options.singleQuote === true);

    default:
      throw new UnsupportedNodeError(node.type);
  }
}

function visitorKeysFor(type: string | undefined): string[] {
  switch (type) {
    case 'Program':
      return ['body'];
    case 'ElementNode':
      return ['attributes', 'children'];
    case 'Attribute':
      return ['value'];
    case 'AttributeValue':
      return ['parts'];
    case 'AttributeBlock':
      return ['block'];
    case 'BlockStatement':
      return ['program', 'inverseChain', 'inverse'];
    case 'ElseBranch':
      return ['program'];
    default:
      return [];
  }
}

export const printer: Printer<Node> = {
  print: printNode,
  getVisitorKeys(node, nonTraversableKeys) {
    const type = typeof node === 'object' && node !== null && 'type' in node ? String(node.type) : undefined;
    return visitorKeysFor(type).filter((key) => !nonTraversableKeys.has(key));
  },
};
