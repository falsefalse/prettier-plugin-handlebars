/* Lookahead: where a construct ends, without building anything. Every answer is an index, so
 * the tree builder can decide whether to refuse before it has committed to a node. */
import { rawTextElements } from '../core/html';
import { fail } from '../core/errors';
import { handlebarsDialect, handlebarsRawBlockCloser, handlebarsRawBlockName } from '../dialects/handlebars/tokens';
import type { HandlebarsToken as MustacheToken } from '../dialects/handlebars/tokens';
import { consumeTagLikeChunk, isTagStart, sameTag, scanTag, startsTemplateTag, tagNameTerminator } from './lex';

export const {
  openDelimiter,
  parseToken: parseMustacheToken,
  findNextOpen: findNextHandlebarsOpen,
  isDynamicElementStart: isDynamicTagStart,
  consumeRawBlock,
} = handlebarsDialect;

/* Where a raw block at `position` ends, or null if there is not one there. A body Handlebars
 * emits literally is copied through wherever it appears; one that never closes is rejected
 * wherever it appears too. */
export function consumeTerminatedRawBlock(text: string, position: number, rangeOffset: number): number | null {
  const end = consumeRawBlock(text, position);

  if (end === null) {
    return null;
  }

  /* Same as for a mustache, except the closer carries the block's own name - and the name is
   * read once here rather than once to decide and again to name it in the message. */
  const openEnd = text.indexOf('}}}}', position + 4);
  const name = openEnd === -1 ? '' : handlebarsRawBlockName(text, position, openEnd);

  if (name === '' || !text.slice(position, end).endsWith(handlebarsRawBlockCloser(name))) {
    fail(`unterminated raw block: expected ${handlebarsRawBlockCloser(name)}`, rangeOffset + position, rangeOffset + end);
  }

  return end;
}

export function hasMatchingBlockEnd(text: string, token: MustacheToken): boolean {
  return findMatchingBlockEnd(text, token) !== null;
}

/**
 * The mustaches in `text` from `from` onwards, minus those inside a `{{{{raw}}}}` body:
 * Handlebars does not parse one, so a `{{#if}}` in there opens nothing.
 *
 * Deliberately does *not* skip HTML comments or `<script>`: Handlebars has no idea what HTML is
 * and rejects `{{#if a}}<!-- {{#if b}} -->{{/if}}`, so these scans must see that `{{#if b}}`.
 */
export function* mustachesFrom(text: string, from: number): Generator<MustacheToken> {
  let pos = from;

  while (pos < text.length) {
    const next = findNextHandlebarsOpen(text, pos);
    if (next === -1) {
      return;
    }

    const rawBlockEnd = consumeRawBlock(text, next);
    if (rawBlockEnd !== null && rawBlockEnd > next) {
      pos = rawBlockEnd;
      continue;
    }

    const token = parseMustacheToken(text, next);
    yield token;
    pos = token.end > next ? token.end : next + 2;
  }
}

/** Where the block opened by `token` closes, or null if it never does. */
export function findMatchingBlockEnd(text: string, token: MustacheToken): number | null {
  if (!token.name) {
    return null;
  }

  let depth = 0;

  /* From the end of the opening tag, which the token already knows - a caller passing a start
   * position instead would have `findNextHandlebarsOpen` land on a `{{` inside the tag's own
   * string literal, reading `{{#if (eq a "{{")}}` as a mustache that never closes. */
  for (const candidate of mustachesFrom(text, token.end)) {
    if (candidate.kind === 'blockStart' && candidate.name === token.name) {
      depth += 1;
    } else if (candidate.kind === 'blockEnd' && candidate.name === token.name) {
      if (depth === 0) {
        return candidate.end;
      }

      depth -= 1;
    }
  }

  return null;
}

/**
 * How far `{{! prettier-ignore }}` reaches: to the end of the one node that follows it, or
 * nowhere if that node's extent cannot be determined.
 *
 * It scans rather than parses: a nested `parseChildren` would run past the enclosing container,
 * handing an element its own `</div>`, and could `fail()` - leaving a directive meant to
 * suppress formatting able to reject the file. `position` means "nothing to ignore".
 */
