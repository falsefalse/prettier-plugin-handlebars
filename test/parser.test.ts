import { describe, expect, it } from 'vitest';
import { parse as parseTemplate } from '../src/parser';
import { flattenCalls } from './call-shape';

/* Calls read as strings here; expression.test.ts covers the node shape. */
const parse = (source: string) => flattenCalls(parseTemplate(source));

/* The parser keeps every whitespace run, so a template written across lines starts with one.
 * These tests are about structure, not indentation. */
const isWhitespace = (node) => node.type === 'TextNode' && node.chars.trim() === '';
const significant = (nodes) => nodes.filter((node) => !isWhitespace(node));

function firstElement(ast) {
  expect(ast).toBeDefined();
  expect(ast.type).toBe('Program');

  const first = significant(ast.body)[0];
  expect(first).toBeDefined();
  expect(first.type).toBe('ElementNode');
  return first;
}

describe('HTML Elements', () => {
  it('empty div', () => {
    const input = `<div></div>`;

    const output = parse(input);
    const el = firstElement(output);

    expect(el).toMatchObject({
      type: 'ElementNode',
      tag: 'div',
      selfClosing: false,
      attributes: [],
      children: []
    });
  });

  it('div with text', () => {
    const input = `<div>text</div>`;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');
    expect(el.selfClosing).toBe(false);
    expect(el.attributes).toEqual([]);

    // one TextNode holding "text"
    expect(el.children).toEqual([
      expect.objectContaining({
        type: 'TextNode',
        chars: 'text'
      })
    ]);
  });

  it('br', () => {
    const input = `<div>text<br/>text</div>`;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');
    expect(el.selfClosing).toBe(false);
    expect(el.attributes).toEqual([]);

    // shape: TextNode "text", ElementNode br, TextNode "text"
    expect(el.children[0]).toMatchObject({
      type: 'TextNode',
      chars: 'text'
    });

    expect(el.children[1]).toMatchObject({
      type: 'ElementNode',
      tag: 'br',
      selfClosing: true,
      attributes: [],
      children: []
    });

    expect(el.children[2]).toMatchObject({
      type: 'TextNode',
      chars: 'text'
    });
  });
});

