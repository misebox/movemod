import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path/posix';
import { parseJsonc } from './jsonc.ts';
import { fromNative, toNative } from './paths.ts';

type RawConfig = {
  extends?: string | string[];
  include?: string[];
  exclude?: string[];
  files?: string[];
  references?: unknown[];
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
};

// Path split around '*'. wildcard is false when there is no '*'
export type PathPattern = { prefix: string; suffix: string; wildcard: boolean };

// implicit is an alias implied by baseUrl (written like 'components/Button'). It is not listed in paths
export type Alias = PathPattern & { targets: PathPattern[]; implicit?: boolean };

export type Project = {
  dir: string;
  // Path relative to the tsconfig folder
  include: string[];
  exclude: string[];
  aliases: Alias[];
  // When there is no config file and all files with no aliases are used instead
  missing?: boolean;
  // When references exist but are not followed
  hasReferences?: boolean;
};

type Layer = { dir: string; raw: RawConfig };

const checkShape = (file: string, raw: RawConfig) => {
  for (const key of ['include', 'exclude', 'files'] as const) {
    const value = raw[key];
    if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
      throw new Error(`${file}: "${key}" must be an array of strings`);
    }
  }
};

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

// Ordered from the extends ancestors, with the file itself last
const loadLayers = (file: string, chain: string[] = []): Layer[] => {
  if (chain.includes(file)) {
    throw new Error(`circular "extends": ${[...chain, file].join(' -> ')}`);
  }
  let raw: RawConfig;
  try {
    raw = parseJsonc(readFileSync(toNative(file), 'utf8')) as RawConfig;
  } catch (error) {
    throw new Error(`${file}: cannot read: ${error instanceof Error ? error.message : error}`);
  }
  checkShape(file, raw);
  const dir = dirname(file);
  const parents = [raw.extends ?? []].flat().flatMap((reference) => {
    let parent: string;
    try {
      parent = resolveExtends(dir, reference);
    } catch {
      throw new Error(`${file}: cannot find "extends": ${reference}`);
    }
    return loadLayers(parent, [...chain, file]);
  });
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
  // With no config file, target all files with no aliases
  if (!existsSync(toNative(tsconfig))) {
    return { dir, include: ['**/*'], exclude: [], aliases: [], missing: true };
  }
  let hasReferences = false;
  let include: string[] | undefined;
  let exclude: string[] | undefined;
  let files: string[] | undefined;
  let baseUrl: string | undefined;
  let paths: { dir: string; map: Record<string, string[]> } | undefined;

  const layers = loadLayers(tsconfig);
  for (const layer of layers) {
    const { raw } = layer;
    const fromTop = (pattern: string) =>
      relative(dir, resolve(layer.dir, pattern));
    if (raw.include) include = raw.include.map(fromTop);
    if (raw.exclude) exclude = raw.exclude.map(fromTop);
    if (raw.files) files = raw.files.map(fromTop);
    if (layer === layers[layers.length - 1] && raw.references?.length) hasReferences = true;
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
  if (baseUrl !== undefined) {
    aliases.push({
      ...splitWildcard('*'),
      targets: [splitWildcard(`${baseUrl}/*`)],
      implicit: true,
    });
  }

  return {
    dir,
    include: include ?? files ?? ['**/*'],
    exclude: exclude ?? [],
    aliases,
    hasReferences,
  };
};