export function consumeNextNode(text: string, position: number): number {
  if (position >= text.length) {
    return position;
  }

  if (startsTemplateTag(text, position)) {
    const token = parseMustacheToken(text, position);

    /* A terminator belongs to whatever opened it, never to the node being skipped. */
    if (token.kind === 'blockEnd' || token.kind === 'else') {
      return position;
    }

    return token.kind === 'blockStart' ? findMatchingBlockEnd(text, token) ?? position : token.end;
  }

  if (text[position] === '<') {
    const tagResult = scanTag(text, position);

    if (!tagResult.terminated || tagResult.kind === 'close') {
      return position;
    }

    if (tagResult.kind === 'selfClosing') {
      return tagResult.end;
    }

    const closeStart = findMatchingTagClose(text, tagResult.tag, tagResult.end);
    if (closeStart === null) {
      return position;
    }

    const closeEnd = text.indexOf('>', closeStart);
    return closeEnd < 0 ? position : closeEnd + 1;
  }

  const nextMarkup = findNextMarkup(text, position);

  if (nextMarkup <= position) {
    return nextMarkup;
  }

  /* Only whitespace is stepped over on the way to the node being ignored - a run of text is a
   * node in its own right, and is the thing to ignore. */
  if (text.slice(position, nextMarkup).trim() !== '' || nextMarkup >= text.length) {
    return nextMarkup;
  }

  return consumeNextNode(text, nextMarkup);
}

export function findNextMarkup(text: string, position: number): number {
  let next = text.length;
  let searchPos = position;

  while (searchPos < text.length) {
    const candidate = text.indexOf('<', searchPos);
    if (candidate === -1) {
      break;
    }

    if (isDynamicTagStart(text, candidate)) {
      next = candidate;
      break;
    }

    if (isTagStart(text, candidate)) {
      next = candidate;
      break;
    }

    searchPos = candidate + 1;
  }

  const hb = findNextHandlebarsOpen(text, position);
  if (hb !== -1 && hb < next) {
    next = hb;
  }
  return next;
}

export function findCurrentBlockBoundary(text: string, position: number, endBlock: string): number {
  let depth = 0;

  for (const token of mustachesFrom(text, position)) {
    if (token.kind === 'blockStart') {
      depth += 1;
    } else if (token.kind === 'blockEnd') {
      if (depth === 0 && token.name === endBlock) {
        return token.start;
      }

      if (depth > 0) {
        depth -= 1;
      }
    } else if (token.kind === 'else' && depth === 0) {
      return token.start;
    }
  }

  return -1;
}

/* Past one mustache, or past a whole raw block: a raw block's body is emitted literally, so the
 * markup inside it is not markup either. Never returns `position`, so callers cannot spin. */
export function skipMustache(text: string, position: number): number {
  const rawBlockEnd = consumeRawBlock(text, position);
  if (rawBlockEnd !== null && rawBlockEnd > position) {
    return rawBlockEnd;
  }

  return Math.max(parseMustacheToken(text, position).end, position + 2);
}

