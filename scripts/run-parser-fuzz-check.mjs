/* Property: the parser drops no source. Child lists tile their container's span, and every
 * expression part sits inside its call, in order.
 *
 * Tiling only means something over source the parser accepts, so the malformed corpus gets the
 * other half of the contract: it must be refused, and the refusal must say where. */
import { parse } from '../dist/parser.js';
import { findExpressionViolations, findTilingViolations } from '../dist/ast-invariants.js';
import { TemplateSyntaxError } from '../dist/errors.js';
import { fuzzCasesFromEnv, malformed } from './fuzz-cases.mjs';

const { cases, seed } = fuzzCasesFromEnv();
const failures = [];

for (const testCase of cases) {
  try {
    const ast = parse(testCase.source);
    const violations = [
      ...findTilingViolations(ast, testCase.source),
      ...findExpressionViolations(ast, testCase.source),
    ];
    if (violations.length > 0) failures.push({ id: testCase.id, source: testCase.source, violations });
  } catch (error) {
    failures.push({
      id: testCase.id,
      source: testCase.source,
      violations: [{ kind: 'crash', container: '-', text: error instanceof Error ? error.message : String(error) }],
    });
  }
}

for (const source of malformed) {
  let error = null;
  try {
    parse(source);
  } catch (thrown) {
    error = thrown;
  }

  if (!(error instanceof TemplateSyntaxError) || !error.loc?.start) {
    failures.push({
      id: 'malformed',
      source,
      violations: [{ kind: 'accepted', container: '-', text: error ? String(error.message) : 'no error thrown' }],
    });
  }
}

if (failures.length > 0) {
  console.error(`Parser fuzz check failed: ${failures.length}/${cases.length + malformed.length} cases.`);

  for (const failure of failures.slice(0, 8)) {
    console.error(`\n--- ${failure.id} ---`);
    console.error(JSON.stringify(failure.source));
    for (const violation of failure.violations.slice(0, 6)) {
      console.error(`  ${violation.kind} in ${violation.container}: ${JSON.stringify(violation.text)}`);
    }
  }

  process.exit(1);
}

console.log(`Parser fuzz check passed: ${cases.length} cases tile, ${malformed.length} refused, seed=${seed}.`);
