import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { forEachLimit } from '../src/io.ts';
import { checkMoves } from '../src/pathMapper.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

const move = (root: string, from: string, to: string) => ({
  from: join(root, from),
  to: join(root, to),
});

describe('設定ファイル自身を動かす', () => {
  test('ファイルだけを動かしても、相対パスの値は新しい位置から見たパスになる', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'tsconfig.build.json': JSON.stringify({ extends: './tsconfig.base.json', include: ['./src'] }),
      'tsconfig.base.json': '{}\n',
      'src/index.ts': 'export {};\n',
    });

    await run(base(root, { moves: [move(root, 'tsconfig.build.json', 'configs/tsconfig.build.json')] }));

    expect(JSON.parse(read(root, 'configs/tsconfig.build.json'))).toEqual({
      extends: '../tsconfig.base.json',
      include: ['../src'],
    });
  });

  test('../ で始まる値が、./ のない名前にならない', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages'] }),
      'tsconfig.base.json': '{}\n',
      'packages/app/tsconfig.build.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
    });

    await run(base(root, { moves: [move(root, 'tsconfig.base.json', 'packages/app/tsconfig.base.json')] }));

    expect(JSON.parse(read(root, 'packages/app/tsconfig.build.json')).extends).toBe('./tsconfig.base.json');
  });

  test('paths のブロックの中のコメントに } があっても、範囲が途中で終わらない', async () => {
    const root = fixture({
      'tsconfig.json':
        '{ "compilerOptions": { "baseUrl": "src", "paths": {\n // "}"\n "@x/*": ["{a,b}/*"],\n "@lib/*": ["lib/*"] } }, "include": ["src"] }',
      'src/lib/util.ts': 'export const u = 1;\n',
    });

    await run(base(root, { moves: [move(root, 'src/lib', 'src/shared/lib')] }));

    const paths = read(root, 'tsconfig.json');
    expect(paths).toContain('"shared/lib/*"');
    expect(paths).toContain('"{a,b}/*"');
  });
});

describe('書き込み', () => {
  test.skipIf(process.platform === 'win32')('シンボリックリンクはリンクのまま、リンク先が書き換わる', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/real.ts': "import { a } from './a';\nexport const r = a;\n",
    });
    symlinkSync(join(root, 'src/real.ts'), join(root, 'src/link.ts'));

    await run(base(root, { moves: [move(root, 'src/a.ts', 'src/b.ts')] }));

    expect(lstatSync(join(root, 'src/link.ts')).isSymbolicLink()).toBe(true);
    expect(read(root, 'src/real.ts')).toBe("import { a } from './b';\nexport const r = a;\n");
  });

  test('U+FFFD をそのまま含む正しい UTF-8 のファイルは、書き換える', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
    });
    writeFileSync(join(root, 'src/ok.ts'), "import { a } from './a';\nexport const s = '�';\n");

    const result = await run(base(root, { moves: [move(root, 'src/a.ts', 'src/b.ts')] }));

    expect(read(root, 'src/ok.ts')).toBe("import { a } from './b';\nexport const s = '�';\n");
    expect(result.warnings).toEqual([]);
  });

  test('forEachLimit は、失敗したら新しい項目を始めず、失敗をまとめて投げる', async () => {
    const started: number[] = [];
    const fail = async (item: number) => {
      started.push(item);
      throw new Error(`failed ${item}`);
    };

    await expect(forEachLimit([0, 1, 2], 3, fail)).rejects.toThrow('and 2 more failures');
    started.length = 0;
    await expect(forEachLimit([0, 1, 2, 3], 1, fail)).rejects.toThrow('failed 0');
    expect(started).toEqual([0]);
  });
});

describe('大文字小文字の確認（ファイルシステムに依らない）', () => {
  const exists = () => true;

  test('親フォルダの綴りが違う移動元は止める', () => {
    const isExactCase = (path: string) => !path.includes('/Src');

    expect(() => checkMoves([{ from: '/r/Src/foo.ts', to: '/r/src/bar.ts' }], exists, isExactCase)).toThrow(
      'differs in letter case',
    );
  });

  test('大文字小文字だけの移動は許し、別のファイルへの上書きは止める', () => {
    const isExactCase = (path: string) => path !== '/r/Button.ts';

    expect(() => checkMoves([{ from: '/r/button.ts', to: '/r/Button.ts' }], exists, isExactCase)).not.toThrow();
    expect(() => checkMoves([{ from: '/r/button.ts', to: '/r/other.ts' }], exists, () => true)).toThrow(
      'destination already exists',
    );
  });
});