describe('Mustache in HTML attributes', () => {
  it('simple mustache in attribute value', () => {
    const input = `<div data-text="{{ text }}"></div>`;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');
    expect(el.children).toEqual([]);

    expect(el.attributes).toHaveLength(1);
    const attr = el.attributes[0];

    expect(attr).toMatchObject({
      type: 'Attribute',
      name: 'data-text',
      value: expect.objectContaining({
        type: 'AttributeValue'
      })
    });

    // value.parts holds a MustacheStatement with path "text"
    expect(attr.value.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'MustacheStatement',
          path: 'text'
        })
      ])
    );
  });

  it('class with simple mustache', () => {
    const input = `<div class="{{ class }}"></div>`;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');
    expect(el.children).toEqual([]);

    expect(el.attributes).toHaveLength(1);
    const attr = el.attributes[0];

    expect(attr).toMatchObject({
      type: 'Attribute',
      name: 'class',
      value: expect.objectContaining({
        type: 'AttributeValue'
      })
    });

    expect(attr.value.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'MustacheStatement',
          path: 'class'
        })
      ])
    );
  });

  it('class with if block in value', () => {
    const input = `
      <div 
        class="
          {{#if class}}
            {{ class }}
          {{/if}}
        "
      ></div>`;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');
    expect(el.children).toEqual([]);

    expect(el.attributes).toHaveLength(1);
    const attr = el.attributes[0];

    expect(attr).toMatchObject({
      type: 'Attribute',
      name: 'class',
      value: expect.objectContaining({
        type: 'AttributeValue'
      })
    });

    // parts holds a BlockStatement with path "if"
    expect(attr.value.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'BlockStatement',
          path: 'if',
          program: expect.objectContaining({
            type: 'Program'
          })
        })
      ])
    );
  });

  it('complex attributes mix (id/class/data + each + ifEquals)', () => {
    const input = `
      <div
        id="id-block--{{#if hasIDModification}}{{ IDModification }}{{else}}none{{/if}}"
        class="a123 a123--{{ modification }}"
        data-a123="value"
        {{#each attributes as |item|}}
          {{ item.name }}="{{ item.value }}"
        {{/each}}
        {{#ifEquals hidden}}
          hidden
        {{/ifEquals}}
      ></div>
    `;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');
    expect(el.selfClosing).toBe(false);
    expect(el.children).toEqual([]);

    // at least 3 plain attributes plus 2 AttributeBlocks
    const attributes = el.attributes;

    const idAttr = attributes.find(a => a.type === 'Attribute' && a.name === 'id');
    const classAttr = attributes.find(a => a.type === 'Attribute' && a.name === 'class');
    const dataAttr = attributes.find(a => a.type === 'Attribute' && a.name === 'data-a123');
    const eachBlock = attributes.find(a => a.type === 'AttributeBlock');
    const ifEqualsBlock = attributes.find(
      a =>
        a.type === 'AttributeBlock' &&
        (a.block as any)?.path === 'ifEquals'
    );

    expect(idAttr).toBeDefined();
    expect(classAttr).toBeDefined();
    expect(dataAttr).toBeDefined();
    expect(eachBlock).toBeDefined();
    expect(ifEqualsBlock).toBeDefined();

    // id: value.parts holds a BlockStatement 'if'
    expect(idAttr.value.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'BlockStatement',
          path: 'if'
        })
      ])
    );

    // class: "a123 a123--" + {{ modification }}
    expect(classAttr.value.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'TextNode'
        }),
        expect.objectContaining({
          type: 'MustacheStatement',
          path: 'modification'
        })
      ])
    );

    // data-a123: just the static value "value"
    expect(dataAttr.value.parts).toEqual([
      expect.objectContaining({
        type: 'TextNode',
        chars: 'value'
      })
    ]);

    // eachBlock: an AttributeBlock holding a BlockStatement 'each'
    expect(eachBlock).toMatchObject({
      type: 'AttributeBlock',
      block: expect.objectContaining({
        type: 'BlockStatement',
        path: 'each',
        blockParams: ['item']
      })
    });
  });
});

