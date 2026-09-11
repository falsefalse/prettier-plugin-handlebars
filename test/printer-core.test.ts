import { describe, expect, it } from 'vitest';
import prettier from 'prettier';
import * as plugin from '../src/plugin';
// @ts-expect-error
import { renderDifference } from './lib/render.mts';

async function format(source: string, printWidth = 80): Promise<string> {
  return prettier.format(source, { parser: 'handlebars', plugins: [plugin as never], printWidth });
}

async function expectStable(source: string, expected: string, printWidth = 80): Promise<void> {
  const first = await format(source, printWidth);
  expect(first).toBe(expected);
  expect(await format(first, printWidth)).toBe(first);
}

/* The governing rule: whitespace between siblings renders, so the author owns it. */
describe('sibling whitespace is reproduced, never invented', () => {
  it('keeps a space a space', async () => {
    await expectStable('{{a}} {{b}}', '{{a}} {{b}}\n');
  });

  it('keeps glued siblings glued', async () => {
    await expectStable('{{a}}{{b}}', '{{a}}{{b}}\n');
  });

  it('keeps a newline a newline, even though the pair would fit', async () => {
    await expectStable('{{a}}\n{{b}}', '{{a}}\n{{b}}\n');
  });

  it('collapses a run of blank lines to one', async () => {
    await expectStable('{{a}}\n\n\n\n{{b}}', '{{a}}\n\n{{b}}\n');
  });

  it('keeps text glued to its neighbours', async () => {
    await expectStable('Hello, {{name}}!', 'Hello, {{name}}!\n');
  });

  /* One hard break must not drag every other gap in the program with it. */
  it('does not turn neighbouring spaces into newlines', async () => {
    await expectStable('{{a}} {{b}}\n{{c}} {{d}}', '{{a}} {{b}}\n{{c}} {{d}}\n');
  });
});

describe('the template as a whole', () => {
  it('drops its own leading and trailing whitespace and ends in one newline', async () => {
    await expectStable('\n\n  {{a}}  \n\n', '{{a}}\n');
  });

  it('prints an empty template as empty', async () => {
    expect(await format('')).toBe('');
    expect(await format('  \n  ')).toBe('');
  });
});

describe('mustaches', () => {
  it.each([
    ['{{ value }}', '{{value}}\n'],
    ['{{value}}', '{{value}}\n'],
    ['{{{ raw }}}', '{{{raw}}}\n'],
    ['{{~ v ~}}', '{{~v~}}\n'],
    ['{{~v}}', '{{~v}}\n'],
    ['{{v~}}', '{{v~}}\n'],
  ])('normalises inner spacing: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  it('keeps a fitting call on one line', async () => {
    await expectStable("{{t 'a.b' n=1}}", "{{t 'a.b' n=1}}\n");
  });

  /* Whitespace inside a mustache does not render, so it is the formatter's: all or nothing. */
  it('breaks every param once the call does not fit', async () => {
    await expectStable(
      "{{t 'some.really.long.translation.key' first=alpha second=beta third=gamma}}",
      "{{t\n  'some.really.long.translation.key'\n  first=alpha\n  second=beta\n  third=gamma\n}}\n",
      60,
    );
  });

  it('breaks a subexpression that does not fit, so width is respected all the way down', async () => {
    const output = await format("{{t 'k' x=(concat 'prefix' (upper name) sep='-' pad=true)}}", 40);

    expect(output.split('\n').every((line) => line.length <= 40)).toBe(true);
    expect(output).toContain('concat');
  });

  it('keeps block params out of the param list', async () => {
    await expectStable('{{helper items as |x i|}}', '{{helper items as |x i|}}\n');
  });
});

/* Three ways a verbatim region - a prettier-ignore fence, a dynamic element - broke the layout
 * around it. All three needed a wider fuzz run than the default to show up, and all three were
 * only visible on the second pass. */
