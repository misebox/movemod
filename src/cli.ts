#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative } from 'node:path/posix';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { parseBulkList, parseWorkers } from './args.ts';
import { run, type Options } from './engine.ts';
import { fromNative, resolveInput, toNative, toNativeText } from './paths.ts';
import { findTsconfigs, resolveRoot } from './root.ts';
import type { Style } from './style.ts';

const DRY_RUN_LIMIT = 50;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const print = (line: string) => console.log(toNativeText(line));

const USAGE = `Move TS/JS files and folders, and rewrite the imports that point to them.

Usage:
  movemod <from> <to> [<from> <to> ...]  move and rewrite imports
  movemod <path>                         normalize the import style in a file or folder ("." for all)

Options:
  --dry-run                 show what would change; change nothing
  --bulk-list <path>        file with moves, one "<from> <to>" per line; lines starting with "#" are ignored
  --style <shortest|keep|relative>
                            shortest: relative first, alias when shorter (default); keep: keep each import's style;
                            relative: always relative (aliases are expanded)
  --tsconfig <path>         tsconfig or jsconfig that selects the files (repeatable; default: above each path, the nearest folder's tsconfig.json, else tsconfig.*.json, else jsconfig.json)
  --func <name>             also rewrite the path in the first argument of this function, e.g. loadModule (repeatable)
                            built in: require, import(), vi.mock, jest.mock
  --include <path>          extra file or folder to rewrite (repeatable)
  --root <dir>              project root: where to look for package.json and config files; all paths must be inside
                            default: for each path, go up from its folder and stop at the first match:
                            package.json/deno.json/jsr.json > .git/.hg/.svn > tsconfig.json/jsconfig.json > the folder shared by the paths.
                            If the paths give different roots (a move between packages or projects), it stops;
                            set --root to a folder that contains all of them (e.g. the workspaces root)
  --workers <n>             worker threads (1 disables)
  --verbose                 list every changed line
  --timing                  show the time of each stage
  --json                    print the result as JSON
  --rewrite-config          also rewrite paths in package.json, tsconfig*.json and jsconfig*.json (default: only report them)
  --force                   apply even with warnings (skipped files, unresolved imports); without it, warnings stop the run before any change
  -h, --help                show this help`;

const parse = () =>
  parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      tsconfig: { type: 'string', multiple: true },
      root: { type: 'string' },
      include: { type: 'string', multiple: true },
      func: { type: 'string', multiple: true },
      style: { type: 'string' },
      workers: { type: 'string' },
      'bulk-list': { type: 'string' },
      'dry-run': { type: 'boolean' },
      verbose: { type: 'boolean' },
      timing: { type: 'boolean' },
      json: { type: 'boolean' },
      force: { type: 'boolean' },
      'rewrite-config': { type: 'boolean' },
    },
  });

