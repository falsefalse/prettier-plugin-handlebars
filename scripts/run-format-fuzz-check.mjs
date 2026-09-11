/* Properties over the shared fuzz corpus: formatting never crashes, is idempotent, and does not
 * change what the template renders. The malformed corpus must be refused with a location, not
 * quietly formatted into something the author did not write. */
import prettier from 'prettier';
import * as plugin from '../dist/plugin.js';
import { TemplateSyntaxError } from '../dist/errors.js';
import { renderDifference } from '../test/lib/render.mts';
import { fuzzCasesFromEnv, malformed } from './lib/fuzz-cases.mjs';

const { cases, seed } = fuzzCasesFromEnv();
const failures = [];

let renderCompared = 0;

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

    /* Content changes only: the generator emits one-line soup that has to wrap, so a sibling
     * gap turning into a newline is expected here. The corpus gate watches that separately. */
    const difference = renderDifference(testCase.source, firstPass);

    /* A case the harness cannot render is a case this gate did not check, not a pass. */
    if (difference?.kind === 'unrenderable') {
      failures.push({ id: testCase.id, type: 'unrenderable', source: testCase.source });
    } else {
      renderCompared += 1;
    }

    if (difference?.kind === 'render') {
      failures.push({
        id: testCase.id,
        type: 'render-changed',
        source: testCase.source,
        firstPass,
        difference,
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

    if (failure.type === 'render-changed') {
      console.error(`--- renders (${failure.difference.branch}) ---`);
      console.error(JSON.stringify(failure.difference.before));
      console.error(JSON.stringify(failure.difference.after));
      return;
    }

    console.error('--- first pass ---');
    console.error(failure.firstPass);
    console.error('--- second pass ---');
    console.error(failure.secondPass);
  });

  process.exit(1);
}

/* Report what was render-compared, not just what was formatted: a gate that cannot measure its
 * own coverage goes vacuous unnoticed. */
console.log(
  `Format fuzz check passed: ${cases.length} formatted, ${renderCompared} render-compared, ` +
    `${malformed.length} refused, seed=${seed}.`,
);
