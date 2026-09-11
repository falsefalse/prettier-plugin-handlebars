import {
  AttributeValue,
  AttributeValuePart,
  Program,
  Node,
  ElementAttribute,
  MustacheStatement,
  BlockStatement,
  ElseBranch,
  PartialStatement,
  DecoratorStatement,
  CommentStatement,
  ParseEndReason,
  UnmatchedNode,
} from './types';
import { voidElements, rawTextElements } from 'template-format-core';
import { locEnd, locStart, normalizeInput, withOptionalRange, withRange } from 'template-format-core';
import { parseCall } from './expression';
import { scanPastQuotes } from './scan';
import { TemplateSyntaxError } from './errors';
import type { HandlebarsToken as MustacheToken } from './dialects/handlebars/tokens';
import * as whitespace from './whitespace';
import {
  handlebarsDialect,
  handlebarsRawBlockCloser,
  handlebarsRawBlockName,
  isHandlebarsBlockComment,
} from './dialects/handlebars/tokens';

export { locEnd, locStart };

/* Built from the shared class so the character list stays written in one place. */
const leadingWhitespace = new RegExp(`^${whitespace.htmlRun.source}`, 'u');

/* HTML's lexical classes, composed from the whitespace list rather than repeating it - both
 * embed it, and a second hand-written copy is what `whitespace.ts` exists to prevent. They
 * live here because the tokenizer below is the only thing that reads them. */

/** What an attribute name is made of: anything but whitespace and the characters that end one. */
const attributeNameCharacter = new RegExp(`[^${whitespace.htmlCharacters}"'<>/=]`, 'u');

/** What ends a tag name. HTML's tag-name state leaves on whitespace, `/` or `>`, and nothing else. */
const tagNameTerminator = new RegExp(`[${whitespace.htmlCharacters}/>]`, 'u');

interface ParseResult {
  nodes: Node[];
  position: number;
  endReason: ParseEndReason;
  endToken?: MustacheToken;
  /** Where the terminator starts, i.e. where the children's content span ends. */
  contentEnd?: number;
  /** How the author spelled the closing tag, which need not match the opening one's case. */
  closeTag?: string;
}

/* Destructured rather than wrapped: seven of these had a one-line function around them whose
 * only job was to give the dialect member a local name. */
const {
  openDelimiter,
  isEscapedOpen,
  parseToken: parseMustacheToken,
  findNextOpen: findNextHandlebarsOpen,
  isDynamicElementStart: isDynamicTagStart,
  consumeRawBlock,
  getBlockExpression,
  getBlockPrefix,
  shouldPreserveTokenVerbatim: shouldPreserveMustacheVerbatim,
} = handlebarsDialect;

export function parse(text: string): Program {
  const normalizedText = normalizeInput(text);

  try {
    const { nodes } = parseChildren(normalizedText, 0, null, null);
    return withRange({ type: 'Program', body: nodes }, 0, normalizedText.length);
  } catch (error) {
    /* Offsets become line and column here, where the whole text is still in hand. */
    throw error instanceof TemplateSyntaxError ? error.locate(normalizedText) : error;
  }
}

/**
 * Every malformed construct ends here. A formatter that guesses at a missing delimiter prints
 * markup the author did not write; one that passes a mismatched tag through leaves the rest of
 * the file unformatted with nothing to show for it. Refusing is the only honest option, and the
 * offsets let an editor put the cursor on the offending place.
 */
function fail(message: string, start: number, end: number): never {
  throw new TemplateSyntaxError(message, start, end);
}

/* The dialect reports an unterminated token as one that ends at EOF, which is also what a token
 * ending the file looks like; the closing delimiter is what tells them apart. */
/* Where a raw block at `position` ends, or null if there is not one there. A body Handlebars
 * emits literally is copied through wherever it appears; one that never closes is rejected
 * wherever it appears too. */
