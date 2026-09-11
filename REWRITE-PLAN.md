# Printer rewrite plan

Status: in progress (phases 0-6.3 done). Branch: `feat/printer-v2`, cut from the tip of `master`.
`feat/style-options` stays as the record of what not to do.

## 1. What went wrong, precisely

One root cause explains every bug in this session.

`src/parser.ts:351-378` throws away whitespace-only text runs shorter than two newlines:

```ts
const trimmed = rawValue.trim();
if (trimmed.length > 0) {
  /* keeps `value` trimmed, stashes edges in leadingWhitespace/trailingWhitespace */
} else {
  const blankLines = Math.max(newlineCount - 1, 0);
  if (blankLines > 0) { /* only a blank-line marker survives */ }
}
```

So `<a>{{x}}</a>`, `<a> {{x}} </a>` and `<a>\n{{x}}\n</a>` produce the *same* node list.
The printer then has to reconstruct "was there whitespace here?" from `options.originalText`
plus node ranges. Every piece of machinery I added — `sourceSeparatesSiblings`,
`readOpenBoundaryWhitespace`, `boundaryWhitespaceRenders`, `layoutFreeNeighbourElements`,
`isGapLayoutFree`, `ChildEdges` — exists only to compensate for that loss.

The second cause is structural: the printer has two parallel families, `print*` returning Docs
and `stringify*` returning strings. `stringifyNode`, `stringifyMustache`, `stringifyInlineChild`,
`stringifySimpleInlineElement`, `stringifyAttributeValue`, `stringifyCompactClassValue` are all
width-blind. Any path that reaches a `stringify*` silently opts out of `printWidth`. That is
where the 139-char `<a role="tab" ...>` line and the 106-char `title="{{t ...}}"` line came from.

The third is eight competing inline gates in `printElement` (`singleChildCanInline`,
`singleTextLikeChildCanUseInlineTag`, `canInlineSimpleChildren`, `shouldPreserveSimpleInlineText`,
`canInlineMixedChildren`, ...) each with its own, sometimes missing, width check. That is why
output is unpredictable from a diff: which gate fires depends on the child's node type, not on
anything visible in the template.

## 2. The reference implementation

`prettier-hbs` is a fork of Prettier 3.1.7. The Handlebars support is
`src/language-handlebars/printer-glimmer.js` — **791 lines** — plus a patch to `@glimmer/syntax`
that fakes classic-Handlebars constructs into Glimmer nodes:

| construct | hack |
|---|---|
| `{{> partial}}` | `mustacheComment("__uncomment__…__uncomment__")` |
| `{{#> layout}}` | rewritten into a `BlockStatement` with `"> "` glued onto the path |
| block in an attribute value | `TextNode` with `{{` escaped to `{_{` |
| block in attribute position | fake comment pushed onto `currentStartTag.comments` |

**We should not copy those hacks.** Our parser already produces a real classic-Handlebars AST —
that is the one genuine asset in this repo and the reason the plugin exists.

What we should copy is the Glimmer **AST contract**, because it is what makes the 791-line
printer possible:

```
Template
  ElementNode div
    TextNode "a "
    ElementNode b
      TextNode "x"
    TextNode "\n  "      <-- whitespace is a first-class node
    MustacheStatement
```

and the printer's mapping of it:

```js
if (isWhitespaceOnly)  return newlines ? generateHardlines(newlines) : [line];
if (leadingWhitespace) leadBreaks  = newlines ? generateHardlines(n) : [line];
if (trailingWhitespace) trailBreaks = ...;
return [...leadBreaks, fill(getTextValueParts(text)), ...trailBreaks];
```

Whitespace in the source becomes a `line` or a `hardline`. No whitespace becomes nothing.
A `line` prints as either `" "` or `"\n"` — both are whitespace in HTML. So *"output has
whitespace iff the source did"* is guaranteed by construction, not checked by a helper.

## 3. The governing rule

