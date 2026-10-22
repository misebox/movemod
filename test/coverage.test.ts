import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

const move = (root: string, from: string, to: string) => ({
  from: join(root, from),
  to: join(root, to),
});

describe('パッケージをまたぐ移動', () => {
  const workspace = (importer: string) => ({
    'tsconfig.json': JSON.stringify({ include: ['packages'] }),
    'packages/a/package.json': JSON.stringify({ name: '@w/a' }),
    'packages/b/package.json': JSON.stringify({ name: '@w/b' }),
    'packages/c/package.json': JSON.stringify({ name: '@w/c' }),
    'packages/a/src/x.ts': 'export const x = 1;\n',
    'packages/b/src/keep.ts': 'export const k = 1;\n',
    'packages/c/src/u.ts': importer,
  });

  test('パッケージ名で書かれた import は、移動先のパッケージ名に変わる', async () => {
    const root = fixture(workspace("import { x } from '@w/a/src/x';\n"));

    await run(base(root, { moves: [move(root, 'packages/a/src/x.ts', 'packages/b/src/x.ts')] }));

    expect(read(root, 'packages/c/src/u.ts')).toBe("import { x } from '@w/b/src/x';\n");
  });

  test('動いたファイルから別のパッケージへの相対 import は、パッケージ名になる', async () => {
    const root = fixture({
      ...workspace(''),
      'packages/a/src/x.ts': "import { k } from '../../b/src/keep';\nexport const x = k;\n",
    });

    await run(base(root, { moves: [move(root, 'packages/a/src/x.ts', 'packages/c/src/x.ts')] }));

    expect(read(root, 'packages/c/src/x.ts')).toBe("import { k } from '@w/b/src/keep';\nexport const x = k;\n");
  });

  test('ルートの package.json は、パッケージとして扱わない', async () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'app' }),
      'tsconfig.json': TSCONFIG,
      'src/a/x.ts': 'export const x = 1;\n',
      'src/u.ts': "import { x } from './a/x';\nexport const u = x;\n",
    });

    await run(base(root, { style: 'keep', moves: [move(root, 'src/a/x.ts', 'src/b/x.ts')] }));

    expect(read(root, 'src/u.ts')).toContain("'./b/x'");
  });
});

describe('--style', () => {
  const importer = [
    "import { u } from '@/lib/util';",
    "import { v } from '../../../lib/util';",
    'export const m = [u, v];',
    '',
  ].join('\n');
  const fixtureWithImporter = () =>
    fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/util.ts': 'export const u = 1; export const v = 2;\n',
      'src/a/b/c/m.ts': importer,
    });
  const moveImporter = (root: string) => move(root, 'src/a/b/c/m.ts', 'src/a/b/d/m.ts');

  test('keep は、alias は alias のまま、相対は相対のまま', async () => {
    const root = fixtureWithImporter();

    await run(base(root, { style: 'keep', moves: [moveImporter(root)] }));

    expect(read(root, 'src/a/b/d/m.ts')).toBe(importer);
  });

  test('shortest は、短いほうに揃える', async () => {
    const root = fixtureWithImporter();

    await run(base(root, { style: 'shortest', moves: [moveImporter(root)] }));

    expect(read(root, 'src/a/b/d/m.ts')).toBe(
      importer.replace("'../../../lib/util'", "'@/lib/util'"),
    );
  });
});

describe('指定子の書き方', () => {
  test('.js・index・.json の書き方を保ったまま直る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/x.ts': 'export const x = 1;\n',
      'src/dir/index.ts': 'export const d = 1;\n',
      'src/data.json': '{}\n',
      'src/main.ts': [
        "import { x } from './x.js';",
        "import { d } from './dir';",
        "import { d as e } from './dir/index';",
        "import data from './data.json' with { type: 'json' };",
        'export const m = [x, d, e, data];',
        '',
      ].join('\n'),
    });
    const moves = [
      move(root, 'src/x.ts', 'src/m/x.ts'),
      move(root, 'src/dir', 'src/m/dir'),
      move(root, 'src/data.json', 'src/m/data.json'),
    ];

    await run(base(root, { style: 'keep', moves }));

    expect(read(root, 'src/main.ts')).toBe(
      [
        "import { x } from './m/x.js';",
        "import { d } from './m/dir';",
        "import { d as e } from './m/dir/index';",
        "import data from './m/data.json' with { type: 'json' };",
        'export const m = [x, d, e, data];',
        '',
      ].join('\n'),
    );
  });
});

