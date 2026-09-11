/**
 * The first index at or after `from` where `stopsAt` holds, skipping quoted runs so a delimiter
 * inside a string literal does not end the scan. Backslash escapes are honoured inside a quote
 * and nowhere else. Returns -1 if the scan reaches the end without stopping.
 *
 * `opensQuote` is the one thing a caller must decide: inside a tag a quote only delimits a
 * value after `=`, and treating every quote as one makes `title=a"b'c>` swallow the file.
 */
export function scanPastQuotes(
  text: string,
  from: number,
  { stopsAt, opensQuote }: { stopsAt: (index: number) => boolean; opensQuote: (index: number) => boolean },
): number {
  let quote: string | null = null;
  let escaped = false;

  for (let index = from; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }

      continue;
    }

    if ((char === '"' || char === "'" || char === '`') && opensQuote(index)) {
      quote = char;
      continue;
    }

    if (stopsAt(index)) {
      return index;
    }
  }

  return -1;
}
