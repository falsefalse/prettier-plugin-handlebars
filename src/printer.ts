import type { AstPath, Doc, ParserOptions, Printer } from 'prettier';
import { builders, utils } from 'prettier/doc';
import { stripCommonIndent, voidElements } from 'template-format-core';
import { handlebarsDialect as templateDialect } from './dialects/handlebars/tokens';
import * as whitespace from './whitespace';
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
  Program,
  TextNode,
  UnmatchedNode,
} from './types';

const { dedent, fill, group, hardline, ifBreak, indent, join, line, literalline, softline } = builders;
const { removeLines } = utils;

/* A run of blank lines collapses to one, which is two hardlines. */
const MAX_HARDLINES = 2;

/** Only prettier's core options reach the printer; this formatter is opinionated. */
/* Only what the printer actually reads. Width and indentation are the doc printer's business,
 * not ours - listing them here just invited code that reached for them directly. */
export type PrintOptions = Pick<ParserOptions<Node>, 'singleQuote'> & {
  /** Quote holding the value being printed into. Unusable by anything nested in it. */
  enclosingQuote?: '"' | "'";
};

/** The `~` of `{{~foo~}}`, which strips the whitespace next to the delimiter it sits on. */
const trim = (marker: boolean | undefined): string => (marker ? '~' : '');

const hardlines = (count: number): Doc[] => Array.from({ length: count }, () => hardline);

/* Sibling whitespace is laid out as pieces so a hard break can end the run it sits in, rather
 * than forcing every other gap in the same program to break with it. */
type Piece =
  | { kind: 'break'; count: number }
  | { kind: 'space'; hard?: boolean }
  /** `withTail` is set on children that can take their container's closing marker inside them. */
  | { kind: 'doc'; doc: Doc; withTail?: (tail: Doc) => Doc };

/**
 * A child that can take its container's closing marker inside it.
 *
 * Lazy rather than memoised: `withCloser` replaces the piece, so `doc` is never read on a child
 * that got a tail. The getter buys not caching but never building the untailed doc at all,
 * which on a deep chain of single children would double the work per level.
 */
function tailable(build: (tail: Doc) => Doc): Piece {
  return {
    kind: 'doc',
    get doc(): Doc {
      return build([]);
    },
    withTail: build,
  };
}

const isGap = (piece: Piece): boolean => piece.kind !== 'doc';

/* Built from the shared class so the character list stays written in one place, and hoisted so
 * `textPieces` is not compiling a pattern per text run. */
const whitespaceGap = new RegExp(`(${whitespace.htmlRun.source})`, 'u');
const trailingWhitespace = new RegExp(`${whitespace.htmlRun.source}$`, 'u');

/**
 * The governing rule: whitespace between siblings renders, so it is reproduced, never invented.
 * A run holding a newline stays a newline, which keeps apart what the author put on separate
 * lines. A run of plain spaces becomes a `line`, free to collapse or wrap by width.
 */
function whitespacePiece(text: string): Piece {
  const newlines = text.split('\n').length - 1;
  return newlines === 0 ? { kind: 'space' } : { kind: 'break', count: Math.min(newlines, MAX_HARDLINES) };
}

/**
 * A text run decomposes into the same pieces as a sibling list: words, and the gaps between
 * them. Treating a run's interior differently from the gaps between nodes would make layout
 * depend on where the parser happened to put a node boundary, collapsing a newline the author
 * wrote inside a text run to a space.
 */
function textPieces(node: TextNode): Piece[] {
  /* Raw text and ignored regions are copied through; literalline keeps them off the indent. */
  if (node.verbatim || node.preserveWhitespace) {
    return [{ kind: 'doc', doc: join(literalline, node.chars.split('\n')) }];
  }

  /* ASCII whitespace only. A non-breaking space is content the author chose - it suppresses a
   * line break on the page - so it travels inside a word rather than becoming a gap. */
  /* Splitting on a capture group already alternates word, gap, word, so the odd slots are the
   * gaps - no second pattern to keep in step with the first. */
  return node.chars
    .split(whitespaceGap)
    .flatMap((part, index) =>
      part === '' ? [] : [index % 2 === 1 ? whitespacePiece(part) : { kind: 'doc', doc: part }],
    );
}

/* Recovered text is copied through, but its trailing whitespace belongs to the surrounding
 * program: left inside the raw it would be reprinted *and* re-added as a line ending, growing
 * the file by a newline on every pass. */
