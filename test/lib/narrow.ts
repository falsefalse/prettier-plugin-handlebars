/* A predicate, so the narrowing is declared once and every caller gets it for free. Its body is
 * the check the compiler cannot make itself; nothing here asserts a type it has not tested. */
function isOfType<U extends { type: string }, T extends U['type']>(
  value: U | undefined,
  type: T,
): value is Extract<U, { type: T }> {
  return value?.type === type;
}

/**
 * The node a test expects, or a failure naming what came instead.
 *
 * Reaching for `as` here would let a parser change go unreported: the cast keeps compiling, and
 * the test fails later on a property that is no longer there - or quietly passes because the
 * assertion never touched the part that moved.
 */
export function ofType<U extends { type: string }, T extends U['type']>(
  value: U | undefined,
  type: T,
): Extract<U, { type: T }> {
  if (!isOfType(value, type)) {
    throw new Error(`expected a ${type}, got ${value?.type ?? 'nothing'}`);
  }

  return value;
}

