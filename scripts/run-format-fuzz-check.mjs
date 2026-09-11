/* Property: formatting is idempotent and never crashes over the shared fuzz corpus - and the
 * other way round for the malformed corpus, which must be refused with a location rather than
 * quietly formatted into something the author did not write. */
import prettier from 'prettier';
import * as plugin from '../dist/plugin.js';
import { TemplateSyntaxError } from '../dist/errors.js';
import { fuzzCasesFromEnv, malformed } from './fuzz-cases.mjs';

const { cases, seed } = fuzzCasesFromEnv();
const failures = [];

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
    failures.push({
      id: testCase.id,
      type: 'crash',
      source: testCase.source,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}

for (const source of malformed) {
  let error = null;
  try {
    await prettier.format(source, { parser: 'handlebars', plugins: [plugin], printWidth: 80 });
  } catch (thrown) {
    error = thrown;
  }

  if (!(error instanceof TemplateSyntaxError) || !error.loc?.start) {
    failures.push({
      id: 'malformed',
      type: 'accepted',
      source,
      error: error ? String(error.message) : 'no error thrown',
    });
  }
}

if (failures.length > 0) {
  console.error(`Fuzz check failed: ${failures.length}/${cases.length} cases failed.`);

  failures.slice(0, 10).forEach((failure) => {
    console.error(`\n--- ${failure.id} ${failure.type} ---`);
    console.error(failure.source);

    if (failure.type === 'crash' || failure.type === 'accepted') {
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

console.log(`Format fuzz check passed: ${cases.length} formatted, ${malformed.length} refused, seed=${seed}.`);
