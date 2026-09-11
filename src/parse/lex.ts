/* Character-level readers: where a tag, a name or a value ends. Nothing here builds a node or
 * knows what a block is, so everything above can be read without this file open. */
import { isVoidElement } from '../core/html';
import { scanPastQuotes } from '../core/scan';
import * as whitespace from '../core/whitespace';
import { handlebarsDialect } from '../dialects/handlebars/tokens';
import type { ElementAttribute } from '../types';

export const { openDelimiter, isEscapedOpen, parseToken: parseMustacheToken } = handlebarsDialect;

/* Built from the shared class so the character list stays written in one place. */
export const leadingWhitespace = new RegExp(`^${whitespace.htmlRun.source}`, 'u');

/* HTML's lexical classes, composed from the whitespace list rather than repeating it - both
 * embed it, and a second hand-written copy is what `whitespace.ts` exists to prevent. They
 * live here because the tokenizer below is the only thing that reads them. */

/** What an attribute name is made of: anything but whitespace and the characters that end one. */
export const attributeNameCharacter = new RegExp(`[^${whitespace.htmlCharacters}"'<>/=]`, 'u');

/** What ends a tag name. HTML's tag-name state leaves on whitespace, `/` or `>`, and nothing else. */
export const tagNameTerminator = new RegExp(`[${whitespace.htmlCharacters}/>]`, 'u');

export function startsTemplateTag(text: string, position: number): boolean {
  return text.startsWith(openDelimiter, position) && !isEscapedOpen(text, position);
}

/**
 * Where a tag ends, what it is called and whether it closed - without building a single node and
 * without rejecting anything.
 *
 * Lookahead has to be total: callers scan regions they may go on to skip, including a
 * `{{! prettier-ignore }}` body, so a `parseTag` here let the directive reject the very file it
 * was written to protect. `terminated` is false when the tag ran to EOF, which is also how an
 * unterminated attribute value shows up.
 */
export function scanTag(
  text: string,
  position: number,
): { kind: 'open' | 'selfClosing' | 'close'; tag: string; end: number; terminated: boolean } {
  let pos = position + 1;
  const closing = text[pos] === '/';
  if (closing) {
    pos += 1;
  }

  const { value: tag, next } = readName(text, pos);
  pos = next;

  const kindAt = (selfClosed: boolean): ParsedTag['kind'] => {
    if (closing) {
      return 'close';
    }

    return selfClosed || isVoidElement(tag) ? 'selfClosing' : 'open';
  };

  /* A quote only delimits a value directly after `=`, whitespace aside. Treating every quote as
   * a delimiter would make `title=a"b'c>` swallow the rest of the file hunting a closing `"`. */
  let afterEquals = false;

  while (pos < text.length) {
    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);
      pos = token.end > pos ? token.end : pos + 2;
      continue;
    }

    const char = text[pos];

    if (whitespace.html.test(char)) {
      pos += 1;
      continue;
    }

    if (char === '=') {
      afterEquals = true;
      pos += 1;
      continue;
    }

    if (afterEquals && char !== '>') {
      pos =
        char === '"' || char === "'"
          ? readQuotedAttributeValue(text, pos + 1, char).position
          : readUnquotedValueEnd(text, pos);
      afterEquals = false;
      continue;
    }

    if (isSelfClosingSlash(text, pos)) {
      return { kind: kindAt(true), tag, end: pos + 2, terminated: true };
    }

    if (char === '>') {
      return { kind: kindAt(false), tag, end: pos + 1, terminated: true };
    }

    afterEquals = false;
    pos += 1;
  }

  return { kind: kindAt(false), tag, end: pos, terminated: false };
}

export type ParsedTag =
  | { kind: 'open'; tag: string; attributes: ElementAttribute[]; attributesRange: [number, number]; end: number; terminated: boolean }
  | { kind: 'selfClosing'; tag: string; attributes: ElementAttribute[]; attributesRange: [number, number]; end: number; terminated: boolean }
  | { kind: 'close'; tag: string; source: string; end: number; terminated: boolean };

/* HTML tag names are case-insensitive, so `<DIV>x</div>` is one element. Comparing them
 * verbatim rejected it as unclosed, while the `voidElements` and `rawTextElements` lookups two
 * lines away had been lowercasing all along. */