> **Whitespace that renders belongs to the author. Whitespace that does not belongs to the
> formatter.**

| where | renders? | who decides | doc primitive |
|---|---|---|---|
| between siblings | yes | author — preserved exactly | `line`, or `hardline` if the source run held a newline |
| inside a tag, between attributes | no | formatter — width-driven, all-or-nothing | `line` inside one `group` |
| inside a mustache, between params | no | formatter — width-driven, all-or-nothing | `line` inside one `group` |
| inside `<pre>`, `<textarea>`, raw blocks | verbatim | nobody — copied through | literal |

This single table answers every "why did it join / split?" question from this session, and it
delivers the stated goals directly:

- *respect whitespace, never change the render* — row 1 is a structural identity.
- *keep simple one-liners simple* — a source one-liner contains no newline runs, so nothing
  forces a break; the group stays flat if it fits.
- *do not join two different logic things* — a source newline becomes a `hardline`, so things
  the author put on separate lines stay on separate lines. The formatter never re-joins.
- *break everything else into lines* — rows 2 and 3 are one group each, so when a tag or a call
  does not fit, **every** attribute / param breaks, never a partial break.
- *respect line length always* — there is no string path left to bypass `printWidth`.

## 4. Parser changes

Keep `src/parser.ts`'s scaffolding: recursive descent, error recovery, `UnmatchedNode`,
`prettier-ignore`, raw blocks (`{{{{raw}}}}`), dynamic tags, void/raw-text element tables from
`template-format-core`. Two changes.

### 4.1 Whitespace fidelity (the critical one)

- `TextNode` becomes `{ type: 'TextNode', chars: string }` holding the source run **verbatim**.
- Drop `value`, `leadingWhitespace`, `trailingWhitespace`, `blankLines`.
- Emit whitespace-only text nodes instead of discarding them.
- `trimEdgeWhitespace` moves out of the parser; trimming a template's leading/trailing blank
  lines is a printing decision.

New invariant, testable as a property: **concatenating every leaf in source order reproduces the
input byte for byte.** The current parser cannot satisfy this. That test alone would have caught
the entire class of bug.

### 4.2 Structured expressions

Today `params: string[]` and `hash: { key, value }[]` are opaque strings, so
`x=(concat 'b' (upper c))` is one atom that can never break. That defeats "respect line length
always".

Handlebars' own AST cannot be mirrored, because it is lossy in exactly the ways a formatter
cannot afford: `a.[b c].d` reconstructs to `a.b c.d`, `'x'` loses its quote character, `1.50`
becomes `1.5`. So every node carries its own `source` and prints from it. **Structure decides
where to break; it never rewrites what the author wrote.** The single exception is string quotes,
which `singleQuote` governs.

```ts
type Expression = PathExpression | Literal | SubExpression;

interface PathExpression extends SourceRange { type: 'PathExpression'; source: string }
interface Literal extends SourceRange {
  type: 'StringLiteral' | 'NumberLiteral' | 'BooleanLiteral' | 'NullLiteral' | 'UndefinedLiteral';
  source: string;
}
interface SubExpression extends SourceRange {
  type: 'SubExpression';
  source: string;
  path: PathExpression | SubExpression;
  params: Expression[];
  hash: HashPair[];
}
interface HashPair extends SourceRange { key: string; value: Expression }
```

`MustacheBase.path` is `PathExpression | SubExpression`. A subexpression head is only reachable
through a dynamic partial — `{{(a b) c}}` and `{{#(a b)}}` are both parse errors in Handlebars,
so the union stays narrow.

The reader is total: anything it cannot classify becomes a `PathExpression` holding the raw text,
because the formatter has to keep working on templates that are mid-edit.

## 5. Printer design

Greenfield `src/printer.ts`. Doc builders only — **no `stringify*` family, no string
concatenation of node output, ever.** That is a lint-enforceable rule and it removes the entire
width-blind bug class.

