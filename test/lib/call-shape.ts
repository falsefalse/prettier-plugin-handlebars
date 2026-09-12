import type { Call } from '../../src/types';

/* Most parser tests care about *what* a call says, not how its parts are modelled. This flattens
 * every call node back to plain strings so those assertions stay readable; the structured shape
 * has its own suite in expression.test.ts. */

/** Every call carries these three, whatever node type it is - which is all this walk needs. */
type CallLike = {
  path: { source: string };
  params: { source: string }[];
  hash: { key: string; value: { source: string } }[];
};

/* Structural, not by node type: mustaches, blocks, partials, decorators and subexpressions all
 * carry the same three properties. A predicate rather than a cast, so the claim is the check. */
function isCallLike(node: object): node is CallLike {
  return 'params' in node && Array.isArray(node.params) && 'hash' in node && Array.isArray(node.hash);
}

function flatten(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(flatten);
  }

  if (typeof node !== 'object' || node === null) {
    return node;
  }

  const flattened: Record<string, unknown> = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, flatten(value)]),
  );

  /* `range` is the one non-enumerable property, kept that way so it stays out of assertions
   * while the location hooks can still read it. Carry the descriptor, not the value. */
  const range = Object.getOwnPropertyDescriptor(node, 'range');
  if (range) {
    Object.defineProperty(flattened, 'range', range);
  }

  if (isCallLike(node)) {
    flattened.path = node.path.source;
    flattened.params = node.params.map((param) => param.source);
    flattened.hash = node.hash.map((pair) => ({ key: pair.key, value: pair.value.source }));
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

/* The one place a cast is unavoidable: `Flat` is a type-level rewrite of the tree, and no
 * amount of narrowing inside `flatten` can show the compiler it performed that rewrite. */
export function flattenCalls<T>(node: T): Flat<T> {
  return flatten(node) as Flat<T>;
}
