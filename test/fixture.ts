import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { run } from '../src/engine.ts';

const WORK = join(import.meta.dirname, '.work');
const created: string[] = [];

export const fixture = (files: Record<string, string>): string => {
  mkdirSync(WORK, { recursive: true });
  const root = mkdtempSync(join(WORK, 'case-'));
  created.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

export const cleanFixtures = () => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
};

export const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');

export const TSCONFIG = JSON.stringify({
  compilerOptions: { paths: { '@/*': ['./src/*'] } },
  include: ['src'],
});

export const base = (root: string, extra: Partial<Parameters<typeof run>[0]> = {}) => ({
  moves: [],
  tsconfigs: [join(root, 'tsconfig.json')],
  root,
  includes: [],
  calls: [],
  style: 'shortest' as const,
  apply: true,
  // Most tests check what warnings say, not that they stop the run
  force: true,
  // Config rewriting is opt-in; tests that check it need it on
  config: true,
  ...extra,
});
