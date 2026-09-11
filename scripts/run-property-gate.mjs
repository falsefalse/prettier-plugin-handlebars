/* The recurring corpus gate from docs/REWRITE-PLAN.md section 7.
 *
 * Reports formattable coverage plus the properties that hold over the formattable subset, so a
 * half-built printer that throws on unhandled nodes still produces a meaningful number.
 *
 * Usage:
 *   node scripts/run-property-gate.mjs <dir> [more-dirs...]
 *   node scripts/run-property-gate.mjs --git <repo> <pathspec> [more-pathspecs...]
 *
 * Options: --width <n>  --json  --list-overwidth  --list-failures
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import prettier from 'prettier';
import { renderDifference } from '../test/lib/render.mts';
import * as plugin from '../dist/plugin.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const die = (message) => {
  console.error(message);
  process.exit(1);
};

/* A flag is not a value: `--git --width 90` would take `--width` as the repo path and reach
 * execFileSync with it. Falling back is worse than throwing - it drops the git mode the caller
 * asked for and reads an empty disk tree while exiting 0. */
const valueOf = (name, fallback) => {
  const at = argv.indexOf(name);
  const value = at === -1 ? undefined : argv[at + 1];

  if (at !== -1 && (value === undefined || value.startsWith('--'))) {
    die(`${name} needs a value.`);
  }

  return value ?? fallback;
};

const printWidth = Number.parseInt(valueOf('--width', '80'), 10);
const asJson = flag('--json');
const gitRepo = flag('--git') ? valueOf('--git') : null;
const positional = argv.filter((arg, index) => {
  if (arg.startsWith('--')) return false;
  const previous = argv[index - 1];
  return previous !== '--width' && previous !== '--git';
});

if (positional.length === 0) {
  die('Usage: node scripts/run-property-gate.mjs [--git <repo>] <path> [more-paths...]');
}

const templateExtensions = new Set(['.hbs', '.handlebars']);

async function collectFromDisk(roots) {
  const files = [];

  const walk = async (current) => {
    const stat = await fs.stat(current);
    if (stat.isFile()) {
      if (templateExtensions.has(path.extname(current))) {
        files.push({ name: current, source: await fs.readFile(current, 'utf8') });
      }
      return;
    }

    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(path.join(current, entry.name));
    }
  };

  for (const root of roots) await walk(root);
  return files;
}

/* Reading at HEAD rather than from the working tree, so a corpus someone is mid-review on does
 * not move the numbers under us. */
function collectFromGit(repo, pathspecs) {
  const listed = execFileSync('git', ['-C', repo, 'ls-files', ...pathspecs], { encoding: 'utf8' });

  return listed
    .trim()
    .split('\n')
    .filter((name) => templateExtensions.has(path.extname(name)))
    .map((name) => ({
      name,
      source: execFileSync('git', ['-C', repo, 'show', `HEAD:${name}`], { encoding: 'utf8', maxBuffer: 1 << 28 }),
    }));
}


/* A line the formatter cannot help: even alone on its own line, its longest token overflows. */
function isUnbreakable(line, width) {
  const longest = line.trim().split(/\s+/).reduce((max, token) => Math.max(max, token.length), 0);
  return line.length - line.trimStart().length + longest > width;
}

/* An unreadable path otherwise throws a raw fs stack, and one matching nothing prints
 * `0/0 formattable` and exits 0 - a typo'd pathspec reading as a clean pass. Same vacuity
 * the render property had: this gate cannot tell "checked nothing" from "checked everything and
 * it was fine", so it has to refuse to report on nothing. */
let files;
try {
  files = gitRepo ? collectFromGit(gitRepo, positional) : await collectFromDisk(positional);
} catch (error) {
  die(`cannot read ${positional.join(', ')}: ${error instanceof Error ? error.message : error}`);
}

if (files.length === 0) {
  die(`no .hbs or .handlebars files under ${positional.join(', ')}${gitRepo ? ` in ${gitRepo}` : ''}.`);
}
const format = (source, filepath) =>
  prettier.format(source, { parser: 'handlebars', plugins: [plugin], filepath, printWidth });

const report = {
  total: files.length,
  formattable: 0,
  unformattable: [],
  renderChanged: [],
  whitespaceChanged: [],
  unrenderable: [],
  nonIdempotent: [],
  overWidth: [],
  overWidthExcused: 0,
};

for (const file of files) {
  let first;
  let second;

  try {
    first = await format(file.source, file.name);
    second = await format(first, file.name);
  } catch (error) {
    report.unformattable.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
    continue;
  }

  report.formattable += 1;

  /* Compiled with the real Handlebars runtime rather than approximated with regexes: the
   * approximation could not see whitespace control, standalone statements or broken quoting. */
  const difference = renderDifference(file.source, first);
  if (difference?.kind === 'unrenderable') {
    /* Not a diff - a file this gate did not check. Bucketing it with the whitespace diffs would
     * report a skipped file as a passing comparison. */
    report.unrenderable.push(file.name);
  } else if (difference) {
    const bucket = difference.kind === 'render' ? report.renderChanged : report.whitespaceChanged;
    bucket.push({ name: file.name, ...difference });
  }
  if (second !== first) report.nonIdempotent.push(file.name);

  first.split('\n').forEach((line, index) => {
    if (line.length <= printWidth) return;
    if (isUnbreakable(line, printWidth)) report.overWidthExcused += 1;
    else report.overWidth.push({ name: file.name, line: index + 1, length: line.length, text: line.trim() });
  });
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { total, formattable } = report;
  console.log(`coverage:        ${formattable}/${total} formattable`);
  console.log(`renders:         ${report.renderChanged.length} changed, ${formattable - report.unrenderable.length}/${formattable} compared`);
  console.log(`whitespace:      ${report.whitespaceChanged.length} amount-only diffs`);
  console.log(`idempotence:     ${report.nonIdempotent.length} unstable`);
  console.log(`width (>${printWidth}):     ${report.overWidth.length} unexcused, ${report.overWidthExcused} unbreakable`);

  if (flag('--list-failures')) {
    for (const entry of report.unformattable) console.log(`  unformattable ${entry.name}: ${entry.error}`);
    for (const entry of [...report.renderChanged, ...report.whitespaceChanged]) {
      console.log(`  ${entry.kind} changed ${entry.name} (${entry.branch})`);
      console.log(`    before ${JSON.stringify(entry.before.slice(0, 160))}`);
      console.log(`    after  ${JSON.stringify(entry.after.slice(0, 160))}`);
    }
    for (const name of report.nonIdempotent) console.log(`  unstable      ${name}`);
  }

  if (flag('--list-overwidth')) {
    for (const entry of report.overWidth) {
      console.log(`  ${entry.name}:${entry.line} (${entry.length}) ${entry.text.slice(0, 70)}`);
    }
  }
}

/* A gate has to be able to fail. Coverage and the two tolerated buckets - a file the harness
 * cannot render, a diff in the *amount* of whitespace - stay reportable numbers, but a template
 * whose page changed or whose formatting will not settle is a property violation; exiting 0 on
 * one makes every corpus run read as a pass. */
if (report.renderChanged.length > 0 || report.nonIdempotent.length > 0) {
  process.exit(1);
}
