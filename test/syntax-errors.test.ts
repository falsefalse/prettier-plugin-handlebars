import { describe, expect, it } from 'vitest';
import prettier from 'prettier';
import { parse } from '../src/parser';
import { TemplateSyntaxError } from '../src/core/errors';
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
 * show for it. Each of these is a shape where doing either would be silent.
 */
describe('malformed templates are rejected', () => {
  it.each([
    ['unclosed tag', '<div>\n  <span>x</span>\n', 'unclosed tag: expected </div>'],
    ['unclosed nested tag', '<div>\n  <span>x\n</div>', 'unclosed tag: expected </span>'],
    ['stray close tag', '<div>x</div>\n</div>', 'unexpected </div>: no tag is open'],
    ['crossed tags', '<div><span>x</div></span>', 'unexpected </div>: expected </span>'],
    ['void element closed', '<br></br>', '<br> is a void element and cannot be closed'],
    ['unterminated tag', '<div class="foo>x</div>', "unterminated tag: expected '>'"],
    ['unquoted value holding both quotes', '<div title=a"b\'c>x</div>', 'cannot contain both quote characters'],
    [
      'quoted value holding both quotes',
      '<div class="{{t \'a\' "b"}}"></div>',
      'cannot contain both quote characters',
    ],
    ['unterminated close tag', '<div>x</div', "unterminated tag: expected '>'"],
    /* The input running out mid-tag is the same fault whether or not the author left a space
     * after the tag name; reading past the end reported it as `unexpected undefined`. */
    ['tag head running out of input', '<div\n', "unterminated tag: expected '>'"],
    ['tag head running out mid-attribute', '<div a=', "unterminated tag: expected '>'"],
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
    /* Handlebars' lexer takes `{{{{/raw}}}}` and nothing else - a tilde or a space inside the
     * closer is an error there, so it is one here. Two hand-written patterns for this disagreed. */
    ['tilde in a raw block closer', '{{{{raw}}}}x{{{{~/raw}}}}', 'unterminated raw block: expected {{{{/raw}}}}'],
    ['spaces in a raw block closer', '{{{{raw}}}}x{{{{ / raw }}}}', 'unterminated raw block: expected {{{{/raw}}}}'],
    ['unterminated ignore region', '{{! prettier-ignore-start }}x', 'unterminated prettier-ignore region'],
    ['unterminated html comment', '<!-- x', "unterminated HTML comment: expected '-->'"],
    ['unterminated mustache', '{{foo', 'unterminated {{: expected }}'],
    /* The tail happens to end in `}}`, which is how the old string-matching check reported this
     * as terminated - and the printer then emitted `{{foo "bar}}}}`, inventing a delimiter. */
    ['unterminated mustache holding a quote', '{{foo "bar}}', 'unterminated {{: expected }}'],
    ['unterminated mustache after a valid one', '{{a}}{{b "c}}', 'unterminated {{: expected }}'],
    ['unterminated triple mustache', '{{{foo', 'unterminated {{{: expected }}}'],
    ['unterminated comment', '{{! x', 'unterminated {{!: expected }}'],
    ['unterminated block comment', '{{!-- x', 'unterminated {{!--: expected --}}'],
  ])('%s', (_name, source, message) => {
    expect(failure(source).message).toContain(message);
  });

  /* HTML's attribute-name state ends only at whitespace, `/`, `>` or `=`. Reading a narrower
   * charset sent `parseTag` down a branch that stepped over the character and carried on, so
   * the author's markup was quietly deleted rather than reported. */
  it.each([
    '<div @click="go">x</div>',
    '<div (click)="go()">x</div>',
    '<div data-x.y="1">x</div>',
    '<div :bound="b" #ref v-bind:z="z">x</div>',
    '<div class="a" %weird>x</div>',
  ])('keeps every character of an unusual attribute name: %j', async (source) => {
    expect(await prettier.format(source, { parser: 'handlebars', plugins: [plugin] })).toBe(`${source}\n`);
  });

  it.each([
    ['a value with no name', '<div ="x">y</div>', 'unexpected = in <div>'],
    ['a bare quoted string', '<div "foo">y</div>', 'unexpected " in <div>'],
    ['a stray slash', '<div / class=x>y</div>', 'unexpected / in <div>'],
  ])('rejects %s rather than skipping the character', (_name, source, message) => {
    expect(failure(source).message).toContain(message);
  });

  /* One quote kind is fine - the printer wraps the value in the other one - and a quote inside a
   * mustache is a string literal, not a delimiter. Rejecting every quote flagged two valid
   * corpus files. Both kinds together is the unprintable case, quoted or not: the value reader
   * skips over mustaches to find the closing quote, so it accepts input a browser cuts short. */
  it.each([
    ['<div title=a"b>x</div>', '<div title=\'a"b\'>x</div>\n'],
    ["<div title=a'b>x</div>", '<div title="a\'b">x</div>\n'],
    ["<img accept={{mimefor 'x'}}>", '<img accept="{{mimefor \'x\'}}">\n'],
  ])('quotes an unquoted value that holds one quote kind: %j', async (source, expected) => {
    expect(await prettier.format(source, { parser: 'handlebars', plugins: [plugin] })).toBe(expected);
  });

  /* The block scanner reads raw text looking for `{{/name}}`, so what it must and must not step
   * over is decided by Handlebars, not by HTML. It does not parse a raw block's body, so a
   * `{{#if}}` in there opens nothing - but it has never heard of an HTML comment or a script,
   * and `{{#if a}}<!-- {{#if b}} -->{{/if}}` is a template it rejects outright. */
  it.each([
    ['a block opened inside a raw block', '{{#if a}}{{{{raw}}}}{{#if b}}{{{{/raw}}}}{{/if}}'],
    ['a block closed inside a raw block', '{{#each xs}}{{{{raw}}}}{{/each}}{{{{/raw}}}}{{/each}}'],
    ['an open delimiter in a string literal', "{{#if (eq a '{{')}}x{{/if}}"],
    ['a close delimiter in a string literal', "{{#if (eq a '}}')}}x{{/if}}"],
  ])('accepts %s', async (_name, source) => {
    expect(await prettier.format(source, { parser: 'handlebars', plugins: [plugin] })).toBe(`${source}\n`);
  });

  it.each([
    ['an HTML comment', '{{#if a}}<!-- {{#if b}} -->{{/if}}'],
    ['a script body', '{{#if a}}<script>var s = "{{#if b}}";</script>{{/if}}'],
  ])('still refuses a block left open inside %s, as Handlebars does', (_name, source) => {
    expect(failure(source).message).toContain('unclosed block');
  });

  /* Three shapes a browser accepts, so this must too. `/` only ends an unquoted value
   * when it is `/>`... which it never is, because HTML's unquoted-value state ends at
   * whitespace or `>` and nowhere else. Tag names ignore case. And raw text ends at `</tag`
   * only when the name really ends there. */
  it.each([
    ['<img src=/a/b/>', '<img src="/a/b/">\n'],
    ['<a href=/path/>t</a>', '<a href="/path/">t</a>\n'],
    ['<DIV>x</div>', '<DIV>x</div>\n'],
    ['<Div><SPAN>y</span></dIV>', '<Div><SPAN>y</span></dIV>\n'],
    ['<script>var s = "</scriptx>";</script>', '<script>var s = "</scriptx>";</script>\n'],
    ['<script>a</SCRIPT>', '<script>a</SCRIPT>\n'],
  ])('accepts %j, as a browser does', async (source, expected) => {
    expect(await prettier.format(source, { parser: 'handlebars', plugins: [plugin] })).toBe(expected);
  });

  /* The close tag's name has to end where the open tag's does. Comparing only its first
   * `tag.length` characters meant `</bdi>` closed a `<b>` and `di` was deleted from the source,
   * so the error - if one came at all - pointed at the next, well-formed close tag. */
  it.each([
    ['<b>x</bdi></b>', 'unexpected </bdi>: expected </b>'],
    ['<p>a</pre></p>', 'unexpected </pre>: expected </p>'],
    ['<b>x</bdi>', 'unclosed tag: expected </b>'],
  ])('reports the close tag the author actually wrote: %j', (source, message) => {
    expect(failure(source).message).toContain(message);
  });

  /* `</script >` is a real end tag - whitespace after the name is allowed - so a script body
   * holding one really does close the element early, in a browser too. */
  it('still ends raw text at a close tag followed by whitespace', () => {
    expect(failure('<script>var s = "</script >";</script>').message).toContain('unexpected </script>');
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
      prettier.format(source, { parser: 'handlebars', plugins: [plugin] }),
    ).resolves.toBe(`${source}\n`);
  });

  it('leaves the node after a prettier-ignore alone', async () => {
    const source = '{{! prettier-ignore }}\n<div    a=1>x</div>';

    await expect(
      prettier.format(source, { parser: 'handlebars', plugins: [plugin] }),
    ).resolves.toBe(`${source}\n`);
  });

  /* Lookahead must not build real nodes: routing `findMatchingTagClose` and `consumeNextNode`
   * through `parseTag` lets a region written precisely because its markup is unusual be rejected
   * on the way past. Scanning cannot fail, which is the only way the promise holds. */
  it.each([
    ['a hash pair followed by a positional param', '<span {{f a=1 b}}></span>'],
    ['an unquoted value holding both quotes', '<span title=a"b\'c></span>'],
    ['a subexpression that never closes', '<span {{f (g a}}></span>'],
  ])('does not parse an ignored region, so it cannot reject one: %s', async (_name, markup) => {
    const source = `<div>\n{{!-- prettier-ignore-start --}}\n${markup}\n{{!-- prettier-ignore-end --}}\n</div>`;

    await expect(
      prettier.format(source, { parser: 'handlebars', plugins: [plugin] }),
    ).resolves.toContain(markup);
  });

  /* Only the three directives that do something are directives. `prettier-ignore-attribute` was
   * recognised and then never consulted - `parseTag` has no idea it exists - so it silently
   * behaved as `prettier-ignore` and swallowed the whole next node instead of one attribute. */
  it.each(['{{! prettier-ignore-attribute }}', '{{! prettier-ignore-everything }}'])(
    'treats %j as an ordinary comment',
    async (comment) => {
      await expect(
        prettier.format(`${comment}\n<div    a=1>x</div>`, { parser: 'handlebars', plugins: [plugin] }),
      ).resolves.toBe(`${comment}\n<div a="1">x</div>\n`);
    },
  );

  /* `{{! prettier-ignore }}` ignores *the next node*, so it needs to know where that node ends.
   * When the markup is malformed there is no such extent, and the directive is only a comment -
   * the region form is the escape hatch for markup that does not balance. Determining the extent
   * by parsing instead lets an ignored region swallow its container's `</div>` or `{{/if}}`,
   * and lets a directive meant to suppress formatting reject the file. */
  it('does not apply to markup whose extent cannot be determined', () => {
    expect(() => parse('{{! prettier-ignore }}\n<div    a=1>x')).toThrow(/unclosed tag/u);
  });

  it.each([
    ['an element that would swallow its block', '{{#if a}}{{! prettier-ignore }}<div>x{{/if}}', /unclosed tag/u],
    ['crossed tags after the directive', '{{! prettier-ignore }}\n<div><span>x</div></span>', /unexpected <\/span>/u],
  ])('reports the real defect, not one the directive caused: %s', (_name, source, message) => {
    expect(() => parse(source)).toThrow(message);
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
      plugins: [plugin],
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

/**
 * Rejection is only tolerable if it is rejecting the right things. Each of these is valid and
 * must format: reporting one as "unclosed" fails the whole file over a parser bug that recovery
 * would otherwise hide.
 */
describe('valid templates that were once rejected', () => {
  it.each([
    ["an apostrophe in a JS comment", "<script>\n  // it's fine\n  var a = 1;\n</script>"],
    ['an apostrophe in a regex', "<script>var r = /it's/;</script>"],
    ['an apostrophe in a CSS comment', "<style>/* don't */ a{color:red}</style>"],
    ['a backtick in a template literal', '<script>var s = `a`;</script>'],
    ['a tag name in another case', '<SCRIPT>var a=1;</script>'],
    ['prettier-ignore inside an element', '<div>{{! prettier-ignore }}text</div>'],
    ['prettier-ignore with nothing to ignore', '<div>{{! prettier-ignore }}</div>'],
    ['prettier-ignore on its own line', '<div>\n  {{! prettier-ignore }}\n</div>'],
    ['prettier-ignore inside a block', '{{#if a}}{{! prettier-ignore }}{{/if}}'],
    ['the {{^}} inverse shorthand', '{{#if x}}a{{^}}b{{/if}}'],
    ['{{^}} in an each', '{{#each xs}}a{{^}}none{{/each}}'],
  ])('accepts %s', (_name, source) => {
    expect(() => parse(source)).not.toThrow();
  });

  /* Raw text ends at the first `</tag`, exactly as a browser tokenises it - which is why this
   * one *is* malformed: everything after the first `</script>` is markup, and the second one
   * closes nothing. */
  it('still rejects an unescaped </script> in a string', () => {
    expect(() => parse('<script>var t = "</script>";</script>')).toThrow(/no tag is open/u);
  });

  it('accepts it once escaped, the way a browser requires', () => {
    expect(() => parse('<script>var t = "<\\/script>";</script>')).not.toThrow();
  });
});

/* A directive has to be the whole comment. Matching a substring meant any comment mentioning it
 * silently switched formatting off - and `prettier-ignore-start` opened a region that then had
 * to be closed or the file was rejected. */
describe('prettier-ignore is a directive, not a word', () => {
  it('ignores a comment that merely mentions it', async () => {
    const output = await prettier.format("{{!-- do not add prettier-ignore here --}}\n<div   a='1'></div>", {
      parser: 'handlebars',
      plugins: [plugin],
    });

    expect(output).toBe('{{!-- do not add prettier-ignore here --}}\n<div a="1"></div>\n');
  });

  it('still honours the real thing', async () => {
    const source = '{{! prettier-ignore }}\n<div   a=1>x</div>';

    await expect(
      prettier.format(source, { parser: 'handlebars', plugins: [plugin] }),
    ).resolves.toBe(`${source}\n`);
  });
});
