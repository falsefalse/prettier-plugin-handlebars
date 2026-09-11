/* Property: formatting is idempotent and never crashes, over the shared fuzz corpus.
 *
 * While the v2 printer is still growing it throws UnsupportedNodeError on node types it does not
 * handle. Those cases are counted as not-yet-covered rather than failures, so the number means
 * something at every phase. */
import prettier from 'prettier';
import * as plugin from '../dist/plugin.js';
import { fuzzCasesFromEnv } from './fuzz-cases.mjs';

const { cases, seed } = fuzzCasesFromEnv();
const failures = [];
let unsupported = 0;

for (const testCase of cases) {
  try {
    const firstPass = await prettier.format(testCase.source, {
      parser: 'handlebars',
      plugins: [plugin],
      printWidth: 80,
    });
    const secondPass = await prettier.format(firstPass, {
      parser: 'handlebars',
      plugins: [plugin],
      printWidth: 80,
    });

    if (secondPass !== firstPass) {
      failures.push({
        id: testCase.id,
        type: 'non-idempotent',
        source: testCase.source,
        firstPass,
        secondPass,
      });
    }
  } catch (error) {
    if (error?.cause?.name === 'UnsupportedNodeError' || error?.name === 'UnsupportedNodeError') {
      unsupported += 1;
      continue;
    }

    failures.push({
      id: testCase.id,
      type: 'crash',
      source: testCase.source,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}

if (failures.length > 0) {
  console.error(`Fuzz check failed: ${failures.length}/${cases.length} cases failed.`);

  failures.slice(0, 10).forEach((failure) => {
    console.error(`\n--- ${failure.id} ${failure.type} ---`);
    console.error(failure.source);

    if (failure.type === 'crash') {
      console.error(failure.error);
      return;
    }

    console.error('--- first pass ---');
    console.error(failure.firstPass);
    console.error('--- second pass ---');
    console.error(failure.secondPass);
  });

  process.exit(1);
}

const covered = cases.length - unsupported;
console.log(`Format fuzz check passed: ${covered}/${cases.length} cases covered, seed=${seed}.`);