describe('--func', () => {
  const files = {
    'tsconfig.json': TSCONFIG,
    'src/m.ts': 'export const m = 1;\n',
    'src/use.ts': "loadModule('./m');\nother('./m');\nrequire(`./${'m'}`);\n",
  };

  test('指定した関数の第 1 引数だけを書き換える', async () => {
    const root = fixture(files);

    await run(base(root, { calls: ['loadModule'], moves: [move(root, 'src/m.ts', 'src/n.ts')] }));

    expect(read(root, 'src/use.ts')).toBe("loadModule('./n');\nother('./m');\nrequire(`./${'m'}`);\n");
  });

  test('指定しなければ、その関数は書き換えない', async () => {
    const root = fixture(files);

    await run(base(root, { moves: [move(root, 'src/m.ts', 'src/n.ts')] }));

    expect(read(root, 'src/use.ts')).toContain("loadModule('./m')");
  });
});

describe('tsconfig', () => {
  test('extends 先の alias を使い、exclude したファイルは触らない', async () => {
    const root = fixture({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./src/*'] } },
      }),
      'tsconfig.json': '{\n  // comment\n  "extends": "./tsconfig.base.json",\n  "include": ["src"],\n  "exclude": ["src/skip"],\n}\n',
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/a.ts': "import { u } from '@/lib/util';\nexport const a = u;\n",
      'src/skip/b.ts': "import { u } from '@/lib/util';\nexport const b = u;\n",
    });

    await run(base(root, { style: 'keep', moves: [move(root, 'src/lib', 'src/shared')] }));

    expect(read(root, 'src/a.ts')).toContain("'@/shared/util'");
    expect(read(root, 'src/skip/b.ts')).toContain("'@/lib/util'");
  });

  test('tsconfig も jsconfig も無いと、警告して全ファイルを対象にする', async () => {
    const root = fixture({
      'a.js': 'module.exports = 1;\n',
      'b.js': "module.exports = require('./a');\n",
    });

    const result = await run(base(root, { moves: [move(root, 'a.js', 'lib/a.js')] }));

    expect(read(root, 'b.js')).toContain("require('./lib/a')");
    expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  test('extends が循環していると、経路つきで止まる', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ extends: './other.json' }),
      'other.json': JSON.stringify({ extends: './tsconfig.json' }),
    });

    await expect(run(base(root))).rejects.toThrow('circular');
  });

  test('壊れた tsconfig は、ファイル名つきで止まる', async () => {
    const root = fixture({ 'tsconfig.json': '{ "include": ' });

    await expect(run(base(root))).rejects.toThrow('tsconfig.json: cannot read');
  });
});

describe('書き方をそろえる範囲', () => {
  test('フォルダを指定すると、名前が前方一致するだけの別のフォルダは触らない', async () => {
    const deep = "import { u } from '../../../lib/util';\nexport const f = u;\n";
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/a/b/c/one.ts': deep,
      'src/a2/b/c/two.ts': deep,
    });

    await run(base(root, { scope: [join(root, 'src/a')] }));

    expect(read(root, 'src/a/b/c/one.ts')).toContain("'@/lib/util'");
    expect(read(root, 'src/a2/b/c/two.ts')).toBe(deep);
  });
});

describe('要確認の報告', () => {
  test('動くファイル自身が相対パスの文字列を持つと、this file moves とする', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/data.json': '{}\n',
      'src/use.ts':
        "import { readFileSync } from 'node:fs';\nreadFileSync('./data.json');\nreadFileSync('./nothing.json');\n",
    });

    const result = await run(base(root, { apply: false, moves: [move(root, 'src/use.ts', 'src/sub/use.ts')] }));

    expect(result.suspects.map(({ text, reason }) => [text, reason])).toEqual([
      ['./data.json', 'this file moves'],
    ]);
  });

  test('名前が前方一致するだけのパスは、設定ファイルでも書き換えない', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'package.json': JSON.stringify({ main: './src/index.ts', types: './src-old/index.d.ts' }),
      'src/index.ts': 'export {};\n',
    });

    await run(base(root, { moves: [move(root, 'src', 'lib')] }));

    const text = read(root, 'package.json');
    expect(text).toContain('./lib/index.ts');
    expect(text).toContain('./src-old/index.d.ts');
  });
});
