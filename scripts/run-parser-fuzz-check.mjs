/* Property: the parser drops no source. Child lists tile their container's span, and every
 * expression part sits inside its call, in order. */
import { parse } from '../dist/parser.js';
import { findExpressionViolations, findTilingViolations } from '../dist/ast-invariants.js';
import { fuzzCasesFromEnv } from './fuzz-cases.mjs';

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

if (failures.length > 0) {
  console.error(`Parser fuzz check failed: ${failures.length}/${cases.length} cases lose source.`);

  for (const failure of failures.slice(0, 8)) {
    console.error(`\n--- ${failure.id} ---`);
    console.error(JSON.stringify(failure.source));
    for (const violation of failure.violations.slice(0, 6)) {
      console.error(`  ${violation.kind} in ${violation.container}: ${JSON.stringify(violation.text)}`);
    }
  }

  process.exit(1);
}

console.log(`Parser fuzz check passed: ${cases.length} cases, seed=${seed}.`);
