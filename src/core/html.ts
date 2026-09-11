/** Elements with no closing tag. Writing one is an error, not a shorthand. */
export const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Elements whose content is text, not markup: a `<` inside one opens nothing. */
export const rawTextElements = new Set(['script', 'style', 'textarea', 'pre']);