let parsed: ReturnType<typeof parse>;
try {
  parsed = parse();
} catch (error) {
  fail(`${error instanceof Error ? error.message.split('.')[0] : error}\n\n${USAGE}`);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const style = values.style ?? 'shortest';
if (style !== 'shortest' && style !== 'keep' && style !== 'relative') {
  fail('--style must be shortest, keep or relative');
}

const requireExisting = (label: string, path: string) => {
  if (!existsSync(toNative(path))) fail(`${label} not found: ${path}`);
};

const bulkList = values['bulk-list'];
const scope = positionals.length === 1 && !bulkList ? positionals.map(resolveInput) : undefined;
const paths = scope ? [] : [...positionals];
if (bulkList) {
  try {
    paths.push(...parseBulkList(readFileSync(bulkList, 'utf8')));
  } catch (error) {
    fail(`${bulkList}: ${error instanceof Error ? error.message : error}`);
  }
}
if (!scope && paths.length === 0) {
  fail(USAGE);
}
for (const path of scope ?? []) requireExisting('path', path);
if (paths.length % 2 !== 0) fail('give sources and destinations in pairs: <from> <to>');

const moves = [];
for (let i = 0; i < paths.length; i += 2) {
  moves.push({ from: resolveInput(paths[i]), to: resolveInput(paths[i + 1]) });
}

const exists = (path: string) => existsSync(toNative(path));
const listNames = (dir: string): string[] => {
  try {
    return readdirSync(toNative(dir));
  } catch {
    return [];
  }
};
const readIfExists =(path: string) => (exists(path) ? readFileSync(toNative(path), 'utf8') : undefined);
// The folders to search from. To normalize a folder, the folder itself; for a move, the folder holding
// each path (a moved folder's own package.json does not make it the project)
const startFolders = scope
  ? scope.map((path) => (statSync(toNative(path)).isDirectory() ? path : dirname(path)))
  : moves.flatMap(({ from, to }) => [dirname(from), dirname(to)]);
let detected: { root: string; reason: string };
if (values.root) {
  detected = { root: resolveInput(values.root), reason: '--root' };
} else {
  try {
    detected = resolveRoot(startFolders, fromNative(homedir()), exists, readIfExists);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
const root = detected.root;
requireExisting('--root', root);

// Without --tsconfig: the nearest one above each path, else ./tsconfig.json (reported as not found)
const nearestConfigs = [
  ...new Set(
    (scope ?? moves.map(({ from }) => from)).flatMap((path) => findTsconfigs(path, root, listNames)),
  ),
];
const tsconfigs = (values.tsconfig ?? (nearestConfigs.length > 0 ? nearestConfigs : ['tsconfig.json'])).map(
  resolveInput,
);
if (values.tsconfig) {
  for (const tsconfig of tsconfigs) {
    if (!exists(tsconfig)) fail(`tsconfig not found: ${tsconfig}`);
  }
}

const includes = (values.include ?? []).map(resolveInput);
for (const include of includes) requireExisting('--include', include);

let workers: number | undefined;
try {
  workers = parseWorkers(values.workers);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const dryRun = values['dry-run'] ?? false;
const options: Options = {
  moves,
  scope,
  tsconfigs,
  root,
  includes,
  calls: values.func ?? [],
  style: style as Style,
  workers,
  detail: dryRun || (values.verbose ?? false),
  apply: !dryRun,
  force: values.force ?? false,
  rewriteConfig: values['rewrite-config'] ?? false,
};

const cwd = resolveInput('.');
const show = (path: string) => relative(cwd, path) || '.';
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

try {
  const result = await run(options);

  // A dry run with warnings exits with 1 too: applying it would stop
  const exitCode = !values.force && result.warnings.length > 0 ? 1 : 0;

  if (values.json) {
    print(JSON.stringify(result, null, 2));
    process.exit(exitCode);
  }

  print(`root: ${show(root)} (${detected.reason})`);
  for (const config of result.configs) {
    const detail = config.missing ? 'not found' : `aliases: ${config.aliases.join(', ') || 'none'}`;
    print(`tsconfig: ${show(config.file)} (${config.referenced ? 'referenced; ' : ''}${detail})`);
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
    print(`\nCheck by hand: paths in strings that point to moved files (${result.suspects.length})`);
    for (const { file, line, text, reason, callee } of result.suspects) {
      const quoted = callee ? `${callee}('${text}')` : `'${text}'`;
      print(`  ${show(file)}:${line}  ${quoted}${reason ? `  (${reason})` : ''}`);
    }
  }
  if (result.configHits.length > 0) {
    print(`\nCheck by hand: moved paths in config files (${result.configHits.length})`);
    for (const { file, line, text } of result.configHits) print(`  ${show(file)}:${line}  ${text}`);
  }

  const summary = `${plural(result.changedFiles, 'file')}, ${plural(result.changes.length, 'import')}`;
  const skipped =
    result.skippedFiles > 0
      ? ` ${plural(result.skippedFiles, 'file')} skipped; imports in them were NOT updated.`
      : '';
  print(
    options.apply
      ? `\nDone: ${summary} changed (${plural(result.scannedFiles, 'file')} scanned).${skipped}`
      : `\nDry run: ${summary} would change (${plural(result.scannedFiles, 'file')} scanned). Nothing was written.${skipped}`,
  );
  if (values.timing) {
    for (const [label, ms] of Object.entries(result.timings)) {
      print(`  ${label}: ${Math.round(ms)} ms`);
    }
  }
  process.exitCode = exitCode;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