function unmatchedPieces(node: UnmatchedNode): Piece[] {
  /* In a value the trailing gap is content, not somewhere to break: split off as one it let the
   * block around it break, and the printer indented the closing marker into a value the author
   * owns - a space appeared on the page. */
  if (node.preserveWhitespace) {
    return [{ kind: 'doc', doc: join(literalline, node.raw.split('\n')) }];
  }

  /* ASCII only, as everywhere else: `\s` matches U+00A0, so on `\s` a non-breaking space ending
   * an ignored region is rewritten as a plain one, and a run of them as a single space. */
  const trailing = trailingWhitespace.exec(node.raw)?.[0] ?? '';
  const body = trailing ? node.raw.slice(0, -trailing.length) : node.raw;

  const pieces: Piece[] = [];

  if (body) {
    pieces.push({ kind: 'doc', doc: join(literalline, body.split('\n')) });
  }

  if (trailing) {
    pieces.push(whitespacePiece(trailing));
  }

  return pieces;
}

/**
 * Each run between hard breaks wraps on its own. `fill` rather than `group`, so a run that does
 * not fit breaks only where it must - all-or-nothing is for attributes and call params, where
 * the whitespace is the formatter's; content wraps like prose. Adjacent pieces with no gap are
 * glued in the source and merge into one fill item.
 */
function assemble(pieces: Piece[]): Doc[] {
  const docs: Doc[] = [];
  const run: Doc[] = [];
  let glued: Doc[] = [];

  /* A group, not a bare array: `propagateBreaks` marks a group holding a hard line as broken,
   * and `fits` then refuses it, so `fill` prints the item in break mode and the groups inside it
   * get measured one by one. Left as an array it measured as "fits" - `fits` stops at the first
   * hard line - and everything after that line printed flat, over width, until the next pass. */
  const flushGlued = () => {
    if (glued.length > 0) {
      run.push(glued.length === 1 ? glued[0] : group([...glued]));
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
      /* fill reads even positions as content; keep separators on the odd ones. A space that must
       * not become a line break is still a separator - printing it as one keeps its neighbours
       * as separate items that `fill` can measure. Gluing it to them makes everything downstream
       * of a standalone-sensitive statement one unbreakable blob, holding a long tag after a
       * `prettier-ignore` region over width until a second pass moves it. */
      if (run.length % 2 === 0) run.push('');
      run.push(spaceDoc(piece));
      continue;
    }

    glued.push(piece.doc);
  }

  flushRun();
  return docs;
}

/** A space the printer may wrap at, or one it may not. */
const spaceDoc = (piece: { hard?: boolean }): Doc => (piece.hard ? ' ' : line);

/** Every space in the run becomes one the printer may not wrap at. */
const harden = (pieces: Piece[]): Piece[] =>
  pieces.map((piece) => (piece.kind === 'space' ? { kind: 'space', hard: true } : piece));

/** Gaps outside a content run have nothing to wrap, so they print as themselves. */
function gapDocs(gaps: Piece[]): Doc[] {
  return gaps.flatMap((gap) => {
    if (gap.kind === 'break') return hardlines(gap.count);
    return gap.kind === 'space' ? [spaceDoc(gap)] : [];
  });
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
  /* `block` already covers a multiline body - the parser sets it for either - so re-testing
   * `multiline` here only invited the two to be kept in step by hand. */
  const [open, close] = node.block
    ? [`{{${trim(node.trimOpen)}!--`, `--${trim(node.trimClose)}}}`]
    : [`{{${trim(node.trimOpen)}!`, `${trim(node.trimClose)}}}`];
  const body = node.value;

  /* express-hbs' layout directive is not prose: padding `{{!< layout}}` to `{{! < layout }}`
   * stops it being recognised and the layout silently stops being applied. The parser decides,
   * from the source - the body alone cannot tell the directive from a comment about one. */
  if (node.layout) {
    return [open, body, close];
  }

  /* A body the author started on its own line is re-indented under the comment, so it follows
   * the surrounding structure instead of staying frozen at the column it was written at.
   * Common indentation is stripped and re-applied, which keeps the body's *relative* shape. */
  if (/^\n/u.test(body)) {
    const lines = stripCommonIndent(body.replace(/^\n/u, '').replace(trailingWhitespace, '').split('\n'));

    return lines.every((line) => line === '')
      ? [open, hardline, close]
      : [open, indent([hardline, join(hardline, lines)]), hardline, close];
  }

  /* Otherwise pad only where the body is not already spaced away from the delimiter: padding
   * regardless puts trailing whitespace on the opening line, which re-parses differently on the
   * next pass. Continuation lines keep their own indentation, having nothing to hang from. */
  /* An empty block comment still gets its spacing: `{{!----}}` reads as a typo, and it is what
   * the formatter would otherwise write over every `{{!-- --}}` in a file. A line comment has no
   * such problem - `{{!}}` is already what an empty one looks like. */
  if (body === '') {
    return node.block ? [open, ' ', close] : [open, close];
  }

  /* ASCII whitespace, not `\s`: a non-breaking space is content the author put there. Trimming
   * on `\s` deleted one off the end of a block comment's body, and reading one as the pad it
   * already had left a line comment unpadded. */
  const lead = whitespace.html.test(body[0] ?? '') ? '' : ' ';
  const tail = whitespace.html.test(body[body.length - 1] ?? '') ? '' : ' ';

  return [open, lead, join(literalline, body.split('\n')), tail, close];
}

