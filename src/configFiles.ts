import { basename, dirname, relative, resolve } from 'node:path/posix';
import { parseJsonc } from './jsonc.ts';

// Non-TS/JS files that likely mention moved paths
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

// Ranges [start, end) of JSONC comments. // or /* inside strings are not counted
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

// Range [start, end) of the braces in "paths": { ... }. Values in tsconfig paths are read relative to baseUrl
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
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
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

const EXPLICIT_RELATIVE = /^\.{1,2}(?:\/|$)/;

// Rewrites value strings that point to moved paths (keys and comments are skipped). Returns undefined if nothing changed.
// When the file itself moves, existing paths starting with ./ or ../ are also rewritten relative to the new location.
// Values in tsconfig paths are read relative to baseUrl if present
export const rewriteJsonPaths = (
  file: string,
  text: string,
  map: (path: string) => string,
  exists: (path: string) => boolean,
): ConfigEdit | undefined => {
  const dir = dirname(file);
  const dirAfter = dirname(map(file));
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
    if (head === '') continue;

    const insidePaths = inPaths !== undefined && match.index >= inPaths[0] && match.index < inPaths[1];
    const base = insidePaths ? pathsBase : dir;
    const baseAfter = insidePaths ? pathsBaseAfter : dirAfter;
    const absolute = resolve(base, head);
    const absoluteAfter = map(absolute);
    const relativeChanged =
      baseAfter !== base && EXPLICIT_RELATIVE.test(value) && exists(absolute);
    if (absoluteAfter === absolute && !relativeChanged) continue;

    let next = relative(baseAfter, absoluteAfter) || '.';
    if (EXPLICIT_RELATIVE.test(value) && !next.startsWith('.')) next = `./${next}`;
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

// Find lines that mention a source path. Rewritten lines are excluded
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
