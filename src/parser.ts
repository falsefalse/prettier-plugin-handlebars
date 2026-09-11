import {
  Program,
  Node,
  ElementAttribute,
  ElementNode,
  TextNode,
  MustacheStatement,
  BlockStatement,
  ElseBranch,
  PartialStatement,
  DecoratorStatement,
  CommentStatement,
  ParseEndReason,
  UnmatchedNode,
} from './types';
import { voidElements, rawTextElements, whitespaceSensitiveRawTextElements } from 'template-format-core';
import { locEnd, locStart, normalizeInput, withOptionalRange, withRange } from 'template-format-core';
import { parseCall } from './expression';
import { TemplateSyntaxError } from './errors';
import type { TemplateToken as MustacheToken } from 'template-format-core';
import { whitespace } from 'template-format-core';
import { handlebarsDialect } from './dialects/handlebars/tokens';

export { locEnd, locStart };

interface ParseResult {
  nodes: Node[];
  position: number;
  endReason: ParseEndReason;
  endToken?: MustacheToken;
  /** Where the terminator starts, i.e. where the children's content span ends. */
  contentEnd?: number;
}

const templateDialect = handlebarsDialect;

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
function isTerminatedToken(text: string, token: MustacheToken): boolean {
  const close = token.triple ? '}}}' : '}}';
  const delimiter = text.startsWith('{{!--', token.start) || text.startsWith('{{{!--', token.start) ? `--${close}` : close;

  return token.end - delimiter.length >= token.start && text.startsWith(delimiter, token.end - delimiter.length);
}

/* Same for raw blocks, except the closer carries the block's own name. */
function isTerminatedRawBlock(text: string, start: number, end: number): boolean {
  const openEnd = text.indexOf('}}}}', start + 4);
  if (openEnd === -1) {
    return false;
  }

  const name = rawBlockName(text, start, openEnd);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

  return new RegExp(`\\{\\{\\{\\{\\s*~?\\s*/\\s*${escaped}\\s*~?\\s*\\}\\}\\}\\}$`, 'u').test(text.slice(start, end));
}

function rawBlockName(text: string, start: number, openEnd: number): string {
  const inner = text.slice(start + 4, openEnd).trim().replace(/^~/u, '').replace(/~$/u, '').trim();

  return inner.split(/\s+/u)[0] ?? '';
}

function startsTemplateTag(text: string, position: number): boolean {
  return text.startsWith(templateDialect.openDelimiter, position) && !templateDialect.isEscapedOpen(text, position);
}

function parseMustacheToken(text: string, position: number): MustacheToken {
  return templateDialect.parseToken(text, position);
}

function findNextHandlebarsOpen(text: string, position: number): number {
  return templateDialect.findNextOpen(text, position);
}

function isDynamicTagStart(text: string, position: number): boolean {
  return templateDialect.isDynamicElementStart(text, position);
}