export function sameTag(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

/**
 * Whether a close tag for exactly `tag` starts here.
 *
 * The name has to end where `tag` does. On a prefix comparison `</bdi>` would close a `<b>`,
 * deleting `di` from the source and pointing any error at the next, well-formed close tag.
 */
export function startsCloseTag(text: string, position: number, tag: string): boolean {
  if (!text.startsWith('</', position)) {
    return false;
  }

  const { value: name, next } = readName(text, position + 2);

  return sameTag(name, tag) && (next >= text.length || tagNameTerminator.test(text[next]));
}

/* Everything between `</` and `>`. HTML keeps only the name and throws the rest away, but it is
 * still the author's source: `</h{{level}}>` has to come back out spelled that way. Whitespace
 * runs collapse so a close tag can never put a raw newline into a doc. */
export function readCloseTagSource(text: string, position: number, closeIdx: number): string {
  return text
    .slice(position + 2, closeIdx >= 0 ? closeIdx : text.length)
    .trim()
    .replace(whitespace.htmlRunGlobal, ' ');
}

/* One past the last non-whitespace character, leaving the author's trailing whitespace to the
 * caller instead of burying it inside a node that prints verbatim. */
export function trimTrailingWhitespace(text: string, from: number): number {
  let end = text.length;

  while (end > from && whitespace.html.test(text[end - 1])) {
    end -= 1;
  }

  return end;
}

export function isTagStart(text: string, position: number): boolean {
  if (text[position] !== '<') {
    return false;
  }

  return /[A-Za-z!/]/u.test(text[position + 1] ?? '');
}

/**
 * Where an unquoted attribute value ends. HTML's unquoted-value state ends at whitespace or `>`
 * and nowhere else, so a `/` is content: breaking on it would drop the trailing slash of
 * `src=/a/b/` and make `<a href=/path/>t</a>` a self-closing `<a>` that rejects its own `</a>`.
 * `scanTag` reads values with this too, so its idea of where a tag ends matches the parser's;
 * were they to disagree, a `{{! prettier-ignore }}` region could stop mid-tag.
 */
export function readUnquotedValueEnd(text: string, position: number): number {
  let pos = position;

  while (pos < text.length && text[pos] !== '>' && !whitespace.html.test(text[pos])) {
    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);
      pos = token.end > pos ? token.end : pos + 2;
      continue;
    }

    pos += 1;
  }

  return pos;
}

export function readQuotedAttributeValue(
  text: string,
  position: number,
  quote: string,
): { value: string; position: number } {
  let pos = position;

  while (pos < text.length) {
    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);
      pos = token.end > pos ? token.end : pos + 2;
      continue;
    }

    if (text[pos] === quote) {
      return { value: text.slice(position, pos), position: pos + 1 };
    }

    pos += 1;
  }

  return { value: text.slice(position), position: text.length };
}

/* One past the whitespace run starting at `position`. Every caller wants an index, and taking
 * one instead of a pair of closures is what let the open-coded copies of this loop go. */
export function skipWhitespace(text: string, position: number): number {
  let pos = position;

  while (pos < text.length && whitespace.html.test(text[pos])) {
    pos += 1;
  }

  return pos;
}

/**
 * HTML's attribute-name state ends at whitespace, `/`, `>` or `=`, and nowhere else.
 *
 * Matching a tag-name charset instead stepped over one character and carried on: `@click` came
 * back as `click` and `(click)="go()"` as two boolean attributes, value gone, silently.
 */

/* Stops at a mustache as well as at the characters HTML ends a name on. `parseDynamicAttribute`
 * has already had its go by the time this runs, so what is left is a block or a partial glued to
 * the name - `<div data-{{#if a}}x{{/if}}>`. Reading `data-{{#if` as the name desynchronised the
 * tag loop, which then reported the `/` of `{{/if}}` as an unexpected character. Left here, the
 * tag loop takes the block as its own glued attribute and the two print back together. */
export function readAttributeName(text: string, position: number): { value: string; next: number } {
  let pos = position;
  while (pos < text.length && attributeNameCharacter.test(text[pos]) && !startsTemplateTag(text, pos)) {
    pos += 1;
  }
  return { value: text.slice(position, pos), next: pos };
}

export function readName(text: string, position: number): { value: string; next: number } {
  let pos = position;
  while (pos < text.length && /[A-Za-z0-9_:-]/.test(text[pos])) {
    pos += 1;
  }
  return { value: text.slice(position, pos), next: pos };
}

function isSelfClosingSlash(text: string, position: number): boolean {
  return text[position] === '/' && text[position + 1] === '>';
}

/** Whether the character before `index`, whitespace aside, is `=`. */
function follows(text: string, index: number, char: string): boolean {
  let at = index - 1;
  while (at >= 0 && whitespace.html.test(text[at])) at -= 1;

  return text[at] === char;
}

export function consumeTagLikeChunk(text: string, position: number): number {
  /* Same rule as a real tag head: a quote delimits a value only after `=`. `<{{t}} a=it's>`
   * otherwise runs to EOF and swallows the rest of the file into one verbatim node. */
  const end = scanPastQuotes(text, position + 1, {
    stopsAt: (index) => text[index] === '>',
    opensQuote: (index) => follows(text, index, '='),
  });

  return end === -1 ? text.length : end + 1;
}