describe('警告', () => {
  test('スキップしたファイルの数が結果に出る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/broken.ts': "import { a } from './a';\nconst = ;\n",
    });

    const result = await run(base(root, { moves: [move(root, 'src/a.ts', 'src/b.ts')] }));

    expect(result.skippedFiles).toBe(1);
  });

  test('tsconfig の対象外にある移動元のファイルは、警告する', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'scripts/x.js': 'module.exports = 1;\n',
    });

    const result = await run(base(root, { moves: [move(root, 'scripts/x.js', 'scripts/y.js')] }));

    expect(result.warnings.some((w) => w.includes('outside the tsconfig include'))).toBe(true);
  });

  test('exports で公開されたパッケージのサブパスは、警告しない', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages', 'src'] }),
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { './button': './src/button/index.tsx' } }),
      'packages/ui/src/button/index.tsx': 'export {};\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/use.ts': "import B from '@acme/ui/button';\nimport { a } from './a';\nexport const u = [B, a];\n",
    });

    const result = await run(base(root, { moves: [move(root, 'src/a.ts', 'src/b.ts')] }));

    expect(result.warnings.filter((w) => w.includes('cannot resolve'))).toEqual([]);
  });

  test('同じ名前のパッケージは、深さが浅いほうを使う', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages', 'apps', 'a'] }),
      'packages/x/package.json': JSON.stringify({ name: '@x/x' }),
      'packages/x/src/foo.ts': 'export const foo = 1;\n',
      'a/b/c/package.json': JSON.stringify({ name: '@x/x' }),
      'apps/web/package.json': JSON.stringify({ name: '@x/web' }),
      'apps/web/src/u.ts': "import { foo } from '@x/x/src/foo';\nexport const u = foo;\n",
    });

    await run(base(root, { moves: [move(root, 'packages/x/src/foo.ts', 'packages/x/src/bar.ts')] }));

    expect(read(root, 'apps/web/src/u.ts')).toContain("'@x/x/src/bar'");
  });
});

describe('--strict', () => {
  test('警告があると、何も変えずに止まる', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/broken.ts': "import { a } from './a';\nconst = ;\n",
    });

    await expect(
      run(base(root, { strict: true, moves: [move(root, 'src/a.ts', 'src/b.ts')] })),
    ).rejects.toThrow('nothing was changed');

    expect(existsSync(join(root, 'src/a.ts'))).toBe(true);
  });
});

describe('コマンドライン', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const execute = (root: string, args: string[]) =>
    Bun.spawnSync([process.execPath, cli, ...args], { cwd: root });

  test('--strict は警告があると終了コード 1、無いと 0', () => {
    const broken = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/broken.ts': "import { a } from './a';\nconst = ;\n",
    });
    const clean = fixture({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' });

    expect(execute(broken, ['src/a.ts', 'src/b.ts', '--dry-run', '--strict']).exitCode).toBe(1);
    expect(execute(broken, ['src/a.ts', 'src/b.ts', '--dry-run']).exitCode).toBe(0);
    expect(execute(clean, ['src/a.ts', 'src/b.ts', '--dry-run', '--strict']).exitCode).toBe(0);
  });

  test('--workers に不正な値を渡すと、何も変えずに終了コード 1', () => {
    const root = fixture({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' });

    const result = execute(root, ['src/a.ts', 'src/b.ts', '--workers', 'abc']);

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(root, 'src/a.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  test('スキップしたファイルは、最後の行に数が出る', () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/broken.ts': "import { a } from './a';\nconst = ;\n",
    });

    const result = execute(root, ['src/a.ts', 'src/b.ts', '--dry-run']);

    expect(result.stdout.toString()).toContain('1 file skipped; imports in them were NOT updated.');
  });
});