function consumeRawBlock(text: string, position: number): number | null {
  return templateDialect.consumeRawBlock(text, position);
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
            preserveWhitespace: whitespaceSensitiveRawTextElements.has(endTag.toLowerCase()),
          } as TextNode,
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

    return { nodes, position: nextPos, endReason: closeStart >= 0 ? 'tagClose' : null, contentEnd };
  }

  while (pos < text.length) {
    const rawBlockEnd = consumeRawBlock(text, pos);
    if (rawBlockEnd !== null) {
      if (!isTerminatedRawBlock(text, pos, rawBlockEnd)) {
        const openEnd = text.indexOf('}}}}', pos + 4);
        const name = openEnd === -1 ? '' : rawBlockName(text, pos, openEnd);
        fail(`unterminated raw block: expected {{{{/${name}}}}}`, rangeOffset + pos, rangeOffset + rawBlockEnd);
      }

      nodes.push(createUnmatchedNode(text, pos, rawBlockEnd));
      pos = rawBlockEnd;
      continue;
    }

    const dynamicElementEnd = consumeDynamicElement(text, pos);
    if (dynamicElementEnd !== null) {
      nodes.push(createUnmatchedNode(text, pos, dynamicElementEnd));
      pos = dynamicElementEnd;
      continue;
    }

    if (endTag && text.startsWith(`</${endTag}`, pos)) {
      const contentEnd = pos;
      const closeIdx = text.indexOf('>', pos);
      if (closeIdx < 0) {
        fail("unterminated tag: expected '>'", rangeOffset + pos, rangeOffset + text.length);
      }

      pos = closeIdx + 1;
      return { nodes, position: pos, endReason: 'tagClose', contentEnd };
    }

    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);

      if (!isTerminatedToken(text, token)) {
        const [open, close] = text.startsWith('{{!--', pos)
          ? ['{{!--', '--}}']
          : token.triple
            ? ['{{{', '}}}']
            : [text.startsWith('{{!', pos) ? '{{!' : '{{', '}}'];
        fail(`unterminated ${open}: expected ${close}`, rangeOffset + pos, rangeOffset + token.end);
      }

      if (shouldPreserveMustacheVerbatim(token) && !(endBlock && token.kind === 'else')) {
        nodes.push(createUnmatchedNode(text, pos, token.end));
        pos = token.end;
        continue;
      }

      if (token.kind === 'comment') {
        const ignoreDirective = getPrettierIgnoreDirective(token.rawContent);

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

          nodes.push(createUnmatchedNode(text, ignoreStart, ignoreEnd));
          pos = ignoreEnd;
          continue;
        }

        if (ignoreDirective === 'next') {
          const ignoredEnd = consumeNextNode(text, token.end);

          /* Nothing follows to ignore, so the directive is only a comment. */
          if (ignoredEnd <= token.end) {
            nodes.push(createComment(token.rawContent, rangeOffset + pos, rangeOffset + token.end));
            pos = token.end;
            continue;
          }

          nodes.push(createUnmatchedNode(text, pos, ignoredEnd));
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
        if (!hasMatchingBlockEnd(text, token, pos)) {
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

      if (token.kind === 'partial') {
        nodes.push(createPartial(token.content, token.trimOpen, token.trimClose, rangeOffset + pos, rangeOffset + token.end, rangeOffset + contentOffset(text, pos, token.end, token.content)));
        pos = token.end;
        continue;
      }

      if (token.specialForm === 'decorator') {
        nodes.push(
          createDecorator(
            token.content.slice(1).trim(),
            token.trimOpen,
            token.trimClose,
            rangeOffset + pos,
            rangeOffset + token.end,
            rangeOffset + contentOffset(text, pos, token.end, token.content.slice(1).trim()),
          ),
        );
        pos = token.end;
        continue;
      }

      if (token.kind === 'comment') {
        nodes.push(createComment(token.rawContent, rangeOffset + pos, rangeOffset + token.end));
        pos = token.end;
        continue;
      }

      nodes.push(
        createMustache(token.content, token.triple, token.trimOpen, token.trimClose, rangeOffset + pos, rangeOffset + token.end, rangeOffset + contentOffset(text, pos, token.end, token.content)),
      );
      pos = token.end;
      continue;
    }

    if (text[pos] === '<') {
      if (text.startsWith('<!', pos) && !text.startsWith('<!--', pos)) {
        const closeIdx = text.indexOf('>', pos + 2);
        const end = closeIdx >= 0 ? closeIdx + 1 : text.length;
        nodes.push(
          withRange(
            { type: 'TextNode', chars: text.slice(pos, end), verbatim: true } as TextNode,
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
            { type: 'TextNode', chars: text.slice(pos, nextMarkup) } as TextNode,
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
            { type: 'TextNode', chars: text.slice(pos, end), verbatim: true } as TextNode,
            rangeOffset + pos,
            rangeOffset + end,
          ),
        );
        pos = end;
        continue;
      }

      const tagResult = parseTag(text, pos);

      if (!tagResult.terminated) {
        fail("unterminated tag: expected '>'", rangeOffset + pos, rangeOffset + tagResult.end);
      }

      if (tagResult.kind === 'close') {
        if (endTag && tagResult.tag === endTag) {
          const contentEnd = pos;
          pos = tagResult.end;
          return { nodes, position: pos, endReason: 'tagClose', contentEnd };
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
            } as ElementNode,
            rangeOffset + pos,
            rangeOffset + tagResult.end,
          ),
        );
        pos = tagResult.end;
        continue;
      }

      const blockBoundary = endBlock ? findCurrentBlockBoundary(text, tagResult.end, endBlock) : -1;

      if (!hasMatchingTagEnd(text, tagResult.tag, tagResult.end, blockBoundary)) {
        fail(`unclosed tag: expected </${tagResult.tag}>`, rangeOffset + pos, rangeOffset + tagResult.end);
      }

      const {
        nodes: children,
        position: newPos,
        endReason: childEndReason,
        contentEnd,
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
            contentRange: [rangeOffset + tagResult.end, rangeOffset + (contentEnd ?? newPos)],
          } as ElementNode,
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