describe('content the printer must not touch', () => {
  const REGION = '{{!-- prettier-ignore-start --}}\n<i>r</i>\n{{!-- prettier-ignore-end --}}';
  const TAG = '<div aaa="1" bbb="2" ccc="3" ddd="4"></div>';

  /* A hard space kept its neighbours in one `fill` item, so everything downstream of a
   * standalone-sensitive statement was measured as a unit and never broke. */
  it('breaks a long tag that follows a verbatim region', async () => {
    const output = await format(`<p>x</p> ${REGION} {{#if o~}} y {{~/if}} ${TAG}`, 40);

    /* Not a width assertion: the space either side of the region is hard, so the region's own
     * lines take whatever width they take. What has to happen is the tag breaking on the first
     * pass rather than the second. */
    expect(output).toContain('<div\n  aaa="1"');
    expect(await format(output, 40)).toBe(output);
  });

  /* `fits` stops at the first hard line and reports success, so an item holding one prints flat
   * - over width - with the groups after that line never measured. */
  it('measures the groups glued after a verbatim region', async () => {
    const source = `${REGION}{{> (lookup . "partialName") data=this}}{{*log value level="debug"}}`;

    expect(await format(source, 40)).toBe(await format(await format(source, 40), 40));
  });

  /* One level further out. The container's own closer was glued onto the last child, but the
   * closer of *its* container was not, and `fill` measures its last item against an empty
   * rest-stack - so the marker was invisible to the width check inside the child. */
  it.each([
    ['<ul><li>text here <img src="pic.png"></li></ul>', 28],
    ['<div><p>hello there <span>world wide</span></p></div>', 30],
    ['<div><ul><li>text here <img src="pic.png"></li></ul></div>', 28],
  ])('counts an outer closing marker against the inner line: %j', async (source, width) => {
    const output = await format(source, width);

    expect(output.split('\n').filter((line) => line.length > width)).toEqual([]);
    expect(await format(output, width)).toBe(output);
  });

  /* The region's text is opaque: this one opens with a comment, so wrapping the space before it
   * made that comment standalone and Handlebars deleted the space from the page. */
  it('keeps the space next to a region as a space', async () => {
    const source = `<b>{{~ value ~}}    ${REGION}<i>x</i></b>`;

    expect(renderDifference(source, await format(source, 40))).toBeNull();
  });
});

/* `\s` matches U+00A0, which the rest of the printer goes out of its way never to treat as
 * whitespace. Trimming on it deleted a non-breaking space off the end of a block comment's
 * body, and reading one as the pad it already had left a line comment unpadded. */
describe('a non-breaking space in a comment', () => {
  it.each([
    ['{{!--\n  body\u00A0\n--}}', '{{!--\n  body\u00A0\n--}}\n'],
    ['{{! a\u00A0 }}', '{{! a\u00A0 }}\n'],
    ['{{! a\u00A0}}', '{{! a\u00A0 }}\n'],
    ['{{!-- a\u00A0--}}', '{{!-- a\u00A0 --}}\n'],
  ])('keeps it and still pads: %j', async (source, expected) => {
    const first = await format(source);
    expect(first).toBe(expected);
    expect(await format(first)).toBe(first);
  });

  it.each([
    ['{{! a }}', '{{! a }}\n'],
    ['{{!--a--}}', '{{!-- a --}}\n'],
  ])('pads an ordinary space exactly as before: %j', async (source, expected) => {
    expect(await format(source)).toBe(expected);
  });
});