```
printProgram      body, joined by the sibling-whitespace rule
printText         whitespace-only -> line|hardlines; else [lead, fill(words), trail]
printElement      group([ '<', tag, indent([line, ...attrs]), ifBreak([softline,'>'], '>') ])
                  + children + closing tag
printAttribute    name, '=', quote, value, quote   (value is a Doc, never a string)
printMustache     group([ open, indent([path, line, params]), softline, close ])
printBlock        open + group([program, inverse-chain, inverse, close])
printPartial      same shape as mustache, '>' prefix
printDecorator    same shape as mustache, '*' prefix
printComment      verbatim, only the delimiter form is normalised
```

Notes on specific traps hit this session:

- **One group per tag.** `printStartingTag` must not wrap attributes in their own inner group.
  That inner group is what produced

  ```
  <button class="btn btn-primary disconnect-perk"
  >{{t '…'}}</button>
  ```

  — the attribute group fit, so only the outer `softline` before `>` broke. Prettier's
  `["<", tag, indent(attributes), ifBreak([softline, ">"], ">")]` has no inner group, so
  attributes and `>` break together.
- **`fill` only for prose.** Attributes, params and hash pairs use `group` + `line` so they break
  all-or-nothing. Only text runs use `fill`, where per-word wrapping is the point.
- **No ancestor sniffing.** No `path.getParentNode()` heuristics like `mustacheInsideBlock`.
  A node's shape must be a function of the node and its own source range.

## 6. Options

Prettier core only: `printWidth`, `tabWidth`, `useTabs`, `endOfLine`, `singleQuote`.
All nine custom options are deleted (`dataAttributeOrder`, `maxEmptyLines`,
`classAttributeSameLine`, `classAttributeLayout`, `attributeOrder`, `voidElementSlash`,
`mustacheSpacing`, `commentSpacing`, `attributeBlockBreak`, `hashParamWrap`).

Baked-in choices, picked to match what `prettier-hbs` emits today so the migration diff on
the target repo stays small:

| decision | choice | why |
|---|---|---|
| attribute order | preserve | reordering is not formatting |
| void elements | `<img>` | matches current corpus |
| mustache padding | `{{value}}` | matches current corpus |
| block comments | `{{! text }}` | matches current corpus |
| class attribute | one line unless it exceeds `printWidth` | no special case for `class` |
| blank lines between siblings | collapse runs to at most one | prettier convention |
| quotes | follow `singleQuote` | core option |

## 7. Testing

Five properties, run over the fuzz generator **and** a real template corpus, not per-case:

1. **Parser tiling** — every child list tiles its container's span, no gaps, no overlaps. Catches
   dropped whitespace directly. Tiling stops at a call's edge, where whitespace belongs to the
   formatter; there the weaker check is that parts stay inside the call, ordered and
   non-overlapping.
2. **Render equivalence** — `render(format(src), data) === render(src, data)` using real
   Handlebars. `test/semantic-render.test.ts` already does this; it becomes the primary gate.
3. **Width** — no output line exceeds `printWidth` unless it is one unbreakable token
   (a long URL, a long string literal). Assert with the exception enumerated, not waived.
4. **Idempotence** — `format(format(x)) === format(x)`.
5. **Differential** — `prettier-hbs` is runnable at
   `--parser glimmer`, and a corpus it has
   already formatted is its output. That gives a free oracle: every divergence
   must be a deliberate, listed improvement.

Plus a syntax-coverage table asserting one case per construct: `{{{triple}}}`, `{{&amp}}`,
`{{{{raw}}}}`, `{{~trim~}}`, `as |block params|`, `@data`, `../parent`, `a.[b c]`, `{{> partial}}`,
`{{#> partial-block}}`, `{{#*inline}}`, `{{* decorator}}`, `{{^inverse}}`, `{{else if}}` chains,
subexpressions, all literal kinds.

### The sixth gate: reading the diffs

