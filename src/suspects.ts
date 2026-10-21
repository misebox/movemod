import { resolve } from 'node:path/posix';
import type { FsIndex } from './fsIndex.ts';

// import ではない文字列のうち、移動に影響を受けそうなパス
export type Suspect = { file: string; line: number; text: string; reason: string };

const PATH_LIKE_STRING = /(['"`])([^'"`\s\\]*\/[^'"`\s\\]*)\1/g;

const lineOf = (source: string, index: number) => {
  let line = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < index; i = source.indexOf('\n', i + 1)) {
    line++;
  }
  return line;
};

// known は、書き換え対象として扱い済みの指定子の開始位置（クォートの内側）
export const findSuspects = (options: {
  file: string;
  source: string;
  known: Set<number>;
  fileMoved: boolean;
  root: string;
  fs: FsIndex;
  map: (path: string) => string;
}): Suspect[] => {
  const { file, source, known, fileMoved, root, fs, map } = options;
  const suspects: Suspect[] = [];

  for (const match of source.matchAll(PATH_LIKE_STRING)) {
    if (known.has(match.index + 1)) continue;
    const dynamicAt = match[2].indexOf('${');
    const text = dynamicAt === -1 ? match[2] : match[2].slice(0, dynamicAt);
    if (text === '') continue;

    const fileBased = text.startsWith('.');
    const fromWorkingDirectory = { path: resolve(root, text), relativeToFile: false };
    const bases = fileBased
      ? [{ path: resolve(file, '..', text), relativeToFile: true }, fromWorkingDirectory]
      : [fromWorkingDirectory];

    for (const { path, relativeToFile } of bases) {
      if (!fs.isFile(path) && !fs.isDirectory(path)) continue;
      const targetMoved = map(path) !== path;
      if (!targetMoved && !(relativeToFile && fileMoved)) continue;
      const base = relativeToFile ? 'relative to this file' : 'relative to the working directory';
      suspects.push({
        file,
        line: lineOf(source, match.index),
        text: match[2],
        reason: `${base}; ${targetMoved ? 'points to a moved path' : 'this file moves'}`,
      });
      break;
    }
  }
  return suspects;
};
