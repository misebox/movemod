import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

describe('mv', () => {
  test('moving a file updates relative imports in it and in its referrers', async () => {
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

  test('works in a JS project without tsconfig', async () => {
    const root = fixture({
      'index.js': "const a = require('./lib/a');\nmodule.exports = a;\n",
      'lib/a.js': 'module.exports = 1;\n',
    });
    await run(base(root, { moves: [{ from: join(root, 'lib'), to: join(root, 'src/lib') }] }));

    expect(read(root, 'index.js')).toContain("require('./src/lib/a')");
  });

  test('moving a folder keeps inner relative imports and updates only imports from outside', async () => {
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

  test('alias imports stay aliases when the destination is under the alias', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/deep/er/user.ts': "import { u } from '@/lib/util';\nexport const v = u;\n",
    });
    await run(base(root, { style: 'keep', moves: [{ from: join(root, 'src/lib/util.ts'), to: join(root, 'src/shared/util.ts') }] }));

    expect(read(root, 'src/deep/er/user.ts')).toContain("'@/shared/util'");
  });

  test('also updates require, import(), vi.mock and require.resolve', async () => {
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

  test('dry-run changes nothing', async () => {
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

  test('reports non-import strings and config files for review', async () => {
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

  test('rewrites paths in tsconfig and package.json', async () => {
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
  test('given a path, rewrites only files inside it', async () => {
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

  test('deep ../ imports become aliases and ./ imports stay relative', async () => {
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