The five properties prove correctness. **They cannot catch bad taste, and bad taste is the
actual problem here.** Every defect in this session — the 139-char `<a role="tab">` line, the
dangling `>` on `perk.hbs`, `class="tab-pane …"` exploded across six lines, `<thead>` splitting
while `<td>` joined — passed render equivalence, idempotence and (mostly) width. They were caught
by a person reading a diff of a real template.

So eye review is a gate, not a wrap-up step, and the plan is built to serve it:

- Every printer phase ends with a corpus diff produced and read. Not "run the gates and ship" —
  read the hunks.
- The new printer **throws on node types it does not yet handle**, and the corpus harness reports
  coverage: *"N/M files formattable, all N pass the five properties."* N grows each phase. That
  keeps real diffs in front of us from the first printer phase instead of the last.
- The migration is chunked by directory, not landed as one commit, so the diffs stay
  small enough to actually read.

Typing: `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`, and a test that greps the
printer for `as ` and fails above a fixed budget. Only `AstPath` boundary casts are legitimate
(see the `no-default-type-casts` memory).

## 8. Phases

No adapters, no compatibility shims, no code written in order to be deleted. The old printer is
removed **first**, so nothing downstream needs to be kept artificially alive while the parser
changes shape. Tests move with the code they cover, in the same commit.

The cost of that, stated plainly: **from phase 1 until phase 4 the branch has no working
formatter.** That is the price of not writing throwaway code, and it is why phase 4 is scoped to
come up quickly.

| # | phase | tests | done when |
|---|---|---|---|
| 0 | Branch. Split the fuzz *generator* out of `run-fuzz-check.mjs` so it can drive a parser-only property. Record current corpus numbers. | — | generator is importable; baseline recorded |
| 1 | **Delete** `src/printer.ts`, its tests, the nine options and their plumbing. | deleted with their code | repo builds; `parse` and `src/parser.test.ts` still green; plugin cannot format |
| 2 | Parser: verbatim whitespace text nodes, in place. | `src/parser.test.ts` rewritten in the same commit | tiling property passes on every fuzz case and every corpus file |
| 3 | Parser: structured expressions, subexpressions as real nodes. | parser tests extended in the same commit | tiling still clean; containment holds; literal and recovery tables covered |
| 4 | Printer: program, text, mustache, comment. Throws on anything else. | new suite, written against the new shape | coverage report shows N/M formattable; those N pass all five properties; **first corpus diff read by eye** |
| 5 | Printer: elements and attributes. | extends phase 4 suite | N grows; single tag group verified against the `perk.hbs` shape; diff read |
| 6 | Printer: blocks, partials, decorators, else-chains, raw blocks. | syntax-coverage table | every corpus file formattable; full syntax table green; diff read |
| 6.1 | Simplification pass over `printer.ts`, `expression.ts`, `call-shape.ts`. | unchanged | output byte-identical over the corpus; printer 506 → 441 lines |
| 6.2 | **Refuse malformed input.** Every construct that opens must close; the parser throws with a location instead of recovering silently. | `test/syntax-errors.test.ts`; both fuzz gates become two-sided | corpus still byte-identical; every reject category covered |
| 6.3 | Attribute values are whitespace-significant all the way down, so a block's body in a value is no longer laid out at the printer's indent level. | three in `printer-elements.test.ts`; two fuzz atoms | value bytes survive at any nesting depth; corpus still byte-identical |
| 7 | Differential against `prettier-hbs` on the corpus. | — | every divergence listed and justified as deliberate |
| 8 | Corpus migration, chunked by directory. | — | each chunk reviewed by eye before the next |

Phases 2 and 3 are load-bearing. If the tiling property holds, most of the printer's
difficulty evaporates.

### 8.1 Why phase 6.2 exists

It should have been a goal from the start. `prettier-hbs`, for all its hacks, crashes loudly on
unbalanced markup, and that crash was doing real work as a poor man's validator. This plugin
recovered instead, in three flavours, all silent:

