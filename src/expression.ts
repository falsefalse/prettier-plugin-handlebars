import type { Expression, HashPair, LiteralType, MustacheBase, PathExpression, SubExpression } from './types';

export type ParsedCall = Pick<MustacheBase, 'path' | 'params' | 'hash' | 'blockParams'>;

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
    while (!this.done && /\s/u.test(this.peek())) {
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
    return match[1].trim().split(/\s+/u).filter(Boolean);
  }

  private readQuoted(): [number, number] {
    const start = this.index;
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

    return [start, this.index];
  }

  /** A bare run stops at whitespace, a closing paren, or the `=` of a hash pair. */
  private readBare(): [number, number] {
    const start = this.index;
    let brackets = 0;

    while (!this.done) {
      const char = this.peek();

      if (char === '[') brackets += 1;
      else if (char === ']') brackets = Math.max(brackets - 1, 0);
      else if (brackets === 0 && (/\s/u.test(char) || char === ')' || char === '=')) break;

      this.index += 1;
    }

    return [start, this.index];
  }

  private readSubExpression(): SubExpression {
    const start = this.index;
    this.index += 1;

    const inner = this.readCall(true);
    if (this.peek() === ')') {
      this.index += 1;
    }

    return {
      type: 'SubExpression',
      source: this.source.slice(start, this.index),
      path: inner.path,
      params: inner.params,
      hash: inner.hash,
      range: this.span(start, this.index),
    };
  }

  private readValue(): Expression {
    if (this.peek() === '(') {
      return this.readSubExpression();
    }

    if (quoteCharacters.has(this.peek())) {
      const [start, end] = this.readQuoted();
      return { type: 'StringLiteral', source: this.source.slice(start, end), range: this.span(start, end) };
    }

    const [start, end] = this.readBare();
    const source = this.source.slice(start, end);

    /* An empty read would spin forever; consume the character as a path instead. */
    if (start === end) {
      this.index += 1;
      return { type: 'PathExpression', source: this.source.slice(start, this.index), range: this.span(start, this.index) };
    }

    const literalType = literalTypeOf(source);
    return literalType
      ? { type: literalType, source, range: this.span(start, end) }
      : { type: 'PathExpression', source, range: this.span(start, end) };
  }

  /** A head must be callable, so a stray literal is reread as a path rather than rejected. */
  private readHead(): PathExpression | SubExpression {
    const value = this.readValue();

    if (value.type === 'SubExpression' || value.type === 'PathExpression') {
      return value;
    }

    return { type: 'PathExpression', source: value.source, range: value.range };
  }

  readCall(nested = false): ParsedCall {
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
        hash.push({ key: value.source, value: pairValue, range: this.span(start, this.index) });
        continue;
      }

      this.index = afterValue;
      params.push(value);
    }

    return blockParams ? { path, params, hash, blockParams } : { path, params, hash };
  }

  private emptyPath(): PathExpression {
    return { type: 'PathExpression', source: '', range: this.span(this.index, this.index) };
  }
}

/**
 * Parses one call's source into structured parts whose ranges are absolute in the template.
 *
 * `offset` is where `source` begins in the template, so a subexpression buried in a hash value
 * can still be located exactly.
 */
export function parseCall(source: string, offset = 0): ParsedCall {
  return new CallReader(source, offset).readCall();
}
