import { describe, expect, it } from 'vitest';
import { locEnd, locStart, parse as parseTemplate } from '../src/parser';
import { flattenCalls } from './call-shape';

/* Calls read as strings here; expression.test.ts covers the node shape. */
const parse = (source: string) => flattenCalls(parseTemplate(source));
import type {
  BlockStatement,
  CommentStatement,
  DecoratorStatement,
  ElementAttribute,
  ElementNode,
  MustacheStatement,
  PartialStatement,
  Program,
  TextNode,
  UnmatchedNode,
} from '../src/types';

function parseProgram(source: string): Program {
  return parse(source);
}

function firstNode<T>(source: string): T {
  return parseProgram(source).body[0] as T;
}

function firstElement(source: string): ElementNode {
  const element = firstNode<ElementNode>(source);
  expect(element.type).toBe('ElementNode');
  return element;
}

describe('simple parser coverage', () => {
  it('tracks non-enumerable source ranges for Prettier location hooks', () => {
    const program = parseProgram('<div>Hello, {{name}}!</div>');
    const element = program.body[0] as ElementNode;
    const text = element.children[0] as TextNode;
    const mustache = element.children[1] as MustacheStatement;

    expect(locStart(program)).toBe(0);
    expect(locEnd(program)).toBe(27);
    expect(locStart(element)).toBe(0);
    expect(locEnd(element)).toBe(27);
    expect(locStart(text)).toBe(5);
    expect(locEnd(text)).toBe(12);
    expect(locStart(mustache)).toBe(12);
    expect(locEnd(mustache)).toBe(20);
    expect(Object.keys(element)).not.toContain('range');
  });

  it('tracks source ranges inside attribute values', () => {
    const element = firstElement('<div title="Hi {{name}}"></div>');
    const attr = element.attributes[0];
    expect(attr.type).toBe('Attribute');
    if (attr.type !== 'Attribute' || !attr.value) {
      throw new Error('Expected title attribute value');
    }

    const mustache = attr.value.parts[1] as MustacheStatement;

    expect(locStart(attr.value)).toBe(12);
    expect(locEnd(attr.value)).toBe(23);
    expect(locStart(mustache)).toBe(15);
    expect(locEnd(mustache)).toBe(23);
    expect(Object.keys(attr.value)).not.toContain('range');
  });

  it('parses short handlebars comments at the top level', () => {
    const comment = firstNode<CommentStatement>('{{! note}}');

    expect(comment).toMatchObject({
      type: 'CommentStatement',
      value: 'note',
      multiline: false,
      block: false,
    });
  });

  it('parses triple-stash expressions', () => {
    const mustache = firstNode<MustacheStatement>('{{{ html }}}');

    expect(mustache).toMatchObject({
      type: 'MustacheStatement',
      path: 'html',
      triple: true,
      params: [],
      hash: [],
    });
  });

  it('keeps escaped mustaches as text', () => {
    const text = firstNode<TextNode>('\\{{value}}');

    expect(text).toMatchObject({
      type: 'TextNode',
      chars: '\\{{value}}',
    });
  });

  it('parses inverse sections as block statements', () => {
    const block = firstNode<BlockStatement>('{{^items}}empty{{/items}}');

    expect(block).toMatchObject({
      type: 'BlockStatement',
      path: 'items',
      blockPrefix: '^',
    });
  });

  it('does not close mustaches on braces inside quoted params', () => {
    const mustache = firstNode<MustacheStatement>('{{helper "a }} b" value}}');

    expect(mustache).toMatchObject({
      type: 'MustacheStatement',
      path: 'helper',
      params: ['"a }} b"', 'value'],
    });
  });

  it('keeps escaped quotes inside quoted params', () => {
    const mustache = firstNode<MustacheStatement>(String.raw`{{helper "a \"b\" c" value}}`);

    expect(mustache).toMatchObject({
      type: 'MustacheStatement',
      path: 'helper',
      params: [String.raw`"a \"b\" c"`, 'value'],
    });
  });

  it('parses partials with hash pairs', () => {
    const partial = firstNode<PartialStatement>("{{> card title=title featured=true}}");

    expect(partial).toMatchObject({
      type: 'PartialStatement',
      path: 'card',
      params: [],
      hash: [
        { key: 'title', value: 'title' },
        { key: 'featured', value: 'true' },
      ],
    });
  });

  it('parses standalone decorators with params and hash pairs', () => {
    const decorator = firstNode<DecoratorStatement>('{{*log value level="debug"}}');

    expect(decorator).toMatchObject({
      type: 'DecoratorStatement',
      path: 'log',
      params: ['value'],
      hash: [{ key: 'level', value: '"debug"' }],
    });
  });

  it('parses boolean and unquoted attributes on void elements', () => {
    const input = firstElement('<input disabled type=text>');

    expect(input).toMatchObject({
      type: 'ElementNode',
      tag: 'input',
      selfClosing: true,
    });

    expect(input.attributes).toEqual([
      {
        type: 'Attribute',
        name: 'disabled',
        value: null,
      },
      {
        type: 'Attribute',
        name: 'type',
        value: {
          type: 'AttributeValue',
          raw: 'text',
          /* Every space inside an attribute value renders, so its text is marked significant. */
          parts: [{ type: 'TextNode', chars: 'text', preserveWhitespace: true }],
        },
      },
    ]);
  });

  it('parses unquoted URL attributes with slash-prefixed mustache values', () => {
    const input = firstElement('<a href=/foo/{{slug}}>Link</a>');
    const attr = input.attributes[0];

    expect(attr).toMatchObject({
      type: 'Attribute',
      name: 'href',
      value: {
        type: 'AttributeValue',
        parts: [
          { type: 'TextNode', chars: '/foo/' },
          { type: 'MustacheStatement', path: 'slug' },
        ],
      },
    });
  });

  /* Both of these used to come back as UnmatchedNode; syntax-errors.test.ts owns them now. */
  it('rejects a closing tag on a void element', () => {
    expect(() => parseTemplate('<br></br>')).toThrow(/void element/u);
  });

  it('rejects a block partial that is never closed', () => {
    expect(() => parseTemplate('{{#> layout}}\n  <main>{{body}}</main>')).toThrow(/expected \{\{\/layout\}\}/u);
  });

  it('parses dynamic attribute names as raw attributes', () => {
    const input = firstElement('<span data-{{ control.badgeData }}></span>');

    expect(input.attributes).toEqual([
      {
        type: 'RawAttribute',
        raw: 'data-{{ control.badgeData }}',
      },
    ]);
  });
});

