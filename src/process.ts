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

// Worker に structured clone で渡せるよう、Map や関数を含めない
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
  // 読めない・解析できないなどで、書き換えなかったファイルの数
  skipped: number;
};

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

// UTF-8 として読めないファイルは書き戻すと文字化けするので、undefined を返す
const readUtf8 = (file: string): string | undefined => {
  const buffer = readFileSync(toNative(file));
  const text = buffer.toString('utf8');
  if (!text.includes('�')) return text;
  try {
    STRICT_UTF8.decode(buffer);
    return text;
  } catch {
    return undefined;
  }
};

export const processChunk = (input: ChunkInput, fs: FsIndex = createFsIndex()): ChunkOutput => {
  const map = createPathMapper(input.moves);
  const packages = createPackages(input.packageList, map);
  const contexts = input.aliasesByProject.map((aliases) =>
    createProjectContext(aliases, packages.names, fs),
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

  const output: ChunkOutput = { edits: [], changes: [], suspects: [], warnings: [], skipped: 0 };
  for (const { file, index } of input.targets) {
    try {
      const source = readUtf8(file);
      if (source === undefined) {
        output.warnings.push(`${file}: skipped, not valid UTF-8`);
        output.skipped++;
        continue;
      }
      const result = rewrite(file, source, contexts[index]);
      if (!result) continue;
      if (result.skipped) output.skipped++;
      output.changes.push(...result.changes);
      output.suspects.push(...result.suspects);
      output.warnings.push(...result.warnings);
      if (result.text !== undefined) {
        output.edits.push({ oldPath: file, newPath: map(file), text: result.text });
      }
    } catch (error) {
      output.warnings.push(`${file}: skipped, ${error instanceof Error ? error.message : error}`);
      output.skipped++;
    }
  }
  output.warnings.push(...fs.problems());
  return output;
};
