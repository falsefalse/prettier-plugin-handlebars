/**
 * Two classes, because which one is right depends on which language owns the text. A loose `\s`
 * in the parser or the expression reader is Handlebars' and points here.
 *
 * Import the module, not the names: `whitespace.html` against `whitespace.handlebars` at the
 * call site is the point.
 */

/**
 * HTML's set. Not `\s`, which also matches U+00A0 - a non-breaking space is content, so
 * `<div title=a b>` is one attribute holding one and `<div a b>` is one attribute named `a b`.
 * Written out once; every class below is built from it, including the two in `parser.ts`.
 */
export const htmlCharacters = '\\t\\n\\f\\r ';

/** `/[\t\n\f\r ]/u` */
export const html = new RegExp(`[${htmlCharacters}]`, 'u');

/** `/[\t\n\f\r ]+/u` - collapsing a run to one space, or splitting text into its gaps. */
export const htmlRun = new RegExp(`[${htmlCharacters}]+`, 'u');

/** `/[\t\n\f\r ]+/gu` - for `replace`. Kept apart: `lastIndex` makes `g` unsafe to `test`. */
export const htmlRunGlobal = new RegExp(`[${htmlCharacters}]+`, 'gu');

/**
 * Handlebars' whitespace is `\s`, U+00A0 included: its lexer reads `{{foo bar}}` as path
 * `foo` and param `bar`. Narrowing these to `html` would put the expression reader out of step
 * with the runtime, and no corpus holds an NBSP inside a mustache to catch it. A `\s` spliced
 * into a larger pattern - `/^else\s+/` - stays written out, and is this class too.
 */
export const handlebars = /\s/u;

/** `/\s+/u` - splitting a mustache's inner text into words. */
export const handlebarsRun = /\s+/u;

/** How many spaces or tabs a line opens with. Not `trimStart`, which also eats a U+00A0. */
function indentOf(line: string): number {
  let at = 0;
  while (line[at] === ' ' || line[at] === '\t') at += 1;

  return at;
}

/**
 * Every line shifted left by the smallest indent any non-blank line carries, trailing spaces
 * and tabs dropped. Keeps a block's relative shape while letting the printer own its column.
 */
export function stripCommonIndent(lines: string[]): string[] {
  const common = lines
    .filter((line) => line.trim() !== '')
    .reduce((least, line) => Math.min(least, indentOf(line)), Infinity);

  return lines.map((line) =>
    line.trim() === '' ? '' : line.slice(Math.min(common, indentOf(line))).replace(/[ \t]+$/u, ''),
  );
}
