import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { base, cleanFixtures, fixture, read } from './fixture.ts';

afterEach(cleanFixtures);

const move = (root: string, from: string, to: string) => ({
  from: join(root, from),
  to: join(root, to),
});

describe('どのパッケージにも属さないファイル', () => {
  test('パッケージ名で書かれた import は、パッケージ名のまま直る', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages', 'scripts'] }),
      'packages/lib/package.json': JSON.stringify({ name: '@a/lib' }),
      'packages/lib/src/util.ts': 'export const u = 1;\n',
      'scripts/build.ts': "import { u } from '@a/lib/src/util';\nexport const b = u;\n",
    });

    await run(base(root, { moves: [move(root, 'packages/lib/src/util.ts', 'packages/lib/src/helpers/util.ts')] }));

    expect(read(root, 'scripts/build.ts')).toContain("'@a/lib/src/helpers/util'");
  });
});

describe('大文字小文字だけの移動', () => {
  test('button.ts を Button.ts に変えられ、import も直る', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'src/button.ts': 'export const b = 1;\n',
      'src/user.ts': "import { b } from './button';\nexport const u = b;\n",
    });

    await run(base(root, { moves: [move(root, 'src/button.ts', 'src/Button.ts')] }));

    expect(readdirSync(join(root, 'src'))).toContain('Button.ts');
    expect(read(root, 'src/user.ts')).toContain("'./Button'");
  });

  test('ディスク上の綴りと大文字小文字が違う移動元は、止める', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'src/button.ts': 'export const b = 1;\n',
    });

    await expect(
      run(base(root, { moves: [move(root, 'src/BUTTON.ts', 'src/ui/button.ts')] })),
    ).rejects.toThrow();
    expect(readdirSync(join(root, 'src'))).toContain('button.ts');
  });
});

describe('設定ファイルが動くとき', () => {
  test('外側を指す extends は、新しい位置から見たパスに直る', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages', 'apps'] }),
      'tsconfig.base.json': '{}\n',
      'packages/a/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src'] }),
      'packages/a/src/x.ts': 'export {};\n',
    });

    await run(base(root, { moves: [move(root, 'packages/a', 'apps/web/a')] }));

    const moved = JSON.parse(read(root, 'apps/web/a/tsconfig.json'));
    expect(moved.extends).toBe('../../../tsconfig.base.json');
    expect(moved.include).toEqual(['src']);
  });
});

describe('baseUrl', () => {
  test('paths の値は baseUrl 基準で読み、移動に合わせて直る', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: 'src', paths: { '@lib/*': ['lib/*'] } },
        include: ['src'],
      }),
      'src/lib/util.ts': 'export const u = 1;\n',
    });

    await run(base(root, { moves: [move(root, 'src/lib', 'src/shared/lib')] }));

    expect(JSON.parse(read(root, 'tsconfig.json')).compilerOptions.paths).toEqual({
      '@lib/*': ['shared/lib/*'],
    });
  });

  test('baseUrl だけの設定でも、components/Button のような import が直る', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' }, include: ['src'] }),
      'src/components/Button.ts': 'export const B = 1;\n',
      'src/app.ts': "import { B } from 'components/Button';\nexport const a = B;\n",
    });

    await run(base(root, { style: 'keep', moves: [move(root, 'src/components/Button.ts', 'src/ui/Button.ts')] }));

    expect(read(root, 'src/app.ts')).toContain("'ui/Button'");
  });

  test('baseUrl の指定は、相対パスの import を baseUrl 形式に変えない', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src' }, include: ['src'] }),
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/a/b/c/m.ts': "import { u } from '../../../lib/util';\nexport const m = u;\n",
    });

    await run(base(root, { moves: [move(root, 'src/lib/util.ts', 'src/lib/x/util.ts')] }));

    expect(read(root, 'src/a/b/c/m.ts')).toContain("'../../../lib/x/util'");
  });
});
