/* Turning a token into the node it stands for. The span is the token's, so nothing here scans:
 * what a construct covers was already settled by the time it gets here. */
import { withOptionalRange, withRange } from '../core/source';
import { parseCall } from '../expression';
import { leadingWhitespace } from './lex';
import { mustachesFrom } from './lookahead';
import type { HandlebarsToken as MustacheToken } from '../dialects/handlebars/tokens';
import type {
  CommentStatement,
  DecoratorStatement,
  MustacheStatement,
  PartialStatement,
  UnmatchedNode,
} from '../types';

export type PrettierIgnoreDirective = 'next' | 'start' | 'end' | null;

/**
 * The directive has to *be* the comment, not appear somewhere inside it: on `includes`, a
 * comment merely mentioning `prettier-ignore` would silently suppress the next node, and one
 * mentioning `prettier-ignore-start` would open a region.
 */
export function getPrettierIgnoreDirective(rawContent: string): PrettierIgnoreDirective {
  switch (rawContent.toLowerCase().replace(/^\s*!(?:-{2})?/u, '').trim()) {
    case 'prettier-ignore-start':
      return 'start';
    case 'prettier-ignore-end':
      return 'end';
    case 'prettier-ignore':
      return 'next';
    default:
      return null;
  }
}

export function findPrettierIgnoreEnd(text: string, position: number): number | null {
  for (const token of mustachesFrom(text, position)) {
    /* Kind first: `commentBody` and the directive lookup are wasted on every mustache, block and
     * partial the scan walks past on the way. */
    if (token.kind === 'comment' && getPrettierIgnoreDirective(commentBody(token)) === 'end') {
      return token.end;
    }
  }

  return null;
}

export function createUnmatchedNode(text: string, start: number, end: number, rangeOffset: number): UnmatchedNode {
  return withRange(
    { type: 'UnmatchedNode', raw: text.slice(start, end) },
    rangeOffset + start,
    rangeOffset + end,
  );
}

/** Where `content` begins inside the tag spanning [tagStart, tagEnd), for absolute expression ranges. */
export function contentOffset(text: string, tagStart: number, tagEnd: number, content: string): number {
  const at = text.slice(tagStart, tagEnd).indexOf(content);
  return at === -1 ? tagStart : tagStart + at;
}

/* The parts every inline statement shares: its call, and the `~` markers on its delimiters. */
export function statementBase(text: string, token: MustacheToken, position: number, rangeOffset: number, content: string) {
  return {
    ...parseCall(content, rangeOffset + contentOffset(text, position, token.end, content)),
    ...(token.trimOpen ? { trimOpen: true } : {}),
    ...(token.trimClose ? { trimClose: true } : {}),
  };
}

/**
 * A mustache built from whatever token is in hand, whether or not it reads as one.
 *
 * The recovery paths use it for a block that never closes and for a stray `{{else}}` or
 * `{{/if}}` in a position that cannot reject them.
 */
export function createMustache(text: string, token: MustacheToken, position: number, rangeOffset: number): MustacheStatement {
  /* Annotated, not inferred: `withOptionalRange` is generic, so an unannotated literal widens
   * `type` to `string` and stops matching the node union. */
  const node: MustacheStatement = {
    type: 'MustacheStatement',
    triple: token.triple,
    ...statementBase(text, token, position, rangeOffset, token.content),
  };

  return withOptionalRange(node, rangeOffset + position, rangeOffset + token.end);
}

/**
 * The node for a token that stands on its own, or null for the three kinds - a block and the two
 * terminators - whose handling depends on where they appear.
 *
 * Every context that reads a mustache needs this dispatch: a program body, an attribute list,
 * the inside of a value. Written out three times, they had drifted at the recovery arms.
 */
export function createStatement(
  text: string,
  token: MustacheToken,
  position: number,
  rangeOffset: number,
): MustacheStatement | PartialStatement | DecoratorStatement | CommentStatement | null {
  const start = rangeOffset + position;
  const end = rangeOffset + token.end;

  if (token.kind === 'comment') {
    return createComment(token, start, end);
  }

  if (token.kind === 'partial') {
    const node: PartialStatement = {
      type: 'PartialStatement',
      ...statementBase(text, token, position, rangeOffset, token.content),
    };

    return withOptionalRange(node, start, end);
  }

  /* Before the mustache arm: a decorator is a mustache token carrying a `*`. */
  if (token.specialForm === 'decorator') {
    const node: DecoratorStatement = {
      type: 'DecoratorStatement',
      ...statementBase(text, token, position, rangeOffset, token.content.slice(1).trim()),
    };

    return withOptionalRange(node, start, end);
  }

  return token.kind === 'mustache' ? createMustache(text, token, position, rangeOffset) : null;
}

/**
 * A comment's body, with the tag's own `~` markers taken off. They are whitespace control, not
 * text: printing `rawContent` straight through emits them as body, turning `{{~! x ~}}` into
 * `{{! ~! x ~ }}` and dropping the stripping the author asked for.
 */
export function commentBody(token: MustacheToken): string {
  let content = token.rawContent;

  if (token.trimOpen) {
    content = content.replace(/^([\t ]*)~/u, '$1');
  }

  /* A block comment's closing `~` follows the `--`, so it never reached `rawContent`. */
  if (token.trimClose) {
    content = content.replace(/~([\t ]*)$/u, '$1');
  }

  return content;
}

export function createComment(token: MustacheToken, start?: number, end?: number): CommentStatement {
  const content = commentBody(token);
  const isBlockStyle = /^\s*!-{2}/.test(content);
  /* express-hbs' layout directive is `{{!< name}}`, with nothing between the `!` and the `<`, so
   * the gap is what distinguishes it. Recognising it by body alone would print the ordinary
   * comment `{{! < name}}` as a directive, silently wrapping the page in a layout. */
  const isLayout = /^!<\s*\S/u.test(content.trim());
  /* Only a block comment's `--` is a marker. Stripping up to two dashes regardless cannot tell
   * it from a body that opens with one, which turns `{{!-foo}}` into `{{! foo }}`.
   *
   * Nothing is stripped from the end: the tokenizer stops before the closing delimiter already,
   * so doing it again would delete a `--` the author wrote. */
  const body = content.replace(isBlockStyle ? /^[\t ]*!--/u : /^[\t ]*!/u, '');
  /* Trailing whitespace comes off first. A space between `{{!--` and the newline is invisible in
   * the source and left the body not *starting* with one, which silently turned off the
   * re-indent below - so `{{!-- \n  x\n--}}` and `{{!--\n  x\n--}}` printed differently. */
  const trimmed = body.replace(/[ \t]+$/gm, '');
  /* A body the author started on its own line keeps its leading newline; the printer reads that
   * to decide whether to re-indent it. ASCII whitespace, not `\s`: a non-breaking space is
   * content the author put there, and `\s` deleted one off the front of a comment body. */
  const value = trimmed.startsWith('\n') ? trimmed : trimmed.replace(leadingWhitespace, '');

  const isMultiline = /\n/.test(content);

  return withOptionalRange({
    type: 'CommentStatement',
    value,
    multiline: isMultiline,
    block: isBlockStyle || isMultiline,
    ...(isLayout ? { layout: true } : {}),
    ...(token.trimOpen ? { trimOpen: true } : {}),
    ...(token.trimClose ? { trimClose: true } : {}),
  }, start, end);
}
