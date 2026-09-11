# @falsefalse/prettier-plugin-handlebars

A Prettier plugin for classic Handlebars templates with mixed HTML markup.

It is **opinionated**: it exposes no options of its own, only Prettier's core `printWidth`,
`tabWidth` and `useTabs`. Everything else is a decision the formatter has already
made.

## The rule everything follows

> Whitespace that renders belongs to the author. Whitespace that does not belongs to the
> formatter.

Between two siblings, whitespace reaches the page, so it is reproduced exactly — a space stays a
space, a newline stays a newline, a run of blank lines collapses to one. The formatter never
invents a gap the author did not write, and never drops one they did.

Inside a tag or a mustache, whitespace never reaches the page, so it is the formatter's: it is
normalised, and driven by width, all-or-nothing.

Two consequences worth stating plainly:

- **A one-liner stays a one-liner.** `{{#if a}}x{{else}}y{{/if}}` is one line because the author
  wrote it as one line, not because it happens to fit.
- **Anything the author broke stays broken.** Reflowing it would move rendered whitespace.

## Install

```bash
npm install --save-dev prettier @falsefalse/prettier-plugin-handlebars
```

```js
/** @type {import("prettier").Config} */
module.exports = {
  plugins: ['@falsefalse/prettier-plugin-handlebars'],
  overrides: [{ files: ['*.hbs', '*.handlebars'], options: { parser: 'handlebars' } }],
};
```

The `overrides` entry is what makes Prettier pick this parser; without it `.hbs` files are either
skipped or handed to the HTML parser. See [docs/EDITOR_SETUP.md](./docs/EDITOR_SETUP.md).

## What it formats

- HTML elements, void elements, custom elements, comments, `pre` / `textarea` / `script` / `style`
- `{{mustache}}`, `{{{triple}}}`, `{{! comments }}`, `{{!-- block comments --}}`
- block helpers, `{{else}}`, `{{else if …}}`, inverted `{{^…}}`
- partials `{{> name}}`, dynamic partials `{{> (lookup . "n")}}`, block partials `{{#> layout}}`
- inline partials `{{#*inline "name"}}`, decorators `{{*log}}`
- Mustache inheritance — `{{< layout}}`, `{{$block}}`
- raw blocks `{{{{raw}}}}…{{{{/raw}}}}`
- whitespace control markers, `{{~v~}}`, `{{~#if a~}}`
- Handlebars inside attribute values, and blocks in attribute position
- hash params written `k=v`, `k= v` or `k = v`, printed consistently
- subexpressions to any depth, broken by width all the way down
- `prettier-ignore`, `prettier-ignore-start` / `-end`

## Unclosed input is rejected

Everything that opens must close. There is no recovery: a formatter that guesses at a missing
`}}` prints markup the author did not write, and one that passes a mismatched tag through leaves
the rest of the file unformatted with nothing to show for it.

```
$ prettier --write page.hbs
[error] page.hbs: SyntaxError: unclosed tag: expected </span> (3:3)
[error]   1 | <div>
[error]   2 |   <p>x</p>
[error] > 3 |   <span>y
[error]     |   ^^^^^^
[error]   4 | </div>
```

The error carries a source range, so editors can put the cursor on it.

This includes the HTML spec's optional end tags: `<ul><li>a<li>b</ul>` is rejected. One rule with
no list of exceptions beats a list of exceptions that has to be kept in step with the spec.

What is checked is structure: delimiters balance, tags nest, a block matches its own closer —
not Handlebars' expression grammar. `{{}}`, `{{{x}}}}` and `{{foo xa"y}}` are all
delimiter-balanced, so they pass through unchanged for Handlebars itself to reject at compile
time. The formatter does not make them worse, and it is not a second implementation of the
language.

### When the markup only balances at render time

Two escape hatches, in order of preference.

Hide the markup behind a call, so the parser sees balanced source and the browser still gets what
you meant:

```hbs
{{#if twoColumns}}{{{concat '<div class="row">'}}}{{/if}}
  …
{{#if twoColumns}}{{{concat '</div>'}}}{{/if}}
```

Or fence the region off entirely. Nothing inside is parsed, so nothing inside can be rejected:

```hbs
{{! prettier-ignore-start }}
<div>deliberately unbalanced
{{! prettier-ignore-end }}
```

## Options

None. `printWidth`, `tabWidth` and `useTabs` are read from Prettier's core config; this plugin
adds nothing. `singleQuote` is **ignored** - quoting is part of the opinion.

Quotes are `"` around an HTML attribute value and `'` around a string literal in a mustache:

```hbs
<div class="card" title="{{t 'card.title'}}">{{t 'card.body' count=n}}</div>
```

The two are complementary, so a literal inside an attribute already wears the quote the attribute
did not and neither has to give way. Both still yield to the quote they sit inside and to
whichever one needs no escaping, so `{{t "it's"}}` keeps its double quote. A literal inside a
block in attribute position, `<img {{#if m}}alt="{{t 'k'}}"{{/if}}>`, keeps the quote the author
gave it: there the enclosing quote is only half of a text node, so no reader downstream can tell
what it is.

## Development

```bash
npm ci
npm run check   # build + tests + both fuzz gates
```

`npm run check` runs the test suite plus two fuzz gates, each two-sided: every generated case
must format idempotently, without losing source, and **without changing what the template
renders** — compiled with the real Handlebars runtime, not approximated. Every malformed case
must be refused with a location.

`scripts/run-property-gate.mjs` checks the same properties over a real corpus:

```bash
npm run corpus:gate -- --git ../your-repo --width 95 path/to/templates
```

The last gate is a person reading the diff the formatter would produce. The property gates prove
correctness; they cannot see bad taste, which is the failure mode that actually matters here.

[docs/REWRITE-PLAN.md](./docs/REWRITE-PLAN.md) is the design record — why the printer looks like
this, and what the previous one got wrong.

## Docs

- [Editor setup](./docs/EDITOR_SETUP.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Printer rewrite plan](./docs/REWRITE-PLAN.md) — the design record
