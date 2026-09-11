import { describe, expect, it } from 'vitest';
import prettier from 'prettier';
import { parse } from '../src/parser';
import { TemplateSyntaxError } from '../src/errors';
import * as plugin from '../src/plugin';

function failure(source: string): TemplateSyntaxError {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof TemplateSyntaxError) {
      return error;
    }

    throw error;
  }

  throw new Error(`expected ${JSON.stringify(source)} to be rejected`);
}

/**
 * A formatter that guesses at a missing delimiter prints markup the author did not write, and one
 * that passes a mismatched tag through leaves the rest of the file unformatted with nothing to
 * show for it. Every one of these used to do one or the other, silently.
 */
describe('malformed templates are rejected', () => {
  it.each([
    ['unclosed tag', '<div>\n  <span>x</span>\n', 'unclosed tag: expected </div>'],
    ['unclosed nested tag', '<div>\n  <span>x\n</div>', 'unclosed tag: expected </span>'],
    ['stray close tag', '<div>x</div>\n</div>', 'unexpected </div>: no tag is open'],
    ['crossed tags', '<div><span>x</div></span>', 'unexpected </div>: expected </span>'],
    ['void element closed', '<br></br>', '<br> is a void element and cannot be closed'],
    ['unterminated tag', '<div class="foo>x</div>', "unterminated tag: expected '>'"],
    ['unterminated close tag', '<div>x</div', "unterminated tag: expected '>'"],
    ['unclosed block', '{{#if a}}\n  x\n', 'unclosed block: expected {{/if}}'],
    ['mismatched block close', '{{#if a}}x{{/unless}}', 'unclosed block: expected {{/if}}'],
    ['stray block close', 'x\n{{/if}}', 'unexpected {{/if}}: no block is open'],
    ['extra block close', '{{#if a}}x{{/if}}{{/unless}}', 'unexpected {{/unless}}: no block is open'],
    ['crossed blocks', '{{#if a}}{{#unless b}}x{{/if}}{{/unless}}', 'unexpected {{/if}}: expected {{/unless}}'],
    ['unclosed inverted block', '{{^a}}x', 'unclosed block: expected {{/a}}'],
    ['unclosed block partial', '{{#> layout}}\n  <main>x</main>', 'unclosed block: expected {{/layout}}'],
    ['unclosed inline decorator', '{{#*inline "n"}}x', 'unclosed block: expected {{/inline}}'],
    ['unterminated raw block', '{{{{raw}}}}x', 'unterminated raw block: expected {{{{/raw}}}}'],
    ['mismatched raw block', '{{{{raw}}}}x{{{{/other}}}}', 'unterminated raw block: expected {{{{/raw}}}}'],
    ['unterminated ignore region', '{{! prettier-ignore-start }}x', 'unterminated prettier-ignore region'],
    ['unterminated html comment', '<!-- x', "unterminated HTML comment: expected '-->'"],
    ['unterminated mustache', '{{foo', 'unterminated {{: expected }}'],
    ['unterminated triple mustache', '{{{foo', 'unterminated {{{: expected }}}'],
    ['unterminated comment', '{{! x', 'unterminated {{!: expected }}'],
    ['unterminated block comment', '{{!-- x', 'unterminated {{!--: expected --}}'],
  ])('%s', (_name, source, message) => {
    expect(failure(source).message).toContain(message);
  });

  /* We close optional end tags in this house, so the HTML spec's implicit closes are errors too:
   * one rule, no list of exceptions to keep in step with the spec. */
  it.each(['<ul><li>a<li>b</ul>', '<table><tr><td>a<td>b</tr></table>', '<p>a<p>b'])(
    'rejects an implicit end tag: %j',
    (source) => {
      expect(() => parse(source)).toThrow(/unclosed tag/u);
    },
  );
});

/* An editor puts the cursor where `loc` says, so it has to point at the construct that is wrong
 * rather than at the end of the file. */
