/* Argument reading for the scripts under `scripts/`. */
import { parseArgs } from 'node:util';

export function die(message) {
  console.error(message);
  process.exit(1);
}

/** `parseArgs` in strict mode, its throws reduced to the one line that says what is wrong. */
export function readArgv(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true });
  } catch (error) {
    return die(error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
}

/* NaN is not a width: `line.length <= NaN` is false for every line, so every line reads as
 * over-width and the report says `>NaN`. */
export function positiveInt(name, raw) {
  if (raw === undefined) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) die(`${name} needs a positive integer.`);
  return parsed;
}
