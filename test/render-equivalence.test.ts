import { describe, expect, it } from 'vitest';
import prettier from 'prettier';
import * as plugin from '../src/plugin';
import { renderDifference, renders } from '../scripts/render.mjs';

async function format(source: string, printWidth = 80): Promise<string> {
  return prettier.format(source, { parser: 'handlebars', plugins: [plugin as never], printWidth });
}

/* These templates avoid HTML, so the only liberty `renders` still grants is a browser's
 * whitespace collapse - the corpus gate's other two tolerances have nothing to act on. */
async function expectSameRender(source: string, printWidth = 80): Promise<void> {
  const formatted = await format(source, printWidth);
  const before = renders(source.trim());
  const after = renders(formatted.trim());

  expect(before).not.toBeNull();
  expect(after, `formatted output no longer compiles:\n${formatted}`).not.toBeNull();
  expect(after, `formatting changed the render:\n${JSON.stringify(formatted)}`).toEqual(before);
}

/**
 * The property the whole rewrite exists for. The gates in `scripts/` check it over the fuzz and
 * real corpora, tolerating the HTML equivalences a browser cannot see; these cases pin the
 * whitespace-exact cases those gates have to let through.
 */
describe('formatting does not change what a template renders', () => {
  /* Handlebars strips the whitespace around a partial, comment or block alone on its line, so a
   * space next to one cannot be allowed to wrap - the space would vanish from the page. */
  it.each([
    'A {{> p}} B',
    'A {{! note }} B',
    'A {{#if x}}y{{/if}} B',
    'A {{#if x}}y{{else}}z{{/if}} B',
    'one {{> p}} two three four five six seven',
  ])('keeps a space next to a standalone-sensitive statement: %j', async (source) => {
    await expectSameRender(source, 8);
  });

  /* Mustaches are not standalone-sensitive, so their gaps stay free to wrap. */
  it('still wraps around a plain mustache', async () => {
    expect(await format('A {{v}} B', 8)).toBe('A {{v}}\nB\n');
  });

  it('still wraps prose word by word', async () => {
    expect(await format('one two three four five six', 10)).toBe('one two\nthree four\nfive six\n');
  });

  /* Breaking an inline block puts its markers alone on their own lines, where Handlebars starts
   * stripping whitespace that used to render. The whole block is an atom, body included. */
  it.each([
    '{{#if ok~}} yes {{~else~}} no {{~/if}}',
    'x {{#if a}} some fairly long body text here {{/if}} y',
    '{{#each items}} {{name}} {{else}} none {{/each}}',
  ])('keeps an inline block inline whatever the width: %j', async (source) => {
    await expectSameRender(source, 20);
  });

  /* An empty `{{else}}` prints nothing, but its `~` markers still strip whitespace. */
  it.each(['{{#if a}}x {{~else~}}{{/if}}', '{{#if a}}x {{~else}}{{/if}}', '{{#if a}} x {{~else~}} {{/if}}'])(
    'keeps whitespace control on an empty else: %j',
    async (source) => {
      await expectSameRender(source);
    },
  );

  /* Splitting on `\s` matched U+00A0 and re-emitted it as a plain space, which is a visible
   * change: a non-breaking space is there to stop the line breaking. */
  it('leaves a non-breaking space alone', async () => {
    const output = await format('<p>a b</p>');

    expect(output).toContain(' ');
    expect(output).toBe('<p>a b</p>\n');
  });

  it('leaves other unicode spaces alone', async () => {
    expect(await format('<p>a b c</p>')).toBe('<p>a b c</p>\n');
  });

  /* Only the value's TextNode parts were checked for quotes, so a quote inside a mustache chose
   * a delimiter that then terminated the attribute early - invalid HTML, silently. */
  it('picks a quote that clears the whole value, mustaches included', async () => {
    expect(await format('<div class=\'{{t "x"}}\'>a</div>')).toBe('<div class=\'{{t "x"}}\'>a</div>\n');
  });

  it('does the same under singleQuote', async () => {
    const output = await prettier.format('<div class="{{t \'x\'}}">a</div>', {
      parser: 'handlebars',
      plugins: [plugin as never],
      singleQuote: true,
    });

    expect(output).toBe('<div class="{{t \'x\'}}">a</div>\n');
  });

  it('still prefers the configured quote when either would do', async () => {
    expect(await format("<div class='{{t x}}'>a</div>")).toBe('<div class="{{t x}}">a</div>\n');
  });
});

/* The corpus gate reports whitespace-amount changes separately from content changes, and holds
 * both at zero. A metric that cannot fail is not a gate, so this pins that it can. */
describe('the whitespace-amount canary has teeth', () => {
  it.each([
    ['a newline that vanishes', '<p>a\nb</p>', '<p>a b</p>', 'whitespace'],
    ['whitespace that vanishes', '<p>a b</p>', '<p>ab</p>', 'render'],
    ['indentation the browser drops', '<div>\n  <b>x</b>\n</div>', '<div>\n    <b>x</b>\n</div>', undefined],
  ])('%s', (_name, before, after, kind) => {
    expect(renderDifference(before, after)?.kind).toBe(kind);
  });
});

/**
 * Known limitation, pinned so it is recorded rather than rediscovered. Handlebars strips the
 * newline after a standalone partial, which turns the *next* line's indentation into rendered
 * content. Indenting an element's children is the formatter's job, so the two collide.
 *
 * It only fires when the formatter changes that indentation, which means only on input that is
 * not already at the formatter's fixpoint - never on a file it has been run over.
 */
describe('known limitation: indentation after a standalone partial', () => {
  it('shows up when un-indented children are indented for the first time', async () => {
    const source = '<section>\n{{> p}}\n<b>x</b>\n</section>';

    expect(renderDifference(source, await format(source))).not.toBeNull();
  });

  it('does not recur once the file is formatted', async () => {
    const formatted = await format('<section>\n{{> p}}\n<b>x</b>\n</section>');

    expect(renderDifference(formatted, await format(formatted))).toBeNull();
  });
});
