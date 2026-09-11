/* Prints what the formatter would do to a corpus, for reading by eye.
 *
 * The property gates prove correctness; they cannot see bad taste, which is the failure mode
 * that actually matters here. Every printer phase ends with someone reading this output.
 *
 * Usage:
 *   node scripts/corpus-diff.mjs --repo ../some-app --path app/templates
 *   ... --stat              one line per file
 *   ... --only budgets      filter paths by substring
 *   ... --limit 3           stop after N differing files
 *   ... --width 80
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prettier from 'prettier';
import * as plugin from '../dist/plugin.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);

const die = (message) => {
  console.error(message);
  process.exit(1);
};

/* A flag is not a value: `--repo --stat` would otherwise take `--stat` as the repo path. */
const valueOf = (name, fallback) => {
  const at = argv.indexOf(name);
  if (at === -1) return fallback;

  const value = argv[at + 1];
  if (value === undefined || value.startsWith('--')) die(`${name} needs a value.`);
  return value;
};

const repo = valueOf('--repo', '') || die('--repo <path to a repo holding .hbs templates> is required.');
const pathspec = valueOf('--path', '') || die('--path <pathspec within the repo> is required.');
const printWidth = Number.parseInt(valueOf('--width', '95'), 10);
const only = valueOf('--only', '');
const limit = Number.parseInt(valueOf('--limit', '0'), 10) || Infinity;
const statOnly = flag('--stat');

/* Read at HEAD, never from the working tree: the corpus may be mid-review. */
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

const files = git('ls-files', pathspec)
  .trim()
  .split('\n')
  .filter((name) => name.endsWith('.hbs') && name.includes(only));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbs-diff-'));
const before = path.join(tempDir, 'source');
const after = path.join(tempDir, 'formatted');

let identical = 0;
let unsupported = 0;
let differing = 0;
let shown = 0;

for (const name of files) {
  const source = git('show', `HEAD:${name}`);
  let formatted;

  try {
    formatted = await prettier.format(source, { parser: 'handlebars', plugins: [plugin], filepath: name, printWidth });
  } catch (error) {
    unsupported += 1;
    if (statOnly) console.log(`  skip  ${name}  (${error.message.split('\n')[0]})`);
    continue;
  }

  if (formatted === source) {
    identical += 1;
    continue;
  }

  differing += 1;

  if (statOnly) {
    const changed = formatted.split('\n').length - source.split('\n').length;
    console.log(`  diff  ${name}  (${changed >= 0 ? '+' : ''}${changed} lines)`);
    continue;
  }

  if (shown >= limit) continue;
  shown += 1;

  fs.writeFileSync(before, source);
  fs.writeFileSync(after, formatted);
  console.log(`\n########## ${name}`);
  try {
    execFileSync('diff', ['-u', '--label', `${name} (source)`, before, '--label', `${name} (formatted)`, after], {
      stdio: 'inherit',
    });
  } catch {
    /* diff exits non-zero when files differ, which is the whole point. */
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });

console.log(
  `\n${files.length} files at width ${printWidth}: ${identical} unchanged, ${differing} differ, ${unsupported} not yet supported.`,
);