describe('comments', () => {
  it.each([
    ['{{! short }}', '{{! short }}\n'],
    ['{{!short}}', '{{! short }}\n'],
    ['{{!-- block --}}', '{{!-- block --}}\n'],
    ['{{!--block--}}', '{{!-- block --}}\n'],
    ['{{!}}', '{{!}}\n'],
    /* An empty block comment keeps its spacing: `{{!----}}` reads as a typo, and is what
     * collapsing the padding writes over every `{{!-- --}}`. */
    ['{{!-- --}}', '{{!-- --}}\n'],
    ['{{!----}}', '{{!-- --}}\n'],
    /* `!--` is the block marker; `!-` is a body that happens to open with a dash. */
    ['{{!-foo}}', '{{! -foo }}\n'],
    ['{{!--foo--}}', '{{!-- foo --}}\n'],
  ])('pads a single-line body: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  /* `~` is the tag's, not the body's: raw token content emits the markers as comment text, and
   * a tokenizer anchored on the block form written without whitespace control demotes
   * `{{~!-- x --~}}` to a line comment. */
  it.each([
    ['{{~! trimmed ~}}', '{{~! trimmed ~}}\n'],
    ['{{~!-- trimmed --~}}', '{{~!-- trimmed --~}}\n'],
    ['{{~! open only }}', '{{~! open only }}\n'],
    ['{{!-- close only --~}}', '{{!-- close only --~}}\n'],
    ['{{~!--\n  multi\n--~}}', '{{~!--\n  multi\n--~}}\n'],
  ])('keeps whitespace control on a comment: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  /* express-hbs matches `{{!<name}}` with nothing between the `!` and the `<`. Deciding from
   * the stripped body instead cut both ways: `{{! <b> is prose}}` was printed back unpadded, and
   * `{{! < layout}}` was turned into a directive the author never wrote. */
  it.each([
    ['{{!< layout}}', '{{!< layout}}\n'],
    ['{{!<layout}}', '{{!<layout}}\n'],
    ['{{! < layout}}', '{{! < layout }}\n'],
    ['{{! <b> is prose}}', '{{! <b> is prose }}\n'],
    ['{{!--< not a directive --}}', '{{!-- < not a directive --}}\n'],
  ])('tells the express-hbs layout directive from prose: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  it('still reads a directive through its whitespace control', async () => {
    await expectStable('{{~! prettier-ignore ~}}\n<div    a=1>x</div>', '{{~! prettier-ignore ~}}\n<div    a=1>x</div>\n');
  });

  /* Padding regardless puts trailing whitespace on the opening line of a multi-line body,
   * which re-parses differently on the next pass. */
  it('pads a multi-line body only where it is not already spaced', async () => {
    await expectStable('{{! one\n  two }}', '{{!-- one\n  two --}}\n');
    await expectStable('{{!--\n  <span>x</span>\n--}}', '{{!--\n  <span>x</span>\n--}}\n');
  });

  it('lands the closer under the opener when the body ends on its own line', async () => {
    const output = await format('<p>\n  {{!\n    note\n  }}\n</p>');

    expect(output).toBe('<p>\n  {{!--\n    note\n  --}}\n</p>\n');
  });

  /* A body written on its own line follows the surrounding structure rather than staying
   * frozen at the column it was first typed at. */
  it('re-indents a body that starts on its own line', async () => {
    await expectStable(
      '<div>\n  <p>\n    {{!\n  under-indented\n    }}\n  </p>\n</div>',
      '<div>\n  <p>\n    {{!--\n      under-indented\n    --}}\n  </p>\n</div>\n',
    );
  });

  it('keeps the body\'s relative shape while re-indenting', async () => {
    const output = await format('{{!\n  outer\n    nested\n  outer again\n}}');

    expect(output).toBe('{{!--\n  outer\n    nested\n  outer again\n--}}\n');
  });

  it('leaves a hanging body alone, having nothing to hang from', async () => {
    await expectStable('{{! one\n  two }}', '{{!-- one\n  two --}}\n');
  });

  /* The tokenizer already stops before `--}}`, so stripping a trailing `--` here only ever ate
   * something the author wrote. */
  it('keeps a trailing double dash in the body', async () => {
    await expectStable('{{!-- ends with -- --}}', '{{!-- ends with -- --}}\n');
  });

  it.each(['{{!--\n--}}', '{{!--\n  a\n\n  b\n--}}'])('survives an odd body: %j', async (source) => {
    await expectStable(source, `${source}\n`);
  });
});

describe('prose', () => {
  it('wraps a long single line at printWidth, word by word', async () => {
    const source = 'one two three four five six seven eight nine ten eleven twelve';
    const output = await format(source, 20);

    expect(output.split('\n').filter(Boolean).length).toBeGreaterThan(1);
    expect(output.trim().split(/\s+/)).toEqual(source.split(' '));
  });

  /* The rule does not stop at node boundaries: a newline the author wrote inside a text run is
   * the same newline as one between two nodes. Treating them differently makes layout depend on
   * where the parser happened to split, joining attributes written one-per-line inside an
   * attribute-position block. */
  it('keeps a newline inside a text run', async () => {
    await expectStable('<p>\n  First sentence.\n  Second sentence.\n</p>', '<p>\n  First sentence.\n  Second sentence.\n</p>\n');
  });
});

describe('coverage', () => {
  it('handles every node type the parser produces', async () => {
    const everyKind =
      '{{! c }}{{v}}{{{r}}}{{> p}}{{*d}}<div a="1">t</div>{{#if a}}x{{else}}y{{/if}}{{{{raw}}}}z{{{{/raw}}}}';

    await expect(format(everyKind)).resolves.toContain('{{#if a}}');
  });
});
