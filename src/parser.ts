import {
  AttributeValue,
  AttributeBlockNode,
  AttributeValuePart,
  Program,
  Node,
  ElementAttribute,
  BlockStatement,
  ElseBranch,
  ParseEndReason,
} from './types';
import { isRawTextElement, isVoidElement } from './core/html';
import { normalizeInput, withOptionalRange, withRange } from './core/source';
import { fail, TemplateSyntaxError } from './core/errors';
import * as whitespace from './core/whitespace';
import {
  attributeNameCharacter,
  isTagStart,
  readAttributeName,
  readAttributeValue,
  readCloseTagSource,
  readName,
  sameTag,
  skipWhitespace,
  startsCloseTag,
  startsTemplateTag,
  trimTrailingWhitespace,
} from './parse/lex';
import type { ParsedTag } from './parse/lex';
import {
  consumeDynamicElement,
  consumeNextNode,
  consumeTerminatedRawBlock,
  findCurrentBlockBoundary,
  findMatchingBlockEnd,
  findMatchingTagClose,
  findNextMarkup,
  findRawTextClose,
  hasMatchingBlockEnd,
} from './parse/lookahead';
import {
  commentBody,
  contentOffset,
  createComment,
  createMustache,
  createStatement,
  createUnmatchedNode,
  textNode,
  findPrettierIgnoreEnd,
  getPrettierIgnoreDirective,
} from './parse/nodes';
import { parseCall } from './expression';
import type { HandlebarsToken as MustacheToken } from './dialects/handlebars/tokens';
import {
  findNextHandlebarsOpen,
  getBlockExpression,
  getBlockPrefix,
  isHandlebarsBlockComment,
  parseMustacheToken,
  shouldPreserveMustacheVerbatim,
} from './dialects/handlebars/tokens';

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

/* The dialect reports an unterminated token as one that ends at EOF, which is also what a token
 * ending the file looks like; the closing delimiter is what tells them apart. */
function parseChildren(
  text: string,
  position: number,
  endTag: string | null,
  endBlock: string | null,
  rangeOffset = 0,
): ParseResult {
  const nodes: Node[] = [];
  let pos = position;

  if (endTag && isRawTextElement(endTag)) {
    return parseRawTextChildren(text, pos, endTag, rangeOffset);
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
      const step = parseMustacheChild(text, pos, endBlock, rangeOffset, nodes);
      if (typeof step !== 'number') return step;

      pos = step;
      continue;
    }

    if (text[pos] === '<') {
      const step = parseElementChild(text, pos, endTag, blockBoundary, rangeOffset, nodes);
      if (typeof step !== 'number') return step;

      pos = step;
      continue;
    }

    /* Text node until the next markup. The run is kept verbatim, whitespace-only runs
     * included: what renders is the printer's to decide, not the parser's to discard. */
    const nextMarkup = findNextMarkup(text, pos);
    if (nextMarkup > pos) {
      nodes.push(textNode(text, pos, nextMarkup, rangeOffset));
    }
    pos = nextMarkup;
  }

  return { nodes, position: pos, endReason: null };
}

/* A raw text element has no children: `<` inside one is text, so the whole body is one run and
 * the only thing to find is the closing tag. */
function parseRawTextChildren(text: string, position: number, endTag: string, rangeOffset: number): ParseResult {
  const closeStart = findRawTextClose(text, position, endTag);
  const contentEnd = closeStart >= 0 ? closeStart : text.length;
  const nodes: Node[] = contentEnd > position ? [textNode(text, position, contentEnd, rangeOffset, true)] : [];

  const closeIdx = closeStart >= 0 ? text.indexOf('>', closeStart) : -1;
  if (closeStart >= 0 && closeIdx < 0) {
    fail("unterminated tag: expected '>'", rangeOffset + closeStart, rangeOffset + text.length);
  }

  return {
    nodes,
    position: closeIdx >= 0 ? closeIdx + 1 : contentEnd,
    endReason: closeStart >= 0 ? 'tagClose' : null,
    contentEnd,
    closeTag: closeStart >= 0 ? readCloseTagSource(text, closeStart, closeIdx) : undefined,
  };
}

/** Either where the next child starts, or the result that ends this child list. */
type ChildStep = number | ParseResult;

/* Split out of `parseChildren` only for size; both read `nodes` as the list being built. */
function parseMustacheChild(
  text: string,
  pos: number,
  endBlock: string | null,
  rangeOffset: number,
  nodes: Node[],
): ChildStep {
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
    return token.end;
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
      return ignoreEnd;
    }

    if (ignoreDirective === 'next') {
      const ignoredEnd = consumeNextNode(text, token.end);

      /* Nothing follows to ignore, so the directive is only a comment. */
      if (ignoredEnd <= token.end) {
        nodes.push(createComment(token, rangeOffset + pos, rangeOffset + token.end));
        return token.end;
      }

      nodes.push(createUnmatchedNode(text, pos, ignoredEnd, rangeOffset));
      return ignoredEnd;
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
    return next;
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
  return token.end;
}

