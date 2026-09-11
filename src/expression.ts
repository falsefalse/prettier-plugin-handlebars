import { withRange } from './core/source';
import { TemplateSyntaxError } from './core/errors';
import * as whitespace from './core/whitespace';
import type { Call, Expression, HashPair, Literal, LiteralType, PathExpression, SubExpression } from './types';

const quoteCharacters = new Set(['"', "'", '`']);
const numberPattern = /^-?(?:\d+\.?\d*|\.\d+)$/u;

function literalTypeOf(source: string): LiteralType | null {
  switch (source) {
    case 'true':
    case 'false':
      return 'BooleanLiteral';
    case 'null':
      return 'NullLiteral';
    case 'undefined':
      return 'UndefinedLiteral';
    default:
      return numberPattern.test(source) ? 'NumberLiteral' : null;
  }
}

/**
 * Recursive-descent reader over one call's source, e.g. `t 'a.b' n=(concat x y)`.
 *
 * Total by construction: anything it cannot classify becomes a PathExpression holding the raw
 * text, because a formatter has to keep working on templates that are mid-edit.
 */
class CallReader {
  private index: number;

  constructor(
    private readonly source: string,
    private readonly offset: number,
  ) {
    this.index = 0;
  }

  private get done(): boolean {
    return this.index >= this.source.length;
  }

  private peek(at = 0): string {
    return this.source[this.index + at] ?? '';
  }

  private skipWhitespace(): void {
    while (!this.done && whitespace.handlebars.test(this.peek())) {
      this.index += 1;
    }
  }

  private span(start: number, end: number): [number, number] {
    return [this.offset + start, this.offset + end];
  }

  /** `as |a b|` closes the parameter list; the names themselves have nothing to break. */
  private readBlockParams(): string[] | null {
    const rest = this.source.slice(this.index);
    const match = /^as\s+\|([^|]*)\|/u.exec(rest);
    if (!match) {
      return null;
    }

    this.index += match[0].length;
    return match[1].trim().split(whitespace.handlebarsRun).filter(Boolean);
  }

  private skipQuoted(): void {
    const quote = this.peek();
    this.index += 1;

    while (!this.done) {
      const char = this.peek();
      if (char === '\\') {
        this.index += 2;
        continue;
      }

      this.index += 1;
      if (char === quote) {
        break;
      }
    }
  }

  /** A bare run stops at whitespace, a closing paren, or the `=` of a hash pair. */
  private skipBare(): void {
    let brackets = 0;

    while (!this.done) {
      const char = this.peek();

      if (char === '[') brackets += 1;
      else if (char === ']') brackets = Math.max(brackets - 1, 0);
      else if (brackets === 0 && (whitespace.handlebars.test(char) || char === ')' || char === '=')) break;

      this.index += 1;
    }
  }

  /** A leaf is its own source text and the span it came from; only the label differs. */
  private leaf(type: LiteralType | 'PathExpression', start: number): Literal | PathExpression {
    const node: Literal | PathExpression = { type, source: this.source.slice(start, this.index) };

    return withRange(node, ...this.span(start, this.index));
  }

  private readSubExpression(): SubExpression {
    const start = this.index;
    this.index += 1;

    const inner = this.readCall(true);

    /* Printing the parts back out would invent the `)` the author did not write, turning a
     * template Handlebars rejects into one it accepts - the opposite of what this branch does
     * everywhere else. */
    if (this.peek() !== ')') {
      throw new TemplateSyntaxError("unterminated subexpression: expected ')'", ...this.span(start, this.index));
    }

    this.index += 1;

    const node: SubExpression = {
      type: 'SubExpression',
      source: this.source.slice(start, this.index),
      path: inner.path,
      params: inner.params,
      hash: inner.hash,
    };

    return withRange(node, ...this.span(start, this.index));
  }

  private readValue(): Expression {
    if (this.peek() === '(') {
      return this.readSubExpression();
    }

    const start = this.index;

    if (quoteCharacters.has(this.peek())) {
      this.skipQuoted();
      return this.leaf('StringLiteral', start);
    }

    this.skipBare();

    /* An empty read would spin forever; consume the character as a path instead. */
    if (this.index === start) {
      this.index += 1;
    }

    return this.leaf(literalTypeOf(this.source.slice(start, this.index)) ?? 'PathExpression', start);
  }

  /** A head must be callable, so a stray literal is reread as a path rather than rejected. */
  private readHead(): PathExpression | SubExpression {
    const value = this.readValue();

    if (value.type === 'SubExpression' || value.type === 'PathExpression') {
      return value;
    }

    const node: PathExpression = { type: 'PathExpression', source: value.source };

    return value.range ? withRange(node, ...value.range) : node;
  }

  readCall(nested = false): Call {
    this.skipWhitespace();

    const path = this.done || this.peek() === ')' ? this.emptyPath() : this.readHead();
    const params: Expression[] = [];
    const hash: HashPair[] = [];
    let blockParams: string[] | undefined;

    for (;;) {
      this.skipWhitespace();
      if (this.done || (nested && this.peek() === ')')) {
        break;
      }

      const names = this.readBlockParams();
      if (names) {
        blockParams = names;
        continue;
      }

      const start = this.index;
      const value = this.readValue();

      /* Handlebars allows space on either side of the `=`, so look past it and rewind when the
       * next token turns out to be a plain param rather than a hash value. */
      const afterValue = this.index;
      this.skipWhitespace();

      if (this.peek() === '=' && value.type === 'PathExpression') {
        this.index += 1;
        this.skipWhitespace();
        const pairValue = this.readValue();
        hash.push(withRange({ key: value.source, value: pairValue }, ...this.span(start, this.index)));
        continue;
      }

      this.index = afterValue;

      /* Handlebars rejects a positional param after a hash pair, and the printer prints params
       * first regardless - so accepting this would silently re-order the author's arguments. */
      if (hash.length > 0) {
        throw new TemplateSyntaxError(
          `unexpected ${value.source} after a hash pair: positional params come first`,
          ...this.span(start, this.index),
        );
      }

      params.push(value);
    }

    return blockParams ? { path, params, hash, blockParams } : { path, params, hash };
  }

  private emptyPath(): PathExpression {
    const node: PathExpression = { type: 'PathExpression', source: '' };

    return withRange(node, ...this.span(this.index, this.index));
  }
}

/**
 * Parses one call's source into structured parts whose ranges are absolute in the template.
 *
 * `offset` is where `source` begins in the template, so a subexpression buried in a hash value
 * can still be located exactly.
 */
export function parseCall(source: string, offset = 0): Call {
  return new CallReader(source, offset).readCall();
}