function consumeTerminatedRawBlock(text: string, position: number, rangeOffset: number): number | null {
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

function startsTemplateTag(text: string, position: number): boolean {
  return text.startsWith(openDelimiter, position) && !isEscapedOpen(text, position);
}

function parseChildren(
  text: string,
  position: number,
  endTag: string | null,
  endBlock: string | null,
  rangeOffset = 0,
): ParseResult {
  const nodes: Node[] = [];
  let pos = position;

  if (endTag && rawTextElements.has(endTag.toLowerCase())) {
    const closeStart = findRawTextClose(text, pos, endTag);
    const contentEnd = closeStart >= 0 ? closeStart : text.length;
    const rawContent = text.slice(pos, contentEnd);

    if (rawContent.length > 0) {
      nodes.push(
        withRange(
          {
            type: 'TextNode',
            chars: rawContent,
            verbatim: true,
          },
          rangeOffset + pos,
          rangeOffset + contentEnd,
        ),
      );
    }

    const closeIdx = closeStart >= 0 ? text.indexOf('>', closeStart) : -1;
    if (closeStart >= 0 && closeIdx < 0) {
      fail("unterminated tag: expected '>'", rangeOffset + closeStart, rangeOffset + text.length);
    }

    const nextPos = closeIdx >= 0 ? closeIdx + 1 : contentEnd;
    const closeTag = closeStart >= 0 ? readCloseTagSource(text, closeStart, closeIdx) : undefined;

    return { nodes, position: nextPos, endReason: closeStart >= 0 ? 'tagClose' : null, contentEnd, closeTag };
  }

  /* The current block's terminator does not move while this call runs, and every position the
   * loop reaches is at depth 0 inside it, so it is hoisted: recomputing it per open tag is
   * quadratic in the number of mustaches in the block's body. */
  const blockBoundary = endBlock ? findCurrentBlockBoundary(text, pos, endBlock) : -1;

  while (pos < text.length) {
    const rawBlockEnd = consumeTerminatedRawBlock(text, pos, rangeOffset);
    if (rawBlockEnd !== null) {
      nodes.push(createUnmatchedNode(text, pos, rawBlockEnd, rangeOffset));
      pos = rawBlockEnd;
      continue;
    }

    const dynamicElementEnd = consumeDynamicElement(text, pos);
    if (dynamicElementEnd !== null) {
      nodes.push(createUnmatchedNode(text, pos, dynamicElementEnd, rangeOffset));
      pos = dynamicElementEnd;
      continue;
    }

    if (endTag && startsCloseTag(text, pos, endTag)) {
      const contentEnd = pos;
      const closeIdx = text.indexOf('>', pos);
      if (closeIdx < 0) {
        fail("unterminated tag: expected '>'", rangeOffset + pos, rangeOffset + text.length);
      }

      const closeTag = readCloseTagSource(text, pos, closeIdx);
      pos = closeIdx + 1;
      return { nodes, position: pos, endReason: 'tagClose', contentEnd, closeTag };
    }

    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);

      if (!token.terminated) {
        const [open, close] = isHandlebarsBlockComment(text, pos)
          ? ['{{!--', '--}}']
          : token.triple
            ? ['{{{', '}}}']
            : [text.startsWith('{{!', pos) ? '{{!' : '{{', '}}'];
        fail(`unterminated ${open}: expected ${close}`, rangeOffset + pos, rangeOffset + token.end);
      }

      if (shouldPreserveMustacheVerbatim(token) && !(endBlock && token.kind === 'else')) {
        nodes.push(createUnmatchedNode(text, pos, token.end, rangeOffset));
        pos = token.end;
        continue;
      }

      if (token.kind === 'comment') {
        const ignoreDirective = getPrettierIgnoreDirective(commentBody(token));

        if (ignoreDirective === 'start') {
          const ignoreStart = pos;
          const ignoreEnd = findPrettierIgnoreEnd(text, token.end);

          if (ignoreEnd === null) {
            fail(
              'unterminated prettier-ignore region: expected {{! prettier-ignore-end }}',
              rangeOffset + ignoreStart,
              rangeOffset + token.end,
            );
          }

          nodes.push(createUnmatchedNode(text, ignoreStart, ignoreEnd, rangeOffset));
          pos = ignoreEnd;
          continue;
        }

        if (ignoreDirective === 'next') {
          const ignoredEnd = consumeNextNode(text, token.end);

          /* Nothing follows to ignore, so the directive is only a comment. */
          if (ignoredEnd <= token.end) {
            nodes.push(createComment(token, rangeOffset + pos, rangeOffset + token.end));
            pos = token.end;
            continue;
          }

          nodes.push(createUnmatchedNode(text, pos, ignoredEnd, rangeOffset));
          pos = ignoredEnd;
          continue;
        }
      }

      if (endBlock && token.kind === 'blockEnd' && token.name === endBlock) {
        return { nodes, position: token.end, endReason: 'blockEnd', endToken: token };
      }

      if (endBlock && token.kind === 'else') {
        return { nodes, position: token.end, endReason: 'else', endToken: token };
      }

      if (token.kind === 'blockStart') {
        if (!hasMatchingBlockEnd(text, token)) {
          fail(`unclosed block: expected {{/${token.name ?? ''}}}`, rangeOffset + pos, rangeOffset + token.end);
        }

        const { node, next, closed } = parseBlock(text, token, rangeOffset);
        if (!closed) {
          fail(`unclosed block: expected {{/${token.name ?? ''}}}`, rangeOffset + pos, rangeOffset + token.end);
        }

        nodes.push(node);
        pos = next;
        continue;
      }

      if (token.kind === 'blockEnd') {
        fail(
          endBlock
            ? `unexpected {{/${token.name ?? ''}}}: expected {{/${endBlock}}}`
            : `unexpected {{/${token.name ?? ''}}}: no block is open`,
          rangeOffset + pos,
          rangeOffset + token.end,
        );
      }

      /* Blocks and terminators are handled above, so the only kind left that `createStatement`
       * declines is a stray `{{else}}` with nothing open - kept as a mustache. */
      nodes.push(createStatement(text, token, pos, rangeOffset) ?? createMustache(text, token, pos, rangeOffset));
      pos = token.end;
      continue;
    }

    if (text[pos] === '<') {
      if (text.startsWith('<!', pos) && !text.startsWith('<!--', pos)) {
        const closeIdx = text.indexOf('>', pos + 2);
        /* Unterminated, so the declaration runs to the end of the input - but its trailing
         * whitespace is still the author's. Folding that into the verbatim run makes the
         * printer's own final newline additive, and the file grows a line on every format. */
        const end = closeIdx >= 0 ? closeIdx + 1 : trimTrailingWhitespace(text, pos);
        nodes.push(
          withRange(
            { type: 'TextNode', chars: text.slice(pos, end), verbatim: true },
            rangeOffset + pos,
            rangeOffset + end,
          ),
        );
        pos = end;
        continue;
      }

      if (!isTagStart(text, pos)) {
        const nextMarkup = findNextMarkup(text, pos + 1);
        nodes.push(
          withRange(
            { type: 'TextNode', chars: text.slice(pos, nextMarkup) },
            rangeOffset + pos,
            rangeOffset + nextMarkup,
          ),
        );
        pos = nextMarkup;
        continue;
      }

      if (text.startsWith('<!--', pos)) {
        const closeIdx = text.indexOf('-->', pos + 4);
        if (closeIdx < 0) {
          fail("unterminated HTML comment: expected '-->'", rangeOffset + pos, rangeOffset + text.length);
        }

        const end = closeIdx + 3;

        nodes.push(
          withRange(
            { type: 'TextNode', chars: text.slice(pos, end), verbatim: true },
            rangeOffset + pos,
            rangeOffset + end,
          ),
        );
        pos = end;
        continue;
      }

      const tagResult = parseTag(text, pos, rangeOffset);

      if (!tagResult.terminated) {
        fail("unterminated tag: expected '>'", rangeOffset + pos, rangeOffset + tagResult.end);
      }

      if (tagResult.kind === 'close') {
        if (endTag && sameTag(tagResult.tag, endTag)) {
          const contentEnd = pos;
          pos = tagResult.end;
          return { nodes, position: pos, endReason: 'tagClose', contentEnd, closeTag: tagResult.source };
        }

        fail(
          endTag
            ? `unexpected </${tagResult.tag}>: expected </${endTag}>`
            : `unexpected </${tagResult.tag}>: no tag is open`,
          rangeOffset + pos,
          rangeOffset + tagResult.end,
        );
      }

      if (tagResult.kind === 'selfClosing') {
        const invalidVoidCloseEnd = consumeInvalidVoidElementClose(text, tagResult.end, tagResult.tag);
        if (invalidVoidCloseEnd !== null) {
          fail(
            `<${tagResult.tag}> is a void element and cannot be closed`,
            rangeOffset + tagResult.end,
            rangeOffset + invalidVoidCloseEnd,
          );
        }

        nodes.push(
          withRange(
            {
              type: 'ElementNode',
              tag: tagResult.tag,
              attributes: tagResult.attributes,
              children: [],
              selfClosing: true,
              attributesRange: tagResult.attributesRange,
            },
            rangeOffset + pos,
            rangeOffset + tagResult.end,
          ),
        );
        pos = tagResult.end;
        continue;
      }

      if (findMatchingTagClose(text, tagResult.tag, tagResult.end, blockBoundary) === null) {
        fail(`unclosed tag: expected </${tagResult.tag}>`, rangeOffset + pos, rangeOffset + tagResult.end);
      }

      const {
        nodes: children,
        position: newPos,
        endReason: childEndReason,
        contentEnd,
        closeTag,
      } = parseChildren(text, tagResult.end, tagResult.tag, null, rangeOffset);
      if (childEndReason !== 'tagClose') {
        fail(`unclosed tag: expected </${tagResult.tag}>`, rangeOffset + pos, rangeOffset + tagResult.end);
      }

      nodes.push(
        withRange(
          {
            type: 'ElementNode',
            tag: tagResult.tag,
            attributes: tagResult.attributes,
            children,
            selfClosing: false,
            ...(closeTag && closeTag !== tagResult.tag ? { closeTag } : {}),
            attributesRange: tagResult.attributesRange,
            contentRange: [rangeOffset + tagResult.end, rangeOffset + (contentEnd ?? newPos)],
          },
          rangeOffset + pos,
          rangeOffset + newPos,
        ),
      );
      pos = newPos;
      continue;
    }

    /* Text node until the next markup. The run is kept verbatim, whitespace-only runs
     * included: what renders is the printer's to decide, not the parser's to discard. */
    const nextMarkup = findNextMarkup(text, pos);
    if (nextMarkup > pos) {
      nodes.push(
        withRange({ type: 'TextNode', chars: text.slice(pos, nextMarkup) }, rangeOffset + pos, rangeOffset + nextMarkup),
      );
    }
    pos = nextMarkup;
  }

  return { nodes, position: pos, endReason: null };
}

