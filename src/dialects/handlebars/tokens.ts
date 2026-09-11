import { isTemplateExpressionQuoteStart } from 'template-format-core';
import { scanPastQuotes } from '../../scan';
import * as whitespace from '../../whitespace';
import type { TemplateBlockPrefix, TemplateToken } from 'template-format-core';

export interface HandlebarsToken extends TemplateToken {
  /**
   * Whether the tokenizer found a closing delimiter, rather than running to the end of the
   * input. Recorded by the one place that knows: re-deriving it by string-matching the token's
   * tail reports true for any unterminated token running to a text end that already ends in
   * `}}`, letting `{{foo "bar}}` past the malformed guard to print as `{{foo "bar}}}}`.
   */
  terminated: boolean;
}

/* Deliberately not typed `: TemplateDialect`. That interface demands nine more members than the
 * parser and printer ever ask for, each a second copy of Handlebars syntax to keep in step by
 * hand - `getLineCommentTag` and `printComment` disagree about the same thing. */
export const handlebarsDialect = {
  openDelimiter: '{{',
  parseToken: parseHandlebarsToken,
  findNextOpen: findNextHandlebarsOpen,
  isEscapedOpen: isEscapedHandlebarsOpen,
  isDynamicElementStart: isDynamicHandlebarsElementStart,
  consumeRawBlock: consumeHandlebarsRawBlock,
  getBlockExpression: getHandlebarsBlockExpression,
  getBlockPrefix: getHandlebarsBlockPrefix,
  getPrintedBlockPrefix: getPrintedHandlebarsBlockPrefix,
  getElseKeyword: getHandlebarsElseKeyword,
  getBlockClosePrefix: getHandlebarsBlockClosePrefix,
  shouldPreserveTokenVerbatim: shouldPreserveHandlebarsTokenVerbatim,
};

/**
 * The path a block opens on, which is where its name ends. A plain whitespace split cut
 * `{{#[my block]}}` down to `[my`, and that never matched the `[my block]` the block's own
 * `{{/[my block]}}` reports - a Handlebars path segment may hold spaces inside `[...]`.
 */
function readPathName(inner: string): string {
  const text = inner.trim();
  let brackets = false;

  for (let pos = 0; pos < text.length; pos += 1) {
    const char = text[pos];

    if (char === '[') {
      brackets = true;
    } else if (char === ']') {
      brackets = false;
    } else if (!brackets && whitespace.handlebars.test(char)) {
      return text.slice(0, pos);
    }
  }

  return text;
}

