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

describe('tags', () => {
  it.each([
    ['<div></div>', '<div></div>\n'],
    ['<img src="a.png">', '<img src="a.png">\n'],
    ['<input disabled>', '<input disabled>\n'],
    ['<x-widget a="1" />', '<x-widget a="1" />\n'],
    ['<input type="text" class="a b" id="x" disabled>', '<input type="text" class="a b" id="x" disabled>\n'],
  ])('keeps a fitting tag on one line: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  /* One group for the whole tag. Grouping the attributes separately would let them fit while
   * the `>` alone drops down, which reads as a stray bracket. */
  it('breaks every attribute at once, with the closing bracket hugging the child', async () => {
    await expectStable(
      '<a role="tab" href="#{{this.id}}" data-target-sel="#{{this.id}}" aria-selected>{{this.label}}</a>',
      '<a\n  role="tab"\n  href="#{{this.id}}"\n  data-target-sel="#{{this.id}}"\n  aria-selected\n>{{this.label}}</a>\n',
    );
  });

  it('never leaves the closing bracket alone on a line', async () => {
    const output = await format('<button class="btn btn-primary disconnect-perk">{{label}}</button>', 40);

    /* `>{{label}}</button>` is fine; a line holding nothing but `>` is the stray-bracket shape. */
    expect(output).not.toMatch(/^\s*>\s*$/m);
    expect(output).toBe('<button\n  class="btn btn-primary disconnect-perk"\n>{{label}}</button>\n');
  });

  it('picks the quote that avoids escaping', async () => {
    await expectStable('<div title=\'He said "hi"\'></div>', '<div title=\'He said "hi"\'></div>\n');
  });

  it('honours singleQuote for attribute values', async () => {
    const output = await prettier.format('<div title="x"></div>', {
      parser: 'handlebars',
      plugins: [plugin as never],
      singleQuote: true,
    });

    expect(output).toBe("<div title='x'></div>\n");
  });
});

/* The governing rule again, now across a tag boundary. */
describe('element children keep the author\'s whitespace', () => {
  it.each([
    ['<div><span>x</span></div>', '<div><span>x</span></div>\n'],
    ['<div> <span>x</span> </div>', '<div> <span>x</span> </div>\n'],
    ['<div>\n  <span>x</span>\n</div>', '<div>\n  <span>x</span>\n</div>\n'],
    ['<a href="/x"><i class="icon"></i></a>', '<a href="/x"><i class="icon"></i></a>\n'],
    ['<div>\n</div>', '<div>\n</div>\n'],
  ])('%j', async (source, expected) => {
    await expectStable(source, expected);
  });

  it('indents nested elements without the closing tags drifting', async () => {
    const source = '<div>\n  <div>\n    <div>\n      <span>x</span>\n    </div>\n  </div>\n</div>';

    await expectStable(source, `${source}\n`);
  });

  it('collapses runs of spaces inside text but keeps a gap a gap', async () => {
    await expectStable('<p>  hello  world  </p>', '<p> hello world </p>\n');
  });
});

describe('attribute values', () => {
  it('reproduces the value text exactly, formatting only the mustaches in it', async () => {
    await expectStable('<a href="/bills/{{bill_id}}/edit">x</a>', '<a href="/bills/{{bill_id}}/edit">x</a>\n');
  });

  /* A block's body inside a value is part of the value: those spaces reach the rendered string.
   * Laying it out at the printer's own indent level - which has nothing to do with the column the
   * value sits at - silently rewrote whitespace the author owns. Neither corpus had a multi-line
   * block in a value, and the change was stable on the second pass, so nothing caught it. */
  it('leaves a multi-line block inside a value exactly as written', async () => {
    const value = '\n    card\n    {{#if primary}}\n      card--primary\n    {{else}}\n      card--plain\n    {{/if}}\n  ';

    await expectStable(`<div\n  class="${value}"\n></div>`, `<div\n  class="${value}"\n></div>\n`);
  });

  /* The value sits at column 0 while the printer is three levels deep; the two must not be
   * confused. The tag itself does break - a value holding hard breaks cannot fit on one line. */
  it('keeps the body at the author\'s column however deep the printer is', async () => {
    const value = '"\n{{#if x}}\n        deep\n{{/if}}\n"';

    await expectStable(
      `<p>\n  <span>\n    <i title=${value}></i>\n  </span>\n</p>`,
      `<p>\n  <span>\n    <i\n      title=${value}\n    ></i>\n  </span>\n</p>\n`,
    );
  });

  it('does not strip trailing spaces inside a value', async () => {
    await expectStable('<div\n  class="a  \n  b"\n></div>', '<div\n  class="a  \n  b"\n></div>\n');
  });

  it('wraps a call in a value that does not fit, since mustache whitespace does not render', async () => {
    const output = await format('<a title="{{t \'k\' billed=amount currency=symbol}}">x</a>', 40);

    expect(output.split('\n').every((line) => line.length <= 40)).toBe(true);
    expect(output).toContain("{{t\n");
  });
});

describe('partials and decorators', () => {
  it.each([
    ['{{> partials/thing}}', '{{> partials/thing}}\n'],
    ['{{> partials/thing param=1}}', '{{> partials/thing param=1}}\n'],
    ['{{> (lookup . "name") data=this}}', '{{> (lookup . "name") data=this}}\n'],
    ['{{*inline "x"}}', '{{*inline "x"}}\n'],
    ['{{~*log value~}}', '{{~*log value~}}\n'],
  ])('%j', async (source, expected) => {
    await expectStable(source, expected);
  });
});

describe('recovery', () => {
  /* A closed raw block is content the author asked to be left alone. Left in the raw text, its
   * trailing newline would be reprinted *and* re-added as the file's line ending, growing the
   * file by one newline on every pass. Unclosed constructs are rejected, not recovered - see
   * syntax-errors.test.ts. */
  it('is idempotent on raw blocks and ignored regions', async () => {
    await expectStable('{{{{raw}}}}<div>{{ notParsed }}</div>{{{{/raw}}}}', '{{{{raw}}}}<div>{{ notParsed }}</div>{{{{/raw}}}}\n');
    await expectStable(
      '{{! prettier-ignore-start }}\n<div   a=1>\n{{! prettier-ignore-end }}',
      '{{! prettier-ignore-start }}\n<div   a=1>\n{{! prettier-ignore-end }}\n',
    );
  });
});
