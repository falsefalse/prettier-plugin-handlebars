/* Deterministic Handlebars source generator, shared by every fuzz-driven property check.
 * Kept free of prettier and plugin imports so parser-only properties can use it too. */

export const DEFAULT_SEED = 20260429;
export const DEFAULT_CASE_COUNT = 400;

/* Legal templates, composed into the generated cases. The positive properties - source is
 * never lost, formatting is idempotent - only mean something over input the parser accepts. */
const atoms = [
  'Hello, {{name}}!',
  /* A quote in a line comment can run the token past its real `}}`, pulling what follows into
   * the comment: valid input, stable across passes, and the page renders nothing. Only a render
   * comparison catches it. */
  '{{! "q }}\n{{#if a}}y{{/if}}',
  '{{ value }}',
  '{{~ value ~}}',
  '{{#if active}}active{{else}}inactive{{/if}}',
  '{{#if ok~}} yes {{~else~}} no {{~/if}}',
  '{{#each items as |item index|}}<span>{{ item.name }}</span>{{else}}empty{{/each}}',
  '{{> card title=title data=(lookup . "payload")}}',
  '{{> (lookup . "partialName") data=this}}',
  "{{> 'card' id='0' item=list.[0]}}",
  '{{*log value level="debug"}}',
  '{{~*log value~}}',
  '{{#> layout title=title}}<main>{{body}}</main>{{/layout}}',
  '{{#*decorate value=true}}<span>{{label}}</span>{{/decorate}}',
  '{{#*inline "badge"}}<span>{{label}}</span>{{/inline}}',
  '{{!-- <span>{{ price }}</span> --}}',
  '{{~! a line comment ~}}',
  '{{~!-- a block comment --~}}',
  '{{~!-- half trimmed --}}',
  '{{!--\n  <span>{{ price }}</span>\n--}}',
  '<!-- {{ not a mustache }} -->',
  '<div class="box {{#if active}}box--active{{/if}} {{ extra }}"></div>',
  '<div class="\n    card\n    {{#if primary}}\n      card--primary\n    {{else}}\n      card--plain\n    {{/if}}\n  "></div>',
  '<span title="{{#each xs}}\n  {{this}}\n{{/each}}"></span>',
  '<div data-json=\'{"html":"<b>","value":"{{raw}}"}\'></div>',
  /* A nested element cannot reuse the quote holding it, and a quoted param inside a value
   * does not end that value. */
  '<div class="{{#if a}}<b class=\'x y\'>t</b>{{/if}}">y</div>',
  '<button data-payload=\'{"ids": {{json (map xs "x => x.id")}}, "flag": true}\'></button>',
  '<input disabled type="text">',
  "<input value='single' data-y=2 />",
  '<div @click="go" (tap)="t()" :bound="b" #ref data-x.y="1"></div>',
  '<br><hr>',
  '<x-thing />',
  '<p>1 < 2 and {{ value }}</p>',
  '<script>const tpl = "<\\/script><div>{{value}}</div>";</script>',
  "<script>\n  // it's fine, an apostrophe is not a string\n  var a = 1;\n</script>",
  '<script>const state={count:1};function read(){return state.count}</script>',
  '<script id="d" type="application/json">{{{ json data }}}</script>',
  '<style>.banner{color:red;background:#fff}</style>',
  '{{{{raw}}}}<div>{{ notParsed }}</div>{{{{/raw}}}}',
  '{{#if a}}{{{{raw}}}}{{#if b}}{{{{/raw}}}}{{/if}}',
  '{{#if (eq a "{{")}}x{{/if}}',
  '{{! prettier-ignore }}\n<div    class="raw">{{value}}</div>',
  '{{!-- prettier-ignore-start --}}\n<div    class="raw">{{value}}</div>\n{{!-- prettier-ignore-end --}}',
  '<{{#if link}}a href="{{href}}"{{else}}div{{/if}} class="box">{{label}}</{{#if link}}a{{else}}div{{/if}}>',
  '<{{ tag }} class="box">{{ value }}</{{ tag }}>',
  '<img {{#if m}}src="d" data-src="{{i}}"{{/if}} alt="{{n}}">',
];

/* The other half of the contract: input the parser must refuse, with a location. Kept separate
 * from the atoms so a malformed fragment cannot quietly poison a generated case. */
