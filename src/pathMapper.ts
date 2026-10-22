import { dirname } from 'node:path/posix';

export type Move = { from: string; to: string };

// from と一致するパス、または from の中にあるパスを、to の側に付け替える。
// 末尾から親へ順にたどり、最初に見つかった from（いちばん深い from）を使う。
export const createPathMapper = (moves: Move[]) => {
  const toByFrom = new Map(moves.map(({ from, to }) => [from, to]));
  const cache = new Map<string, string>();

  const compute = (path: string): string => {
    let current = path;
    while (true) {
      const to = toByFrom.get(current);
      if (to !== undefined) return to + path.slice(current.length);
      const parent = dirname(current);
      if (parent === current) return path;
      current = parent;
    }
  };

  return (path: string): string => {
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const mapped = compute(path);
    cache.set(path, mapped);
    return mapped;
  };
};

const DRIVE_ROOT = /^\/[A-Za-z]:$/;

// path とその親のうち、実在するのにディスク上の綴りと大文字小文字が違うもの。Windows のドライブ直下は読まない
const firstWrongCase = (
  path: string,
  exists: (path: string) => boolean,
  isExactCase: (path: string) => boolean,
): string | undefined => {
  for (let current = path; dirname(current) !== current && !DRIVE_ROOT.test(dirname(current)); current = dirname(current)) {
    if (exists(current) && !isExactCase(current)) return current;
  }
  return undefined;
};

// 移動先が別の移動元の中にある場合などを、O(件数 × 深さ) で調べる。
// exists は大文字小文字を区別しないファイルシステムでは区別しないので、isExactCase でディスク上の綴りと照合する
export const checkMoves = (
  moves: Move[],
  exists: (path: string) => boolean,
  isExactCase: (path: string) => boolean = () => true,
): void => {
  const problems: string[] = [];
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const { from, to } of moves) {
    if (!exists(from)) {
      problems.push(`source does not exist: ${from}`);
    } else {
      const wrong = firstWrongCase(from, exists, isExactCase);
      if (wrong) problems.push(`source differs in letter case from the one on disk: ${wrong}`);
    }
    const wrongParent = firstWrongCase(dirname(to), exists, isExactCase);
    if (wrongParent) problems.push(`destination folder differs in letter case from the one on disk: ${wrongParent}`);
    // 大文字小文字だけを変える移動は、同じファイルを指しているので上書きではない
    const renamesCaseOnly = from !== to && from.toLowerCase() === to.toLowerCase();
    if (exists(to) && !(renamesCaseOnly && !isExactCase(to))) {
      problems.push(`destination already exists: ${to}`);
    }
    if (froms.has(from)) problems.push(`duplicate source: ${from}`);
    if (tos.has(to)) problems.push(`duplicate destination: ${to}`);
    froms.add(from);
    tos.add(to);
  }
  for (const { to } of moves) {
    for (let dir = dirname(to); dir !== dirname(dir); dir = dirname(dir)) {
      if (froms.has(dir)) {
        problems.push(`destination is inside another source: ${to}`);
        break;
      }
      if (tos.has(dir)) {
        problems.push(`destination is inside another destination: ${to}`);
        break;
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
};
