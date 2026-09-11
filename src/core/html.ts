/** Elements with no closing tag. Writing one is an error, not a shorthand. */
const voidElements = new Set([
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
const rawTextElements = new Set(['script', 'style', 'textarea', 'pre']);

/* Both sets are keyed lowercase and a tag name is not: `<BR>` is a `br`. Asking through these
 * rather than reaching for the set is what keeps the fold from being forgotten at a call site. */
export function isVoidElement(tag: string): boolean {
  return voidElements.has(tag.toLowerCase());
}

export function isRawTextElement(tag: string): boolean {
  return rawTextElements.has(tag.toLowerCase());
}