function parseHandlebarsToken(text: string, position: number): HandlebarsToken {
  const triple = text.startsWith('{{{', position);
  const openLength = triple ? 3 : 2;
  const close = triple ? '}}}' : '}}';

  const isBlockComment = isHandlebarsBlockComment(text, position);
  const blockClose = isBlockComment ? findHandlebarsBlockCommentClose(text, position + openLength, close) : null;

  /* A comment body is text, not an expression: Handlebars ends a line comment at the first close
   * delimiter, full stop. The quote-aware scanner lets an unbalanced quote run the token past
   * its real `}}`, so `{{! "q }}\n{{#if a}}y{{/if}}` swallows the block and renders nothing -
   * stable across passes, and invisible to every gate. */
  const isLineComment = !isBlockComment && /^~?!/u.test(text.slice(position + openLength, position + openLength + 2));

  const closeIdx = isBlockComment
    ? blockClose?.index ?? -1
    : isLineComment
      ? text.indexOf(close, position + openLength)
      : findHandlebarsClose(text, position + openLength, close);
  const end = isBlockComment
    ? blockClose?.end ?? text.length
    : closeIdx >= 0
      ? closeIdx + close.length
      : text.length;
  const rawContent = text.slice(position + openLength, closeIdx >= 0 ? closeIdx : undefined);
  const rawInner = rawContent.trim();
  const trimOpen = rawInner.startsWith('~');
  /* A block comment's closing `~` sits after the `--`, so it is outside `rawContent`. */
  const trimClose = blockClose ? blockClose.trimClose : rawInner.endsWith('~');
  const inner = rawInner.replace(/^~/, '').replace(/~$/, '').trim();

  const baseToken = {
    rawContent,
    rawInner,
    start: position,
    end,
    triple,
    trimOpen,
    trimClose,
    terminated: isBlockComment ? blockClose !== null : closeIdx >= 0,
  };

  if (inner.startsWith('!')) {
    return { kind: 'comment', content: inner, name: undefined, ...baseToken };
  }

  if (inner.startsWith('>')) {
    return { kind: 'partial', content: inner.slice(1).trim(), name: undefined, ...baseToken };
  }

  if (inner.startsWith('<')) {
    const name = readPathName(inner.slice(1));
    return { kind: 'blockStart', content: inner, name, specialForm: 'parent', ...baseToken };
  }

  if (inner.startsWith('#>')) {
    const name = readPathName(inner.slice(2));
    return { kind: 'blockStart', content: inner, name, specialForm: 'blockPartial', ...baseToken };
  }

  if (inner.startsWith('#*')) {
    const name = readPathName(inner.slice(2));
    return { kind: 'blockStart', content: inner, name, specialForm: 'decoratorBlock', ...baseToken };
  }

  if (inner.startsWith('*')) {
    return { kind: 'mustache', content: inner, name: undefined, specialForm: 'decorator', ...baseToken };
  }

  if (inner.startsWith('#')) {
    const name = readPathName(inner.slice(1));
    return { kind: 'blockStart', content: inner, name, ...baseToken };
  }

  if (inner.startsWith('^')) {
    const name = readPathName(inner.slice(1));

    /* Bare `{{^}}` is the shorthand for `{{else}}`; only `{{^name}}` opens an inverted block. */
    if (!name) {
      return { kind: 'else', content: inner, name: 'else', ...baseToken };
    }

    return { kind: 'blockStart', content: inner, name, specialForm: 'inverseBlock', ...baseToken };
  }

  if (inner.startsWith('$')) {
    const name = readPathName(inner.slice(1));
    return { kind: 'blockStart', content: inner, name, specialForm: 'mustacheBlock', ...baseToken };
  }

  if (inner.startsWith('/')) {
    const name = inner.slice(1).trim();
    return { kind: 'blockEnd', content: inner, name, ...baseToken };
  }

  if (inner === 'else' || inner.startsWith('else ')) {
    return {
      kind: 'else',
      content: inner,
      name: 'else',
      specialForm: inner === 'else' ? undefined : 'elseIf',
      ...baseToken,
    };
  }

  return { kind: 'mustache', content: inner, name: undefined, ...baseToken };
}

/**
 * Whether a comment at `position` is written in block form. `{{~!-- x --~}}` is one as much as
 * `{{!-- x --}}`, so the `~` is skipped: anchoring on a literal `{{!--` reads the
 * whitespace-control form as a line comment and demotes it to `{{! !-- x -- }}`.
 */
export function isHandlebarsBlockComment(text: string, position: number): boolean {
  const openLength = text.startsWith('{{{', position) ? 3 : 2;

  return /^~?!--/u.test(text.slice(position + openLength, position + openLength + 4));
}

/** The first `--}}` or `--~}}`, whichever comes first. */
function findHandlebarsBlockCommentClose(
  text: string,
  position: number,
  close: string,
): { index: number; end: number; trimClose: boolean } | null {
  const plain = text.indexOf(`--${close}`, position);
  const trimmed = text.indexOf(`--~${close}`, position);

  if (trimmed >= 0 && (plain < 0 || trimmed < plain)) {
    return { index: trimmed, end: trimmed + close.length + 3, trimClose: true };
  }

  return plain < 0 ? null : { index: plain, end: plain + close.length + 2, trimClose: false };
}

