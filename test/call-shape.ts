/* Most parser tests care about *what* a call says, not how its parts are modelled. This flattens
 * every call node back to plain strings so those assertions stay readable; the structured shape
 * has its own suite in expression.test.ts. */

type Unknown = Record<string, unknown>;

const isObject = (value: unknown): value is Unknown => typeof value === 'object' && value !== null;

function hasSource(value: unknown): value is { source: string } {
  return isObject(value) && typeof value.source === 'string';
}

function isCall(value: Unknown): boolean {
  return hasSource(value.path) && Array.isArray(value.params) && Array.isArray(value.hash);
}

export function flattenCalls<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map(flattenCalls) as unknown as T;
  }

  if (!isObject(node)) {
    return node;
  }

  /* `range` is defined non-enumerable so it stays out of snapshots; copy descriptors rather
   * than entries so the copy keeps that property too. */
  const flattened: Unknown = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
    Object.defineProperty(flattened, key, {
      ...descriptor,
      ...('value' in descriptor ? { value: flattenCalls(descriptor.value) } : {}),
    });
  }

  if (isCall(node) && hasSource(node.path)) {
    flattened.path = node.path.source;
    flattened.params = (node.params as Array<{ source: string }>).map((param) => param.source);
    flattened.hash = (node.hash as Array<{ key: string; value: { source: string } }>).map((pair) => ({
      key: pair.key,
      value: pair.value.source,
    }));
  }

  return flattened as T;
}
