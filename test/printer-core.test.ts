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

  /* Padding a multi-line body puts trailing whitespace on the opening line, which re-parses
   * differently on the next pass. */
  it('leaves a multi-line body exactly as written', async () => {
    await expectStable('{{!--\n  <span>x</span>\n--}}', '{{!--\n  <span>x</span>\n--}}\n');
  });
});

describe('prose', () => {
  it('wraps long text at printWidth without changing whitespace count', async () => {
    const source = 'one two three four five six seven eight nine ten eleven twelve';
    const output = await format(source, 20);

    expect(output.split('\n').filter(Boolean).length).toBeGreaterThan(1);
    expect(output.trim().split(/\s+/)).toEqual(source.split(' '));
  });
});

describe('coverage boundary', () => {
  it('reports what it cannot print yet', async () => {
    await expect(format('{{#if a}}x{{/if}}')).rejects.toThrow(/does not handle BlockStatement yet/);
  });
});
