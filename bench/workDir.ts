import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WORK_DIR = join(import.meta.dirname, '.work');
const MARKER_PATH = join(WORK_DIR, '.tsmv-bench');

// マーカーがあるフォルダだけを消す。bench が作ったものではない場合は止める
export const cleanWorkDir = (): void => {
  if (!existsSync(WORK_DIR)) return;
  if (!existsSync(MARKER_PATH)) {
    throw new Error(`bench が作ったフォルダではないため消しません: ${WORK_DIR}`);
  }
  rmSync(WORK_DIR, { recursive: true, force: true });
};

// 前回の残りを消してから、空の作業フォルダを作る
export const createWorkDir = (): string => {
  cleanWorkDir();
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(MARKER_PATH, '');
  return WORK_DIR;
};