function hasMatchingBlockEnd(text: string, token: MustacheToken, start: number): boolean {
  return findMatchingBlockEnd(text, token, start) !== null;
}

/** Where the block opened by `token` closes, or null if it never does. */
function findMatchingBlockEnd(text: string, token: MustacheToken, start: number): number | null {
  if (!token.name) {
    return null;
  }

  let depth = 0;
  let pos = start + 1;

  while (pos < text.length) {
    const next = findNextHandlebarsOpen(text, pos);
    if (next === -1) {
      return null;
    }

    const candidate = parseMustacheToken(text, next);

    if (candidate.kind === 'blockStart' && candidate.name === token.name) {
      depth += 1;
    } else if (candidate.kind === 'blockEnd' && candidate.name === token.name) {
      if (depth === 0) {
        return candidate.end;
      }

      depth -= 1;
    }

    pos = candidate.end > next ? candidate.end : next + 2;
  }

  return null;
}

function parseBlock(
  text: string,
  token: MustacheToken,
  rangeOffset = 0,
): { node: BlockStatement; next: number; closed: boolean } {
  const blockExpression = getBlockExpression(token);
  const openInfo = parseExpression(
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

  let inverseBody: Program = withRange(
    { type: 'Program', body: [] },
    rangeOffset + afterProgram,
    rangeOffset + afterProgram,
  );
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
      const branchInfo = parseExpression(
        branchExpressionText,
        rangeOffset + contentOffset(text, currentElseToken.start, currentElseToken.end, branchExpressionText),
      );
      const { type: _branchType, ...branchExpression } = branchInfo;
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

  // Drop the mustache-specific `type` field so we can build a proper BlockStatement
  const { type: _ignored, ...expression } = openInfo;

  const node: BlockStatement = withRange(
    {
      type: 'BlockStatement',
      program: programBody,
      ...(inverseChain.length > 0 ? { inverseChain } : {}),
      inverse: inverseBody,
      ...(inverseTrimOpen ? { inverseTrimOpen } : {}),
      ...(inverseTrimClose ? { inverseTrimClose } : {}),
      blockPrefix,
      trimOpen: token.trimOpen,
      trimClose: token.trimClose,
      closeTrimOpen: closeToken?.trimOpen,
      closeTrimClose: closeToken?.trimClose,
      ...expression,
    },
    rangeOffset + token.start,
    rangeOffset + finalPos,
  );

  return { node, next: finalPos, closed: Boolean(closeToken) };
}

function getBlockExpression(token: MustacheToken): string {
  return templateDialect.getBlockExpression(token);
}

function getBlockPrefix(token: MustacheToken): '#' | '#>' | '#*' | '^' | '<' | '$' {
  return templateDialect.getBlockPrefix(token);
}

function hasMatchingTagEnd(text: string, tag: string, start: number, limit = -1): boolean {
  return findMatchingTagClose(text, tag, start, limit) !== null;
}

type PrettierIgnoreDirective = 'next' | 'start' | 'end' | null;

/**
 * The directive has to *be* the comment, not appear somewhere inside it. Matching on `includes`
 * meant a comment that merely mentioned `prettier-ignore` silently stopped the next node from
 * being formatted - and a mention of `prettier-ignore-start` opened a region.
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
  let pos = position;

  while (pos < text.length) {
    const next = findNextHandlebarsOpen(text, pos);

    if (next === -1) {
      return null;
    }

    const token = parseMustacheToken(text, next);
    const directive = getPrettierIgnoreDirective(token.rawContent);

    if (token.kind === 'comment' && directive === 'end') {
      return token.end;
    }

    pos = token.end > next ? token.end : next + 2;
  }

  return null;
}

/**
 * How far `{{! prettier-ignore }}` reaches: to the end of the one node that follows it, or
 * nowhere if that node's extent cannot be determined.
 *
 * It scans rather than parses. Parsing meant a nested `parseChildren` ran past the enclosing
 * container - handing an element its own `</div>`, or a block its own `{{/if}}` - and meant this
 * could `fail()`, so a directive meant to suppress formatting could reject the file instead.
 * Returning `position` says "nothing to ignore"; the caller then treats the directive as a plain
 * comment and the markup after it is parsed, and reported on, as usual.
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

    return token.kind === 'blockStart' ? findMatchingBlockEnd(text, token, position) ?? position : token.end;
  }

  if (text[position] === '<') {
    const tagResult = parseTag(text, position);

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

function createUnmatchedNode(text: string, start: number, end: number): UnmatchedNode {
  return withRange({ type: 'UnmatchedNode', raw: text.slice(start, end) }, start, end);
}

/**
 * `terminated` is false when the tag ran to EOF without a `>`, which is also how an unterminated
 * attribute value shows up. It is reported rather than thrown because the lookahead scanners call
 * this too, and a throw from a predicate would surface a later problem than the author's.
 */
function parseTag(text: string, position: number):
  | { kind: 'open'; tag: string; attributes: ElementAttribute[]; end: number; terminated: boolean }
  | { kind: 'selfClosing'; tag: string; attributes: ElementAttribute[]; end: number; terminated: boolean }
  | { kind: 'close'; tag: string; end: number; terminated: boolean } {
  let pos = position + 1; // skip '<'

  if (text[pos] === '/') {
    pos += 1;
    const { value: tag, next } = readName(text, pos);
    const closeIdx = text.indexOf('>', next);
    return { kind: 'close', tag, end: closeIdx >= 0 ? closeIdx + 1 : text.length, terminated: closeIdx >= 0 };
  }

  const { value: tag, next } = readName(text, pos);
  pos = next;
  const attributes: ElementAttribute[] = [];
  let glued = false;

  /* Whether the author left a space before this attribute. The first one always needs one, or it
   * would run into the tag name. */
  const add = (attribute: ElementAttribute) => {
    attributes.push(glued && attributes.length > 0 ? { ...attribute, glued: true } : attribute);
  };

  while (pos < text.length) {
    skipWhitespace(text, () => pos++, () => pos);
    /* Look at the character before the attribute rather than at whether whitespace was skipped
     * here: some of the attribute readers consume their own trailing space. */
    glued = pos > 0 && !/\s/u.test(text[pos - 1]);

    const dynamicAttribute = parseDynamicAttribute(text, pos);
    if (dynamicAttribute) {
      add(dynamicAttribute.attribute);
      pos = dynamicAttribute.position;
      continue;
    }

    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);

      // a comment in attribute position
      if (token.kind === 'comment') {
        add({
          type: 'AttributeBlock',
          block: createComment(token.rawContent, pos, token.end),
        });
        pos = token.end;
        continue;
      }

      // a partial in attribute position
      if (token.kind === 'partial') {
        add({
          type: 'AttributeBlock',
          block: createPartial(token.content, token.trimOpen, token.trimClose, pos, token.end, contentOffset(text, pos, token.end, token.content)),
        });
        pos = token.end;
        continue;
      }

      // standalone decorator in the opening tag
      if (token.specialForm === 'decorator') {
        add({
          type: 'AttributeBlock',
          block: createDecorator(
            token.content.slice(1).trim(),
            token.trimOpen,
            token.trimClose,
            pos,
            token.end,
            contentOffset(text, pos, token.end, token.content.slice(1).trim()),
          ),
        });
        pos = token.end;
        continue;
      }

      // a plain {{ mustache }}
      if (token.kind === 'mustache') {
        add({
          type: 'AttributeBlock',
          block: createMustache(token.content, token.triple, token.trimOpen, token.trimClose, pos, token.end, contentOffset(text, pos, token.end, token.content)),
        });
        pos = token.end;
        continue;
      }

      // {{#block}} ... {{/block}} in attribute position
      if (token.kind === 'blockStart') {
        if (!hasMatchingBlockEnd(text, token, pos)) {
          // no close, so keep it as an unmatched fragment
          add({
            type: 'AttributeBlock',
            block: createMustache(token.content, token.triple, token.trimOpen, token.trimClose, pos, token.end, contentOffset(text, pos, token.end, token.content)),
          });
          pos = token.end;
          continue;
        }

        const { node, next } = parseBlock(text, token);
        add({
          type: 'AttributeBlock',
          block: node,
        });
        pos = next;
        continue;
      }

      // else / blockEnd in attribute position: odd, but not worth failing over
      add({
        type: 'AttributeBlock',
        block: createMustache(token.content, token.triple, token.trimOpen, token.trimClose, pos, token.end, contentOffset(text, pos, token.end, token.content)),
      });
      pos = token.end;
      continue;
    }

    if (text[pos] === '/' && text[pos + 1] === '>') {
      pos += 2;
      return { kind: 'selfClosing', tag, attributes, end: pos, terminated: true };
    }
    if (text[pos] === '>') {
      pos += 1;
      const kind = voidElements.has(tag.toLowerCase()) ? 'selfClosing' : 'open';
      return { kind, tag, attributes, end: pos, terminated: true };
    }

    const beforeAttr = pos;
    const attr = parseAttribute(text, pos);

    if (!attr) {
      pos = beforeAttr + 1;
      continue;
    }

    add(attr.attribute);
    pos = attr.position;

    if (pos <= beforeAttr) {
      pos = beforeAttr + 1;
    }
  }

  const kind = voidElements.has(tag.toLowerCase()) ? 'selfClosing' : 'open';
  return { kind, tag, attributes, end: pos, terminated: false };
}

