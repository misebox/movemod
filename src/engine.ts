import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path/posix';
import { Worker } from 'node:worker_threads';
import {
  CONFIG_FILE,
  findConfigHits,
  REWRITABLE_JSON,
  rewriteJsonPaths,
  type ConfigHit,
} from './configFiles.ts';
import { createFsIndex, type FsIndex } from './fsIndex.ts';
import { compilePattern, staticPrefix } from './glob.ts';
import { forEachLimit, readText, writeText } from './io.ts';
import { toNative } from './paths.ts';
import { readPackage, type Pkg } from './packages.ts';
import { checkMoves, createPathMapper, type Move } from './pathMapper.ts';
import { checkInsideRoot } from './root.ts';
import {
  processChunk,
  type ChunkInput,
  type ChunkOutput,
  type FileEdit,
} from './process.ts';
import type { Change } from './rewriter.ts';
import { DEFAULT_CALLS } from './specifiers.ts';
import type { Style } from './style.ts';
import type { Suspect } from './suspects.ts';
import { loadProjects, type Project } from './tsconfig.ts';
import { SOURCE_FILE, walk } from './walk.ts';

export type Options = {
  // When empty, only normalizes the style without moving anything
  moves: Move[];
  tsconfigs: string[];
  // Limits style normalization to files inside this path. All files if omitted (not used when there are moves)
  scope?: string[];
  // Starting point for finding packages (package.json) and config files
  root: string;
  // Files or folders outside tsconfig whose imports should be rewritten
  includes: string[];
  // Names of functions whose first argument is treated as a module specifier (added to DEFAULT_CALLS)
  calls: string[];
  style: Style;
  // Number of parallel Workers. Chosen from file count and CPU count if omitted (1 or less uses no Workers)
  workers?: number;
  // Include the line number and the lines before and after in the result for each change
  detail?: boolean;
  // When false, changes nothing and only returns the result
  apply: boolean;
  // When there are warnings, fails without changing anything
  // Apply even when there are warnings. Without it, warnings stop the run before anything is changed
  force?: boolean;
  // Rewrite paths in package.json, tsconfig*.json and jsconfig*.json. Without it, they are only reported
  rewriteConfig?: boolean;
};

export type Result = {
  scannedFiles: number;
  // Number of files left unchanged because of syntax errors etc.
  skippedFiles: number;
  changedFiles: number;
  changes: Change[];
  suspects: Suspect[];
  configHits: ConfigHit[];
  configFilesChanged: string[];
  warnings: string[];
  timings: Record<string, number>;
};

const READ_CONCURRENCY = 64;
// With fewer files than this, starting Workers costs more than it saves
const WORKER_MIN_FILES = 3000;
const MAX_WORKERS = 4;

export const isWorkerCount = (value: number) => Number.isInteger(value) && value >= 1;

const defaultWorkerCount = (files: number) =>
  files < WORKER_MIN_FILES ? 1 : Math.min(availableParallelism(), MAX_WORKERS);

// Split while keeping order, so nearby files land in the same chunk
const splitEvenly = <T>(items: T[], count: number): T[][] => {
  const size = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, i) => items.slice(i * size, (i + 1) * size)).filter(
    (chunk) => chunk.length > 0,
  );
};

// worker.ts when running from source, worker.js after build
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
  import.meta.url,
);

const runInWorker = async (input: ChunkInput): Promise<ChunkOutput> => {
  const worker = new Worker(WORKER_URL);
  try {
    return await new Promise<ChunkOutput>((resolvePromise, reject) => {
      worker.once('message', resolvePromise);
      worker.once('error', reject);
      worker.once('messageerror', reject);
      worker.once('exit', (code) => reject(new Error(`worker exited with code ${code}`)));
      worker.postMessage(input);
    });
  } finally {
    await worker.terminate();
  }
};

const listProjectFiles = (fs: FsIndex, project: Project, seen: Set<string>): string[] => {
  const includes = project.include.map(compilePattern);
  const excludes = project.exclude.map(compilePattern);
  // Files outside the tsconfig folder are matched by relative path such as '../shared/x.ts'
  const relativeToProject = (path: string) => relative(project.dir, path);
  const isExcluded = (path: string) => excludes.some((pattern) => pattern.test(relativeToProject(path)));

  const roots = [...new Set(project.include.map((pattern) => staticPrefix(pattern)))]
    .map((prefix) => resolve(project.dir, prefix || '.'))
    .sort()
    .filter((root, index, all) => !all.slice(0, index).some((other) => root.startsWith(`${other}/`)));

  const files: string[] = [];
  const add = (path: string, name: string) => {
    if (!SOURCE_FILE.test(name) || seen.has(path)) return;
    const projectRelative = relativeToProject(path);
    if (!includes.some((pattern) => pattern.test(projectRelative)) || isExcluded(path)) return;
    seen.add(path);
    files.push(path);
  };
  for (const root of roots) walk(fs, root, isExcluded, add);
  return files;
};

