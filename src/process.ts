import { readFileSync } from 'node:fs';
import { createFsIndex, type FsIndex } from './fsIndex.ts';
import { toNative } from './paths.ts';
import { createPackages, type Pkg } from './packages.ts';
import { createPathMapper, type Move } from './pathMapper.ts';
import { createProjectContext, createRewriter, type Change } from './rewriter.ts';
import type { Style } from './style.ts';
import type { Suspect } from './suspects.ts';
import type { Alias } from './tsconfig.ts';

export type FileEdit = { oldPath: string; newPath: string; text: string };

// Worker に structured clone で渡せるよう、文字列と配列だけで作る
export type ChunkInput = {
  moves: Move[];
  root: string;
  style: Style;
  calls: string[];
  realign: boolean;
  detail: boolean;
  aliasesByProject: Alias[][];
  packageList: Pkg[];
  targets: { file: string; index: number }[];
};

export type ChunkOutput = {
  edits: FileEdit[];
  changes: Change[];
  suspects: Suspect[];
  warnings: string[];
};

export const processChunk = (input: ChunkInput, fs: FsIndex = createFsIndex()): ChunkOutput => {
  const map = createPathMapper(input.moves);
  const packages = createPackages(input.packageList, map);
  const contexts = input.aliasesByProject.map((aliases) =>
    createProjectContext(aliases, packages.names),
  );
  const rewrite = createRewriter({
    fs,
    map,
    packages,
    style: input.style,
    calls: input.calls,
    root: input.root,
    realign: input.realign,
    suspects: !input.realign,
    detail: input.detail,
  });

  const output: ChunkOutput = { edits: [], changes: [], suspects: [], warnings: [] };
  for (const { file, index } of input.targets) {
    const result = rewrite(file, readFileSync(toNative(file), 'utf8'), contexts[index]);
    if (!result) continue;
    output.changes.push(...result.changes);
    output.suspects.push(...result.suspects);
    output.warnings.push(...result.warnings);
    if (result.text !== undefined) {
      output.edits.push({ oldPath: file, newPath: map(file), text: result.text });
    }
  }
  return output;
};
