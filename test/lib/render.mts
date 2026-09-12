/* Renders a template with the real Handlebars runtime, so "formatting never changes what the
 * template renders" can be checked rather than approximated.
 *
 * Nothing here cares what a template *means*, only that two renders of it match, so the data is
 * synthetic. Unknown helpers and partials resolve to a marker instead of throwing, and the
 * conditional builtins are overridden to take a fixed branch rather than consult the data. That
 * makes rendering total over arbitrary input, which is what lets the fuzz corpus drive it. */
import Handlebars from 'handlebars';
import { templateFacts } from './handlebars-facts.mts';

type Branch = 'fn' | 'inverse';
const BRANCHES: Branch[] = ['fn', 'inverse'];

interface PartialFacts {
  literals: Set<string>;
  hashKeys: Set<string>;
}

export type RenderDifference =
  | { kind: 'unrenderable' }
  | { kind: 'render' | 'whitespace'; branch: string; before: string; after: string };

/* Deliberately not imported from `src/core/whitespace.ts`. This file is the oracle the parser is
 * checked against, so it states HTML's rule independently: sharing the constant would let a
 * wrong one be wrong on both sides, and the gate would agree with the bug. Written once here. */
const HTML_WHITESPACE = /[ \t\r\n\f]/u;
const HTML_WHITESPACE_RUN = /[ \t\r\n\f]+/gu;

/* Deduplicated here and nowhere else: a partial is registered once per name, while the format
 * gate needs them in order. Nothing for a source Handlebars cannot parse - the malformed corpus
 * - which is fine, those are never rendered anyway. */
function partialFactsOf(source: string): PartialFacts {
  const facts = templateFacts(source);

  return { literals: new Set(facts?.literals), hashKeys: new Set(facts?.hashKeys) };
}

/**
 * The two bodies a helper may be given, both optional: `helperMissing` is handed neither unless
 * the missing helper was written as a block. `HelperOptions` declares both required, which is
 * true of a builtin and not of this.
 */
type BranchOptions = Partial<Pick<Handlebars.HelperOptions, Branch>>;

/** What Handlebars puts last for `helperMissing`: the call's options, plus the name it missed. */
type MissingHelperOptions = BranchOptions & { name: string };

