import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path/posix';
import { toNative } from './paths.ts';

export type Entries = Map<string, 'file' | 'dir'>;

export type FsIndex = {
  entries: (dir: string) => Entries;
  isFile: (path: string) => boolean;
  isDirectory: (path: string) => boolean;
  // Warnings for unreadable folders. Not added when the folder simply does not exist
  problems: () => string[];
};

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

// Runs readdir once per folder and caches the result. Used to see the state before any move starts
export const createFsIndex = (): FsIndex => {
  const directories = new Map<string, Entries>();
  const problems: string[] = [];

  const entries = (dir: string): Entries => {
    const cached = directories.get(dir);
    if (cached) return cached;
    const result: Entries = new Map();
    try {
      for (const entry of readdirSync(toNative(dir), { withFileTypes: true })) {
        result.set(entry.name, entry.isDirectory() ? 'dir' : 'file');
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!MISSING.has(code)) problems.push(`${dir}: cannot read folder: ${code || error}`);
    }
    directories.set(dir, result);
    return result;
  };

  return {
    problems: () => problems,
    entries,
    isFile: (path) => entries(dirname(path)).get(basename(path)) === 'file',
    isDirectory: (path) => entries(dirname(path)).get(basename(path)) === 'dir',
  };
};
