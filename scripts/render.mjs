/* Renders a template with the real Handlebars runtime, so "formatting never changes what the
 * template renders" can be checked rather than approximated.
 *
 * Nothing here cares what a template *means*, only that two renders of it match, so the data is
 * synthetic. Unknown helpers and partials resolve to a marker instead of throwing, and the
 * conditional builtins are overridden to take a fixed branch rather than consult the data. That
 * makes rendering total over arbitrary input, which is what lets the fuzz corpus drive it. */
import Handlebars from 'handlebars';

const BRANCHES = ['fn', 'inverse'];

function environment(source, branch) {
  const env = Handlebars.create();

  /* Branch by fiat, not by data: every conditional body gets rendered on one pass or the other,
   * so a defect hiding in an `{{else}}` is still visible. */
  const take = function (_context, options) {
    const body = options[branch];
    return body ? body(this) : '';
  };

  for (const name of ['if', 'unless', 'each', 'with']) env.registerHelper(name, take);
  env.registerHelper('blockHelperMissing', take);
  env.registerHelper('helperMissing', function (...args) {
    const options = args[args.length - 1];
    return options.fn ? take.call(this, null, options) : `[${options.name}]`;
  });

  /* `{{> name}}` and `{{#> name}}`; a dynamic head like `{{> (lookup . "n")}}` has no name. */
  for (const [, name] of source.matchAll(/\{\{~?#?>\s*([^\s}()]+)/gu)) {
    env.registerPartial(name, `[partial:${name}]`);
  }

  return env;
}

/* The two liberties the formatter takes with markup, neither of which reaches the page. */
const htmlEquivalent = (text) =>
  text
    /* A tag broken across lines leaves its `>` behind whitespace, which no browser sees. */
    .replace(/[ \t\r\n\f]+(\/?>)/gu, '$1')
    /* `accept=x` and `accept="x"` are the same attribute; the formatter always quotes. */
    .replace(/=([^\s"'<>`]+)/gu, '="$1"');

/**
 * How a browser treats HTML: a run of ASCII whitespace is one space, and whitespace at the edges
 * of the document does not show. Re-indenting children and breaking a tag across lines are the
 * formatter's job and change nothing on the page, so the comparison has to tolerate them.
 *
 * Deliberately not `\s`: a non-breaking space is content, not layout, and must survive.
 */
const asRendered = (text) => htmlEquivalent(text).replace(/[ \t\r\n\f]+/gu, ' ').trim();

/**
 * The one thing `asRendered` cannot see: a change in the *amount* of rendered whitespace.
 * Horizontal runs still collapse - indentation is the formatter's to set - but a newline that
 * appears or vanishes counts, which is how Handlebars' standalone rule shows itself. Moving a
 * partial onto its own line makes it standalone and strips the newlines around it; moving it off
 * one puts them back. Reported separately because it is a layout change, not a content change.
 */
const asShape = (text) =>
  htmlEquivalent(text)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t\f]+/gu, ' ')
    .trim();

function rawRenders(source) {
  try {
    return BRANCHES.map((branch) => environment(source, branch).compile(source)({}));
  } catch {
    return null;
  }
}

/** What the page shows, per branch, or null if this template cannot be rendered at all. */
export function renders(source) {
  const raw = rawRenders(source);
  return raw === null ? null : raw.map(asRendered);
}

/**
 * The one liberty the formatter takes over a whole file is its own leading and trailing
 * whitespace, so that is normalised away on both sides. Everything else must render identically.
 *
 * Returns null when the source itself will not render - there is nothing to compare against.
 * A `kind` of `whitespace` means the page has the same content in the same order, but a
 * different amount of it; `render` means the content itself moved.
 */
export function renderDifference(source, formatted) {
  const before = rawRenders(source.trim());
  if (before === null) return null;

  const after = rawRenders(formatted.trim());
  if (after === null) return { kind: 'render', branch: 'compile', before: 'compiles', after: 'throws' };

  for (const [kind, normalize] of [['render', asRendered], ['whitespace', asShape]]) {
    const index = before.findIndex((text, at) => normalize(text) !== normalize(after[at]));
    if (index !== -1) {
      return { kind, branch: BRANCHES[index], before: normalize(before[index]), after: normalize(after[index]) };
    }
  }

  return null;
}