function consumeInvalidVoidElementClose(text: string, position: number, tag: string): number | null {
  if (!voidElements.has(tag.toLowerCase())) {
    return null;
  }

  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.slice(position).match(new RegExp(`^[\\t\\n\\f\\r ]*</\\s*${escapedTag}\\s*>`, 'i'));

  return match ? position + match[0].length : null;
}

function isTagStart(text: string, position: number): boolean {
  if (text[position] !== '<') {
    return false;
  }

  const next = text[position + 1];
  return /[A-Za-z!/]/.test(next ?? '') || next === '/';
}

function parseAttribute(text: string, position: number): { attribute: ElementAttribute; position: number } | null {
  let pos = position;
  skipWhitespace(text, () => pos++, () => pos);
  const attrStart = pos;
  const { value: name, next } = readName(text, pos);
  pos = next;

  if (!name) {
    return null;
  }

  skipWhitespace(text, () => pos++, () => pos);

  // a boolean attribute: no "="
  if (text[pos] !== '=') {
    return { attribute: createAttribute(name, null), position: pos };
  }

  pos += 1;
  skipWhitespace(text, () => pos++, () => pos);

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
    while (pos < text.length && text[pos] !== '>') {
      if (startsTemplateTag(text, pos)) {
        const token = parseMustacheToken(text, pos);
        pos = token.end;
        continue;
      }

      if (isSelfClosingSlash(text, pos)) {
        break;
      }

      if (whitespace.test(text[pos])) {
        break;
      }

      pos += 1;
    }
    rawValue = text.slice(start, pos);

    /* Only an unquoted value can hold both quote characters - a quoted one would have ended at
     * the first matching delimiter - and there is then no quote left to wrap it in. It used to
     * come back as `title='a"b'c'`, which HTML reads as two attributes. */
    if (rawValue.includes('"') && rawValue.includes("'")) {
      fail('unquoted attribute value cannot contain both quote characters', start, pos);
    }
  }


  return { attribute: createAttribute(name, rawValue, valueStart), position: pos };
}


