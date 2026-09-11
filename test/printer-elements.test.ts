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

  /* `parseDynamicAttribute` assembles `data-{{x}}` on its own; a later merge step could not tell
   * that apart from two attributes with a space between them, and glued those together too. */
  it('keeps a trailing-dash attribute separate from the mustache after it', async () => {
    await expectStable('<div data- {{key}}>x</div>', '<div data- {{key}}>x</div>\n');
    await expectStable('<span data-{{ control.badge }}></span>', '<span data-{{ control.badge }}></span>\n');
  });

  /* The same reader also handles a dynamic name that carries a value, and a mustache in the
   * middle of one. Both come back as a `RawAttribute` printed verbatim - there is no structure
   * to reflow, and the pieces cannot be separated without changing the attribute's name. */
  it.each([
    '<div data-{{k}}="1">x</div>',
    "<div data-{{k}}='1'>x</div>",
    '<div a{{b}}c=1>x</div>',
    '<div data-{{k}}={{v}}>x</div>',
  ])('keeps a dynamic attribute name with its value: %j', async (source) => {
    await expectStable(source, `${source}\n`);
  });

  /* A block or terminator in attribute position that does not balance. The tag's own extent is
   * already fixed, so being unbalanced is not grounds to reject here; it is kept as a mustache
   * and printed back as written. */
  it.each(['<div {{else}}>x</div>', '<div {{/if}}>x</div>', '<div {{#if a}}>x</div>'])(
    'prints an unbalanced mustache in attribute position verbatim: %j',
    async (source) => {
      await expectStable(source, `${source}\n`);
    },
  );

  it('picks the quote that avoids escaping', async () => {
    await expectStable('<div title=\'He said "hi"\'></div>', '<div title=\'He said "hi"\'></div>\n');
  });

  /* The house quote is not up for negotiation: `singleQuote` is prettier's, and this printer
   * does not read it. Asking for the opposite has to change nothing. */
  it('ignores singleQuote and keeps attribute values double-quoted', async () => {
    const output = await prettier.format("<div title='x'></div>", {
      parser: 'handlebars',
      plugins: [plugin as never],
      singleQuote: true,
    });

    expect(output).toBe('<div title="x"></div>\n');
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

  /* A space here is not the formatter's to add: `<h {{level}}>` is an `<h>` with an attribute,
   * and `</h>` is a different close tag from the one that was written. */
  it.each([
    ['<h{{level}}>Title</h{{level}}>', '<h{{level}}>Title</h{{level}}>\n'],
    ['<div{{attrs}}>x</div>', '<div{{attrs}}>x</div>\n'],
    ['<div{{#if x}} a{{/if}}>x</div>', '<div{{#if x}} a{{/if}}>x</div>\n'],
    ['<div {{attrs}}>x</div>', '<div {{attrs}}>x</div>\n'],
  ])('keeps a mustache glued to the tag name: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  /* HTML's unquoted-value state ends at whitespace or `>`, so the `/` belongs to the value.
   * `scanTag` stopped at the `/>` while `parseAttribute` read through it, and a lookahead that
   * disagrees with the parser about where a tag ends ended a verbatim region mid-tag. */
  it.each([
    ['<a href=/path/>t</a>', '<a href="/path/">t</a>\n'],
    ['{{! prettier-ignore }}\n<a href=/path/>t</a>', '{{! prettier-ignore }}\n<a href=/path/>t</a>\n'],
    ['<div a=/>x</div>', '<div a="/">x</div>\n'],
  ])('reads a `/` in an unquoted value as content: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  /* A quote in an unquoted value is content. Opening one here runs the scan to EOF and takes the
   * rest of the file into a single verbatim node. */
  it('keeps formatting after a dynamic tag holding an apostrophe', async () => {
    await expectStable(
      `<{{tag}} title=it's>x</{{tag}}>\n<div    class="y"   >z</div>`,
      `<{{tag}} title=it's>x</{{tag}}>\n<div class="y">z</div>\n`,
    );
  });

  /* `parseDynamicAttribute` only takes plain mustaches, so a block glued to an attribute name
   * fell through to `readAttributeName`, which ate `data-{{#if` and desynchronised the loop. */
  it.each([
    ['<div data-{{#if a}}x{{/if}}>y</div>', '<div data-{{#if a}}x{{/if}}>y</div>\n'],
    ['<div data-{{> p}}>y</div>', '<div data-{{> p}}>y</div>\n'],
    ['<div data-{{k}}="1">y</div>', '<div data-{{k}}="1">y</div>\n'],
  ])('keeps a block glued to an attribute name: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

  /* Refused outright before: the name reader bailed on the block, `readAttributeName` stopped
   * at `{{`, and the `=` then had no name in front of it. Handlebars accepts every one of
   * these - it does not read HTML, so a block spanning part of a name is just text to it. */
  it.each([
    '<div data-{{#if a}}x{{/if}}="1">y</div>',
    '<div data-{{#if a}}x{{else}}y{{/if}}="1">y</div>',
    '<div data-{{#if a}}{{#if b}}x{{/if}}{{/if}}="1">y</div>',
    '<div data-{{#if a}}x{{/if}}=unquoted>y</div>',
    '<div data-{{#if a}}x{{/if}}="1" b="2">y</div>',
    '<div {{#if a}}x{{/if}}="1">y</div>',
    '<div {{k}}="1">y</div>',
  ])('takes a value on a name a block or mustache runs through: %j', async (source) => {
    await expectStable(source, `${source}\n`);
  });

  /* Which model a dynamic name gets turns on whether it has a static part, and nothing else. A
   * static part makes the mustache part of a name, so the name is kept exactly as written -
   * this pins the block form against the mustache form beside it, both padded. Without a
   * static part the mustache or block stands alone, wrapping whole attributes rather than
   * naming one, and its body is worth formatting. */
  it.each([
    ['<div data-{{  k  }}>y</div>', '<div data-{{  k  }}>y</div>\n'],
    ['<div data-{{#if a}}  x  {{/if}}>y</div>', '<div data-{{#if a}}  x  {{/if}}>y</div>\n'],
    ['<div {{  attrs  }}>y</div>', '<div {{attrs}}>y</div>\n'],
    ['<div {{#if a}}  class="x"  {{/if}}>y</div>', '<div {{#if a}} class="x" {{/if}}>y</div>\n'],
  ])(
    'formats a dynamic attribute only where it is not part of a name: %j',
    async (source, expected) => {
      await expectStable(source, expected);
    },
  );

  it.each([
    ['<div>x</div\n>', '<div>x</div>\n'],
    ['<div>x</div   >', '<div>x</div>\n'],
    ['<DIV>x</div>', '<DIV>x</div>\n'],
  ])('normalises only whitespace in a close tag: %j', async (source, expected) => {
    await expectStable(source, expected);
  });
});

describe('attribute values', () => {
  /* A quote ends the value holding it, so a nested element takes the other one. */
  it.each([
    [`<div class="{{#if a}}<b class='x y'>t</b>{{/if}}"></div>`, false],
    [`<div class='{{#if a}}<b title="x">t</b>{{/if}}'></div>`, true],
  ])('keeps a nested element off the enclosing quote: %j', async (source, singleQuote) => {
    const out = await prettier.format(source, {
      parser: 'handlebars',
      plugins: [plugin as never],
      singleQuote,
    });

    expect(out).toBe(`${source}\n`);
  });


  /* A raw block's body is emitted literally, so reformatting the mustache inside one changes
   * what the value renders. Only the sibling list skipped raw blocks; a value did not. */
  it('copies a raw block through a value untouched', async () => {
    await expectStable(
      '<div class="{{{{raw}}}}{{  x  }}{{{{/raw}}}}">y</div>',
      '<div class="{{{{raw}}}}{{  x  }}{{{{/raw}}}}">y</div>\n',
    );
  });

  /* An ignored region ends in the author's newline. Split off as a gap it let the block around
   * it break, and the printer indented `{{/if}}` into a value where that space renders. */
  it('keeps an ignored region in a value from making its block breakable', async () => {
    const value = '{{#if a}}{{! prettier-ignore }}\nfoo\n{{/if}}';

    await expectStable(`<div class="${value}">y</div>`, `<div\n  class="${value}"\n>y</div>\n`);
  });

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

  /* Whitespace *inside* a mustache never reaches the page, so a call in a value may be
   * reflowed - but an element in one is text the value renders, and breaking its tag head put
   * the printer's own newlines and indentation into a string the author owns. The render oracle
   * saw it; nothing in either corpus had an element inside a value. */
  it('does not break an element inside a value, however long its tag head', async () => {
    const value = '{{#if a}}<span data-aaaa="1" data-bbbb="2" data-cccc="3" data-dddd="4">y</span>{{/if}}';

    await expectStable(`<div class='${value}'></div>`, `<div\n  class='${value}'\n></div>\n`);
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
    ["{{> (lookup . 'name') data=this}}", "{{> (lookup . 'name') data=this}}\n"],
    ["{{*inline 'x'}}", "{{*inline 'x'}}\n"],
    ['{{~*log value~}}', '{{~*log value~}}\n'],
  ])('%j', async (source, expected) => {
    await expectStable(source, expected);
  });
});

describe('recovery', () => {
  /* Every other scanner consults the dialect before treating a `<` as markup; the one looking
   * for a matching close tag did not, so the `<div>` inside a string literal was counted as an
   * open tag and the real `</div>` went to closing it. */
  it.each([
    ["<div>{{t '<div>'}}</div>", "<div>{{t '<div>'}}</div>\n"],
    ["<p>{{t 'a<b'}}</p>", "<p>{{t 'a<b'}}</p>\n"],
    ['<div>{{{{raw}}}}</div>{{{{/raw}}}}</div>', '<div>{{{{raw}}}}</div>{{{{/raw}}}}</div>\n'],
  ])('does not read a `<` inside a mustache as markup: %j', async (source, expected) => {
    await expectStable(source, expected);
  });

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

  /* Same trap one level down: an unterminated `<!` declaration runs to the end of the input,
   * and taking the author's last newline with it makes the printer's own final newline additive. */
  it.each([
    ['<!DOCTYPE html>\n<p>x</p>', '<!DOCTYPE html>\n<p>x</p>\n'],
    ['<!\n', '<!\n'],
    ['<!', '<!\n'],
    ['<!x  \n\n', '<!x\n'],
  ])('is idempotent on markup declarations: %j', async (source, expected) => {
    await expectStable(source, expected);
  });
});
