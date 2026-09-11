# Troubleshooting

## Prettier does not format `.hbs` files

Almost always a resolution problem, not a formatting one. Prettier will not pick a plugin's parser
for an extension unless you say so:

```js
/** @type {import("prettier").Config} */
module.exports = {
  plugins: ['@falsefalse/prettier-plugin-handlebars'],
  overrides: [{ files: ['*.hbs', '*.handlebars'], options: { parser: 'handlebars' } }],
};
```

Check, in order:

1. `npx prettier --check "**/*.{hbs,handlebars}"` — the terminal is the source of truth. If this
   works and the editor does not, the problem is editor resolution; see
   [EDITOR_SETUP.md](./EDITOR_SETUP.md).
2. `.prettierignore` does not cover the files.
3. The plugin resolves from the project, not a global install: `npm ls prettier`.

In a pnpm or monorepo layout the plugin may not be hoisted where Prettier looks. Give it an
explicit path:

```js
plugins: [require.resolve('@falsefalse/prettier-plugin-handlebars')];
```

## Prettier picks the HTML parser instead

The `overrides` entry is missing, or a broader entry above it already claimed `*.hbs`. Prettier
applies the last matching override, so put the Handlebars one last.

## `SyntaxError: unclosed tag: expected </div> (12:3)`

Not a plugin bug — the template is malformed and the plugin refuses to guess. See
[the README](../README.md#malformed-input-is-rejected) for the full list of what is rejected and
the two escape hatches.

The common surprises:

- **Optional end tags are not optional here.** `<li>`, `<td>`, `<p>` and friends must be closed,
  even though the HTML spec lets you omit them.
- **`{{#*inline "name"}}` closes with `{{/inline}}`**, not `{{/name}}`.
- **A typo'd closer reports at the opener.** `{{#if a}}x{{/unless}}` says "unclosed block:
  expected `{{/if}}`" and points at the `{{#if}}`, because that is where the parser knows
  something is wrong. Crossed constructs report at the closer, which is the more useful place:
  `{{#each xs}}{{#if a}}x{{/each}}{{/if}}` points at `{{/each}}`.
- **A missing quote swallows the tag.** `<div class="foo>` reports "unterminated tag: expected
  `'>'`" — the quote is what actually went wrong.

## A block of markup must stay byte-for-byte

```hbs
{{! prettier-ignore }}
<div   class="keep   exactly"></div>
```

Or a range, which is also the escape hatch for markup that is deliberately unbalanced:

```hbs
{{! prettier-ignore-start }}
<script>
  window.data = {{ rawJson }};
</script>
{{! prettier-ignore-end }}
```

## The formatter left my file alone and I expected it to change something

It probably did the right thing. The formatter reproduces whitespace between siblings exactly, so
a template that is already consistent with the author's own line breaks has nothing to change. It
only reflows inside tags and mustaches, and only when a line exceeds `printWidth`.

Conversely, if you want a block joined onto one line, join it yourself — the formatter will keep
it that way. It will not join lines you separated.

## Debug checklist

1. `npx prettier --check "**/*.{hbs,handlebars}"`
2. `npm ls prettier @falsefalse/prettier-plugin-handlebars`
3. `.prettierignore` does not cover the files
4. The editor uses the workspace Prettier, not a bundled one

If none of that explains it,
[open an issue](https://github.com/falsefalse/prettier-plugin-handlebars/issues) with the smallest
template that reproduces the problem and the Prettier version you are on.