function parseDynamicAttribute(
  text: string,
  position: number,
): { attribute: ElementAttribute; position: number } | null {
  let pos = position;
  skipWhitespace(text, () => pos++, () => pos);

  const start = pos;
  let hasDynamicPart = false;
  let hasStaticPart = false;

  while (pos < text.length) {
    if (startsTemplateTag(text, pos)) {
      const token = parseMustacheToken(text, pos);

      if (token.kind !== 'mustache') {
        return null;
      }

      hasDynamicPart = true;
      pos = token.end;
      continue;
    }

    if (/[A-Za-z0-9_:-]/.test(text[pos])) {
      hasStaticPart = true;
      pos += 1;
      continue;
    }

    break;
  }

  if (!hasDynamicPart || !hasStaticPart) {
    return null;
  }

  const nameEnd = pos;
  let afterName = pos;
  while (afterName < text.length && whitespace.test(text[afterName])) {
    afterName += 1;
  }

  if (text[afterName] !== '=') {
    return {
      attribute: createRawAttribute(text.slice(start, nameEnd)),
      position: nameEnd,
    };
  }

  pos = afterName + 1;
  while (pos < text.length && whitespace.test(text[pos])) {
    pos += 1;
  }

  if (text[pos] === '"' || text[pos] === "'") {
    const quote = text[pos];
    pos += 1;
    pos = readQuotedAttributeValue(text, pos, quote).position;
  } else {
    while (pos < text.length && !whitespace.test(text[pos]) && text[pos] !== '>') {
      if (isSelfClosingSlash(text, pos)) {
        break;
      }

      if (startsTemplateTag(text, pos)) {
        const token = parseMustacheToken(text, pos);
        pos = token.end;
        continue;
      }

      pos += 1;
    }
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

  const parts = parseAttributeValueParts(rawValue, valueStart ?? 0);

  return {
    type: 'Attribute',
    name,
    value: withOptionalRange(
      {
        type: 'AttributeValue' as const,
        parts,
        raw: rawValue,
      },
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
): (TextNode | MustacheStatement | BlockStatement | PartialStatement | DecoratorStatement | CommentStatement)[] {
  const parts: (TextNode | MustacheStatement | BlockStatement | PartialStatement | DecoratorStatement | CommentStatement)[] = [];
  let pos = 0;

  while (pos < value.length) {
    if (startsTemplateTag(value, pos)) {
      const token = parseMustacheToken(value, pos);

      // a comment
      if (token.kind === 'comment') {
        parts.push(createComment(token.rawContent, rangeOffset + pos, rangeOffset + token.end));
        pos = token.end;
        continue;
      }

      // partial
      if (token.kind === 'partial') {
        parts.push(createPartial(token.content, token.trimOpen, token.trimClose, rangeOffset + pos, rangeOffset + token.end, rangeOffset + contentOffset(value, pos, token.end, token.content)));
        pos = token.end;
        continue;
      }

      if (token.specialForm === 'decorator') {
        parts.push(
          createDecorator(
            token.content.slice(1).trim(),
            token.trimOpen,
            token.trimClose,
            rangeOffset + pos,
            rangeOffset + token.end,
            rangeOffset + contentOffset(value, pos, token.end, token.content.slice(1).trim()),
          ),
        );
        pos = token.end;
        continue;
      }

      // a plain mustache
      if (token.kind === 'mustache') {
        parts.push(
          createMustache(token.content, token.triple, token.trimOpen, token.trimClose, rangeOffset + pos, rangeOffset + token.end, rangeOffset + contentOffset(value, pos, token.end, token.content)),
        );
        pos = token.end;
        continue;
      }

      // a block, {{#if ...}} ... {{/if}}
      if (token.kind === 'blockStart') {
        if (!hasMatchingBlockEnd(value, token, pos)) {
          // no close found, so keep it as text rather than fail
          parts.push(
            withRange(
              { type: 'TextNode', chars: value.slice(pos, token.end) } as TextNode,
              rangeOffset + pos,
              rangeOffset + token.end,
            ),
          );
          pos = token.end;
          continue;
        }

        const { node, next } = parseBlock(value, token, rangeOffset);
        parts.push(node);
        pos = next;
        continue;
      }

      // else / blockEnd: odd, but not worth failing over
      parts.push(
        withRange(
          { type: 'TextNode', chars: value.slice(pos, token.end) } as TextNode,
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
      parts.push(withRange({ type: 'TextNode', chars: rawText } as TextNode, rangeOffset + pos, rangeOffset + end));
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
      preserveValueWhitespace(node.children);
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

function skipWhitespace(text: string, advance: () => void, getPos: () => number) {
  while (getPos() < text.length && whitespace.test(text[getPos()])) {
    advance();
  }
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
  let pos = position;

  while (pos < text.length) {
    const next = findNextHandlebarsOpen(text, pos);
    if (next === -1) {
      return -1;
    }

    const token = parseMustacheToken(text, next);

    if (token.kind === 'blockStart') {
      depth += 1;
    } else if (token.kind === 'blockEnd') {
      if (depth === 0 && token.name === endBlock) {
        return next;
      }

      if (depth > 0) {
        depth -= 1;
      }
    } else if (token.kind === 'else' && depth === 0) {
      return next;
    }

    pos = token.end > next ? token.end : next + 2;
  }

  return -1;
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

    const tagResult = parseTag(text, next);

    if (tagResult.kind === 'close') {
      if (tagResult.tag === tag) {
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

    if (tagResult.kind === 'open' && tagResult.tag === tag) {
      depth += 1;
    }

    pos = tagResult.end;
  }

  return null;
}

function shouldPreserveMustacheVerbatim(token: MustacheToken): boolean {
  return templateDialect.shouldPreserveTokenVerbatim(token);
}

/**
 * Raw text ends at the first `</tag`, whatever it appears to sit inside.
 *
 * A browser's tokenizer does not parse the script or style body looking for string literals -
 * that is exactly why `"<\\/script>"` has to be escaped in JS. Tracking quotes here instead made
 * an apostrophe in a comment hide the closing tag.
 */
function findRawTextClose(text: string, position: number, tag: string): number {
  const needle = `</${tag.toLowerCase()}`;

  /* Scanning case-insensitively rather than lowercasing the whole template: this runs once per
   * raw-text element and again inside every close-tag scan, so a copy of the file each time
   * turns a page of `<script>`s into quadratic work. */
  for (let index = text.indexOf('<', position); index !== -1; index = text.indexOf('<', index + 1)) {
    if (text.slice(index, index + needle.length).toLowerCase() === needle) {
      return index;
    }
  }

  return -1;
}

function consumeTagLikeChunk(text: string, position: number): number {
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let index = position + 1; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '>') {
      return index + 1;
    }
  }

  return text.length;
}

function consumeDynamicElement(text: string, position: number): number | null {
  if (!isDynamicTagStart(text, position)) {
    return null;
  }

  const dynamicOpen = `<${templateDialect.openDelimiter}`;
  const dynamicClose = `</${templateDialect.openDelimiter}`;

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

function parseExpression(content: string, contentStart = 0): MustacheStatement {
  const expression = parseCall(content, contentStart);
  return {
    type: 'MustacheStatement',
    triple: false,
    ...expression,
  };
}

function createMustache(
  content: string,
  triple: boolean,
  trimOpen = false,
  trimClose = false,
  start?: number,
  end?: number,
  contentStart = 0,
): MustacheStatement {
  const expression = parseCall(content, contentStart);
  const node: MustacheStatement = {
    type: 'MustacheStatement',
    triple,
    ...expression,
  };

  if (trimOpen) {
    node.trimOpen = true;
  }

  if (trimClose) {
    node.trimClose = true;
  }

  return withOptionalRange(node, start, end);
}

function createPartial(content: string, trimOpen = false, trimClose = false, start?: number, end?: number, contentStart = 0): PartialStatement {
  const expression = parseCall(content, contentStart);
  const node: PartialStatement = {
    type: 'PartialStatement',
    ...expression,
  };

  if (trimOpen) {
    node.trimOpen = true;
  }

  if (trimClose) {
    node.trimClose = true;
  }

  return withOptionalRange(node, start, end);
}

function createDecorator(content: string, trimOpen = false, trimClose = false, start?: number, end?: number, contentStart = 0): DecoratorStatement {
  const expression = parseCall(content, contentStart);
  const node: DecoratorStatement = {
    type: 'DecoratorStatement',
    ...expression,
  };

  if (trimOpen) {
    node.trimOpen = true;
  }

  if (trimClose) {
    node.trimClose = true;
  }

  return withOptionalRange(node, start, end);
}

function createComment(content: string, start?: number, end?: number): CommentStatement {
  const isBlockStyle = /^\s*!-{2}/.test(content);
  /* The tokenizer already stopped before the closing delimiter, so there is none to strip here;
   * doing it anyway deleted a `--` the author wrote at the end of the body. */
  const body = content.replace(/^[\t ]*!-{0,2}/, '');
  const inline = !body.startsWith('\n');
  let value = inline ? body.replace(/^\s*/, '') : body;

  value = value.replace(/[ \t]+$/gm, '');

  const isMultiline = /\n/.test(content);

  return withOptionalRange({
    type: 'CommentStatement',
    value,
    multiline: isMultiline,
    block: isBlockStyle || isMultiline,
    inline,
  }, start, end);
}
