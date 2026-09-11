/** Where a node came from. Optional: a node built rather than read has no source to point at. */
export interface SourceRange {
  range?: [number, number];
}

/** A BOM and a CRLF are not content. Every offset the parser records counts the result. */
export function normalizeInput(text: string): string {
  return text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
}

export function locStart(node: SourceRange): number {
  return node.range?.[0] ?? 0;
}

export function locEnd(node: SourceRange): number {
  return node.range?.[1] ?? 0;
}

/* Non-enumerable, so a range never reaches a snapshot, a `JSON.stringify` or a structural
 * comparison between an expected node and a parsed one. */
export function withRange<T extends object>(node: T, start: number, end: number): T {
  Object.defineProperty(node, 'range', { value: [start, end], enumerable: false, configurable: true });

  return node;
}

/** For a node whose span is only sometimes known - an attribute value outside a template. */
export function withOptionalRange<T extends object>(node: T, start?: number, end?: number): T {
  return typeof start === 'number' && typeof end === 'number' ? withRange(node, start, end) : node;
}
