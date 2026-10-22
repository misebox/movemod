import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { toNative } from './paths.ts';

type BunLike = {
  file: (path: string) => { text: () => Promise<string> };
  write: (path: string, data: string) => Promise<number>;
};

const bun = (globalThis as { Bun?: BunLike }).Bun;

let temporaryCounter = 0;

export const readText =(path: string): Promise<string> =>
  bun ? bun.file(toNative(path)).text() : readFile(toNative(path), 'utf8');

// Writes to a temp file in the same folder, then replaces, so a failure midway never truncates the original.
// Symlinks: the target is rewritten. Permissions match the original file. The temp file is removed on failure
export const writeText = async (path: string, text: string): Promise<void> => {
  const native = await realpath(toNative(path));
  // Keeps temp files from colliding when links to the same file are written at once
  const temporary = `${native}.${process.pid}.${temporaryCounter++}.movemod-tmp`;
  try {
    const { mode } = await stat(native);
    if (bun) {
      await bun.write(temporary, text);
    } else {
      await writeFile(temporary, text);
    }
    await chmod(temporary, mode);
    await rename(temporary, native);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

// Runs fn on all items with at most limit running at once.
// After one failure, starts no new items, waits for running ones to finish, then throws the failures together
export const forEachLimit = async <T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const failures: Error[] = [];
  const worker = async () => {
    while (next < items.length && failures.length === 0) {
      try {
        await fn(items[next++]);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new Error(`${failures[0].message}\n(and ${failures.length - 1} more failures)`);
  }
};
