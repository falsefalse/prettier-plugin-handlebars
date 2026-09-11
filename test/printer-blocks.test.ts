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

/** A source one-liner has no newline runs in it, so nothing forces the block to break. */
describe('one-liners stay one-liners', () => {
  it.each([
    "{{#if a}}{{t 'x'}}{{/if}}",
    '{{#if a}}x{{else}}y{{/if}}',
    '{{#if a}}x{{else if b}}y{{else}}z{{/if}}',
    '{{#each xs as |x i|}}<li>{{x}}</li>{{/each}}',
    '{{^cond}}n{{/cond}}',
    '{{#> layout title=t}}<main>{{body}}</main>{{/layout}}',
    "{{#*inline 'badge'}}<span>{{label}}</span>{{/inline}}",
    '{{$body}}x{{/body}}',
    '{{#if a}}{{/if}}',
    '{{~#if a~}}x{{~/if~}}',
    '{{#if a}}{{#if b}}deep{{/if}}{{/if}}',
  ])('%j', async (source) => {
    await expectStable(source, `${source}\n`);
  });
});

/** And a block the author broke stays broken, whether or not it would now fit. */
describe('multi-line blocks keep their shape', () => {
  it.each([
    '{{#if a}}\n  x\n{{/if}}',
    '{{#if a}}\n  x\n{{else if b}}\n  y\n{{else}}\n  z\n{{/if}}',
    '<div>\n  {{#if a}}\n    <span>x</span>\n  {{/if}}\n</div>',
    '{{#each rows}}\n  <tr>\n    <td>{{name}}</td>\n  </tr>\n{{/each}}',
  ])('%j', async (source) => {
    await expectStable(source, `${source}\n`);
  });

  it('indents nested blocks without the markers drifting', async () => {
    const source = '{{#if a}}\n  {{#each xs}}\n    {{#if b}}\n      x\n    {{/if}}\n  {{/each}}\n{{/if}}';

    await expectStable(source, `${source}\n`);
  });

  /* A Handlebars path segment may hold spaces inside `[...]`. Splitting the block's name on
   * whitespace cuts `{{#[my block]}}` down to `[my`, which never matches the `[my block]` its
   * own closer reports, refusing a block for not closing the one it opened. */
  it.each([
    '{{#[my block]}}x{{/[my block]}}',
    '{{^[my block]}}x{{/[my block]}}',
    '{{#> [my part]}}x{{/[my part]}}',
    '{{#[a b].c d}}x{{/[a b].c}}',
  ])('closes a block whose name holds a space: %j', async (source) => {
    await expectStable(source, `${source}\n`);
  });
});

describe('blocks in attribute position and attribute values', () => {
  it.each([
    '<select {{#if disabled}}disabled readonly{{/if}}></select>',
    '<i class="icon-{{#if icon}}{{icon}}{{else}}info{{/if}}"></i>',
    '<div class="a {{#if b}}c{{/if}} d"></div>',
  ])('stays inline: %j', async (source) => {
    await expectStable(source, `${source}\n`);
  });

  /* Breaking one part of a mixed value scatters it across lines and splits markers like
   * `{{else if` from their condition. A value that *is* one call may still break. */
  it('never splits a marker inside a mixed attribute value', async () => {
    const source =
      '<span class="badge {{#if cur}}text-bg-success{{else if fut}}text-bg-info{{else}}text-bg-light{{/if}}"></span>';
    const output = await format(source, 60);

    expect(output).not.toMatch(/\{\{else if\s*$/m);
    expect(output).toContain('{{else if fut}}');
  });

  it('still breaks a value that is a single call', async () => {
    const output = await format('<a title="{{t \'k\' billed=amount currency=symbol}}">x</a>', 40);

    expect(output.split('\n').every((line) => line.length <= 40)).toBe(true);
  });
});

describe('whitespace control markers survive', () => {
  it.each([
    '{{#if ok~}}x{{~else~}}y{{~/if}}',
    '{{~#each xs~}}{{x}}{{~/each~}}',
  ])('%j', async (source) => {
    await expectStable(source, `${source}\n`);
  });
});

describe('blocks in attribute position', () => {
  it.each([
    '<span\n  {{#if d}}\n    data-bs-toggle="tooltip"\n    title="{{t \'k\'}}"\n  {{/if}}\n>x</span>',
    '<input\n  {{#if a}}\n    type="text"\n    placeholder="HH:MM"\n  {{else}}\n    type="number"\n    min="0"\n  {{/if}}\n>',
  ])('keeps one attribute per line when the author wrote it that way', async (source) => {
    await expectStable(source, `${source}\n`);
  });
});

/* Breakability is a property of each section, not of the block as a whole. Read whole-block, a
 * newline in *one* branch unwraps every other branch with it, spreading `{{#if a}} x {{else}}`
 * across three lines. That makes `{{#if a}}` standalone and changes the whitespace Handlebars
 * strips around it - the very thing the one-liner rule exists to prevent. */
describe('a section the author kept on one line stays on one line', () => {
  it.each([
    ['{{#if a}} x {{else}}\ny\n{{/if}}', '{{#if a}} x {{else}}\n  y\n{{/if}}\n'],
    ['{{#if a}}\nx\n{{else}} y {{/if}}', '{{#if a}}\n  x\n{{else}} y {{/if}}\n'],
    [
      '{{#if a}} x {{else if b}}\ny\n{{else}} z {{/if}}',
      '{{#if a}} x {{else if b}}\n  y\n{{else}} z {{/if}}\n',
    ],
  ])('%j', async (source, expected) => {
    await expectStable(source, expected);
  });
});

describe('the whole corpus surface', () => {
  it('handles every block prefix', async () => {
    const prefixes = [
      '{{#if a}}x{{/if}}',
      '{{^a}}x{{/a}}',
      '{{#> p}}x{{/p}}',
      "{{#*inline 'n'}}x{{/inline}}",
      '{{$s}}x{{/s}}',
    ];

    for (const source of prefixes) {
      await expect(format(source)).resolves.toBe(`${source}\n`);
    }
  });
});
