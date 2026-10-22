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
import { loadProject, type Project } from './tsconfig.ts';
import { SOURCE_FILE, walk } from './walk.ts';

export type Options = {
  // 空のときは、移動せずに書き方だけをそろえる
  moves: Move[];
  tsconfigs: string[];
  // 書き方をそろえる対象を、このパスの中のファイルに限る。省略するとすべて（移動があるときは使わない）
  scope?: string[];
  // パッケージ（package.json）と設定ファイルを探す起点
  root: string;
  // tsconfig の対象外で、import を書き換えたいファイルまたはフォルダ
  includes: string[];
  // 第 1 引数をモジュール指定子として扱う関数名（DEFAULT_CALLS に加える）
  calls: string[];
  style: Style;
  // 並列に処理する Worker の数。省略するとファイル数と CPU 数から決める（1 以下で Worker を使わない）
  workers?: number;
  // 変更ごとに、行番号と書き換え前後の行を結果に含める
  detail?: boolean;
  // false のときは何も変更せず、結果だけ返す
  apply: boolean;
};

export type Result = {
  scannedFiles: number;
  changedFiles: number;
  changes: Change[];
  suspects: Suspect[];
  configHits: ConfigHit[];
  configFilesChanged: string[];
  warnings: string[];
  timings: Record<string, number>;
};

const READ_CONCURRENCY = 64;
// これより少ないファイル数では、Worker の起動のほうが高くつく
const WORKER_MIN_FILES = 3000;
const MAX_WORKERS = 4;

export const isWorkerCount = (value: number) => Number.isInteger(value) && value >= 1;

const defaultWorkerCount = (files: number) =>
  files < WORKER_MIN_FILES ? 1 : Math.min(availableParallelism(), MAX_WORKERS);

// 近いファイルが同じチャンクに入るよう、順序を保って分ける
const splitEvenly = <T>(items: T[], count: number): T[][] => {
  const size = Math.ceil(items.length / count);
  return Array.from({ length: count }, (_, i) => items.slice(i * size, (i + 1) * size)).filter(
    (chunk) => chunk.length > 0,
  );
};

// ソースのまま動かすときは worker.ts、ビルド後は worker.js
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
  // tsconfig のあるフォルダの外のファイルは、'../shared/x.ts' のような相対パスで照合する
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

// dist/ などに package.json の写しがあっても取り違えないよう、同じ名前ではいちばん浅いものを使う
const dropDuplicateNames = (list: Pkg[], warnings: string[]): Pkg[] => {
  const byName = new Map<string, Pkg>();
  for (const pkg of [...list].sort((a, b) => a.dir.length - b.dir.length)) {
    const kept = byName.get(pkg.name);
    if (kept) {
      warnings.push(`${pkg.dir}/package.json: ignored, same name as ${kept.dir}/package.json: ${pkg.name}`);
    } else {
      byName.set(pkg.name, pkg);
    }
  }
  return [...byName.values()];
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
  checkMoves(
    moves,
    (path) => existsSync(toNative(path)),
    (path) => fs.entries(dirname(path)).has(basename(path)),
  );
  const map = createPathMapper(moves);
  const root = resolve(options.root);
  const realign = moves.length === 0;

  const projects = options.tsconfigs.map((tsconfig) => loadProject(resolve(tsconfig)));
  clock.lap('tsconfig');

  const scanWarnings: string[] = [];
  for (const [index, project] of projects.entries()) {
    const config = options.tsconfigs[index];
    if (project.missing) scanWarnings.push(`${config}: not found; aliases are not resolved`);
    if (project.hasReferences) scanWarnings.push(`${config}: "references" are not followed`);
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
      if (edit) {
        edits.push({ oldPath: file, newPath: map(file), text: edit.text });
        configFilesChanged.push(file);
      }
      configHits.push(
        ...findConfigHits({ file, text, root, froms, skipLines: edit?.changedLines }),
      );
    });
  }
  clock.lap('config files');

  if (options.apply) {
    let moved = 0;
    let written = 0;
    try {
      const deepestFirst = [...moves].sort((a, b) => b.from.length - a.from.length);
      for (const { from, to } of deepestFirst) {
        mkdirSync(toNative(dirname(to)), { recursive: true });
        renameSync(toNative(from), toNative(to));
        moved++;
      }
      await forEachLimit(edits, READ_CONCURRENCY, async ({ newPath, text }) => {
        await writeText(newPath, text);
        written++;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${reason}\nStopped part way: moved ${moved} of ${moves.length} paths, wrote ${written} of ${edits.length} files. Imports may be only partly updated.`,
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
    changedFiles: edits.length,
    changes,
    suspects,
    configHits,
    configFilesChanged: configFilesChanged.sort(),
    warnings,
    timings: clock.timings,
  };
};