function hasMatchingBlockEnd(text: string, token: MustacheToken): boolean {
  return findMatchingBlockEnd(text, token) !== null;
}

/**
 * The mustaches in `text` from `from` onwards, minus those inside a `{{{{raw}}}}` body:
 * Handlebars does not parse one, so a `{{#if}}` in there opens nothing.
 *
 * Deliberately does *not* skip HTML comments or `<script>`: Handlebars has no idea what HTML is
 * and rejects `{{#if a}}<!-- {{#if b}} -->{{/if}}`, so these scans must see that `{{#if b}}`.
 */
function* mustachesFrom(text: string, from: number): Generator<MustacheToken> {
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
function findMatchingBlockEnd(text: string, token: MustacheToken): number | null {
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

function parseBlock(
  text: string,
  token: MustacheToken,
  rangeOffset = 0,
): { node: BlockStatement; next: number; closed: boolean } {
  const blockExpression = getBlockExpression(token);
  const openInfo = parseCall(
    blockExpression,
    rangeOffset + contentOffset(text, token.start, token.end, blockExpression),
  );
  const blockPrefix = getBlockPrefix(token);
  const { nodes: program, position: afterProgram, endReason, endToken } = parseChildren(
    text,
    token.end,
    null,
    openInfo.path.source,
    rangeOffset,
  );
  const buildProgram = (nodes: Node[], start: number, end: number): Program =>
    withRange({ type: 'Program', body: nodes }, rangeOffset + start, rangeOffset + end);
  /* A program ends where its terminator begins, not after it, so the body tiles the range. */
  const programBody = buildProgram(program, token.end, endToken?.start ?? afterProgram);

  /* Set only when the author wrote a bare `{{else}}`; otherwise the empty inverse is built at
   * the end, once the closer's position is known. Anchoring it at `afterProgram` up here put it
   * inside the else-if chain - a point belonging to a different section of the block. */
  let inverseBody: Program | undefined;
  const inverseChain: ElseBranch[] = [];
  let finalPos = afterProgram;
  let closeToken = endReason === 'blockEnd' ? endToken : undefined;
  let inverseTrimOpen = false;
  let inverseTrimClose = false;

  if (endReason === 'else' && endToken) {
    let currentElseToken: MustacheToken | undefined = endToken;
    let currentPosition = afterProgram;

    while (currentElseToken?.specialForm === 'elseIf') {
      const branchExpressionText = currentElseToken.content.replace(/^else\s+/, '');
      const branchExpression = parseCall(
        branchExpressionText,
        rangeOffset + contentOffset(text, currentElseToken.start, currentElseToken.end, branchExpressionText),
      );
      const {
        nodes: branchNodes,
        position: afterBranch,
        endReason: branchEndReason,
        endToken: branchEndToken,
      } = parseChildren(text, currentPosition, null, openInfo.path.source, rangeOffset);

      inverseChain.push(
        withRange(
          {
            type: 'ElseBranch',
            program: buildProgram(branchNodes, currentElseToken.end, branchEndToken?.start ?? afterBranch),
            trimOpen: currentElseToken.trimOpen,
            trimClose: currentElseToken.trimClose,
            ...branchExpression,
          },
          rangeOffset + currentElseToken.start,
          rangeOffset + afterBranch,
        ),
      );

      finalPos = afterBranch;
      closeToken = branchEndReason === 'blockEnd' ? branchEndToken : undefined;

      if (branchEndReason === 'else' && branchEndToken) {
        currentElseToken = branchEndToken;
        currentPosition = afterBranch;
        continue;
      }

      currentElseToken = undefined;
    }

    if (currentElseToken) {
      inverseTrimOpen = currentElseToken.trimOpen;
      inverseTrimClose = currentElseToken.trimClose;
      const {
        nodes: inverseNodes,
        position: afterInverse,
        endReason: inverseEndReason,
        endToken: inverseEndToken,
      } = parseChildren(text, currentPosition, null, openInfo.path.source, rangeOffset);
      inverseBody = buildProgram(inverseNodes, currentElseToken.end, inverseEndToken?.start ?? afterInverse);
      finalPos = afterInverse;
      closeToken = inverseEndReason === 'blockEnd' ? inverseEndToken : undefined;
    }
  }

  const closerAnchor = closeToken?.start ?? finalPos;

  const node: BlockStatement = withRange(
    {
      type: 'BlockStatement',
      program: programBody,
      ...(inverseChain.length > 0 ? { inverseChain } : {}),
      /* An empty inverse sits where the block's closer starts: after every branch, before
       * `{{/if}}`. It is a zero-width point, so it has to be a position the block actually
       * owns. */
      inverse: inverseBody ?? buildProgram([], closerAnchor, closerAnchor),
      ...(inverseTrimOpen ? { inverseTrimOpen } : {}),
      ...(inverseTrimClose ? { inverseTrimClose } : {}),
      blockPrefix,
      trimOpen: token.trimOpen,
      trimClose: token.trimClose,
      closeTrimOpen: closeToken?.trimOpen,
      closeTrimClose: closeToken?.trimClose,
      ...openInfo,
    },
    rangeOffset + token.start,
    rangeOffset + finalPos,
  );

  return { node, next: finalPos, closed: Boolean(closeToken) };
}

type PrettierIgnoreDirective = 'next' | 'start' | 'end' | null;

/**
 * The directive has to *be* the comment, not appear somewhere inside it: on `includes`, a
 * comment merely mentioning `prettier-ignore` would silently suppress the next node, and one
 * mentioning `prettier-ignore-start` would open a region.
 */
function getPrettierIgnoreDirective(rawContent: string): PrettierIgnoreDirective {
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

function findPrettierIgnoreEnd(text: string, position: number): number | null {
  for (const token of mustachesFrom(text, position)) {
    /* Kind first: `commentBody` and the directive lookup are wasted on every mustache, block and
     * partial the scan walks past on the way. */
    if (token.kind === 'comment' && getPrettierIgnoreDirective(commentBody(token)) === 'end') {
      return token.end;
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
function consumeNextNode(text: string, position: number): number {
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

function createUnmatchedNode(text: string, start: number, end: number, rangeOffset: number): UnmatchedNode {
  return withRange(
    { type: 'UnmatchedNode', raw: text.slice(start, end) },
    rangeOffset + start,
    rangeOffset + end,
  );
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
function scanTag(
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

    return selfClosed || voidElements.has(tag.toLowerCase()) ? 'selfClosing' : 'open';
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

type ParsedTag =
  | { kind: 'open'; tag: string; attributes: ElementAttribute[]; attributesRange: [number, number]; end: number; terminated: boolean }
  | { kind: 'selfClosing'; tag: string; attributes: ElementAttribute[]; attributesRange: [number, number]; end: number; terminated: boolean }
  | { kind: 'close'; tag: string; source: string; end: number; terminated: boolean };

function parseTag(text: string, position: number, rangeOffset = 0): ParsedTag {
  let pos = position + 1; // skip '<'

  if (text[pos] === '/') {
    pos += 1;
    const { value: tag, next } = readName(text, pos);
    const closeIdx = text.indexOf('>', next);
    return {
      kind: 'close',
      tag,
      source: readCloseTagSource(text, position, closeIdx),
      end: closeIdx >= 0 ? closeIdx + 1 : text.length,
      terminated: closeIdx >= 0,
    };
  }

  const { value: tag, next } = readName(text, pos);
  pos = next;
  const attributes: ElementAttribute[] = [];
  const headStart = pos;
  const span = (headEnd: number): [number, number] => [rangeOffset + headStart, rangeOffset + headEnd];
  let glued = false;
  let attrStart = pos;

  /* `glued` is whether the author left a space before this attribute. That includes the first
   * one: running into the tag name is what makes `<h{{level}}>` a heading rather than an `<h>`
   * with an attribute. The span is what lets `findTilingViolations` see that an attribute
   * accounts for all of the source it was read from. */
  const add = (attribute: ElementAttribute, end: number) => {
    const marked = glued ? { ...attribute, glued: true } : attribute;
    attributes.push(withRange(marked, rangeOffset + attrStart, rangeOffset + end));
  };

  while (pos < text.length) {
    pos = skipWhitespace(text, pos);

    /* Trailing whitespace can run out the input. Falling through would ask `parseAttribute` to
     * read past the end and report `unexpected undefined`, when the tag is simply unterminated. */
    if (pos >= text.length) {
      break;
    }

    /* Look at the character before the attribute rather than at whether whitespace was skipped
     * here: some of the attribute readers consume their own trailing space. */
    glued = pos > 0 && !whitespace.html.test(text[pos - 1]);
    attrStart = pos;

    const dynamicAttribute = parseDynamicAttribute(text, pos);
    if (dynamicAttribute) {
      add(dynamicAttribute.attribute, dynamicAttribute.position);
      pos = dynamicAttribute.position;
      continue;
    }

    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);

      const statement = createStatement(text, token, pos, rangeOffset);
      if (statement) {
        add({ type: 'AttributeBlock', block: statement }, token.end);
        pos = token.end;
        continue;
      }

      if (token.kind === 'blockStart' && hasMatchingBlockEnd(text, token)) {
        const { node, next } = parseBlock(text, token, rangeOffset);
        add({ type: 'AttributeBlock', block: node }, next);
        pos = next;
        continue;
      }

      /* A block that never closes, or a stray `{{else}}` / `{{/if}}`. Being unbalanced is not
       * itself grounds to reject here - the tag's own extent is already fixed - so they are kept
       * as a mustache. `createMustache` still parses the call, so what is *inside* one can be
       * rejected the same as anywhere else. */
      add({ type: 'AttributeBlock', block: createMustache(text, token, pos, rangeOffset) }, token.end);
      pos = token.end;
      continue;
    }

    if (text[pos] === '/' && text[pos + 1] === '>') {
      const headEnd = pos;
      pos += 2;
      return { kind: 'selfClosing', tag, attributes, attributesRange: span(headEnd), end: pos, terminated: true };
    }
    if (text[pos] === '>') {
      const headEnd = pos;
      pos += 1;
      const kind = voidElements.has(tag.toLowerCase()) ? 'selfClosing' : 'open';
      return { kind, tag, attributes, attributesRange: span(headEnd), end: pos, terminated: true };
    }

    const attr = parseAttribute(text, pos, rangeOffset);

    /* Every remaining character is one an attribute name may start with, so there is nothing
     * left to skip over - and skipping is what quietly deleted the author's markup. */
    if (!attr) {
      fail(`unexpected ${text[pos]} in <${tag}>: expected an attribute name or '>'`, rangeOffset + pos, rangeOffset + pos + 1);
    }

    add(attr.attribute, attr.position);
    pos = attr.position;
  }

  const kind = voidElements.has(tag.toLowerCase()) ? 'selfClosing' : 'open';
  return { kind, tag, attributes, attributesRange: span(pos), end: pos, terminated: false };
}

function consumeInvalidVoidElementClose(text: string, position: number, tag: string): number | null {
  if (!voidElements.has(tag.toLowerCase())) {
    return null;
  }

  const afterGap = skipWhitespace(text, position);
  if (!text.startsWith('</', afterGap)) {
    return null;
  }

  const { value, next } = readName(text, afterGap + 2);
  const end = skipWhitespace(text, next);

  return sameTag(value, tag) && text[end] === '>' ? end + 1 : null;
}

/* HTML tag names are case-insensitive, so `<DIV>x</div>` is one element. Comparing them
 * verbatim rejected it as unclosed, while the `voidElements` and `rawTextElements` lookups two
 * lines away had been lowercasing all along. */
function sameTag(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

/**
 * Whether a close tag for exactly `tag` starts here.
 *
 * The name has to end where `tag` does. On a prefix comparison `</bdi>` would close a `<b>`,
 * deleting `di` from the source and pointing any error at the next, well-formed close tag.
 */
function startsCloseTag(text: string, position: number, tag: string): boolean {
  if (!text.startsWith('</', position)) {
    return false;
  }

  const { value: name, next } = readName(text, position + 2);

  return sameTag(name, tag) && (next >= text.length || tagNameTerminator.test(text[next]));
}

/* Everything between `</` and `>`. HTML keeps only the name and throws the rest away, but it is
 * still the author's source: `</h{{level}}>` has to come back out spelled that way. Whitespace
 * runs collapse so a close tag can never put a raw newline into a doc. */
function readCloseTagSource(text: string, position: number, closeIdx: number): string {
  return text
    .slice(position + 2, closeIdx >= 0 ? closeIdx : text.length)
    .trim()
    .replace(whitespace.htmlRunGlobal, ' ');
}

/* One past the last non-whitespace character, leaving the author's trailing whitespace to the
 * caller instead of burying it inside a node that prints verbatim. */
function trimTrailingWhitespace(text: string, from: number): number {
  let end = text.length;

  while (end > from && whitespace.html.test(text[end - 1])) {
    end -= 1;
  }

  return end;
}

function isTagStart(text: string, position: number): boolean {
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
function readUnquotedValueEnd(text: string, position: number): number {
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

function parseAttribute(
  text: string,
  position: number,
  rangeOffset = 0,
): { attribute: ElementAttribute; position: number } | null {
  let pos = position;
  pos = skipWhitespace(text, pos);
  const { value: name, next } = readAttributeName(text, pos);
  pos = next;

  if (!name) {
    return null;
  }

  pos = skipWhitespace(text, pos);

  // a boolean attribute: no "="
  if (text[pos] !== '=') {
    return { attribute: createAttribute(name, null), position: pos };
  }

  pos += 1;
  pos = skipWhitespace(text, pos);

  let rawValue = '';
  let valueStart = pos;
  if (text[pos] === '"' || text[pos] === "'") {
    const quote = text[pos];
    pos += 1;
    valueStart = pos;
    const quoted = readQuotedAttributeValue(text, pos, quote);
    rawValue = quoted.value;
    pos = quoted.position;
  } else {
    const start = pos;
    valueStart = start;
    pos = readUnquotedValueEnd(text, pos);
    rawValue = text.slice(start, pos);
  }

  /* A value holding both quote characters cannot be printed: whichever one the printer wraps it
   * in ends the attribute early: `title=a"b'c` would print as `title='a"b'c'`, which HTML reads
   * as two attributes. The reader skips over mustaches to find the closing quote, so it accepts
   * values like `class="{{t 'a' "b"}}"` that a browser would cut short. */
  if (rawValue.includes('"') && rawValue.includes("'")) {
    fail('attribute value cannot contain both quote characters', rangeOffset + valueStart, rangeOffset + pos);
  }


  return { attribute: createAttribute(name, rawValue, rangeOffset + valueStart), position: pos };
}


function parseDynamicAttribute(
  text: string,
  position: number,
): { attribute: ElementAttribute; position: number } | null {
  let pos = position;
  pos = skipWhitespace(text, pos);

  const start = pos;
  let hasDynamicPart = false;
  let hasStaticPart = false;

  while (pos < text.length) {
    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);

      /* A block in the middle of a name is part of the name, so it is consumed whole rather
       * than refused. Unbalanced it is not a name at all, and the caller's error is better
       * than a guess at where it ends. */
      if (token.kind === 'blockStart') {
        const blockEnd = findMatchingBlockEnd(text, token);

        if (blockEnd === null) {
          return null;
        }

        hasDynamicPart = true;
        pos = blockEnd;
        continue;
      }

      if (token.kind !== 'mustache') {
        return null;
      }

      hasDynamicPart = true;
      pos = token.end;
      continue;
    }

    if (attributeNameCharacter.test(text[pos])) {
      hasStaticPart = true;
      pos += 1;
      continue;
    }

    break;
  }

  if (!hasDynamicPart) {
    return null;
  }

  const nameEnd = pos;
  const afterName = skipWhitespace(text, pos);

  if (text[afterName] !== '=') {
    /* A static part is what makes this a name with a mustache in it rather than a mustache
     * standing alone. Without one the caller's model is the better fit - `{{attrs}}` is an
     * `AttributeMustache` and `{{#if a}}class="x"{{/if}}` an `AttributeBlock` wrapping whole
     * attributes, whose body is worth formatting - so hand it back. */
    if (!hasStaticPart) {
      return null;
    }

    return {
      attribute: createRawAttribute(text.slice(start, nameEnd)),
      position: nameEnd,
    };
  }

  /* A value overrides that: it attaches to the composite name, and once the name is split
   * there is nothing left to attach it to. */
  pos = skipWhitespace(text, afterName + 1);

  if (text[pos] === '"' || text[pos] === "'") {
    const quote = text[pos];
    pos += 1;
    pos = readQuotedAttributeValue(text, pos, quote).position;
  } else {
    pos = readUnquotedValueEnd(text, pos);
  }

  return {
    attribute: createRawAttribute(text.slice(start, pos)),
    position: pos,
  };
}

function createAttribute(name: string, rawValue: string | null, valueStart?: number): ElementAttribute {
  if (rawValue == null) {
    return {
      type: 'Attribute',
      name,
      value: null,
    };
  }

  const value: AttributeValue = {
    type: 'AttributeValue',
    parts: parseAttributeValueParts(rawValue, valueStart ?? 0),
    raw: rawValue,
  };

  return {
    type: 'Attribute',
    name,
    value: withOptionalRange(
      value,
      valueStart,
      typeof valueStart === 'number' ? valueStart + rawValue.length : undefined,
    ),
  };
}

function createRawAttribute(raw: string): ElementAttribute {
  return {
    type: 'RawAttribute',
    raw,
  };
}

function parseAttributeValueParts(
  value: string,
  rangeOffset = 0,
): AttributeValuePart[] {
  const parts: AttributeValuePart[] = [];
  let pos = 0;

  while (pos < value.length) {
    /* A raw block's body is emitted literally by Handlebars, so it is copied through here for
     * the same reason it is between siblings: reformatting the `{{ x }}` inside one changes
     * what the value renders. Only the sibling list guarded this. */
    const rawBlockEnd = consumeTerminatedRawBlock(value, pos, rangeOffset);
    if (rawBlockEnd !== null) {
      parts.push(
        withRange({ type: 'TextNode', chars: value.slice(pos, rawBlockEnd) }, rangeOffset + pos, rangeOffset + rawBlockEnd),
      );
      pos = rawBlockEnd;
      continue;
    }

    if (startsTemplateTag(value, pos)) {
      const token = parseMustacheToken(value, pos);

      const statement = createStatement(value, token, pos, rangeOffset);
      if (statement) {
        parts.push(statement);
        pos = token.end;
        continue;
      }

      if (token.kind === 'blockStart' && hasMatchingBlockEnd(value, token)) {
        const { node, next } = parseBlock(value, token, rangeOffset);
        parts.push(node);
        pos = next;
        continue;
      }

      /* A value is a string, so the recovery here keeps the source as text rather than as a
       * node - unlike attribute position, where an unreadable token stays a mustache. */
      parts.push(
        withRange(
          { type: 'TextNode', chars: value.slice(pos, token.end) },
          rangeOffset + pos,
          rangeOffset + token.end,
        ),
      );
      pos = token.end;
      continue;
    }

    const next = findNextHandlebarsOpen(value, pos);
    const end = next === -1 ? value.length : next;
    const rawText = value.slice(pos, end);

    if (rawText.length > 0) {
      parts.push(withRange({ type: 'TextNode', chars: rawText }, rangeOffset + pos, rangeOffset + end));
    }

    pos = end;
  }

  preserveValueWhitespace(parts);

  return parts;
}

/**
 * An attribute value is a string, so every space in it renders - including the spaces inside a
 * block's body. Without this the printer lays that body out at its own indent level, which is
 * unrelated to the column the value sits at, and rewrites whitespace the author owns.
 */
function preserveValueWhitespace(nodes: Node[]): void {
  for (const node of nodes) {
    if (node.type === 'TextNode') {
      node.preserveWhitespace = true;
    } else if (node.type === 'BlockStatement') {
      preserveValueWhitespace(node.program.body);
      (node.inverseChain ?? []).forEach((branch) => preserveValueWhitespace(branch.program.body));
      preserveValueWhitespace(node.inverse.body);
    } else if (node.type === 'ElementNode') {
      node.preserveWhitespace = true;
      preserveValueWhitespace(node.children);
    } else if (node.type === 'UnmatchedNode') {
      node.preserveWhitespace = true;
    }
  }
}

function readQuotedAttributeValue(
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
function skipWhitespace(text: string, position: number): number {
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
function readAttributeName(text: string, position: number): { value: string; next: number } {
  let pos = position;
  while (pos < text.length && attributeNameCharacter.test(text[pos]) && !startsTemplateTag(text, pos)) {
    pos += 1;
  }
  return { value: text.slice(position, pos), next: pos };
}

function readName(text: string, position: number): { value: string; next: number } {
  let pos = position;
  while (pos < text.length && /[A-Za-z0-9_:-]/.test(text[pos])) {
    pos += 1;
  }
  return { value: text.slice(position, pos), next: pos };
}

function isSelfClosingSlash(text: string, position: number): boolean {
  return text[position] === '/' && text[position + 1] === '>';
}

function findNextMarkup(text: string, position: number): number {
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

function findCurrentBlockBoundary(text: string, position: number, endBlock: string): number {
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
function skipMustache(text: string, position: number): number {
  const rawBlockEnd = consumeRawBlock(text, position);
  if (rawBlockEnd !== null && rawBlockEnd > position) {
    return rawBlockEnd;
  }

  return Math.max(parseMustacheToken(text, position).end, position + 2);
}

function findMatchingTagClose(text: string, tag: string, position: number, limit = -1): number | null {
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
function findRawTextClose(text: string, position: number, tag: string): number {
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

/** Whether the character before `index`, whitespace aside, is `=`. */
function follows(text: string, index: number, char: string): boolean {
  let at = index - 1;
  while (at >= 0 && whitespace.html.test(text[at])) at -= 1;

  return text[at] === char;
}

function consumeTagLikeChunk(text: string, position: number): number {
  /* Same rule as a real tag head: a quote delimits a value only after `=`. `<{{t}} a=it's>`
   * otherwise runs to EOF and swallows the rest of the file into one verbatim node. */
  const end = scanPastQuotes(text, position + 1, {
    stopsAt: (index) => text[index] === '>',
    opensQuote: (index) => follows(text, index, '='),
  });

  return end === -1 ? text.length : end + 1;
}

function consumeDynamicElement(text: string, position: number): number | null {
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

/** Where `content` begins inside the tag spanning [tagStart, tagEnd), for absolute expression ranges. */
function contentOffset(text: string, tagStart: number, tagEnd: number, content: string): number {
  const at = text.slice(tagStart, tagEnd).indexOf(content);
  return at === -1 ? tagStart : tagStart + at;
}

/* The parts every inline statement shares: its call, and the `~` markers on its delimiters. */
function statementBase(text: string, token: MustacheToken, position: number, rangeOffset: number, content: string) {
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
function createMustache(text: string, token: MustacheToken, position: number, rangeOffset: number): MustacheStatement {
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
function createStatement(
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
function commentBody(token: MustacheToken): string {
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

function createComment(token: MustacheToken, start?: number, end?: number): CommentStatement {
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
