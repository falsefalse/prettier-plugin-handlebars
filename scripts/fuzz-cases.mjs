/* Deterministic Handlebars source generator, shared by every fuzz-driven property check.
 * Kept free of prettier and plugin imports so parser-only properties can use it too. */

export const DEFAULT_SEED = 20260429;
export const DEFAULT_CASE_COUNT = 400;

/* Legal templates, composed into the generated cases. The positive properties - source is
 * never lost, formatting is idempotent - only mean something over input the parser accepts. */
const atoms = [
  'Hello, {{name}}!',
  '{{ value }}',
  '{{~ value ~}}',
  '{{#if active}}active{{else}}inactive{{/if}}',
  '{{#if ok~}} yes {{~else~}} no {{~/if}}',
  '{{#each items as |item index|}}<span>{{ item.name }}</span>{{else}}empty{{/each}}',
  '{{> card title=title data=(lookup . "payload")}}',
  '{{> (lookup . "partialName") data=this}}',
  '{{*log value level="debug"}}',
  '{{~*log value~}}',
  '{{#> layout title=title}}<main>{{body}}</main>{{/layout}}',
  '{{#*decorate value=true}}<span>{{label}}</span>{{/decorate}}',
  '{{#*inline "badge"}}<span>{{label}}</span>{{/inline}}',
  '{{!-- <span>{{ price }}</span> --}}',
  '{{!--\n  <span>{{ price }}</span>\n--}}',
  '<!-- {{ not a mustache }} -->',
  '<div class="box {{#if active}}box--active{{/if}} {{ extra }}"></div>',
  '<div class="\n    card\n    {{#if primary}}\n      card--primary\n    {{else}}\n      card--plain\n    {{/if}}\n  "></div>',
  '<span title="{{#each xs}}\n  {{this}}\n{{/each}}"></span>',
  '<div data-json=\'{"html":"<b>","value":"{{raw}}"}\'></div>',
  '<input disabled type=text>',
  '<br><hr>',
  '<x-thing />',
  '<p>1 < 2 and {{ value }}</p>',
  '<script>const tpl = "</script><div>{{value}}</div>";</script>',
  '<script>const state={count:1};function read(){return state.count}</script>',
  '<style>.banner{color:red;background:#fff}</style>',
  '{{{{raw}}}}<div>{{ notParsed }}</div>{{{{/raw}}}}',
  '{{! prettier-ignore }}\n<div    class="raw">{{value}}</div>',
  '{{!-- prettier-ignore-start --}}\n<div    class="raw">{{value}}</div>\n{{!-- prettier-ignore-end --}}',
  '<{{#if link}}a href="{{href}}"{{else}}div{{/if}} class="box">{{label}}</{{#if link}}a{{else}}div{{/if}}>',
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
  '{{foo',
  '{{!-- x',
];

const wrappers = [
  (body) => body,
  (body) => `<section>${body}</section>`,
  (body) => `<div class="wrap">\n${body}\n</div>`,
  (body) => `{{#if visible}}\n${body}\n{{/if}}`,
  (body) => `{{#unless hidden}}\n${body}\n{{else}}\nFallback\n{{/unless}}`,
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

    for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
      pieces.push(`${maybe('  ', 0.2)}${pick(atoms)}${maybe('  ', 0.2)}`);
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
export function fuzzCasesFromEnv(env = process.env) {
  const count = Number.parseInt(env.HBS_FUZZ_CASES ?? String(DEFAULT_CASE_COUNT), 10);
  const seed = Number.parseInt(env.HBS_FUZZ_SEED ?? String(DEFAULT_SEED), 10);

  return { cases: generateFuzzCases({ count, seed }), seed };
}
