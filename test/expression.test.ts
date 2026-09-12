import { describe, expect, it } from 'vitest';
import { parseCall } from '../src/expression';
import { parse } from '../src/parser';
import { findExpressionViolations, findTilingViolations, walk } from './lib/ast-invariants.mts';
import { ofType } from './lib/narrow';
import type { Expression } from '../src/types';

const kindsOf = (expressions: Expression[]) => expressions.map((expression) => expression.type);
const sourcesOf = (expressions: Expression[]) => expressions.map((expression) => expression.source);

describe('literal kinds', () => {
  it('classifies every literal Handlebars accepts', () => {
    const { params } = parseCall('helper 1 -2.5 .5 true false null undefined "dq" \'sq\'');

    expect(kindsOf(params)).toEqual([
      'NumberLiteral',
      'NumberLiteral',
      'NumberLiteral',
      'BooleanLiteral',
      'BooleanLiteral',
      'NullLiteral',
      'UndefinedLiteral',
      'StringLiteral',
      'StringLiteral',
    ]);
  });

  it('treats anything else as a path', () => {
    const { params } = parseCall('helper a.b.c ../../x @index this ./y a.[b c].d');

    expect(kindsOf(params)).toEqual(Array(6).fill('PathExpression'));
  });
});

/* Handlebars' own AST reconstructs these and loses them; a formatter cannot afford that. */
describe('source is preserved exactly', () => {
  it.each([
    ['a.[b c].d', 'brackets in a segment path'],
    ['../../x', 'parent references'],
    ['@root.thing', 'data references'],
  ])('keeps %j (%s)', (source) => {
    expect(parseCall(`helper ${source}`).params[0].source).toBe(source);
  });

  it('keeps the quote character the author chose', () => {
    expect(sourcesOf(parseCall('t "dq" \'sq\'').params)).toEqual(['"dq"', "'sq'"]);
  });

  it('keeps a number exactly as written', () => {
    expect(sourcesOf(parseCall('t 1.50 -0 .5').params)).toEqual(['1.50', '-0', '.5']);
  });

  it('keeps an escaped quote inside a string', () => {
    expect(parseCall("t 'it\\'s'").params[0].source).toBe("'it\\'s'");
  });
});

describe('subexpressions', () => {
  it('nests, so a long call has somewhere to break', () => {
    const { hash } = parseCall("t 'a.b' x=(concat 'p' (upper c) sep='-')");

    expect(hash).toHaveLength(1);
    expect(hash[0].key).toBe('x');

    const outer = hash[0].value;
    expect(outer.type).toBe('SubExpression');
    if (outer.type !== 'SubExpression') return;

    expect(outer.path.source).toBe('concat');
    expect(kindsOf(outer.params)).toEqual(['StringLiteral', 'SubExpression']);
    expect(sourcesOf(outer.hash.map((pair) => pair.value))).toEqual(["'-'"]);

    const inner = ofType(outer.params[1], 'SubExpression');
    expect(inner.path.source).toBe('upper');
    expect(sourcesOf(inner.params)).toEqual(['c']);
  });

  it('is the only head form other than a path, and only for dynamic partials', () => {
    const dynamic = parseCall('(lookup . "partialName") data=this');

    expect(dynamic.path.type).toBe('SubExpression');
    expect(dynamic.path.source).toBe('(lookup . "partialName")');
  });
});

describe('block params', () => {
  it('reads `as |x y|` without treating it as params', () => {
    const call = parseCall('each items as |item index|');

    expect(sourcesOf(call.params)).toEqual(['items']);
    expect(call.blockParams).toEqual(['item', 'index']);
  });
});

/* Anything the reader cannot classify becomes a PathExpression holding the raw text, so odd but
 * closed input still round-trips rather than stopping the formatter. */
describe('recovery', () => {
  it.each(['', '   ', "unclosed 'str", 'weird ((deep))', 'trailing=', '=leading', 'a )'])(
    'never throws or hangs on %j',
    (source) => {
      expect(() => parseCall(source)).not.toThrow();
    },
  );

  /* The two exceptions, both cases where printing the parts back out would produce a template
   * Handlebars accepts from one it rejects: an invented `)`, or re-ordered arguments. */
  it.each([
    ['an unterminated subexpression', '((((', /unterminated subexpression/u],
    ['a subexpression missing its close', "t (concat 'a'", /unterminated subexpression/u],
    ['a positional param after a hash pair', 't a=1 c', /positional params come first/u],
  ])('rejects %s', (_name, source, message) => {
    expect(() => parseCall(source)).toThrow(message);
  });
});