describe('Mustache blocks in children', () => {
  it('parses mustache parents and overridable blocks', () => {
    const input = `
      {{< layout}}
        {{$title}}Hello{{/title}}
      {{/layout}}
    `;

    const output = parse(input);
    const parent = output.body.find(
      child =>
        child.type === 'BlockStatement' &&
        child.path === 'layout'
    ) as any;

    expect(parent).toMatchObject({
      type: 'BlockStatement',
      path: 'layout',
      blockPrefix: '<'
    });

    expect(significant(parent.program.body)[0]).toMatchObject({
      type: 'BlockStatement',
      path: 'title',
      blockPrefix: '$',
      program: expect.objectContaining({
        type: 'Program',
        body: expect.arrayContaining([
          expect.objectContaining({
            type: 'TextNode',
            chars: 'Hello'
          })
        ])
      })
    });
  });

  it('parses mustache parent paths with slash-separated names and spaced closing tags', () => {
    const input = `
      {{< theme_boost/drawer}}
        {{$drawercontent}}{{{content}}}{{/drawercontent}}
      {{/ theme_boost/drawer}}
    `;

    const output = parse(input);
    const parent = output.body.find(
      child =>
        child.type === 'BlockStatement' &&
        child.path === 'theme_boost/drawer'
    ) as any;

    expect(parent).toMatchObject({
      type: 'BlockStatement',
      path: 'theme_boost/drawer',
      blockPrefix: '<'
    });

    expect(significant(parent.program.body)[0]).toMatchObject({
      type: 'BlockStatement',
      path: 'drawercontent',
      blockPrefix: '$',
      program: expect.objectContaining({
        body: expect.arrayContaining([
          expect.objectContaining({
            type: 'MustacheStatement',
            path: 'content',
            triple: true
          })
        ])
      })
    });
  });

  it('parses dynamic mustache parent names', () => {
    const input = `{{<*dynamic}}{{$text}}Hello{{/text}}{{/*dynamic}}`;

    const output = parse(input);
    const parent = output.body[0] as any;

    expect(parent).toMatchObject({
      type: 'BlockStatement',
      path: '*dynamic',
      blockPrefix: '<',
      program: expect.objectContaining({
        body: expect.arrayContaining([
          expect.objectContaining({
            type: 'BlockStatement',
            path: 'text',
            blockPrefix: '$'
          })
        ])
      })
    });
  });

  it('if block as content', () => {
    const input = `
      <div>
        {{#if text}}
          {{ text }}
        {{/if}}
      </div>
    `;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');

    // the children hold a BlockStatement 'if'
    const ifBlock = el.children.find(
      child =>
        child.type === 'BlockStatement' &&
        child.path === 'if'
    );

    expect(ifBlock).toBeDefined();
    expect(ifBlock.program).toMatchObject({
      type: 'Program'
    });
  });

  it('captures else-if branches separately from the final else branch', () => {
    const input = `
      <div>
        {{#if primary}}
          one
        {{else if secondary}}
          two
        {{else if (and tertiary quaternary)}}
          three
        {{else}}
          four
        {{/if}}
      </div>
    `;

    const output = parse(input);
    const el = firstElement(output);
    const ifBlock = el.children.find(
      child =>
        child.type === 'BlockStatement' &&
        child.path === 'if'
    ) as any;

    expect(ifBlock).toMatchObject({
      type: 'BlockStatement',
      path: 'if',
      inverseChain: [
        {
          type: 'ElseBranch',
          path: 'if',
          params: ['secondary'],
          program: expect.objectContaining({ type: 'Program' })
        },
        {
          type: 'ElseBranch',
          path: 'if',
          params: ['(and tertiary quaternary)'],
          program: expect.objectContaining({ type: 'Program' })
        }
      ],
      inverse: expect.objectContaining({ type: 'Program' })
    });

    expect(ifBlock.inverse.body.some(node => node.type === 'TextNode' && node.chars.includes('four'))).toBe(true);
  });

  it('keeps quoted comparison operators as positional params', () => {
    const input = `
      <div>
        {{#ifCompare ../activeIndex '===' @index}}
          active
        {{/ifCompare}}
      </div>
    `;

    const output = parse(input);
    const el = firstElement(output);
    const ifCompareBlock = el.children.find(
      child =>
        child.type === 'BlockStatement' &&
        child.path === 'ifCompare'
    ) as any;

    expect(ifCompareBlock).toMatchObject({
      path: 'ifCompare',
      params: ['../activeIndex', "'==='", '@index'],
      hash: []
    });
  });

  it('keeps spaced hash assignments as hash pairs', () => {
    const input = `
      <div>
        {{> 'ui/input-primary/input-primary'
          id= 'compare-family-name'
          type = 'text'
          placeholder='Surname'
        }}
      </div>
    `;

    const output = parse(input);
    const el = firstElement(output);
    const partial = el.children.find(child => child.type === 'PartialStatement') as any;

    expect(partial).toMatchObject({
      path: "'ui/input-primary/input-primary'",
      params: [],
      hash: [
        { key: 'id', value: "'compare-family-name'" },
        { key: 'type', value: "'text'" },
        { key: 'placeholder', value: "'Surname'" }
      ]
    });
  });

  it('each attributes in tag (AttributeBlock)', () => {
    const input = `
      <div
        {{#each attributes as |item|}}
          {{ item.name }}="{{ item.value }}"
        {{/each}}
      ></div>
    `;

    const output = parse(input);
    const el = firstElement(output);

    expect(el.tag).toBe('div');
    expect(el.children).toEqual([]);

    // attributes holds an AttributeBlock with a BlockStatement 'each'
    const eachAttrBlock = el.attributes.find(
      a =>
        a.type === 'AttributeBlock' &&
        (a.block as any)?.path === 'each'
    );

    expect(eachAttrBlock).toBeDefined();
    expect(eachAttrBlock.block).toMatchObject({
      type: 'BlockStatement',
      blockParams: ['item'],
      program: expect.objectContaining({
        type: 'Program'
      })
    });
  });
});
