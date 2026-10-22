import { basename, dirname, relative, resolve } from 'node:path/posix';
import { parseJsonc } from './jsonc.ts';

// TS/JS 以外で、移動したパスを書いていそうなファイル
export const CONFIG_FILE =
  /^(?:package\.json|[jt]sconfig(?:\..+)?\.json|\.oxlintrc\.json|biome\.jsonc?|(?:vite|vitest|webpack|rollup|jest|eslint|playwright|tsup|astro|svelte|next|nuxt)\.config\.[cm]?[jt]s|.+\.ya?ml|Dockerfile.*)$/;

export const REWRITABLE_JSON = /^(?:package\.json|[jt]sconfig(?:\..+)?\.json)$/;

export type ConfigHit = { file: string; line: number; text: string };

export type ConfigEdit = { text: string; changedLines: Set<number> };

const JSON_STRING = /"((?:[^"\\\n]|\\.)*)"(\s*:)?/g;
const PATH_LIKE = /^[\w@.\/*{},!-]+$/;

const lineOf = (text: string, index: number) => {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line++;
  }
  return line;
};

// JSONC のコメントの範囲 [start, end)。文字列の中の // や /* は数えない
const commentRanges = (text: string): [number, number][] => {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      ranges.push([i, end === -1 ? text.length : end]);
      i = end === -1 ? text.length : end;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      ranges.push([i, end === -1 ? text.length : end + 2]);
      i = end === -1 ? text.length : end + 2;
    } else {
      i++;
    }
  }
  return ranges;
};

// "paths": { ... } の波括弧の範囲 [start, end)。tsconfig の paths の値は baseUrl 基準で読まれる
const pathsRange = (text: string): [number, number] | undefined => {
  const open = /"paths"\s*:\s*\{/.exec(text);
  if (!open) return undefined;
  const start = open.index + open[0].length - 1;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return [start, i + 1];
    }
  }
  return undefined;
};

const baseUrlOf = (text: string): string | undefined => {
  try {
    const baseUrl = (parseJsonc(text) as { compilerOptions?: { baseUrl?: unknown } }).compilerOptions?.baseUrl;
    return typeof baseUrl === 'string' ? baseUrl : undefined;
  } catch {
    return undefined;
  }
};

const EXPLICIT_RELATIVE = /^\.{1,2}\//;

// 値の文字列のうち、移動するパスを指すものを書き換える（キーとコメントは対象外）。変更が無ければ undefined。
// ファイル自身が動くときは、./ や ../ で始まる実在するパスも、新しい位置から見たパスに直す。
// tsconfig の paths の値は、baseUrl があればそこを基準に読む
export const rewriteJsonPaths = (
  file: string,
  text: string,
  map: (path: string) => string,
  exists: (path: string) => boolean,
): ConfigEdit | undefined => {
  const dir = dirname(file);
  const dirAfter = map(dir);
  const edits: { start: number; end: number; text: string }[] = [];
  const comments = commentRanges(text);
  const inPaths = /^[jt]sconfig/.test(basename(file)) ? pathsRange(text) : undefined;
  const baseUrl = inPaths ? baseUrlOf(text) : undefined;
  const pathsBase = baseUrl === undefined ? dir : resolve(dir, baseUrl);
  const pathsBaseAfter = baseUrl === undefined ? dirAfter : map(pathsBase);

  for (const match of text.matchAll(JSON_STRING)) {
    const value = match[1];
    if (match[2] || !PATH_LIKE.test(value)) continue;
    if (comments.some(([start, end]) => match.index >= start && match.index < end)) continue;

    const globAt = value.search(/[*?{]/);
    const head = (globAt === -1 ? value : value.slice(0, globAt)).replace(/\/+$/, '');
    if (head === '' || head === '.' || head === '..') continue;

    const insidePaths = inPaths !== undefined && match.index >= inPaths[0] && match.index < inPaths[1];
    const base = insidePaths ? pathsBase : dir;
    const baseAfter = insidePaths ? pathsBaseAfter : dirAfter;
    const absolute = resolve(base, head);
    const absoluteAfter = map(absolute);
    const relativeChanged =
      baseAfter !== base && EXPLICIT_RELATIVE.test(value) && exists(absolute);
    if (absoluteAfter === absolute && !relativeChanged) continue;

    let next = relative(baseAfter, absoluteAfter);
    if (value.startsWith('./') && !next.startsWith('.')) next = `./${next}`;
    const rewritten = next + value.slice(head.length);
    if (rewritten === value) continue;
    edits.push({
      start: match.index + 1,
      end: match.index + 1 + value.length,
      text: rewritten,
    });
  }
  if (edits.length === 0) return undefined;

  let result = text;
  for (const edit of edits.reverse()) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return { text: result, changedLines: new Set(edits.map((edit) => lineOf(text, edit.start))) };
};

// 移動元のパスを書いている行を探す。書き換え済みの行は含めない
export const findConfigHits = (options: {
  file: string;
  text: string;
  root: string;
  froms: string[];
  skipLines?: Set<number>;
}): ConfigHit[] => {
  const { file, text, root, froms, skipLines } = options;
  const dir = dirname(file);
  const needles = new Set<string>();
  for (const from of froms) {
    for (const base of [dir, root]) {
      const needle = relative(base, from);
      if (needle.length >= 2) needles.add(needle);
    }
  }

  const matched = [...needles].filter((needle) => text.includes(needle));
  if (matched.length === 0) return [];

  const hits: ConfigHit[] = [];
  text.split('\n').forEach((line, index) => {
    if (skipLines?.has(index + 1)) return;
    if (matched.some((needle) => line.includes(needle))) {
      hits.push({ file, line: index + 1, text: line.trim() });
    }
  });
  return hits;
};