describe('ranges are absolute and contained', () => {
  it('points at the template, not at the expression string', () => {
    const template = '<p>{{t \'a.b\' n=1}}</p>';
    const { params } = parseCall("t 'a.b' n=1", template.indexOf("t 'a.b'"));

    expect(template.slice(...(params[0].range ?? [0, 0]))).toBe("'a.b'");
  });

  it.each([
    '{{t \'a\' x=(concat \'p\' (upper c))}}',
    '{{> (lookup . "n") data=this}}',
    '{{#each xs as |x i|}}{{x}}{{/each}}',
    '{{#if (eq a b)}}y{{else if (gt c d)}}n{{/if}}',
    '<div class="{{cls (join a b)}}"></div>',
    '{{*inline "x"}}',
  ])('keeps every part inside its call: %j', (source) => {
    const ast = parse(source);

    expect(findTilingViolations(ast, source)).toEqual([]);
    expect(findExpressionViolations(ast, source)).toEqual([]);
  });

  /* A zero-width node still has to sit at a position its parent owns. The empty inverse was
   * anchored just past the *first* program, which on an else-if chain is a point inside a
   * sibling branch - `findTilingViolations` skips empty bodies, so nothing caught it. */
  it.each([
    ['{{#if a}}x{{else if b}}y{{/if}}', 24],
    ['{{#if a}}x{{/if}}', 10],
    ['{{#if a}}x{{else if b}}{{else if c}}z{{/if}}', 37],
  ])('puts an empty inverse where the closer starts: %j', (source, at) => {
    const block = parse(source).body[0];
    if (block?.type !== 'BlockStatement') throw new Error('expected a block');

    expect(block.inverse.range).toEqual([at, at]);
    expect(source.startsWith('{{/', at)).toBe(true);
  });

  /* Ranges are metadata, not content: every node carries one non-enumerably so it stays out of
   * assertions and out of `JSON.stringify` while the location hooks can still read it.
   * Attaching one as a plain property instead serialises the same tree two ways depending on
   * which subtree you are in. */
  it('keeps a range off the enumerable shape of every node alike', () => {
    const ast = parse('{{f a b=(g c)}}');
    const call = ast.body[0];
    if (call?.type !== 'MustacheStatement') throw new Error('expected a mustache');

    const subExpression = call.hash[0]?.value;
    const nodes = [call, call.path, call.params[0], call.hash[0], subExpression];

    for (const node of nodes) {
      expect(node && Object.keys(node)).not.toContain('range');
      expect(node?.range).toBeDefined();
    }

    expect(JSON.stringify(ast)).not.toContain('range');
  });

  /* The attribute list has to account for the whole tag head. While it did not, `parseTag`
   * could step over a character it failed to read and this gate reported no violation at all. */
  it('covers the tag head, so a dropped attribute character is a violation', () => {
    const source = '<div @click="go">x</div>';
    const ast = parse(source);

    expect(findTilingViolations(ast, source)).toEqual([]);

    const element = ast.body[0];
    if (element?.type !== 'ElementNode') throw new Error('expected an element');
    const attribute = element.attributes[0];
    if (!attribute) throw new Error('expected an attribute');

    /* A narrow name charset yields a `click` attribute starting one past the `@`. */
    Object.defineProperty(attribute, 'range', { value: [6, 17], configurable: true });

    expect(findTilingViolations(ast, source)).toEqual([
      { kind: 'uncovered-head', container: '<div> attributes', start: 4, end: 6, text: ' @' },
    ]);
  });

  /* Offsets are absolute, not relative to the value substring: relative ones point
   * `--cursor-offset` and any error raised in there at the wrong part of the file. */
  it('gives an attribute nested in a value its offset in the template', () => {
    const source = '<div class="{{#if a}}<span title=\'{{x}}\'>y</span>{{/if}}">z</div>';
    const ranges: Array<string | undefined> = [];


    walk(parse(source), (node) => {
      if (node.type !== 'ElementNode') return;

      for (const attribute of node.attributes) {
        ranges.push(attribute.range && source.slice(attribute.range[0], attribute.range[1]));
      }
    });

    expect(ranges).toContain('class="{{#if a}}<span title=\'{{x}}\'>y</span>{{/if}}"');
    expect(ranges).toContain("title='{{x}}'");
  });

  /* A block in attribute position is not part of any tiled span - whitespace between attributes
   * belongs to the formatter - so it is easily skipped, taking its own body with it. */
  it('descends into a block sitting in attribute position', () => {
    const source = '<div {{#if a}}data-x="1"{{/if}}>t</div>';
    const ast = parse(source);

    expect(findTilingViolations(ast, source)).toEqual([]);

    const element = ast.body[0];
    if (element?.type !== 'ElementNode') throw new Error('expected an element');
    const attribute = element.attributes[0];
    if (attribute?.type !== 'AttributeBlock' || attribute.block.type !== 'BlockStatement') {
      throw new Error('expected a block in attribute position');
    }

    /* Widen the block's body span past its one child. Only a walk that reaches in reports it. */
    Object.defineProperty(attribute.block.program, 'range', { value: [5, 31], configurable: true });

    expect(findTilingViolations(ast, source).map((violation) => violation.kind)).toEqual([
      'uncovered-head',
      'uncovered-tail',
    ]);
  });
});