// Packages sharing a name: a copy inside the other one (e.g. dist/package.json) belongs to it, so the
// outer one is used. Folders that are unrelated cannot be told apart, so none is used and it warns
const dropDuplicateNames = (list: Pkg[], warnings: string[]): Pkg[] => {
  const groups = new Map<string, Pkg[]>();
  for (const pkg of list) groups.set(pkg.name, [...(groups.get(pkg.name) ?? []), pkg]);
  return [...groups].flatMap(([name, group]) => {
    if (group.length === 1) return group;
    const owner = group.find((pkg) => group.every((other) => other === pkg || other.dir.startsWith(`${pkg.dir}/`)));
    if (owner) return [owner];
    warnings.push(`same package name "${name}" in ${group.map((pkg) => pkg.dir).sort().join(', ')}; none of them is used`);
    return [];
  });
};

// Check whether the name exists on disk, case-sensitive but ignoring Unicode normalization (NFC vs NFD)
const hasExactName = (entries: Map<string, unknown>, name: string): boolean => {
  if (entries.has(name)) return true;
  const normalized = name.normalize('NFC');
  return [...entries.keys()].some((entry) => entry.normalize('NFC') === normalized);
};

const timer = () => {
  const timings: Record<string, number> = {};
  let last = performance.now();
  return {
    timings,
    lap: (label: string) => {
      const now = performance.now();
      timings[label] = (timings[label] ?? 0) + now - last;
      last = now;
    },
  };
};

