import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { findTilingViolations } from './lib/ast-invariants.mts';
import type { ElementNode, Node } from '../src/types';

function textChars(nodes: Node[]): Array<string | null> {
  return nodes.map((node) => (node.type === 'TextNode' ? node.chars : null));
}

function onlyElement(source: string): ElementNode {
  const first = parse(source).body.find((node): node is ElementNode => node.type === 'ElementNode');

  if (!first) {
    throw new Error(`no element in ${JSON.stringify(source)}`);
  }

  return first;
}

/* The printer decides what renders; the parser is not allowed to have an opinion. */
describe('whitespace survives parsing', () => {
  it('keeps a whitespace-only run between siblings as its own node', () => {
    expect(textChars(onlyElement('<div>{{a}} {{b}}</div>').children)).toEqual([null, ' ', null]);
    expect(textChars(onlyElement('<div>{{a}}\n{{b}}</div>').children)).toEqual([null, '\n', null]);
    expect(textChars(onlyElement('<div>{{a}}\n\n{{b}}</div>').children)).toEqual([null, '\n\n', null]);
  });

  it('emits nothing between glued siblings', () => {
    expect(textChars(onlyElement('<div>{{a}}{{b}}</div>').children)).toEqual([null, null]);
  });

  it('distinguishes the three shapes the old parser collapsed into one', () => {
    const shapes = ['<a>{{x}}</a>', '<a> {{x}} </a>', '<a>\n{{x}}\n</a>'];
    const children = shapes.map((shape) => textChars(onlyElement(shape).children));

    expect(children).toEqual([[null], [' ', null, ' '], ['\n', null, '\n']]);
    expect(new Set(children.map((entry) => JSON.stringify(entry))).size).toBe(3);
  });

  it('keeps text runs untrimmed, edges included', () => {
    const [text] = onlyElement('<p>  hello  world  </p>').children;

    expect(text).toMatchObject({ type: 'TextNode', chars: '  hello  world  ' });
  });

  it('keeps the template\'s own leading and trailing whitespace', () => {
    expect(textChars(parse('\n  <div></div>\n').body)).toEqual(['\n  ', null, '\n']);
  });

  it('keeps whitespace at block-body edges', () => {
    const [block] = parse('{{#if a}}\n  x\n{{/if}}').body;
    expect(block.type).toBe('BlockStatement');

    if (block.type === 'BlockStatement') {
      expect(textChars(block.program.body)).toEqual(['\n  x\n']);
    }
  });
});

describe('spans line up with content', () => {
  it('gives an element a content span between its tags', () => {
    const source = '<div> {{x}} </div>';
    const element = onlyElement(source);

    expect(element.contentRange).toEqual([5, 12]);
    expect(source.slice(...(element.contentRange ?? [0, 0]))).toBe(' {{x}} ');
  });

  it('ends a block program where its terminator begins', () => {
    const source = '{{#if a}}yes{{else}}no{{/if}}';
    const [block] = parse(source).body;

    if (block.type !== 'BlockStatement') throw new Error('expected a block');
    expect(source.slice(...block.program.range!)).toBe('yes');
    expect(source.slice(...block.inverse.range!)).toBe('no');
  });
});

describe('tiling invariant', () => {
  const shapes = [
    '<div> {{x}}\n<b>y</b> </div>',
    '{{#if a}} x {{else if b}} y {{else}} z {{/if}}',
    '{{#each xs as |x|}}\n  <li>{{x}}</li>\n{{/each}}',
    '<div class="a {{#if b}}c{{/if}} d"></div>',
    '<script>const a = 1;</script>',
    '<pre>  keep  </pre>',
    '{{!-- note --}}\n<p>text</p>\n{{! short }}',
    '{{{{raw}}}}<div>{{ notParsed }}</div>{{{{/raw}}}}',
    '<input disabled type=text>',
    '<Div><SPAN>y</span></dIV>',
    '<img src=/a/b/>',
    '<div @click="go" (tap)="t()" :bound="b" #ref data-x.y="1" v-bind:z="z"></div>',
    '<div class="{{#if a}}<span title=\'{{x}}\'>y</span>{{/if}}">z</div>',
    '{{#> layout title=t}}<main>{{body}}</main>{{/layout}}',
    '<{{#if link}}a href="{{h}}"{{else}}div{{/if}}>{{label}}</{{#if link}}a{{else}}div{{/if}}>',
    '<h{{level}}>Title</h{{level}}>',
    '<div{{attrs}}>x</div\n>',
    '',
    '   ',
    '\n\n',
  ];

  it.each(shapes)('loses no source: %j', (source) => {
    expect(findTilingViolations(parse(source), source)).toEqual([]);
  });

  /* An UnmatchedNode inside a value is built from the value slice; its range is the template's. */
  it.each([
    '<div class="{{#if a}}{{! prettier-ignore }}<b   >x</b>{{/if}}">y</div>',
    '<div class="{{#if a}}{{{{raw}}}}<b>x</b>{{{{/raw}}}}{{/if}}">y</div>',
  ])('offsets an unmatched node in a value against the template: %j', (source) => {
    expect(findTilingViolations(parse(source), source)).toEqual([]);
  });
});
