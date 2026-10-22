import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WORK_DIR = join(import.meta.dirname, '.work');
const MARKER_PATH = join(WORK_DIR, '.movemod-bench');

// Deletes only a folder that has the marker. Stops if bench did not create it
export const cleanWorkDir = (): void => {
  if (!existsSync(WORK_DIR)) return;
  if (!existsSync(MARKER_PATH)) {
    throw new Error(`Not deleting, the folder was not created by bench: ${WORK_DIR}`);
  }
  rmSync(WORK_DIR, { recursive: true, force: true });
};

// Removes leftovers from the previous run, then creates an empty work folder
export const createWorkDir = (): string => {
  cleanWorkDir();
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(MARKER_PATH, '');
  return WORK_DIR;
};
