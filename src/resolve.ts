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

// 'x.js' と書いて x.ts を指す指定（ESM の書き方）
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const TS_EXTENSIONS = ['.tsx', '.ts', '.mts', '.cts'];

// 指定子の書き方。移動後も同じ書き方で書き直すために覚えておく
//   exact:     './x.json'   ファイル名そのもの
//   extension: './x'        拡張子を省略
//   index:     './x'        フォルダの index を指す
//   js:        './x.js'     x.ts を .js と書いている
export type Resolved = {
  file: string;
  kind: 'exact' | 'extension' | 'index' | 'js';
  ext: string;
};

// 拡張子の補完や index の規則に従って、絶対パスを実在するファイルに解決する
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

// tsconfig の paths で書かれた指定子を解決する
export const resolveAlias = (
  fs: FsIndex,
  aliases: Alias[],
  specifier: string,
): Resolved | undefined => {
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
      const base = target.wildcard
        ? target.prefix + captured + target.suffix
        : target.prefix;
      const resolved = resolvePath(fs, base);
      if (resolved) return resolved;
    }
  }
  return undefined;
};

const stripExtension = (path: string, ext: string) =>
  path.endsWith(ext) ? path.slice(0, -ext.length) : path;

// 解決先が移動した後に、指定子が名指しするパス（拡張子や index の省略を反映したもの）
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
