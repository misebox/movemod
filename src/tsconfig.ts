import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path/posix';
import { parseJsonc } from './jsonc.ts';
import { fromNative, toNative } from './paths.ts';

type RawConfig = {
  extends?: string | string[];
  include?: string[];
  exclude?: string[];
  files?: string[];
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
};

// '*' で前後に分けたパス。'*' が無いときは wildcard が false
export type PathPattern = { prefix: string; suffix: string; wildcard: boolean };

export type Alias = PathPattern & { targets: PathPattern[] };

export type Project = {
  dir: string;
  // tsconfig のあるフォルダからの相対パス
  include: string[];
  exclude: string[];
  aliases: Alias[];
};

type Layer = { dir: string; raw: RawConfig };

const resolveExtends = (dir: string, reference: string): string => {
  if (reference.startsWith('.') || isAbsolute(reference)) {
    return resolve(dir, reference.endsWith('.json') ? reference : `${reference}.json`);
  }
  const require = createRequire(toNative(join(dir, 'package.json')));
  try {
    return fromNative(require.resolve(reference));
  } catch {
    return fromNative(require.resolve(`${reference}/tsconfig.json`));
  }
};

// extends の先祖から順に、自分が最後になるように並べる
const loadLayers = (file: string): Layer[] => {
  const raw = parseJsonc(readFileSync(toNative(file), 'utf8')) as RawConfig;
  const dir = dirname(file);
  const parents = [raw.extends ?? []]
    .flat()
    .flatMap((reference) => loadLayers(resolveExtends(dir, reference)));
  return [...parents, { dir, raw }];
};

const splitWildcard = (value: string): PathPattern => {
  const index = value.indexOf('*');
  if (index === -1) return { prefix: value, suffix: '', wildcard: false };
  return {
    prefix: value.slice(0, index),
    suffix: value.slice(index + 1),
    wildcard: true,
  };
};

export const loadProject = (tsconfig: string): Project => {
  const dir = dirname(tsconfig);
  let include: string[] | undefined;
  let exclude: string[] | undefined;
  let files: string[] | undefined;
  let baseUrl: string | undefined;
  let paths: { dir: string; map: Record<string, string[]> } | undefined;

  for (const layer of loadLayers(tsconfig)) {
    const { raw } = layer;
    const fromTop = (pattern: string) =>
      relative(dir, resolve(layer.dir, pattern));
    if (raw.include) include = raw.include.map(fromTop);
    if (raw.exclude) exclude = raw.exclude.map(fromTop);
    if (raw.files) files = raw.files.map(fromTop);
    const options = raw.compilerOptions;
    if (options?.baseUrl !== undefined) baseUrl = resolve(layer.dir, options.baseUrl);
    if (options?.paths) paths = { dir: layer.dir, map: options.paths };
  }

  const pathsBase = baseUrl ?? paths?.dir ?? dir;
  const aliases = Object.entries(paths?.map ?? {})
    .map(([key, targets]) => ({
      ...splitWildcard(key),
      targets: targets.map((target) => splitWildcard(resolve(pathsBase, target))),
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    dir,
    include: include ?? files ?? ['**/*'],
    exclude: exclude ?? [],
    aliases,
  };
};
