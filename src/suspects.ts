import { resolve } from 'node:path/posix';
import type { FsIndex } from './fsIndex.ts';

// Paths in non-import strings that a move may affect
// reason is absent when the target moves, and set only when this file itself moves
// callee is the name of the function that receives the string as its first argument
export type Suspect = { file: string; line: number; text: string; reason?: string; callee?: string };

const PATH_LIKE_STRING = /(['"`])([^'"`\s\\]*\/[^'"`\s\\]*)\1/g;
const CALLEE_BEFORE = /([\w$.]+)\s*\(\s*$/;
const CALLEE_LOOKBEHIND = 80;

const calleeOf = (source: string, index: number) =>
  CALLEE_BEFORE.exec(source.slice(Math.max(0, index - CALLEE_LOOKBEHIND), index))?.[1];

const lineOf = (source: string, index: number) => {
  let line = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < index; i = source.indexOf('\n', i + 1)) {
    line++;
  }
  return line;
};

// known is the start positions (inside the quotes) of specifiers already handled for rewriting
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
      suspects.push({
        file,
        line: lineOf(source, match.index),
        text: match[2],
        callee: calleeOf(source, match.index),
        reason: targetMoved ? undefined : 'this file moves',
      });
      break;
    }
  }
  return suspects;
};
