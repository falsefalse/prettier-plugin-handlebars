import { locEnd, locStart, parse } from './parser';
import { printer } from './printer';

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

export const printers = {
  'handlebars-ast': printer,
};

/* Opinionated formatter - prettier's core options only. */
export const options = {};

export const defaultOptions = {};
