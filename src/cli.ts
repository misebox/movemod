#!/usr/bin/env node
// Usage:
//   tsmv <from> <to> [<from> <to> ...]   move files or folders and rewrite imports; <to> is the new path itself
//   tsmv --bulk-list <path>              read the moves from a file, one "<from> <to>" per line
//   tsmv <path>                          normalize the import style inside a file or folder
//                                        use `tsmv .` for everything (for example after adding an alias)
//   with no arguments, nothing happens
//
// Options:
//   --dry-run                  show what would change; change nothing
//   --style <shortest|keep>    shortest: `./` first; when `../` is needed, the shorter of relative and alias (default)
//                              keep: keep each import's current style
//   --tsconfig <path>          tsconfig that selects the files to rewrite (repeatable; default ./tsconfig.json)
//   --bulk-list <path>         file with a list of moves, one "<from> <to>" per line; lines starting with # are ignored
//   --call <name>              function whose first argument is a module path, e.g. vi.mock (repeatable)
//   --include <path>           extra file or folder to rewrite that the tsconfig does not cover (repeatable)
//   --root <dir>               where to look for package.json and config files (default: cwd)
//   --workers <n>              number of worker threads (default: from file count and CPU count; 1 disables)
//   --verbose                  list every changed line
//   --timing                   show the time of each stage
//   --json                     print the result as JSON
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path/posix';
import { parseArgs } from 'node:util';
import { run, type Options } from './engine.ts';
import { resolveInput, toNative, toNativeText } from './paths.ts';
import type { Style } from './style.ts';

const DRY_RUN_LIMIT = 50;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const print = (line: string) => console.log(toNativeText(line));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tsconfig: { type: 'string', multiple: true },
    root: { type: 'string' },
    include: { type: 'string', multiple: true },
    call: { type: 'string', multiple: true },
    style: { type: 'string' },
    workers: { type: 'string' },
    'bulk-list': { type: 'string' },
    'dry-run': { type: 'boolean' },
    verbose: { type: 'boolean' },
    timing: { type: 'boolean' },
    json: { type: 'boolean' },
  },
});

const style = values.style ?? 'shortest';
if (style !== 'shortest' && style !== 'keep') fail('--style must be shortest or keep');

const bulkList = values['bulk-list'];
const scope = positionals.length === 1 && !bulkList ? positionals.map(resolveInput) : undefined;
const paths = scope ? [] : [...positionals];
if (bulkList) {
  for (const line of readFileSync(bulkList, 'utf8').split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const [from, to, ...rest] = text.split(/\s+/);
    if (!to || rest.length > 0) fail(`cannot read this line of the bulk list: ${line}`);
    paths.push(from, to);
  }
}
if (!scope && paths.length === 0) {
  fail('usage: tsmv <from> <to> [<from> <to> ...]  |  tsmv <path>  (see README.md)');
}
if (paths.length % 2 !== 0) fail('give sources and destinations in pairs: <from> <to>');

const moves = [];
for (let i = 0; i < paths.length; i += 2) {
  moves.push({ from: resolveInput(paths[i]), to: resolveInput(paths[i + 1]) });
}

const tsconfigs = (values.tsconfig ?? ['tsconfig.json']).map(resolveInput);
for (const tsconfig of tsconfigs) {
  if (!existsSync(toNative(tsconfig))) fail(`tsconfig not found: ${tsconfig}`);
}

const dryRun = values['dry-run'] ?? false;
const options: Options = {
  moves,
  scope,
  tsconfigs,
  root: resolveInput(values.root ?? '.'),
  includes: (values.include ?? []).map(resolveInput),
  calls: values.call ?? [],
  style: style as Style,
  workers: values.workers === undefined ? undefined : Number(values.workers),
  detail: dryRun || (values.verbose ?? false),
  apply: !dryRun,
};

const cwd = resolveInput('.');
const show = (path: string) => relative(cwd, path) || '.';
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

try {
  const result = await run(options);

  if (values.json) {
    print(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  for (const { from, to } of moves) print(`${show(from)} -> ${show(to)}`);
  for (const warning of result.warnings) console.warn(toNativeText(`warning: ${warning}`));

  if (options.detail) {
    const limit = values.verbose ? result.changes.length : DRY_RUN_LIMIT;
    for (const change of result.changes.slice(0, limit)) {
      print(`\n${show(change.file)}:${change.line}`);
      print(`- ${change.before}`);
      print(`+ ${change.after}`);
    }
    const hidden = result.changes.length - limit;
    if (hidden > 0) print(`\n... and ${plural(hidden, 'more change')} (use --verbose to list all)`);
  }

  if (result.configFilesChanged.length > 0) {
    print(`\nConfig files ${options.apply ? 'updated' : 'to update'}:`);
    for (const file of result.configFilesChanged) print(`  ${show(file)}`);
  }
  if (result.suspects.length > 0) {
    print(`\nCheck by hand: paths in strings that are not imports (${result.suspects.length})`);
    for (const { file, line, text, reason } of result.suspects) {
      print(`  ${show(file)}:${line}  '${text}'  (${reason})`);
    }
  }
  if (result.configHits.length > 0) {
    print(`\nCheck by hand: moved paths in config files (${result.configHits.length})`);
    for (const { file, line, text } of result.configHits) print(`  ${show(file)}:${line}  ${text}`);
  }

  const summary = `${plural(result.changedFiles, 'file')}, ${plural(result.changes.length, 'import')}`;
  print(
    options.apply
      ? `\nDone: ${summary} changed (${plural(result.scannedFiles, 'file')} scanned).`
      : `\nDry run: ${summary} would change (${plural(result.scannedFiles, 'file')} scanned). Nothing was written.`,
  );
  if (values.timing) {
    for (const [label, ms] of Object.entries(result.timings)) {
      print(`  ${label}: ${Math.round(ms)} ms`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