function environment(source: string, branch: Branch, facts: PartialFacts) {
  const env = Handlebars.create();

  /* Branch by fiat, not by data: every conditional body gets rendered on one pass or the other,
   * so a defect hiding in an `{{else}}` is still visible. */
  const take = function (this: unknown, _context: unknown, options: BranchOptions) {
    const body = options[branch];
    /* Block params have to be supplied even though nothing reads them: `{{#each xs as |a b|}}`
     * makes Handlebars index into the array the caller was supposed to pass, and without one it
     * throws before the body runs - which silently disabled the render check for every case
     * built from that atom. */
    return body ? body(this, { blockParams: [undefined, undefined] }) : '';
  };

  for (const name of ['if', 'unless', 'each', 'with']) env.registerHelper(name, take);
  env.registerHelper('blockHelperMissing', take);
  /* Handlebars passes the call's arguments and puts the options last. A rest parameter cannot
   * say "the last of these is the options", so it is asserted once here rather than re-guessed
   * at every use. */
  env.registerHelper('helperMissing', function (this: unknown, ...args: unknown[]) {
    const options = args[args.length - 1] as MissingHelperOptions;

    return options.fn ? take.call(this, null, options) : `[${options.name}]`;
  });

  /* A decorator is not a helper - `registerHelper` does not cover one, and a missing decorator
   * throws at compile time rather than resolving to a marker the way a missing helper does. */
  for (const name of ['log', 'decorate', 'inline']) {
    env.registerDecorator(name, (program: unknown) => program);
  }

  /* A dynamic head - `{{> (lookup . "n")}}` - has no name to read off the source, so `lookup`
   * returns its key and every string literal in the template is registered under its own name.
   * Returning a constant instead would render the case, but blind the oracle to the literal: a
   * printer that corrupted `"n"` would produce the same output. The literals come from
   * Handlebars' own parse rather than a regex over the source, because pairing quotes in text
   * mis-pairs the moment an attribute value spans lines - the same trap `htmlEquivalent` hit. */
  const { literals, hashKeys } = facts;

  /* The body echoes the arguments it was given, so a literal that only ever reaches the page
   * through a partial's hash - `{{> card data=(lookup . "payload")}}` - is still visible. A
   * constant body renders the same whatever it is passed. */
  const partialBody = (name: string) => `[partial:${name}${[...hashKeys].map((key) => ` {{${key}}}`).join('')}]`;

  for (const literal of literals) env.registerPartial(literal, partialBody(literal));
  for (const [, name] of source.matchAll(/\{\{~?#?>\s*([^\s}()]+)/gu)) {
    env.registerPartial(name, partialBody(name));
  }

  env.registerHelper('lookup', (_context: unknown, key: unknown) => key);

  return env;
}

/* `a=x`, `a='x'` and `a="x"` are one attribute written three ways. The printer always quotes,
 * and picks `"` unless the value holds one, so all three have to reduce to the same thing. A
 * bare value cannot hold HTML whitespace, which is what bounds the third branch - but it can
 * hold a non-breaking space, so the class is ASCII and not `\s`. On `\s` the value truncates at
 * the NBSP and the before side reads it as an attribute separator, reporting a render change
 * the printer never made. */
const attributeValue = /=(?:"([^"]*)"|'([^']*)'|([^ \t\r\n\f<>`]+))/gu;

/**
 * Where the tags are, found the way a tokenizer finds them rather than by regex: a quote opens
 * a value only directly after `=`, so `<div a=x"y>` ends at its own `>` instead of running on
 * looking for a closing quote.
 */
function* tagSpans(text: string): Generator<[number, number]> {
  let index = text.indexOf('<');

  while (index !== -1) {
    if (!/[a-zA-Z/]/u.test(text[index + 1] ?? '')) {
      index = text.indexOf('<', index + 1);
      continue;
    }

    let pos = index + 1;
    let afterEquals = false;

    while (pos < text.length && text[pos] !== '>') {
      const char = text[pos];

      if (afterEquals && (char === '"' || char === "'")) {
        const close = text.indexOf(char, pos + 1);
        pos = close === -1 ? text.length : close + 1;
        afterEquals = false;
        continue;
      }

      afterEquals = char === '=' || (afterEquals && HTML_WHITESPACE.test(char));
      pos += 1;
    }

    if (pos >= text.length) {
      return;
    }

    yield [index, pos + 1];
    index = text.indexOf('<', pos + 1);
  }
}

/**
 * The liberties the formatter takes, none of which reaches the page - and every one of them
 * inside a tag. Applied to the whole document instead, the same rewrites fired on ordinary
 * text: a page rendering `Set x='a'` compared equal to one rendering `Set x="a"`, and `a/>b`
 * to `a>b`. This is the gate that proves formatting never changes what a template renders, so
 * it has to stop at the tag it is allowed to touch.
 */
const htmlEquivalent = (text: string): string => {
  let out = '';
  let last = 0;

  for (const [start, end] of tagSpans(text)) {
    out +=
      text.slice(last, start) +
      text
        .slice(start, end)
        /* `JSON.stringify` both canonicalises the quoting and escapes what is inside, which is
         * what keeps the whitespace collapse below out of a value the author owns. */
        .replace(attributeValue, (_match: string, doubled: string, singled: string, bare: string) => `=${JSON.stringify(doubled ?? singled ?? bare)}`)
        /* Whitespace inside a tag is the formatter's, so how much of it there is says nothing
         * and a tag broken across lines must compare equal to the same tag on one line. */
        .replace(HTML_WHITESPACE_RUN, ' ')
        /* The printer also drops a void element's `/`. */
        .replace(/ ?\/?>$/u, '>');
    last = end;
  }

  return out + text.slice(last);
};

/**
 * How a browser treats HTML: a run of ASCII whitespace is one space, and whitespace at the edges
 * of the document does not show. Re-indenting children and breaking a tag across lines are the
 * formatter's job and change nothing on the page, so the comparison has to tolerate them.
 *
 * Deliberately not `\s`: a non-breaking space is content, not layout, and must survive.
 */
const asRendered = (text: string): string => htmlEquivalent(text).replace(HTML_WHITESPACE_RUN, ' ').trim();

/**
 * The one thing `asRendered` cannot see: a change in the *amount* of rendered whitespace.
 * Horizontal runs still collapse - indentation is the formatter's to set - but a newline that
 * appears or vanishes counts, which is how Handlebars' standalone rule shows itself. Moving a
 * partial onto its own line makes it standalone and strips the newlines around it; moving it off
 * one puts them back. Reported separately because it is a layout change, not a content change.
 */
const asShape = (text: string): string =>
  htmlEquivalent(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\f]+/gu, ' ')
    .trim();

function rawRenders(source: string): string[] | null {
  try {
    /* Once per source, not once per branch: the facts are what the *template* says, and both
     * branches read the same ones - so parsing per branch doubled every render comparison. */
    const facts = partialFactsOf(source);

    return BRANCHES.map((branch) => environment(source, branch, facts).compile(source)({}));
  } catch {
    return null;
  }
}

/** What the page shows, per branch, or null if this template cannot be rendered at all. */
export function renders(source: string): string[] | null {
  const raw = rawRenders(source);
  return raw === null ? null : raw.map(asRendered);
}

/**
 * The one liberty the formatter takes over a whole file is its own leading and trailing
 * whitespace, so that is normalised away on both sides. Everything else must render identically.
 *
 * Null means the two render identically. A `kind` of `whitespace` means the page has the same
 * content in the same order but a different amount of it; `render` means the content itself
 * moved; `unrenderable` means the source will not compile, so nothing was compared at all.
 *
 * That last one is a state of its own rather than another null: collapsed together, a caller
 * cannot tell "checked, identical" from "never checked", and the gate counts both as passes.
 * One un-renderable atom disables the check for every case built from it.
 */
export function renderDifference(source: string, formatted: string): RenderDifference | null {
  const before = rawRenders(source.trim());
  if (before === null) return { kind: 'unrenderable' };

  const after = rawRenders(formatted.trim());
  if (after === null) return { kind: 'render', branch: 'compile', before: 'compiles', after: 'throws' };

  const comparisons: Array<['render' | 'whitespace', (text: string) => string]> = [
    ['render', asRendered],
    ['whitespace', asShape],
  ];

  for (const [kind, normalize] of comparisons) {
    const index = before.findIndex((text, at) => normalize(text) !== normalize(after[at]));
    if (index !== -1) {
      return { kind, branch: BRANCHES[index], before: normalize(before[index]), after: normalize(after[index]) };
    }
  }

  return null;
}
