import { locEnd, locStart, parse } from './parser';

export const languages = [
  {
    name: 'Handlebars',
    type: 'markup',
    parsers: ['handlebars'],
    extensions: ['.hbs', '.handlebars'],
    aliases: ['hbs', 'htmlbars', 'classic-handlebars'],
    vscodeLanguageIds: ['handlebars'],
  },
];

export const parsers = {
  'handlebars': {
    parse,
    astFormat: 'handlebars-ast',
    locStart,
    locEnd,
  },
};

/* No printer yet: the v1 printer is gone and v2 lands in phase 4 of REWRITE-PLAN.md.
 * Formatting therefore fails with "no printer for handlebars-ast" until then, by design. */
export const printers = {};

/* Opinionated formatter - prettier's core options only. */
export const options = {};

export const defaultOptions = {};