export const malformed = [
  '<div>\n  <span>x</span>\n',
  '<div>x</div>\n</div>',
  '<div><span>x</div></span>',
  '<div class="foo>x</div>',
  '<br></br>',
  '<ul><li>a<li>b</ul>',
  '{{#if a}}\n  x\n',
  '{{#if a}}x{{/unless}}',
  '{{#if a}}x{{/if}}{{/unless}}',
  '{{#if a}}{{#unless b}}x{{/if}}{{/unless}}',
  '{{#> layout}}\n  <main>{{body}}</main>',
  '{{#*inline "badge"}}<span>{{label}}</span>',
  '{{{{raw}}}}<div>{{ notParsed }}</div>',
  '{{! prettier-ignore-start }}\n<div class="raw">{{value}}</div>',
  '<!-- unterminated',
  '<script>var tpl = "</script>";</script>',
  '{{foo',
  '{{!-- x',
];

/* Bodies come in indented, the way a template is actually written. Feeding un-indented children
 * to a container instead exercises one known limitation - see docs/REWRITE-PLAN.md 9, "indentation
 * after a standalone partial" - which `printer-core.test.ts` pins directly rather than having it
 * turn up in a third of the generated cases. */
const indented = (body) =>
  body
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');

const wrappers = [
  (body) => body,
  (body) => `<section>\n${indented(body)}\n</section>`,
  (body) => `<div class="wrap">\n${indented(body)}\n</div>`,
  (body) => `{{#if visible}}\n${indented(body)}\n{{/if}}`,
  (body) => `{{#unless hidden}}\n${indented(body)}\n{{else}}\n  Fallback\n{{/unless}}`,
  (body) => `{{!-- header --}}\n${body}\n{{!-- footer --}}`,
];

/** Every generated case is a pure function of `seed`, so failures reproduce from the log line. */
export function generateFuzzCases({ count = DEFAULT_CASE_COUNT, seed = DEFAULT_SEED } = {}) {
  let state = seed >>> 0;

  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const maybe = (value, probability = 0.5) => (random() < probability ? value : '');

  const buildGeneratedCase = (index) => {
    const pieceCount = 1 + Math.floor(random() * 5);
    const separator = pick(['', ' ', '\n', '\n\n']);
    const pieces = [];

    /* Padding a piece that starts a line would indent it out of step with its neighbours, which
     * is the same known limitation `indented` avoids: the formatter re-indents, and the line
     * after a standalone statement has its indentation rendered. Off a line start it is just
     * whitespace between siblings, which is exactly what wants fuzzing. */
    const pad = separator.includes('\n') ? () => '' : () => maybe('  ', 0.2);

    for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
      pieces.push(`${pad()}${pick(atoms)}${pad()}`);
    }

    return { id: `generated-${index}`, source: pick(wrappers)(pieces.join(separator)) };
  };

  const total = Number.isFinite(count) ? Math.max(count, 0) : DEFAULT_CASE_COUNT;

  return [
    ...atoms.map((source, index) => ({ id: `fixed-${index}`, source })),
    ...Array.from({ length: total }, (_, index) => buildGeneratedCase(index)),
  ];
}

/** Reads the shared `HBS_FUZZ_*` overrides so every property check is tuned the same way. */
export function fuzzCasesFromEnv(env = process.env, argv = process.argv.slice(2)) {
  /* Neither runner takes arguments, and an ignored one is worse than a rejected one: `--seed 3`
   * runs the default seed and prints it, so a sweep intended to cover six seeds can be one seed
   * six times without ever saying so. */
  if (argv.length > 0) {
    console.error(`unexpected argument ${argv[0]}: configure with HBS_FUZZ_SEED and HBS_FUZZ_CASES.`);
    process.exit(1);
  }

  const count = Number.parseInt(env.HBS_FUZZ_CASES ?? String(DEFAULT_CASE_COUNT), 10);
  /* Guarded the way `count` is: `HBS_FUZZ_SEED=abc` parsed to NaN, `seed >>> 0` turned it into
   * seed 0, and the run logged `seed=NaN` - so the log line stopped being a usable record of
   * what produced it. */
  const parsedSeed = Number.parseInt(env.HBS_FUZZ_SEED ?? String(DEFAULT_SEED), 10);
  const seed = Number.isFinite(parsedSeed) ? parsedSeed : DEFAULT_SEED;

  return { cases: generateFuzzCases({ count, seed }), seed };
}