export function findMatchingTagClose(text: string, tag: string, position: number, limit = -1): number | null {
  if (rawTextElements.has(tag.toLowerCase())) {
    const closeStart = findRawTextClose(text, position, tag);
    if (closeStart === -1 || (limit >= 0 && closeStart >= limit)) {
      return null;
    }

    return closeStart;
  }

  let depth = 0;
  let pos = position;

  while (pos < text.length) {
    const next = text.indexOf('<', pos);
    if (next === -1 || (limit >= 0 && next >= limit)) {
      return null;
    }

    /* A `<` inside a mustache is not markup, so the dialect is consulted first, as every other
     * scanner here does. Otherwise `{{t "<div>"}}` reads as an open tag, leaving the scan a level
     * too deep and the real `</div>` closing it - refusing the file as unclosed. */
    const mustache = findNextHandlebarsOpen(text, pos);
    if (mustache !== -1 && mustache < next) {
      pos = skipMustache(text, mustache);
      continue;
    }

    if (text.startsWith('<!--', next)) {
      const closeIdx = text.indexOf('-->', next + 4);
      pos = closeIdx >= 0 ? closeIdx + 3 : text.length;
      continue;
    }

    if (text.startsWith('<!', next) && !text.startsWith('<!--', next)) {
      const closeIdx = text.indexOf('>', next + 2);
      pos = closeIdx >= 0 ? closeIdx + 1 : text.length;
      continue;
    }

    const dynamicEnd = consumeDynamicElement(text, next);
    if (dynamicEnd !== null) {
      pos = dynamicEnd;
      continue;
    }

    if (!isTagStart(text, next)) {
      pos = next + 1;
      continue;
    }

    const tagResult = scanTag(text, next);

    if (tagResult.kind === 'close') {
      if (sameTag(tagResult.tag, tag)) {
        if (depth === 0) {
          return next;
        }

        depth -= 1;
      }

      pos = tagResult.end;
      continue;
    }

    if (tagResult.kind === 'open' && rawTextElements.has(tagResult.tag.toLowerCase())) {
      const closeStart = findRawTextClose(text, tagResult.end, tagResult.tag);
      const closeIdx = closeStart >= 0 ? text.indexOf('>', closeStart) : -1;
      pos = closeIdx >= 0 ? closeIdx + 1 : text.length;
      continue;
    }

    if (tagResult.kind === 'open' && sameTag(tagResult.tag, tag)) {
      depth += 1;
    }

    pos = tagResult.end;
  }

  return null;
}

/**
 * Raw text ends at the first `</tag`, whatever it appears to sit inside.
 *
 * A browser's tokenizer does not parse the script or style body looking for string literals -
 * that is exactly why `"<\\/script>"` has to be escaped in JS. Tracking quotes here instead would
 * let an apostrophe in a comment hide the closing tag.
 */
export function findRawTextClose(text: string, position: number, tag: string): number {
  const needle = `</${tag.toLowerCase()}`;
  /* The name has to end there: HTML's script-data end-tag state needs whitespace, `/` or `>`
   * after it, so `"</scriptx>"` inside a script body does not close the element. */

  /* Scanning case-insensitively rather than lowercasing the whole template: this runs once per
   * raw-text element and again inside every close-tag scan, so a copy of the file each time
   * turns a page of `<script>`s into quadratic work. */
  for (let index = text.indexOf('<', position); index !== -1; index = text.indexOf('<', index + 1)) {
    if (text.slice(index, index + needle.length).toLowerCase() === needle && tagNameTerminator.test(text[index + needle.length] ?? '>')) {
      return index;
    }
  }

  return -1;
}

export function consumeDynamicElement(text: string, position: number): number | null {
  if (!isDynamicTagStart(text, position)) {
    return null;
  }

  const dynamicOpen = `<${openDelimiter}`;
  const dynamicClose = `</${openDelimiter}`;

  if (text.startsWith(dynamicClose, position)) {
    return consumeTagLikeChunk(text, position);
  }

  const openEnd = consumeTagLikeChunk(text, position);
  let depth = 0;
  let pos = openEnd;

  while (pos < text.length) {
    const nextOpen = text.indexOf(dynamicOpen, pos);
    const nextClose = text.indexOf(dynamicClose, pos);
    const candidates = [nextOpen, nextClose].filter((value) => value !== -1);
    const next = candidates.length > 0 ? Math.min(...candidates) : -1;

    if (next === -1) {
      return openEnd;
    }

    if (next === nextClose) {
      if (depth === 0) {
        return consumeTagLikeChunk(text, nextClose);
      }

      depth -= 1;
      pos = consumeTagLikeChunk(text, nextClose);
      continue;
    }

    depth += 1;
    pos = consumeTagLikeChunk(text, nextOpen);
  }

  return openEnd;
}
