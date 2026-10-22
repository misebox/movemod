import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { parseJsonc } from '../src/jsonc.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

const move = (root: string, from: string, to: string) => ({
  from: join(root, from),
  to: join(root, to),
});

describe('移動先の入れ子', () => {
  test('別の移動先の中に移すと、何も変えずに止まる', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/legacy/x.ts': 'export const legacy = 1;\n',
      'src/x.ts': 'export const x = 1;\n',
    });

    await expect(
      run(base(root, { moves: [move(root, 'src/legacy', 'src/lib'), move(root, 'src/x.ts', 'src/lib/x.ts')] })),
    ).rejects.toThrow('destination is inside another destination');

    expect(existsSync(join(root, 'src/legacy/x.ts'))).toBe(true);
    expect(read(root, 'src/x.ts')).toBe('export const x = 1;\n');
  });
});

describe('parseJsonc', () => {
  test('最後の項目の後ろにコメントがあっても、末尾のカンマを許す', () => {
    const text = '{\n  "a": 1,\n  // "b": 2\n}\n';
    const block = '{\n  "a": [1, /* two */\n  ],\n}\n';

    expect(parseJsonc(text)).toEqual({ a: 1 });
    expect(parseJsonc(block)).toEqual({ a: [1] });
  });
});

describe('設定ファイルの書き換え', () => {
  test('値が変わらないものは、更新したことにしない', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages'] }),
      'packages/a/package.json': JSON.stringify({ name: 'a', main: 'src/index.ts' }),
      'packages/a/src/index.ts': 'export {};\n',
    });

    const result = await run(base(root, { moves: [move(root, 'packages/a', 'packages/b')] }));

    expect(result.configFilesChanged).toEqual([]);
  });
});

describe('相対パスでしか書けない書き方', () => {
  test('new URL と reference は、alias にせず相対パスのまま直る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/w.ts': 'export const w = 1;\n',
      'src/types/env.d.ts': 'declare const env: string;\n',
      'src/a/b/c/run.ts': [
        '/// <reference path="../../../types/env.d.ts" />',
        "const u = new URL('../../../lib/w.ts', import.meta.url);",
        '',
      ].join('\n'),
    });
    const moves = [move(root, 'src/lib/w.ts', 'src/lib/x/w.ts'), move(root, 'src/types', 'src/t')];

    await run(base(root, { moves }));

    expect(read(root, 'src/a/b/c/run.ts')).toBe(
      [
        '/// <reference path="../../../t/env.d.ts" />',
        "const u = new URL('../../../lib/x/w.ts', import.meta.url);",
        '',
      ].join('\n'),
    );
  });

  test('./ を付けない reference のパスも、書き方を保って直る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/types/env.d.ts': 'declare const env: string;\n',
      'src/main.ts': '/// <reference path="types/env.d.ts" />\nexport {};\n',
    });

    await run(base(root, { moves: [move(root, 'src/types', 'src/t')] }));

    expect(read(root, 'src/main.ts')).toBe('/// <reference path="t/env.d.ts" />\nexport {};\n');
  });
});

describe('tsconfig の外を指す include', () => {
  test('../shared のファイルも対象になる', async () => {
    const root = fixture({
      'app/tsconfig.json': JSON.stringify({ include: ['src', '../shared'] }),
      'shared/util.ts': 'export const u = 1;\n',
      'shared/user.ts': "import { u } from './util';\nexport const v = u;\n",
    });

    await run(
      base(root, {
        tsconfigs: [join(root, 'app/tsconfig.json')],
        moves: [move(root, 'shared/util.ts', 'shared/lib/util.ts')],
      }),
    );

    expect(read(root, 'shared/user.ts')).toContain("'./lib/util'");
  });
});

describe('同じ名前のパッケージ', () => {
  test('dist の中の写しは使わず、警告する', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages', 'apps'] }),
      'packages/a/package.json': JSON.stringify({ name: '@x/a' }),
      'packages/a/dist/package.json': JSON.stringify({ name: '@x/a' }),
      'packages/a/src/foo.ts': 'export const foo = 1;\n',
      'apps/web/package.json': JSON.stringify({ name: '@x/web' }),
      'apps/web/src/u.ts': "import { foo } from '@x/a/src/foo';\nexport const u = foo;\n",
    });

    const result = await run(base(root, { moves: [move(root, 'packages/a/src/foo.ts', 'packages/a/src/bar.ts')] }));

    expect(read(root, 'apps/web/src/u.ts')).toContain("'@x/a/src/bar'");
    expect(result.warnings.some((w) => w.includes('same name'))).toBe(true);
  });
});
