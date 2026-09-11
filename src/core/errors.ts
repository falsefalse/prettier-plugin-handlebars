interface Position {
  line: number;
  column: number;
}

function positionAt(text: string, offset: number): Position {
  const upTo = text.slice(0, Math.max(0, Math.min(offset, text.length)));

  return { line: upTo.split('\n').length, column: upTo.length - (upTo.lastIndexOf('\n') + 1) + 1 };
}

/**
 * A construct the template opened and never closed, or closed with the wrong thing.
 *
 * The formatter refuses rather than guessing: guessing at a missing `}}` means printing markup
 * the author did not write, and quietly passing a mismatched tag through means the rest of the
 * file goes unformatted with nothing to show for it.
 */
export class TemplateSyntaxError extends SyntaxError {
  /** Prettier renders a code frame from this, and editors put the cursor on it. */
  loc?: { start: Position; end: Position };

  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    /* Editor integrations grep stderr for `: SyntaxError: <message> (line:col)` to place the
     * cursor -- JsPrettier for Sublime Text does, and a subclass name misses that pattern. */
    this.name = 'SyntaxError';
  }

  /** Offsets are all the parser knows; line and column need the whole text. */
  locate(text: string): this {
    const start = positionAt(text, this.start);

    this.loc = { start, end: positionAt(text, this.end) };
    this.message = `${this.message} (${start.line}:${start.column})`;

    return this;
  }
}

/**
 * Every malformed construct ends here. A formatter that guesses at a missing delimiter prints
 * markup the author did not write; one that passes a mismatched tag through leaves the rest of
 * the file unformatted with nothing to show for it. Refusing is the only honest option, and the
 * offsets let an editor put the cursor on the offending place.
 */
export function fail(message: string, start: number, end: number): never {
  throw new TemplateSyntaxError(message, start, end);
}
