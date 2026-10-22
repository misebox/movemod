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

// 途中で失敗しても元のファイルが切り詰められないよう、同じフォルダの一時ファイルに書いてから置き換える。
// シンボリックリンクはリンク先を書き換え、権限は元のファイルと同じにする。失敗したら一時ファイルを消す
export const writeText = async (path: string, text: string): Promise<void> => {
  const native = await realpath(toNative(path));
  // 同じファイルを指すリンクを同時に書いても、一時ファイルがぶつからないようにする
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

// 同時に実行する数を limit に抑えて、items すべてに fn を実行する。
// 1 つ失敗したら新しい項目は始めず、実行中のものが終わるのを待ってから、失敗をまとめて投げる
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