/**
 * The quote that needs no escaping; `singleQuote` decides only when either would do.
 *
 * Against the value's raw text, not just its TextNode parts: a quote inside a mustache is printed
 * too, so `class='{{t "x"}}'` cannot be re-quoted with `"` without ending the attribute early.
 */
/* A quote ends the value holding it, so a nested element cannot reuse the outer one. */
function chooseQuote(value: AttributeValue, options: PrintOptions): '"' | "'" {
  const preferred: '"' | "'" = options.singleQuote === true ? "'" : '"';
  const candidates: Array<'"' | "'"> = [preferred, preferred === '"' ? "'" : '"'];

  return candidates.find((q) => q !== options.enclosingQuote && !value.raw.includes(q)) ?? preferred;
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
  const quote = chooseQuote(attribute.value, options);
  const nested = { ...options, enclosingQuote: quote };

  return [attribute.name, '=', quote, ...parts.map((part) => printAny(part, nested)), quote];
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

  /* A gap between attributes is normally the formatter's - it never reaches the page. But a
   * mustache or block in attribute position emits content, so two the author glued together
   * have to stay glued: `{{a}}{{b}}` is one attribute, `{{a}} {{b}}` is two. */
  const attributes = node.attributes.flatMap((attribute, index) => {
    const printed = printAttribute(attribute, options);
    return index === 0 || attribute.glued ? [printed] : [line, printed];
  });

  /* Same rule against the tag name itself: a first attribute the author glued on stays glued,
   * or `<h{{level}}>` prints as `<h {{level}}>` and stops being a heading. */
  const head = node.attributes[0].glued ? attributes : [line, ...attributes];

  return group(['<', node.tag, indent(head), ifBreak([softline, marker.trimStart()], marker)]);
}

/**
 * The content between two markers - a tag's brackets, or a block's open and close - together
 * with the marker that ends it.
 *
 * The trailing gap sits inside the indent, so the dedent lands the closer at the container's
 * own level; dedenting outside overshoots, and the overshoot compounds with depth.
 *
 * With no trailing gap the closer is glued onto the last piece: `fill` measures its last item
 * blind to what follows, so a `</p>` left outside would not count towards its line's width.
 */
function printBody(pieces: Piece[], closer: Doc): Doc[] {
  if (pieces.length === 0) {
    return [closer];
  }

  const [start, end] = contentSpan(pieces);

  /* Nothing but whitespace inside: emit it once rather than as both edges. */
  if (start >= end) {
    return [...gapDocs(pieces.slice(0, 1)), closer];
  }

  const leading = gapDocs(pieces.slice(0, start));
  const trailing = gapDocs(pieces.slice(end)).map(dedent);
  const content = pieces.slice(start, end);

  if (trailing.length === 0) {
    return [indent([...leading, ...assemble(withCloser(content, closer))])];
  }

  return [indent([...leading, ...assemble(content), ...trailing]), closer];
}

/**
 * The closer goes *inside* the last child when that child has a body to put it in. `fill`
 * measures its last item against an empty rest-stack, so a marker appended after the child is
 * invisible to the width check one level down as well as at this one: the line came out over
 * width, and the next pass - now seeing a real break there - printed it differently.
 */
function withCloser(content: Piece[], closer: Doc): Piece[] {
  const last = content[content.length - 1];

  if (last?.kind === 'doc' && last.withTail) {
    return [...content.slice(0, -1), { kind: 'doc', doc: last.withTail(closer) }];
  }

  return [...content, { kind: 'doc', doc: closer }];
}

/* Containers thread the marker into their body; everything else just carries it along. */
function printWithTail(node: Node, options: PrintOptions, tail: Doc): Doc {
  if (node.type === 'ElementNode') {
    return printElement(node, options, tail);
  }

  if (node.type === 'BlockStatement') {
    return printBlock(node, options, tail);
  }

  return [printAny(node, options), tail];
}

function printElement(node: ElementNode, options: PrintOptions, tail: Doc = []): Doc {
  const openTag = printOpenTag(node, options);
  const closer: Doc = ['</', node.closeTag ?? node.tag, '>', tail];
  const doc: Doc = node.selfClosing
    ? [openTag, tail]
    : group([openTag, ...printBody(childPieces(node.children, options), closer)]);

  /* Inside an attribute value every character renders, so the tag may not be broken across
   * lines - that would put the printer's newlines and indent inside a value the author owns,
   * changing the page. Only calls may still be reflowed: `{{ }}` never reaches the page. */
  return node.preserveWhitespace ? removeLines(doc) : doc;
}

