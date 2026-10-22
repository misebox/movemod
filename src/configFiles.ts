import { dirname, relative, resolve } from 'node:path/posix';

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

// 値の文字列のうち、移動するパスを指すものを書き換える（キーは対象外）。変更が無ければ undefined
export const rewriteJsonPaths = (
  file: string,
  text: string,
  map: (path: string) => string,
): ConfigEdit | undefined => {
  const dir = dirname(file);
  const dirAfter = map(dir);
  const edits: { start: number; end: number; text: string }[] = [];

  for (const match of text.matchAll(JSON_STRING)) {
    const value = match[1];
    if (match[2] || !PATH_LIKE.test(value)) continue;

    const globAt = value.search(/[*?{]/);
    const head = (globAt === -1 ? value : value.slice(0, globAt)).replace(/\/+$/, '');
    if (head === '' || head === '.' || head === '..') continue;

    const absolute = resolve(dir, head);
    const absoluteAfter = map(absolute);
    if (absoluteAfter === absolute) continue;

    let next = relative(dirAfter, absoluteAfter);
    if (value.startsWith('./') && !next.startsWith('.')) next = `./${next}`;
    edits.push({
      start: match.index + 1,
      end: match.index + 1 + value.length,
      text: next + value.slice(head.length),
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
