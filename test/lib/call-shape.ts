import type { Call } from '../../src/types';

/* Most parser tests care about *what* a call says, not how its parts are modelled. This flattens
 * every call node back to plain strings so those assertions stay readable; the structured shape
 * has its own suite in expression.test.ts. */

/* The walk is over shapeless AST data, so it is typed as such: hand-rolled guards here would
 * only assert what the parser's own types already say. */
function flatten(node: any): any {
  if (Array.isArray(node)) {
    return node.map(flatten);
  }

  if (typeof node !== 'object' || node === null) {
    return node;
  }

  const flattened = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, flatten(value)]));

  /* `range` is the one non-enumerable property, kept that way so it stays out of assertions
   * while the location hooks can still read it. Carry the descriptor, not the value. */
  const range = Object.getOwnPropertyDescriptor(node, 'range');
  if (range) {
    Object.defineProperty(flattened, 'range', range);
  }

  /* Structural, not by node type: mustaches, blocks, partials, decorators and subexpressions
   * all carry the same three properties. */
  if (Array.isArray(node.params) && Array.isArray(node.hash)) {
    flattened.path = node.path.source;
    flattened.params = node.params.map((param: any) => param.source);
    flattened.hash = node.hash.map((pair: any) => ({ key: pair.key, value: pair.value.source }));
  }

  return flattened;
}

/** Every call's parts, as `flatten` leaves them. */
type FlatCallParts = { path: string; params: string[]; hash: { key: string; value: string }[] };

/** The tree with every call's parts replaced by their source text. */
export type Flat<T> = T extends Call
    ? Omit<{ [K in keyof T]: Flat<T[K]> }, keyof FlatCallParts> & FlatCallParts
    : T extends object
      ? { [K in keyof T]: Flat<T[K]> }
      : T;

export function flattenCalls<T>(node: T): Flat<T> {
  return flatten(node);
}