/**
 * One marker and the body that follows it. `open` is deferred because whether a block may break
 * is a property of every body at once, and the markers have to be printed knowing it.
 */
interface BlockSection {
  program: Program;
  open: (breakable: boolean) => Doc;
}

function printBlock(node: BlockStatement, options: PrintOptions, tail: Doc = []): Doc {
  const prefix = templateDialect.getPrintedBlockPrefix(node.blockPrefix ?? '#');
  const elseKeyword = templateDialect.getElseKeyword();

  const sections: BlockSection[] = [
    {
      program: node.program,
      open: (breakable) =>
        printCall(node, ['{{', trim(node.trimOpen), prefix], [trim(node.trimClose), '}}'], breakable),
    },
    ...(node.inverseChain ?? []).map((branch) => ({
      program: branch.program,
      open: (breakable: boolean) =>
        printCall(branch, ['{{', trim(branch.trimOpen), `${elseKeyword} `], [trim(branch.trimClose), '}}'], breakable),
    })),
  ];

  /* An empty `{{else}}` prints nothing - unless it carries `~`, which strips whitespace that
   * would otherwise render. */
  if (node.inverse.body.length > 0 || node.inverseTrimOpen || node.inverseTrimClose) {
    sections.push({
      program: node.inverse,
      open: () => ['{{', trim(node.inverseTrimOpen), elseKeyword, trim(node.inverseTrimClose), '}}'],
    });
  }

  const close: Doc = [
    '{{',
    trim(node.closeTrimOpen),
    templateDialect.getBlockClosePrefix(node.path.source),
    trim(node.closeTrimClose),
    '}}',
    tail,
  ];

  const pieces = sections.map((section) => childPieces(section.program.body, options));

  /* A section the author kept on one line is an atom: wrapping its body would leave a marker
   * alone on its line, where Handlebars strips the whitespace around it and the page changes.
   * Per section, not per block - read whole-block, a newline in one branch unwrapped the rest.
   * Markers stay a whole-block decision; splitting `{{else if` from its condition never helps. */
  const sectionBreaks = pieces.map((body) => body.some((piece) => piece.kind === 'break'));
  const breakable = sectionBreaks.some(Boolean);
  const opens = sections.map((section) => section.open(breakable));

  /* Each body carries the marker that closes it, so `fill` can see it when measuring. */
  return group([
    opens[0],
    ...pieces.flatMap((body, index) =>
      printBody(sectionBreaks[index] ? body : harden(body), opens[index + 1] ?? close),
    ),
  ]);
}

/* Handlebars strips the whitespace around a partial, comment or block left alone on its line -
 * a mustache is not - so a space next to one has to stay a space: wrapping there would start or
 * stop that stripping. `UnmatchedNode` is in the set because its verbatim text may begin or end
 * with any of them. */
const standaloneStatements = new Set<Node['type']>([
  'PartialStatement',
  'CommentStatement',
  'BlockStatement',
  'DecoratorStatement',
  'UnmatchedNode',
]);

/**
 * Children need no separators: the whitespace between them is already in the tree, so the
 * printer cannot add a gap the author did not write, nor drop one they did.
 */
function childPieces(nodes: Node[], options: PrintOptions): Piece[] {
  const pieces: Piece[] = [];
  const sensitive: number[] = [];

  for (const child of nodes) {
    if (child.type === 'TextNode') {
      pieces.push(...textPieces(child));
      continue;
    }

    if (child.type === 'UnmatchedNode') {
      const verbatim = unmatchedPieces(child);
      /* Both edges: the text is opaque, so either end may be a standalone statement. */
      sensitive.push(pieces.length, pieces.length + verbatim.length - 1);
      pieces.push(...verbatim);
      continue;
    }

    if (standaloneStatements.has(child.type)) {
      sensitive.push(pieces.length);
    }

    pieces.push(tailable((tail) => printWithTail(child, options, tail)));
  }

  for (const at of sensitive) {
    for (const neighbour of [at - 1, at + 1]) {
      if (pieces[neighbour]?.kind === 'space') {
        pieces[neighbour] = { kind: 'space', hard: true };
      }
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

    /* `childPieces` intercepts these, so this arm only keeps the switch exhaustive. It goes
     * through `unmatchedPieces` all the same, rather than repeating it: a second copy drifts,
     * and one missing the trailing-whitespace split grows the file by a newline every pass. */
    case 'UnmatchedNode':
      return assemble(unmatchedPieces(node));

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
