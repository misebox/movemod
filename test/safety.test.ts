import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

const files = {
  'tsconfig.json': TSCONFIG,
  'src/a.ts': 'export const a = 1;\n',
  'src/user.ts': "import { a } from './a';\nexport const u = a;\n",
};

describe('move validation', () => {
  test('stops without changing anything when the destination exists', async () => {
    const root = fixture({ ...files, 'src/b.ts': 'export const b = 1;\n' });
    const move = { from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') };

    await expect(run(base(root, { moves: [move] }))).rejects.toThrow('destination already exists');

    expect(read(root, 'src/a.ts')).toBe('export const a = 1;\n');
    expect(read(root, 'src/user.ts')).toContain("'./a'");
  });

  test('stops without changing anything when the destination is inside another source', async () => {
    const root = fixture({ ...files, 'src/dir/x.ts': 'export {};\n' });
    const moves = [
      { from: join(root, 'src/dir'), to: join(root, 'src/moved') },
      { from: join(root, 'src/a.ts'), to: join(root, 'src/dir/a.ts') },
    ];

    await expect(run(base(root, { moves }))).rejects.toThrow('destination is inside another source');

    expect(existsSync(join(root, 'src/dir/x.ts'))).toBe(true);
  });

  test('stops when the source is missing', async () => {
    const root = fixture(files);
    const move = { from: join(root, 'src/none.ts'), to: join(root, 'src/x.ts') };

    await expect(run(base(root, { moves: [move] }))).rejects.toThrow('source does not exist');
  });
});

describe('--workers', () => {
  test('rejects invalid values before moving', async () => {
    const root = fixture(files);
    const move = { from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') };

    for (const workers of [Number.NaN, 2.5, 0]) {
      await expect(run(base(root, { moves: [move], workers }))).rejects.toThrow('workers must be');
    }
    expect(existsSync(join(root, 'src/a.ts'))).toBe(true);
  });

  test('gives the same result with workers as with a single thread', async () => {
    const make = () =>
      fixture({
        'tsconfig.json': TSCONFIG,
        'src/lib/util.ts': 'export const u = 1;\n',
        ...Object.fromEntries(
          Array.from({ length: 7 }, (_, i) => [
            `src/f${i}.ts`,
            `import { u } from './lib/util';\nexport const v${i} = u;\n`,
          ]),
        ),
      });
    const results = [];
    for (const workers of [1, 3]) {
      const root = make();
      const move = { from: join(root, 'src/lib'), to: join(root, 'src/shared') };
      const result = await run(base(root, { moves: [move], workers }));
      results.push({
        files: Array.from({ length: 7 }, (_, i) => read(root, `src/f${i}.ts`)),
        changes: result.changes.map(({ from, to }) => `${from} ${to}`),
        scanned: result.scannedFiles,
      });
    }

    expect(results[1]).toEqual(results[0]);
    expect(results[0].files[0]).toContain("'./shared/util'");
  });
});

describe('unreadable files', () => {
  test('does not rewrite files with syntax errors and warns with the cause', async () => {
    const broken = "import { a } from './a';\nconst = ;\n";
    const root = fixture({ ...files, 'src/broken.ts': broken });
    const move = { from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') };

    const result = await run(base(root, { moves: [move] }));

    expect(read(root, 'src/broken.ts')).toBe(broken);
    expect(result.warnings.some((w) => w.includes('broken.ts') && w.includes('syntax error'))).toBe(true);
    expect(read(root, 'src/user.ts')).toContain("'./b'");
  });

  test('does not rewrite non-UTF-8 files and warns', async () => {
    const root = fixture(files);
    const legacy = Buffer.concat([
      Buffer.from("import { a } from './a';\n// "),
      Buffer.from([0xe9, 0x0a]),
    ]);
    writeFileSync(join(root, 'src/legacy.ts'), legacy);
    const move = { from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') };

    const result = await run(base(root, { moves: [move] }));

    expect(readFileSync(join(root, 'src/legacy.ts')).equals(legacy)).toBe(true);
    expect(result.warnings.some((w) => w.includes('legacy.ts') && w.includes('UTF-8'))).toBe(true);
  });

  test('warns about an unresolvable alias import only when it points inside a moving path', async () => {
    const root = fixture({
      ...files,
      'src/lib/util.ts': 'export const u = 1;\n',
      'src/gone.ts': "import { x } from '@/lib/missing';\nimport { y } from '@/elsewhere';\n",
    });

    const result = await run(base(root, { moves: [{ from: join(root, 'src/lib'), to: join(root, 'src/shared') }] }));

    expect(result.warnings.filter((w) => w.includes('cannot resolve'))).toEqual([
      `${join(root, 'src/gone.ts')}: cannot resolve: @/lib/missing`,
    ]);
  });

  test('warns when there are no target files', async () => {
    const root = fixture({ 'tsconfig.json': TSCONFIG });

    const result = await run(base(root));

    expect(result.warnings.some((w) => w.includes('no source files'))).toBe(true);
  });

  test('warns about a broken package.json and skips it', async () => {
    const root = fixture({ ...files, 'packages/p/package.json': '{ "name": ' });
    const move = { from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') };

    const result = await run(base(root, { moves: [move] }));

    expect(result.warnings.some((w) => w.includes('packages/p/package.json'))).toBe(true);
  });
});

describe('writes', () => {
  test('keeps the executable bit and CRLF', async () => {
    const root = fixture({
      ...files,
      'src/cli.ts': "import { a } from './a';\r\nexport const c = a;\r\n",
    });
    chmodSync(join(root, 'src/cli.ts'), 0o755);
    const move = { from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') };

    await run(base(root, { moves: [move] }));

    expect(read(root, 'src/cli.ts')).toBe("import { a } from './b';\r\nexport const c = a;\r\n");
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'src/cli.ts')).mode & 0o777).toBe(0o755);
    }
  });

  test('leaves no temp files', async () => {
    const root = fixture(files);
    const move = { from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') };

    await run(base(root, { moves: [move] }));

    expect(readdirSync(join(root, 'src')).filter((name) => name.endsWith('.movemod-tmp'))).toEqual([]);
  });

  test('imports after a Japanese string keep correct positions', async () => {
    const root = fixture({
      ...files,
      'src/c.ts': 'export const c = 1;\n',
      'src/jp.ts':
        "const 名前 = '日本語🎌';\nimport { a } from './a'; import { c } from './c';\nexport const j = [名前, a, c];\n",
    });
    const moves = [
      { from: join(root, 'src/a.ts'), to: join(root, 'src/aaa/a.ts') },
      { from: join(root, 'src/c.ts'), to: join(root, 'src/c/c.ts') },
    ];

    await run(base(root, { moves }));

    expect(read(root, 'src/jp.ts')).toBe(
      "const 名前 = '日本語🎌';\nimport { a } from './aaa/a'; import { c } from './c/c';\nexport const j = [名前, a, c];\n",
    );
  });
});

describe('dry-run', () => {
  test('does nothing for folder moves and config rewrites either', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['src'] }),
      'package.json': JSON.stringify({ name: 'x', main: './src/index.ts' }),
      'src/index.ts': 'export {};\n',
    });
    const move = { from: join(root, 'src'), to: join(root, 'lib') };

    const result = await run(base(root, { moves: [move], apply: false }));

    expect(existsSync(join(root, 'src/index.ts'))).toBe(true);
    expect(existsSync(join(root, 'lib'))).toBe(false);
    expect(read(root, 'package.json')).toContain('./src/index.ts');
    expect(result.configFilesChanged.some((file) => file.endsWith('package.json'))).toBe(true);
  });
});
