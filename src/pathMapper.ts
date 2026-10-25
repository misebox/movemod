import { dirname } from 'node:path/posix';

export type Move = { from: string; to: string };

// Remaps a path equal to from, or inside from, onto to.
// Walks from the end up through the parents and uses the first from found (the deepest one).
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

// Path or parents that exist but differ in case from the spelling on disk. Does not read directly under a Windows drive
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

const SHOWN_NAMES = 3;

// " (contains: a, b, c, ... and 4 more)" for a non-empty folder
const describeContents = (names: string[]): string => {
  if (names.length === 0) return '';
  const hidden = names.length - SHOWN_NAMES;
  // The order of a directory listing depends on the filesystem
  const shown = [...names].sort().slice(0, SHOWN_NAMES).join(', ');
  return ` (contains: ${shown}${hidden > 0 ? `, ... and ${hidden} more` : ''})`;
};

// Checks cases such as a destination inside another source, in O(count x depth).
// exists ignores case on case-insensitive filesystems, so isExactCase compares against the spelling on disk
export const checkMoves = (
  moves: Move[],
  exists: (path: string) => boolean,
  isExactCase: (path: string) => boolean = () => true,
  // Names inside a folder, hidden ones included; empty for a file
  list: (path: string) => string[] = () => [],
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
    // A move that only changes case points to the same file, so it is not an overwrite
    const renamesCaseOnly = from !== to && from.toLowerCase() === to.toLowerCase();
    if (from === to) {
      problems.push(`source and destination are the same: ${to}`);
    } else if (from.startsWith(`${to}/`)) {
      // Moving a folder onto its own parent would merge its contents into the parent
      problems.push(`destination is a parent of the source (merge is not supported): ${to}${describeContents(list(to))}`);
    } else if (exists(to) && !(renamesCaseOnly && !isExactCase(to))) {
      problems.push(`destination already exists: ${to}${describeContents(list(to))}`);
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
