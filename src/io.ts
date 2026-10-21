import { readFile, writeFile } from 'node:fs/promises';
import { toNative } from './paths.ts';

type BunLike = {
  file: (path: string) => { text: () => Promise<string> };
  write: (path: string, data: string) => Promise<number>;
};

const bun = (globalThis as { Bun?: BunLike }).Bun;

export const readText = (path: string): Promise<string> =>
  bun ? bun.file(toNative(path)).text() : readFile(toNative(path), 'utf8');

export const writeText = async (path: string, text: string): Promise<void> => {
  if (bun) {
    await bun.write(toNative(path), text);
  } else {
    await writeFile(toNative(path), text);
  }
};

// 同時に実行する数を limit に抑えて、items すべてに fn を実行する
export const forEachLimit = async <T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
};