export const run = async (options: Options): Promise<Result> => {
  const clock = timer();
  const moves = options.moves.map(({ from, to }) => ({ from: resolve(from), to: resolve(to) }));
  const fs = createFsIndex();
  const root = resolve(options.root);
  checkInsideRoot(moves, root);
  checkMoves(
    moves,
    (path) => existsSync(toNative(path)),
    (path) => hasExactName(fs.entries(dirname(path)), basename(path)),
    (path) => [...fs.entries(path)].map(([name, kind]) => (kind === 'dir' ? `${name}/` : name)),
  );
  const map = createPathMapper(moves);
  const realign = moves.length === 0;

  const loadedProjects = loadProjects(options.tsconfigs.map((tsconfig) => resolve(tsconfig)));
  const projects = loadedProjects.map(({ project }) => project);
  clock.lap('tsconfig');

  const scanWarnings: string[] = [];
  for (const { config, project } of loadedProjects) {
    if (project.missing) scanWarnings.push(`${config}: not found; aliases are not resolved`);
  }

  const packageList: Pkg[] = [];
  const configFiles: string[] = [];
  walk(fs, root, () => false, (path, name) => {
    if (name === 'package.json' && dirname(path) !== root) {
      const pkg = readPackage(path, (message) => scanWarnings.push(message));
      if (pkg) packageList.push(pkg);
    }
    if (CONFIG_FILE.test(name)) configFiles.push(path);
  });
  const packages = dropDuplicateNames(packageList, scanWarnings);
  clock.lap('scan config files');

  const seen = new Set<string>();
  const projectFiles = projects.map((project) => listProjectFiles(fs, project, seen));
  const extraFiles: string[] = [];
  for (const include of options.includes) {
    walk(fs, resolve(include), () => false, (path, name) => {
      if (SOURCE_FILE.test(name) && !seen.has(path)) {
        seen.add(path);
        extraFiles.push(path);
      }
    });
  }
  const inScope = (file: string) =>
    !options.scope || options.scope.some((path) => file === path || file.startsWith(`${path}/`));
  const targets = [
    ...projectFiles.flatMap((files, index) => files.map((file) => ({ file, index }))),
    ...extraFiles.map((file) => ({ file, index: 0 })),
  ].filter(({ file }) => inScope(file));
  clock.lap('scan sources');

  const input: Omit<ChunkInput, 'targets'> = {
    moves,
    root,
    style: options.style,
    calls: [...DEFAULT_CALLS, ...options.calls],
    realign,
    detail: options.detail ?? false,
    aliasesByProject: projects.map((project) => project.aliases),
    packageList: packages,
  };
  if (options.workers !== undefined && !isWorkerCount(options.workers)) {
    throw new Error(`workers must be a positive integer: ${options.workers}`);
  }
  const workerCount = options.workers ?? defaultWorkerCount(targets.length);
  let outputs: ChunkOutput[];
  if (workerCount <= 1) {
    outputs = [processChunk({ ...input, targets }, fs)];
  } else {
    const chunks = splitEvenly(targets, workerCount);
    if (chunks.flat().length !== targets.length) throw new Error('internal error: files were lost when splitting the work');
    outputs = await Promise.all(chunks.map((chunk) => runInWorker({ ...input, targets: chunk })));
  }

  const edits: FileEdit[] = outputs.flatMap((output) => output.edits);
  const changes: Change[] = outputs.flatMap((output) => output.changes);
  const suspects: Suspect[] = outputs.flatMap((output) => output.suspects);
  const warnings: string[] = [
    ...new Set([...scanWarnings, ...fs.problems(), ...outputs.flatMap((output) => output.warnings)]),
  ];
  if (targets.length === 0) {
    warnings.push('no source files to process; check --tsconfig, --include or the path');
  }
  const scanned = new Set(targets.map(({ file }) => file));
  for (const { from } of moves) {
    const unscanned: string[] = [];
    walk(fs, from, () => false, (path, name) => {
      if (SOURCE_FILE.test(name) && !scanned.has(path)) unscanned.push(path);
    });
    if (unscanned.length > 0) {
      warnings.push(
        `${unscanned.length} source files in ${from} are outside the tsconfig include, so their imports were not updated (use --include): ${unscanned.slice(0, 3).join(', ')}`,
      );
    }
  }
  const skippedFiles = outputs.reduce((sum, output) => sum + output.skipped, 0);
  clock.lap('read and rewrite');

  const configHits: ConfigHit[] = [];
  const configFilesChanged: string[] = [];
  if (!realign) {
    const froms = moves.map(({ from }) => from);
    await forEachLimit(configFiles, READ_CONCURRENCY, async (file) => {
      let text: string;
      try {
        text = await readText(file);
      } catch (error) {
        warnings.push(`${file}: skipped, ${error instanceof Error ? error.message : error}`);
        return;
      }
      const name = file.slice(file.lastIndexOf('/') + 1);
      const edit = REWRITABLE_JSON.test(name)
        ? rewriteJsonPaths(file, text, map, (path) => existsSync(toNative(path)))
        : undefined;
      if (edit && options.rewriteConfig) {
        edits.push({ oldPath: file, newPath: map(file), text: edit.text });
        configFilesChanged.push(file);
      } else if (edit) {
        // Not rewritten without --rewrite-config: report the lines that would change
        const lines = text.split('\n');
        for (const line of edit.changedLines) configHits.push({ file, line, text: lines[line - 1].trim() });
      }
      configHits.push(
        ...findConfigHits({ file, text, root, froms, skipLines: edit?.changedLines }),
      );
    });
  }
  clock.lap('config files');

  if (options.apply && !options.force && warnings.length > 0) {
    throw new Error(
      `nothing was changed because of ${warnings.length} warnings (add --force to apply anyway):\n${warnings.map((warning) => `  ${warning}`).join('\n')}`,
    );
  }

  if (options.apply) {
    const done: string[] = [];
    let written = 0;
    try {
      const deepestFirst = [...moves].sort((a, b) => b.from.length - a.from.length);
      for (const { from, to } of deepestFirst) {
        mkdirSync(toNative(dirname(to)), { recursive: true });
        renameSync(toNative(from), toNative(to));
        done.push(`${from} -> ${to}`);
      }
      await forEachLimit(edits, READ_CONCURRENCY, async ({ newPath, text }) => {
        await writeText(newPath, text);
        written++;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (done.length === 0 && written === 0) throw new Error(`${reason}\nNothing was changed.`);
      throw new Error(
        `${reason}\nStopped part way: wrote ${written} of ${edits.length} files. Moved already:\n${done.map((line) => `  ${line}`).join('\n') || '  (none)'}\nImports may be only partly updated.`,
      );
    }
  }
  clock.lap('write');

  changes.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  suspects.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  configHits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  warnings.sort();
  return {
    scannedFiles: targets.length,
    skippedFiles,
    changedFiles: edits.length,
    changes,
    suspects,
    configHits,
    configFilesChanged: configFilesChanged.sort(),
    warnings,
    timings: clock.timings,
  };
};