describe('medium parser coverage', () => {
  it('parses blocks with inverse branches and block params', () => {
    const block = firstNode<BlockStatement>(
      '{{#each items as |item idx|}}<span>{{ item }}</span>{{else}}<em>Empty</em>{{/each}}',
    );

    expect(block).toMatchObject({
      type: 'BlockStatement',
      path: 'each',
      params: ['items'],
      blockParams: ['item', 'idx'],
    });

    expect(block.program.body).toHaveLength(1);
    expect(block.inverse.body).toHaveLength(1);
    expect((block.inverse.body[0] as ElementNode).tag).toBe('em');
  });

  it('tracks trim markers on final else branches', () => {
    const block = firstNode<BlockStatement>('{{#if ok}}A{{~else~}}B{{/if}}');

    expect(block.inverseTrimOpen).toBe(true);
    expect(block.inverseTrimClose).toBe(true);
  });

  it('parses html comments inside elements as verbatim text nodes', () => {
    const element = firstElement('<div><!-- keep --><span>{{ value }}</span></div>');
    const comment = element.children[0] as TextNode;

    expect(comment).toMatchObject({
      type: 'TextNode',
      chars: '<!-- keep -->',
      verbatim: true,
    });

    expect((element.children[1] as ElementNode).tag).toBe('span');
  });

  it('keeps handlebars-looking expressions inside handlebars comments as comment text', () => {
    const comment = firstNode<CommentStatement>('{{!-- <span>{{ price }}</span> --}}');

    expect(comment).toMatchObject({
      type: 'CommentStatement',
      value: '<span>{{ price }}</span>',
      block: true,
    });
  });

  it('parses style contents as a single verbatim child', () => {
    const style = firstElement('<style>\n  .x { color: red; }\n</style>');
    const child = style.children[0] as TextNode;

    expect(style.tag).toBe('style');
    expect(style.children).toHaveLength(1);
    expect(child).toMatchObject({
      type: 'TextNode',
      chars: '\n  .x { color: red; }\n',
      verbatim: true,
    });
  });

  it('parses comment blocks in opening tags as attribute blocks', () => {
    const element = firstElement('<div {{!-- note --}} hidden></div>');
    const attrBlock = element.attributes[0] as Extract<ElementAttribute, { type: 'AttributeBlock' }>;

    expect(attrBlock).toMatchObject({
      type: 'AttributeBlock',
      block: {
        type: 'CommentStatement',
        value: 'note',
        multiline: false,
        block: true,
      },
    });

    expect(element.attributes[1]).toEqual({
      type: 'Attribute',
      name: 'hidden',
      value: null,
    });
  });

  it('parses custom element names with dashed tags', () => {
    const element = firstElement('<product-card data-view=grid></product-card>');

    expect(element).toMatchObject({
      type: 'ElementNode',
      tag: 'product-card',
      selfClosing: false,
    });
  });
});
