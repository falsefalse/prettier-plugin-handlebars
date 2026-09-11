/* Formattable coverage over a real corpus, plus the properties that hold over the formattable
 * subset - so a printer that still throws on some node produces a meaningful number.
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
import { die, positiveInt, readArgv } from './lib/argv.mjs';
import { renderDifference } from '../test/lib/render.mts';
import * as plugin from '../dist/plugin.js';

const { values, positionals } = readArgv(process.argv.slice(2), {
  width: { type: 'string' },
  git: { type: 'string' },
  json: { type: 'boolean' },
  'list-overwidth': { type: 'boolean' },
  'list-failures': { type: 'boolean' },
});

const printWidth = positiveInt('--width', values.width) ?? 80;
const gitRepo = values.git;

if (positionals.length === 0) {
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

/* Read at HEAD, never from the working tree: the corpus may be mid-review. */
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

/* This gate cannot tell "checked nothing" from "checked everything and it was fine", so it
 * refuses to report on nothing: a typo'd pathspec would otherwise exit 0 at `0/0 formattable`. */
let files;
try {
  files = gitRepo ? collectFromGit(gitRepo, positionals) : await collectFromDisk(positionals);
} catch (error) {
  die(`cannot read ${positionals.join(', ')}: ${error instanceof Error ? error.message : error}`);
}

if (files.length === 0) {
  die(`no .hbs or .handlebars files under ${positionals.join(', ')}${gitRepo ? ` in ${gitRepo}` : ''}.`);
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

  /* Through the real Handlebars runtime: a regex approximation cannot see whitespace control,
   * standalone statements or broken quoting. */
  const difference = renderDifference(file.source, first);
  if (difference?.kind === 'unrenderable') {
    /* Not a diff - a file this gate did not check. Bucketed with the diffs it reads as a pass. */
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

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { total, formattable } = report;
  console.log(`coverage:        ${formattable}/${total} formattable`);
  console.log(`renders:         ${report.renderChanged.length} changed, ${formattable - report.unrenderable.length}/${formattable} compared`);
  console.log(`whitespace:      ${report.whitespaceChanged.length} amount-only diffs`);
  console.log(`idempotence:     ${report.nonIdempotent.length} unstable`);
  console.log(`width (>${printWidth}):     ${report.overWidth.length} unexcused, ${report.overWidthExcused} unbreakable`);

  if (values['list-failures']) {
    for (const entry of report.unformattable) console.log(`  unformattable ${entry.name}: ${entry.error}`);
    for (const entry of [...report.renderChanged, ...report.whitespaceChanged]) {
      console.log(`  ${entry.kind} changed ${entry.name} (${entry.branch})`);
      console.log(`    before ${JSON.stringify(entry.before.slice(0, 160))}`);
      console.log(`    after  ${JSON.stringify(entry.after.slice(0, 160))}`);
    }
    for (const name of report.nonIdempotent) console.log(`  unstable      ${name}`);
  }

  if (values['list-overwidth']) {
    for (const entry of report.overWidth) {
      console.log(`  ${entry.name}:${entry.line} (${entry.length}) ${entry.text.slice(0, 70)}`);
    }
  }
}

/* A gate has to be able to fail. Coverage and the tolerated buckets - unrenderable, whitespace
 * amount - stay reportable numbers; a changed page or unstable formatting is a violation. */
if (report.renderChanged.length > 0 || report.nonIdempotent.length > 0) {
  process.exit(1);
}
