import { describe, expect, it } from 'vitest';
import {
  consumeRawBlock,
  ELSE_KEYWORD,
  findNextHandlebarsOpen,
  getBlockClosePrefix,
  getBlockExpression,
  getBlockPrefix,
  getPrintedBlockPrefix,
  parseMustacheToken,
} from '../src/dialects/handlebars/tokens';

describe('handlebars dialect tokens', () => {
  it('classifies Handlebars token forms', () => {
    expect(parseMustacheToken('{{#if ok}}', 0)).toMatchObject({
      kind: 'blockStart',
      name: 'if',
    });
    expect(parseMustacheToken('{{/if}}', 0)).toMatchObject({
      kind: 'blockEnd',
      name: 'if',
    });
    expect(parseMustacheToken('{{> user-card}}', 0)).toMatchObject({
      kind: 'partial',
      content: 'user-card',
    });
    expect(parseMustacheToken('{{!-- comment --}}', 0)).toMatchObject({
      kind: 'comment',
      content: '!-- comment',
    });
  });

  it('classifies Handlebars dialect-only special forms', () => {
    expect(parseMustacheToken('{{else if ready}}', 0)).toMatchObject({
      kind: 'else',
      specialForm: 'elseIf',
    });
    expect(parseMustacheToken('{{#> card}}', 0)).toMatchObject({
      kind: 'blockStart',
      specialForm: 'blockPartial',
    });
    expect(parseMustacheToken('{{#*inline "row"}}', 0)).toMatchObject({
      kind: 'blockStart',
      specialForm: 'decoratorBlock',
    });
    expect(parseMustacheToken('{{*log}}', 0)).toMatchObject({
      kind: 'mustache',
      specialForm: 'decorator',
    });
    expect(parseMustacheToken('{{< layout}}', 0)).toMatchObject({
      kind: 'blockStart',
      specialForm: 'parent',
    });
    expect(parseMustacheToken('{{$title}}', 0)).toMatchObject({
      kind: 'blockStart',
      specialForm: 'mustacheBlock',
    });
  });

  it('keeps scanning and recovery rules in the dialect', () => {
    const escaped = '\\{{ignored}} {{name}}';
    expect(findNextHandlebarsOpen(escaped, 0)).toBe(13);

    const rawBlock = '{{{{raw}}}} {{value}} {{{{/raw}}}}';
    expect(consumeRawBlock(rawBlock, 0)).toBe(rawBlock.length);

    const parent = parseMustacheToken('{{< layout}}', 0);
    expect(getBlockExpression(parent)).toBe('layout');
    expect(getBlockPrefix(parent)).toBe('<');
    expect(getPrintedBlockPrefix('<')).toBe('< ');
  });

  it('keeps Handlebars print syntax in the dialect', () => {
    expect(ELSE_KEYWORD).toBe('else');
    expect(getBlockClosePrefix('if')).toBe('/if');
  });
});
