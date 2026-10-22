import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../src/engine.ts';

const WORK = join(import.meta.dirname, '.work');
const created: string[] = [];

const fixture = (files: Record<string, string>): string => {
  mkdirSync(WORK, { recursive: true });
  const root = mkdtempSync(join(WORK, 'case-'));
  created.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
});

const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');

const TSCONFIG = JSON.stringify({
  compilerOptions: { paths: { '@/*': ['./src/*'] } },
  include: ['src'],
});

const base = (root: string, extra: Partial<Parameters<typeof run>[0]> = {}) => ({
  moves: [],
  tsconfigs: [join(root, 'tsconfig.json')],
  root,
  includes: [],
  calls: [],
  style: 'shortest' as const,
  apply: true,
  ...extra,
});

describe('mv', () => {
  test('ファイルを動かすと、動かしたファイルと参照元の相対 import が直る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a/x.ts': "import { y } from '../b/y';\nimport z from './z';\nexport const x = y + z;\n",
      'src/a/z.ts': 'export default 1;\n',
      'src/b/y.ts': 'export const y = 1;\n',
      'src/c/user.ts': "import { x } from '../a/x';\nexport const u = x;\n",
    });
    await run(base(root, { style: 'keep', moves: [{ from: join(root, 'src/a/x.ts'), to: join(root, 'src/d/e/x.ts') }] }));

    expect(read(root, 'src/d/e/x.ts')).toBe(
      "import { y } from '../../b/y';\nimport z from '../../a/z';\nexport const x = y + z;\n",
    );
    expect(read(root, 'src/c/user.ts')).toContain("'../d/e/x'");
  });

  test('tsconfig が無い JS プロジェクトでも動く', async () => {
    const root = fixture({
      'index.js': "const a = require('./lib/a');\nmodule.exports = a;\n",
      'lib/a.js': 'module.exports = 1;\n',
    });
    await run(base(root, { moves: [{ from: join(root, 'lib'), to: join(root, 'src/lib') }] }));

    expect(read(root, 'index.js')).toContain("require('./src/lib/a')");
  });

  test('フォルダを動かすと、中の相対 import は変わらず、外からの import だけ直る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/lib/b.ts': 'export const b = 1;\n',
      'src/app.ts': "import { a } from './lib/a';\nexport const app = a;\n",
    });
    const result = await run(base(root, { moves: [{ from: join(root, 'src/lib'), to: join(root, 'src/core/lib') }] }));

    expect(read(root, 'src/core/lib/a.ts')).toBe("import { b } from './b';\nexport const a = b;\n");
    expect(read(root, 'src/app.ts')).toContain("'./core/lib/a'");
    expect(result.changes).toHaveLength(1);
  });

  test('alias の import は、移動先が alias の下なら alias のまま直る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/deep/er/user.ts': "import { u } from '@/lib/util';\nexport const v = u;\n",
    });
    await run(base(root, { style: 'keep', moves: [{ from: join(root, 'src/lib/util.ts'), to: join(root, 'src/shared/util.ts') }] }));

    expect(read(root, 'src/deep/er/user.ts')).toContain("'@/shared/util'");
  });

  test('require / import() / vi.mock / require.resolve も直る', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/m.ts': 'export const m = 1;\n',
      'src/use.ts': [
        "const a = require('./m');",
        "const b = await import('./m');",
        "const c = require.resolve('./m');",
        "vi.mock('./m');",
        "type T = typeof import('./m');",
        '',
      ].join('\n'),
    });
    await run(base(root, { moves: [{ from: join(root, 'src/m.ts'), to: join(root, 'src/x/m.ts') }] }));

    expect(read(root, 'src/use.ts')).toBe(
      [
        "const a = require('./x/m');",
        "const b = await import('./x/m');",
        "const c = require.resolve('./x/m');",
        "vi.mock('./x/m');",
        "type T = typeof import('./x/m');",
        '',
      ].join('\n'),
    );
  });

  test('dry-run では何も変更しない', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/m.ts': 'export const m = 1;\n',
      'src/use.ts': "import { m } from './m';\n",
    });
    const result = await run(base(root, { apply: false, moves: [{ from: join(root, 'src/m.ts'), to: join(root, 'src/x/m.ts') }] }));

    expect(result.changes).toHaveLength(1);
    expect(existsSync(join(root, 'src/m.ts'))).toBe(true);
    expect(read(root, 'src/use.ts')).toBe("import { m } from './m';\n");
  });

  test('import 以外の文字列と設定ファイルは、要確認として報告する', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/data/a.json': '{}\n',
      'src/use.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('./data/a.json');\n",
      'ci.yml': 'run: ls src/data\n',
    });
    const result = await run(base(root, { apply: false, moves: [{ from: join(root, 'src/data'), to: join(root, 'src/assets') }] }));

    expect(result.suspects.map((s) => s.text)).toEqual(['./data/a.json']);
    expect(result.suspects.map((s) => s.callee)).toEqual(['readFileSync']);
    expect(result.configHits.map((h) => h.file.endsWith('ci.yml'))).toEqual([true]);
  });

  test('tsconfig と package.json のパスは書き換える', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['src', 'tests/**/*'] }),
      'package.json': JSON.stringify({ name: 'x', main: './src/index.ts' }),
      'src/index.ts': 'export {};\n',
    });
    await run(base(root, { moves: [{ from: join(root, 'src'), to: join(root, 'lib') }] }));

    expect(read(root, 'package.json')).toContain('"./lib/index.ts"');
    expect(read(root, 'tsconfig.json')).toContain('"lib"');
  });
});

describe('realign', () => {
  test('パスを指定すると、その中のファイルだけ書き直す', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/a/b/c/one.ts': "import { u } from '../../../lib/util';\nexport const f = u;\n",
      'src/a/b/c/two.ts': "import { u } from '../../../lib/util';\nexport const g = u;\n",
    });
    await run(base(root, { scope: [join(root, 'src/a/b/c/one.ts')] }));

    expect(read(root, 'src/a/b/c/one.ts')).toContain("'@/lib/util'");
    expect(read(root, 'src/a/b/c/two.ts')).toContain("'../../../lib/util'");
  });

  test('../ が深い import は alias に、./ は相対のままになる', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/lib/near.ts': "import { u } from '@/lib/util';\nexport const n = u;\n",
      'src/a/b/c/far.ts': "import { u } from '../../../lib/util';\nexport const f = u;\n",
    });
    await run(base(root));

    expect(read(root, 'src/lib/near.ts')).toContain("'./util'");
    expect(read(root, 'src/a/b/c/far.ts')).toContain("'@/lib/util'");
  });
});
