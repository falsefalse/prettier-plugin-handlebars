import { describe, expect, it } from 'vitest';
import prettier from 'prettier';
import * as plugin from '../src/plugin';

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

describe('comments', () => {
  it.each([
    ['{{! short }}', '{{! short }}\n'],
    ['{{!short}}', '{{! short }}\n'],
    ['{{!-- block --}}', '{{!-- block --}}\n'],
    ['{{!--block--}}', '{{!-- block --}}\n'],
    ['{{!}}', '{{!}}\n'],
    ['{{!----}}', '{{!----}}\n'],
  ])('pads a single-line body: %j', async (source, expected) => {
    await expectStable(source, expected);
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
   * the same newline as one between two nodes. Treating them differently made layout depend on
   * where the parser happened to split, which is how attributes written one-per-line inside an
   * attribute-position block came back joined. */
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