function parseElementChild(
  text: string,
  pos: number,
  endTag: string | null,
  blockBoundary: number,
  rangeOffset: number,
  nodes: Node[],
): ChildStep {
  if (text.startsWith('<!', pos) && !text.startsWith('<!--', pos)) {
    const closeIdx = text.indexOf('>', pos + 2);
    /* Unterminated, so the declaration runs to the end of the input - but its trailing
     * whitespace is still the author's. Folding that into the verbatim run makes the
     * printer's own final newline additive, and the file grows a line on every format. */
    const end = closeIdx >= 0 ? closeIdx + 1 : trimTrailingWhitespace(text, pos);
    nodes.push(textNode(text, pos, end, rangeOffset, true));
    return end;
  }

  if (!isTagStart(text, pos)) {
    const nextMarkup = findNextMarkup(text, pos + 1);
    nodes.push(textNode(text, pos, nextMarkup, rangeOffset));
    return nextMarkup;
  }

  if (text.startsWith('<!--', pos)) {
    const closeIdx = text.indexOf('-->', pos + 4);
    if (closeIdx < 0) {
      fail("unterminated HTML comment: expected '-->'", rangeOffset + pos, rangeOffset + text.length);
    }

    const end = closeIdx + 3;

    nodes.push(textNode(text, pos, end, rangeOffset, true));
    return end;
  }

  return parseElement(text, pos, endTag, blockBoundary, rangeOffset, nodes);
}

/* Split from `parseElementChild` so the three things that open with `<` and are not an element -
 * a declaration, a comment, a bare `<` - stay out of the way of the one that is. */