function findHandlebarsClose(text: string, position: number, closeDelimiter: string): number {
  return scanPastQuotes(text, position, {
    stopsAt: (index) => text.startsWith(closeDelimiter, index),
    opensQuote: (index) => isTemplateExpressionQuoteStart(text, index, position),
  });
}

function isEscapedHandlebarsOpen(text: string, position: number): boolean {
  if (!text.startsWith('{{', position)) {
    return false;
  }

  let slashCount = 0;
  for (let index = position - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function findNextHandlebarsOpen(text: string, position: number): number {
  let searchPos = position;

  while (searchPos < text.length) {
    const candidate = text.indexOf('{{', searchPos);
    if (candidate === -1) {
      return -1;
    }

    if (!isEscapedHandlebarsOpen(text, candidate)) {
      return candidate;
    }

    searchPos = candidate + 2;
  }

  return -1;
}

function isDynamicHandlebarsElementStart(text: string, position: number): boolean {
  return text.startsWith('<{{', position) || text.startsWith('</{{', position);
}

/**
 * The name a raw block opens with, or `''` if `position` is not one. Tildes are tolerated on the
 * open because the lexer takes them there; the closer below is stricter for the same reason.
 */
export function handlebarsRawBlockName(text: string, position: number, openEnd: number): string {
  const inner = text.slice(position + 4, openEnd).trim().replace(/^~/u, '').replace(/~$/u, '').trim();

  return inner.startsWith('/') ? '' : (inner.split(whitespace.handlebarsRun)[0] ?? '');
}

/**
 * The only closer Handlebars accepts: no whitespace inside it and no tilde on either side -
 * `{{{{~/raw}}}}` and `{{{{ / raw }}}}` are both lexical errors. One literal, so there is nothing
 * to escape and nothing to drift - the two hand-written patterns this replaces disagreed about
 * exactly that whitespace.
 */
export function handlebarsRawBlockCloser(name: string): string {
  return `{{{{/${name}}}}}`;
}

function consumeHandlebarsRawBlock(text: string, position: number): number | null {
  if (!text.startsWith('{{{{', position)) {
    return null;
  }

  const openIdx = text.indexOf('}}}}', position + 4);
  if (openIdx === -1) {
    return text.length;
  }

  const name = handlebarsRawBlockName(text, position, openIdx);
  if (!name) {
    return null;
  }

  const closer = handlebarsRawBlockCloser(name);
  const closeIdx = text.indexOf(closer, openIdx + 4);

  if (closeIdx === -1) {
    return text.length;
  }

  return closeIdx + closer.length;
}

function getHandlebarsBlockExpression(token: TemplateToken): string {
  if (token.specialForm === 'blockPartial' || token.specialForm === 'decoratorBlock') {
    return token.content.slice(2).trim();
  }

  return token.content.slice(1).trim();
}

function getHandlebarsBlockPrefix(token: TemplateToken): TemplateBlockPrefix {
  if (token.specialForm === 'blockPartial') {
    return '#>';
  }

  if (token.specialForm === 'decoratorBlock') {
    return '#*';
  }

  if (token.specialForm === 'inverseBlock') {
    return '^';
  }

  if (token.specialForm === 'parent') {
    return '<';
  }

  if (token.specialForm === 'mustacheBlock') {
    return '$';
  }

  return '#';
}

function getPrintedHandlebarsBlockPrefix(prefix: TemplateBlockPrefix): string {
  if (prefix === '#>' || prefix === '<') {
    return `${prefix} `;
  }

  return prefix;
}

function getHandlebarsElseKeyword(): string {
  return 'else';
}

function getHandlebarsBlockClosePrefix(path: string): string {
  return `/${path}`;
}

function shouldPreserveHandlebarsTokenVerbatim(token: TemplateToken): boolean {
  return token.specialForm === 'elseIf';
}

