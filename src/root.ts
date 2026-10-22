import { dirname } from 'node:path/posix';
import type { Move } from './pathMapper.ts';

const PROJECT_FILES = ['package.json', 'deno.json', 'deno.jsonc', 'jsr.json'];
const REPOSITORY_FOLDERS = ['.git', '.hg', '.svn'];
const CONFIG_FILES = ['tsconfig.json', 'jsconfig.json'];
// Monorepo tools that mark their root without a workspaces declaration
const MONOREPO_FILES = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json', 'rush.json'];

// Walks up from start, never into the home folder or the filesystem root, and stops at the first
// folder with a project file (package.json, deno.json, ...), or with a repository folder (.git, ...,
// the boundary). Without either, the nearest folder with tsconfig.json or jsconfig.json; else
// undefined. reason names the rule that chose the folder
export const detectRoot = (
  start: string,
  home: string,
  exists: (path: string) => boolean,
): { root: string; reason: string } | undefined => {
  const has = (dir: string, names: string[]) => names.find((name) => exists(`${dir}/${name}`));
  let nearestConfig: string | undefined;
  for (let dir = start; dir !== home && dir !== dirname(dir); dir = dirname(dir)) {
    const project = has(dir, PROJECT_FILES);
    if (project) return { root: dir, reason: `nearest ${project}` };
    // The repository boundary: nothing above it belongs to this project
    const repository = has(dir, REPOSITORY_FOLDERS);
    if (repository) return { root: dir, reason: `nearest ${repository}` };
    if (nearestConfig === undefined && has(dir, CONFIG_FILES)) nearestConfig = dir;
  }
  return nearestConfig === undefined ? undefined : { root: nearestConfig, reason: 'nearest tsconfig.json/jsconfig.json' };
};

const isInside = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

// The nearest folder, from start (inclusive) upward, that is a workspaces root: it declares them
// ("workspaces" in package.json) or has a monorepo tool file (pnpm-workspace.yaml, turbo.json, ...)
export const findWorkspaceRoot = (
  start: string,
  home: string,
  exists: (path: string) => boolean,
  read: (path: string) => string | undefined,
): string | undefined => {
  for (let dir = start; dir !== home && dir !== dirname(dir); dir = dirname(dir)) {
    if (MONOREPO_FILES.some((name) => exists(`${dir}/${name}`)) || /"workspaces"\s*:/.test(read(`${dir}/package.json`) ?? '')) {
      return dir;
    }
  }
  return undefined;
};

// Each folder has its own root (see detectRoot). Folders that agree share it. Folders with different
// roots throw: moving between packages needs an explicit --root, which the message suggests when a
// workspaces root contains them. With no marker at all, the root is the folder they share
export const resolveRoot = (
  folders: string[],
  home: string,
  exists: (path: string) => boolean,
  read: (path: string) => string | undefined,
): { root: string; reason: string } => {
  const found = folders.map((folder) => detectRoot(folder, home, exists));
  const roots = new Set(found.map((item) => item?.root));
  if (roots.size === 1 && found[0]) return found[0];
  if (roots.size === 1) return { root: commonFolder(folders), reason: 'no marker found; folder shared by the paths' };
  const workspaceRoot = findWorkspaceRoot(commonFolder(folders), home, exists, read);
  const lines = folders.map((folder, index) => `  ${folder} (${found[index]?.root ?? 'no project'})`);
  throw new Error(
    workspaceRoot
      ? `the paths belong to different packages:\n${lines.join('\n')}\nThey are in the workspaces root ${workspaceRoot}. Set --root ${workspaceRoot} to move between packages.`
      : `the paths belong to different projects:\n${lines.join('\n')}\nSet --root to a folder that contains all of them.`,
  );
};

// The deepest folder that contains every given folder
export const commonFolder = (folders: string[]): string => {
  const [first, ...others] = folders.map((folder) => folder.split('/'));
  let length = first.length;
  for (const parts of others) {
    let same = 0;
    while (same < length && same < parts.length && parts[same] === first[same]) same++;
    length = same;
  }
  return first.slice(0, length).join('/') || '/';
};

export const checkInsideRoot = (moves: Move[], root: string): void => {
  const problems = moves.flatMap(({ from, to }) =>
    [from, to].filter((path) => !isInside(root, path)).map((path) => `outside the project root ${root}: ${path}`),
  );
  if (problems.length > 0) {
    throw new Error(`${problems.join('\n')}\nRun inside the project, or set --root to a folder that contains all paths.`);
  }
};

// The TS config files in the nearest folder that has any, from start up to and including stop.
// Priority: tsconfig.json, then tsconfig.*.json (tsconfig.app.json, ...), then jsconfig.json
export const findTsconfigs = (start: string, stop: string, list: (dir: string) => string[]): string[] => {
  for (let dir = start; ; dir = dirname(dir)) {
    const names = list(dir);
    const variants = names.filter((name) => /^tsconfig\..+\.json$/.test(name)).sort();
    const found = names.includes('tsconfig.json')
      ? ['tsconfig.json']
      : variants.length > 0
        ? variants
        : names.filter((name) => name === 'jsconfig.json');
    if (found.length > 0) return found.map((name) => `${dir}/${name}`);
    if (dir === stop || dir === dirname(dir)) return [];
  }
};