describe('errors carry the offending place', () => {
  it('points at the tag that was never closed', () => {
    const error = failure('<div>\n  <p>x</p>\n  <span>y\n</div>');

    expect(error.loc).toEqual({ start: { line: 3, column: 3 }, end: { line: 3, column: 9 } });
    expect(error.message).toContain('(3:3)');
  });

  it('points at the closer, not the opener, when the closer is the surprise', () => {
    expect(failure('{{#each xs}}\n  {{#if a}}x{{/each}}\n{{/if}}').loc?.start).toEqual({ line: 2, column: 13 });
  });

  it('counts lines from the whole file, not from the enclosing node', () => {
    expect(failure('<div>\n</div>\n\n\n{{/if}}').loc?.start).toEqual({ line: 5, column: 1 });
  });
});

describe('what stays legal', () => {
  it.each([
    '<div><span>x</span></div>',
    '<br><img src="a"><input>',
    '<x-widget a="1" />',
    '<script>if (a<b) { c("</div>"); }</script>',
    '<style>.a > .b { color: red }</style>',
    '<pre>\n  a < b\n</pre>',
    '<!DOCTYPE html>\n<html><body>x</body></html>',
    '<!-- </div> -->',
    '<div data-x="a<b">y</div>',
    '{{#if a}}x{{else if b}}y{{else}}z{{/if}}',
    '{{#each xs as |x|}}{{x}}{{/each}}',
    '{{{{raw}}}}<div>{{x}}{{{{/raw}}}}',
    '{{! prettier-ignore-start }}<div   a=1>{{! prettier-ignore-end }}',
    '<div {{#if a}}hidden{{/if}}>x</div>',
  ])('%j', (source) => {
    expect(() => parse(source)).not.toThrow();
  });
});

/* Rejecting malformed input is only tolerable because there is a way to say "I meant that". */
describe('the escape hatches still work', () => {
  it('leaves an ignored region unparsed, so nothing in it can be rejected', async () => {
    const source = '{{! prettier-ignore-start }}\n<div>oops\n{{! prettier-ignore-end }}\n<p>x</p>';

    await expect(
      prettier.format(source, { parser: 'handlebars', plugins: [plugin as never] }),
    ).resolves.toBe(`${source}\n`);
  });

  it('leaves the node after a prettier-ignore alone, malformed or not', async () => {
    const source = '{{! prettier-ignore }}\n<div    a=1>x';

    await expect(
      prettier.format(source, { parser: 'handlebars', plugins: [plugin as never] }),
    ).resolves.toBe(`${source}\n`);
  });

  /* How the corpus writes markup that only balances at render time - see cost_centers_fields.hbs. */
  it('accepts conditional markup hidden behind a call', () => {
    const source = '{{#if a}}{{{concat "<div>"}}}{{/if}}x{{#if a}}{{{concat "</div>"}}}{{/if}}';

    expect(() => parse(source)).not.toThrow();
  });
});

/* Prettier turns `loc` into a code frame; that is what makes the failure readable in a terminal
 * and jumpable in an editor. */
describe('prettier surfaces the failure', () => {
  it('renders a code frame pointing at the offending line', async () => {
    const attempt = prettier.format('<div>\n  <span>y\n</div>', {
      parser: 'handlebars',
      plugins: [plugin as never],
    });

    await expect(attempt).rejects.toThrow(/unclosed tag: expected <\/span> \(2:3\)/u);
    await expect(attempt).rejects.toThrow(/> 2 \|\s+<span>y/u);
  });

  /* Editors read the position back out of the CLI's stderr rather than out of `loc`, and they
   * match on the plain name: JsPrettier for Sublime Text wants `: SyntaxError: <msg> (line:col)`
   * and puts the cursor nowhere if the name is anything else. */
  it('names itself the way editors grep for', () => {
    const error = failure('{{#if a}}\n  x\n');
    const stderr = `[error] page.hbs: ${error.name}: ${error.message}`;

    expect(stderr).toMatch(/^.+?:\s(?:SyntaxError):\s(?<message>.+) \((?<line>\d+):(?<col>\d+)\)/mu);
  });
});