function parseElement(
  text: string,
  pos: number,
  endTag: string | null,
  blockBoundary: number,
  rangeOffset: number,
  nodes: Node[],
): ChildStep {
  const tagResult = parseTag(text, pos, rangeOffset);

  if (!tagResult.terminated) {
    fail("unterminated tag: expected '>'", rangeOffset + pos, rangeOffset + tagResult.end);
  }

  if (tagResult.kind === 'close') {
    if (endTag && sameTag(tagResult.tag, endTag)) {
      return { nodes, position: tagResult.end, endReason: 'tagClose', contentEnd: pos, closeTag: tagResult.source };
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
    return tagResult.end;
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
  return newPos;
}

function parseBlock(
  text: string,
  token: MustacheToken,
  rangeOffset: number,
): { node: BlockStatement; next: number; closed: boolean } {
  /* A call's source is a slice of its own token, so its parts locate against the template. */
  const callAt = (at: MustacheToken, source: string) =>
    parseCall(source, rangeOffset + contentOffset(text, at.start, at.end, source));

  const openInfo = callAt(token, getBlockExpression(token));
  const blockPrefix = getBlockPrefix(token);

  /* Every branch reads to the same terminator - this block's own closer - so they differ only
   * in where they start. */
  const parseBranch = (from: number) => parseChildren(text, from, null, openInfo.path.source, rangeOffset);

  const { nodes: program, position: afterProgram, endReason, endToken } = parseBranch(token.end);
  const buildProgram = (nodes: Node[], start: number, end: number): Program =>
    withRange({ type: 'Program', body: nodes }, rangeOffset + start, rangeOffset + end);
  /* A program ends where its terminator begins, not after it, so the body tiles the range. */
  const programBody = buildProgram(program, token.end, endToken?.start ?? afterProgram);

  /* Set only when the author wrote a bare `{{else}}`; otherwise the empty inverse is built at
   * the end, once the closer's position is known. Anchoring it at `afterProgram` up here put it
   * inside the else-if chain - a point belonging to a different section of the block. */
  let inverse: { program: Program; trimOpen: boolean; trimClose: boolean } | undefined;
  const inverseChain: ElseBranch[] = [];
  let finalPos = afterProgram;
  let closeToken = endReason === 'blockEnd' ? endToken : undefined;

  if (endReason === 'else' && endToken) {
    let currentElseToken: MustacheToken | undefined = endToken;
    let currentPosition = afterProgram;

    while (currentElseToken?.specialForm === 'elseIf') {
      const branchExpression = callAt(currentElseToken, currentElseToken.content.replace(/^else\s+/, ''));
      const {
        nodes: branchNodes,
        position: afterBranch,
        endReason: branchEndReason,
        endToken: branchEndToken,
      } = parseBranch(currentPosition);

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
      const {
        nodes: inverseNodes,
        position: afterInverse,
        endReason: inverseEndReason,
        endToken: inverseEndToken,
      } = parseBranch(currentPosition);

      inverse = {
        program: buildProgram(inverseNodes, currentElseToken.end, inverseEndToken?.start ?? afterInverse),
        trimOpen: currentElseToken.trimOpen,
        trimClose: currentElseToken.trimClose,
      };
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
      inverse: inverse?.program ?? buildProgram([], closerAnchor, closerAnchor),
      ...(inverse?.trimOpen ? { inverseTrimOpen: true } : {}),
      ...(inverse?.trimClose ? { inverseTrimClose: true } : {}),
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

/**
 * The node a mustache stands for and where it ends, or null when it stands for nothing on its
 * own: a block that never closes, a stray `{{else}}` or `{{/if}}`. Recovering from that is the
 * caller's, and the two callers disagree - in attribute position it stays a mustache, inside a
 * value it goes back to being text.
 */
function readTemplateNode(
  text: string,
  token: MustacheToken,
  position: number,
  rangeOffset: number,
): { node: AttributeBlockNode; next: number } | null {
  const statement = createStatement(text, token, position, rangeOffset);
  if (statement) {
    return { node: statement, next: token.end };
  }

  if (token.kind === 'blockStart' && hasMatchingBlockEnd(text, token)) {
    return parseBlock(text, token, rangeOffset);
  }

  return null;
}

function parseTag(text: string, position: number, rangeOffset: number): ParsedTag {
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
  /* A void element is self-closing however it was written, so `<br>` and `<br/>` agree. */
  const kindOf = (selfClosed: boolean): 'open' | 'selfClosing' =>
    selfClosed || isVoidElement(tag) ? 'selfClosing' : 'open';
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

      /* Unbalanced is not itself grounds to reject here - the tag's own extent is already fixed
       * - so it stays a mustache. `createMustache` still parses the call, so what is *inside*
       * one can be rejected the same as anywhere else. */
      const read = readTemplateNode(text, token, pos, rangeOffset) ?? {
        node: createMustache(text, token, pos, rangeOffset),
        next: token.end,
      };

      add({ type: 'AttributeBlock', block: read.node }, read.next);
      pos = read.next;
      continue;
    }

    const selfClosed = text[pos] === '/' && text[pos + 1] === '>';
    if (selfClosed || text[pos] === '>') {
      const headEnd = pos;
      pos += selfClosed ? 2 : 1;
      return { kind: kindOf(selfClosed), tag, attributes, attributesRange: span(headEnd), end: pos, terminated: true };
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

  return { kind: kindOf(false), tag, attributes, attributesRange: span(pos), end: pos, terminated: false };
}

function consumeInvalidVoidElementClose(text: string, position: number, tag: string): number | null {
  if (!isVoidElement(tag)) {
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

function parseAttribute(
  text: string,
  position: number,
  rangeOffset: number,
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

  const { raw: rawValue, start: valueStart, end } = readAttributeValue(text, pos);
  pos = end;

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
  pos = readAttributeValue(text, skipWhitespace(text, afterName + 1)).end;

  return {
    attribute: createRawAttribute(text.slice(start, pos)),
    position: pos,
  };
}

function createAttribute(name: string, rawValue: string | null, valueStart?: number): ElementAttribute {
  if (rawValue === null) {
    return { type: 'Attribute', name, value: null };
  }

  const value: AttributeValue = {
    type: 'AttributeValue',
    parts: parseAttributeValueParts(rawValue, valueStart ?? 0),
    raw: rawValue,
  };
  const valueEnd = valueStart === undefined ? undefined : valueStart + rawValue.length;

  return { type: 'Attribute', name, value: withOptionalRange(value, valueStart, valueEnd) };
}

function createRawAttribute(raw: string): ElementAttribute {
  return {
    type: 'RawAttribute',
    raw,
  };
}

function parseAttributeValueParts(value: string, rangeOffset: number): AttributeValuePart[] {
  const parts: AttributeValuePart[] = [];
  let pos = 0;

  while (pos < value.length) {
    /* A raw block's body is emitted literally by Handlebars, so it is copied through here for
     * the same reason it is between siblings: reformatting the `{{ x }}` inside one changes
     * what the value renders. Only the sibling list guarded this. */
    const rawBlockEnd = consumeTerminatedRawBlock(value, pos, rangeOffset);
    if (rawBlockEnd !== null) {
      parts.push(
        textNode(value, pos, rawBlockEnd, rangeOffset),
      );
      pos = rawBlockEnd;
      continue;
    }

    if (startsTemplateTag(value, pos)) {
      const token = parseMustacheToken(value, pos);

      /* A value is a string, so the recovery here keeps the source as text rather than as a
       * node - unlike attribute position, where an unreadable token stays a mustache. */
      const read = readTemplateNode(value, token, pos, rangeOffset);

      parts.push(read?.node ?? textNode(value, pos, token.end, rangeOffset));
      pos = read?.next ?? token.end;
      continue;
    }

    const next = findNextHandlebarsOpen(value, pos);
    const end = next === -1 ? value.length : next;
    const rawText = value.slice(pos, end);

    if (rawText.length > 0) {
      parts.push(textNode(value, pos, end, rangeOffset));
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
