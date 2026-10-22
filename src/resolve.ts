import { basename, dirname, join } from 'node:path/posix';
import type { FsIndex } from './fsIndex.ts';
import type { Alias } from './tsconfig.ts';

const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
];

// Specifier written as 'x.js' that points to x.ts (ESM style)
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const TS_EXTENSIONS = ['.tsx', '.ts', '.mts', '.cts'];

// How the specifier is written. Remembered so it can be rewritten the same way after a move
//   exact:     './x.json'   the file name itself
//   extension: './x'        extension omitted
//   index:     './x'        points to the folder's index
//   js:        './x.js'     x.ts written as .js
export type Resolved = {
  file: string;
  kind: 'exact' | 'extension' | 'index' | 'js';
  ext: string;
};

// Resolves an absolute path to an existing file using extension completion and index rules
export const resolvePath = (fs: FsIndex, base: string): Resolved | undefined => {
  if (fs.isFile(base)) return { file: base, kind: 'exact', ext: '' };

  for (const ext of EXTENSIONS) {
    if (fs.isFile(base + ext)) return { file: base + ext, kind: 'extension', ext };
  }

  for (const [jsExt, tsExts] of Object.entries(JS_TO_TS)) {
    if (!base.endsWith(jsExt)) continue;
    for (const tsExt of tsExts) {
      const file = base.slice(0, -jsExt.length) + tsExt;
      if (fs.isFile(file)) return { file, kind: 'js', ext: jsExt };
    }
  }

  if (fs.isDirectory(base)) {
    for (const ext of EXTENSIONS) {
      const file = join(base, `index${ext}`);
      if (fs.isFile(file)) return { file, kind: 'index', ext };
    }
  }

  return undefined;
};

// Paths a specifier written via tsconfig paths can point to (before extension/index completion), in alias order
export const aliasCandidates = (aliases: Alias[], specifier: string): string[] => {
  const bases: string[] = [];
  for (const alias of aliases) {
    const matched = alias.wildcard
      ? specifier.length >= alias.prefix.length + alias.suffix.length &&
        specifier.startsWith(alias.prefix) &&
        specifier.endsWith(alias.suffix)
      : specifier === alias.prefix;
    if (!matched) continue;
    const captured = specifier.slice(
      alias.prefix.length,
      specifier.length - alias.suffix.length,
    );
    for (const target of alias.targets) {
      bases.push(target.wildcard ? target.prefix + captured + target.suffix : target.prefix);
    }
  }
  return bases;
};

// Resolves a specifier written via tsconfig paths
export const resolveAlias = (
  fs: FsIndex,
  aliases: Alias[],
  specifier: string,
): Resolved | undefined => {
  for (const base of aliasCandidates(aliases, specifier)) {
    const resolved = resolvePath(fs, base);
    if (resolved) return resolved;
  }
  return undefined;
};

const stripExtension = (path: string, ext: string) =>
  path.endsWith(ext) ? path.slice(0, -ext.length) : path;

// Path the specifier names after the target moves (reflecting omitted extension or index)
export const specifierTarget = (resolved: Resolved, targetNew: string): string => {
  switch (resolved.kind) {
    case 'exact':
      return targetNew;
    case 'extension':
      return stripExtension(targetNew, resolved.ext);
    case 'index':
      return /^index\./.test(basename(targetNew))
        ? dirname(targetNew)
        : stripExtension(targetNew, resolved.ext);
    case 'js': {
      const tsExt = TS_EXTENSIONS.find((ext) => targetNew.endsWith(ext));
      return tsExt ? stripExtension(targetNew, tsExt) + resolved.ext : targetNew;
    }
  }
};