| shape | what it did | example |
|---|---|---|
| local recovery | opener became a raw node; the rest of the file still parsed | `<div>` never closed |
| swallow to EOF | everything from the opener became one verbatim node — indistinguishable from "the plugin chose not to touch this file" | a missing `"` in one attribute; a typo'd `prettier-ignore-end` |
| silent completion | **the formatter wrote the closing delimiter the author did not** | `{{foo` → `{{foo}}` |

The third breaks §3 outright: it changes what renders. It was invisible because the property
gates only run over well-formed corpus files.

The rule is now one rule, with no exceptions to keep in step with the HTML spec: **everything
that opens must close.** That includes the spec's optional end tags — `<li>`, `<td>`, `<p>` —
because a list of exemptions is a maintenance surface, and the corpus already closes them
(no corpus file relied on an implicit close).

Escape hatches, both already in use and both preserved:

- `{{{concat '<div class="row">'}}}` for genuinely conditional markup, e.g.
  `shared/cost_centers_fields.hbs`
- `{{! prettier-ignore }}` / `{{! prettier-ignore-start }}` … `{{! prettier-ignore-end }}` for a
  region to be left alone; nothing inside is parsed, so nothing inside can be rejected

`UnmatchedNode` keeps only its four honest verbatim jobs: closed raw blocks, closed ignore
regions, dynamic elements, unsupported mustache kinds. `shouldPreserveUnclosedBlockRemainder`
existed only to choose between the first two shapes above and is gone.

### 8.2 Why phase 6.3 exists

An attribute value's text was emitted as a plain JS string holding literal `\n`. Prettier's doc
printer copies those through without learning that a line ended, so it never resets its column. A
block in the same value emitted real `hardline`s, which *do* re-indent — to the printer's own doc
level, which has nothing to do with the column the value sits at. The two halves of one value were
laid out by two unrelated notions of "what column am I at":

```hbs
<div class="            →  <div
        a                    class="
        {{#if x}}                    a          ← author's column, kept
          b                          {{#if x}}  ← author's column, kept
        {{/if}}                b                ← printer's indent, 4
"></div>                     {{/if}}            ← printer's indent, 2
```

That is a §3 violation: for `class` the browser re-tokenises and nothing shows, but for `title`,
`alt` or any `data-*` read back verbatim the rendered string changes.

Three gates missed it independently, which is the part worth remembering:

- **idempotence** — the change happens once and the result is stable, so pass two is a no-op
- **the corpus** — 27 blocks inside attribute values, all single-line, zero multi-line
- **the fuzz corpus** — its one attribute-value atom was single-line too

The fix is one rule rather than a special case: the parser marks every text node inside an
attribute value `preserveWhitespace`, at any depth, because every space in a value renders. The
printer already knows what to do with that flag — `literalline`, which resets to column 0 and
leaves trailing spaces alone — so `printAttribute` stopped special-casing text and routes every
part through `printAny`. Prettier now also sees where the value's lines end, so width measurement
over multi-line values is correct for the first time.

## 9. Risks

- **No working formatter for phases 1-3.** Accepted deliberately, in exchange for zero throwaway
  code. Mitigation is scope, not shims: phase 4 is small on purpose, and the throw-on-unknown
  coverage report means real output is back under review as early as possible.
- **Subexpression parsing is the one genuinely new piece of code.** Contained, but it needs its
  own fuzz coverage from the phase it lands in.
- **`fill` semantics for CJK / long words** — inherited from prettier's `getTextValueParts`; copy
  their approach rather than inventing one.
- **Markup split across partials** — `{{> header}}` opens a `<div>`, `{{> footer}}` closes it —
  is a hard failure under phase 6.2 and cannot be fixed by closing a tag. Not present in the
  corpus. `prettier-ignore` is the escape hatch if it ever comes up.
- **Taste regressions are invisible to the gates.** The only defence is §7's sixth gate. If a
  phase ends without someone having read its corpus diff, that phase is not done.
