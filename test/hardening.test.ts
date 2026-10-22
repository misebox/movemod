import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { forEachLimit } from '../src/io.ts';
import { checkMoves } from '../src/pathMapper.ts';
import { commonFolder, detectRoot, findTsconfigs, resolveRoot } from '../src/root.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

const move = (root: string, from: string, to: string) => ({
  from: join(root, from),
  to: join(root, to),
});

describe('moving a config file itself', () => {
  test('relative path values are rewritten for the new location even when only the file moves', async () => {
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

  test('values starting with ../ never become names without ./', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ include: ['packages'] }),
      'tsconfig.base.json': '{}\n',
      'packages/app/tsconfig.build.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
    });

    await run(base(root, { moves: [move(root, 'tsconfig.base.json', 'packages/app/tsconfig.base.json')] }));

    expect(JSON.parse(read(root, 'packages/app/tsconfig.build.json')).extends).toBe('./tsconfig.base.json');
  });

  test('a } in a comment inside the paths block does not end the range early', async () => {
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

describe('writes', () => {
  test.skipIf(process.platform === 'win32')('a symlink stays a symlink and its target is rewritten', async () => {
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

  test('rewrites valid UTF-8 files that contain U+FFFD', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
    });
    writeFileSync(join(root, 'src/ok.ts'), "import { a } from './a';\nexport const s = '�';\n");

    const result = await run(base(root, { moves: [move(root, 'src/a.ts', 'src/b.ts')] }));

    expect(read(root, 'src/ok.ts')).toBe("import { a } from './b';\nexport const s = '�';\n");
    expect(result.warnings).toEqual([]);
  });

  test('forEachLimit starts no new items after a failure and throws the failures together', async () => {
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

describe('case checks (filesystem independent)', () => {
  const exists = () => true;

  test('stops when the source parent folder has different case', () => {
    const isExactCase = (path: string) => !path.includes('/Src');

    expect(() => checkMoves([{ from: '/r/Src/foo.ts', to: '/r/src/bar.ts' }], exists, isExactCase)).toThrow(
      'differs in letter case',
    );
  });

  test('allows case-only moves and stops overwrites of other files', () => {
    const isExactCase = (path: string) => path !== '/r/Button.ts';

    expect(() => checkMoves([{ from: '/r/button.ts', to: '/r/Button.ts' }], exists, isExactCase)).not.toThrow();
    expect(() => checkMoves([{ from: '/r/button.ts', to: '/r/other.ts' }], exists, () => true)).toThrow(
      'destination already exists',
    );
  });
});

describe('warnings', () => {
  test('the result includes the number of skipped files', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/broken.ts': "import { a } from './a';\nconst = ;\n",
    });

    const result = await run(base(root, { moves: [move(root, 'src/a.ts', 'src/b.ts')] }));

    expect(result.skippedFiles).toBe(1);
  });

  test('warns about a source file outside the tsconfig scope', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'scripts/x.js': 'module.exports = 1;\n',
    });

    const result = await run(base(root, { moves: [move(root, 'scripts/x.js', 'scripts/y.js')] }));

    expect(result.warnings.some((w) => w.includes('outside the tsconfig include'))).toBe(true);
  });

  test('does not warn about package subpaths exposed by exports', async () => {
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

  test('for packages with the same name, uses the shallower one', async () => {
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
  test('stops without changing anything when there are warnings', async () => {
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

describe('command line', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  // The root is found by package.json, so the fixture needs one to be its own project
  const execute = (root: string, args: string[]) => {
    if (!existsSync(join(root, 'package.json'))) writeFileSync(join(root, 'package.json'), '{}');
    return Bun.spawnSync([process.execPath, cli, ...args], { cwd: root });
  };

  test('--strict exits 1 with warnings and 0 without', () => {
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

  test('--workers with an invalid value exits 1 without changing anything', () => {
    const root = fixture({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' });

    const result = execute(root, ['src/a.ts', 'src/b.ts', '--workers', 'abc']);

    expect(result.exitCode).toBe(1);
    expect(existsSync(join(root, 'src/a.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  test('the last line shows the number of skipped files', () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/broken.ts': "import { a } from './a';\nconst = ;\n",
    });

    const result = execute(root, ['src/a.ts', 'src/b.ts', '--dry-run']);

    expect(result.stdout.toString()).toContain('1 file skipped; imports in them were NOT updated.');
  });

  test('a move between packages stops with the --root to set, and runs with it', () => {
    const root = fixture({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: '@x/a' }),
      'packages/a/src/x.ts': 'export const x = 1;\n',
      'packages/b/package.json': JSON.stringify({ name: '@x/b' }),
    });
    const paths = ['packages/a/src/x.ts', 'packages/b/src/x.ts', '--dry-run'];

    const stopped = execute(root, paths);
    const allowed = execute(root, [...paths, '--root', '.']);

    expect(stopped.exitCode).toBe(1);
    expect(stopped.stderr.toString()).toContain(`Set --root ${root} to move between packages.`);
    expect(allowed.exitCode).toBe(0);
  });

  test('a move inside one package needs no --root', () => {
    const root = fixture({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/a/package.json': JSON.stringify({ name: '@x/a' }),
      'packages/a/src/x.ts': 'export const x = 1;\n',
    });

    const result = execute(root, ['packages/a/src/x.ts', 'packages/a/src/y.ts', '--dry-run']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('root: packages/a (nearest package.json)');
  });

  test('tsconfig discovery: tsconfig.json first, then tsconfig.*.json, then jsconfig.json', () => {
    const names = ['jsconfig.json', 'tsconfig.node.json', 'tsconfig.app.json'];

    expect(findTsconfigs('/r/src', '/r', () => names)).toEqual(['/r/src/tsconfig.app.json', '/r/src/tsconfig.node.json']);
    expect(findTsconfigs('/r/src', '/r', () => [...names, 'tsconfig.json'])).toEqual(['/r/src/tsconfig.json']);
    expect(findTsconfigs('/r/src', '/r', (dir) => (dir === '/r' ? ['jsconfig.json'] : []))).toEqual(['/r/jsconfig.json']);
    expect(findTsconfigs('/r/src', '/r', () => [])).toEqual([]);
  });

  test('without --tsconfig, uses the nearest tsconfig above the path, not the working directory\'s', () => {
    const root = fixture({
      'app/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } }, include: ['src'] }),
      'app/src/utils/cn.ts': 'export const cn = 1;\n',
      'app/src/a/b.ts': "import { cn } from '../utils/cn';\nexport const x = cn;\n",
    });

    const result = execute(root, ['app/src/a/b.ts', '--dry-run']);

    expect(result.stdout.toString()).toContain("+ import { cn } from '@/utils/cn';");
  });
});

describe('tsconfig references', () => {
  test('are followed, so aliases defined in a referenced config are used', async () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': TSCONFIG,
      'src/utils/cn.ts': 'export const cn = 1;\n',
      'src/a/b.ts': "import { cn } from '../utils/cn';\nexport const x = cn;\n",
    });

    const result = await run({ ...base(root), tsconfigs: [join(root, 'tsconfig.json')] });

    expect(read(root, 'src/a/b.ts')).toBe("import { cn } from '@/utils/cn';\nexport const x = cn;\n");
    expect(result.warnings).toEqual([]);
  });
});

describe('project root', () => {
  const has = (...paths: string[]) => (path: string) => paths.includes(path);

  const root = (start: string, ...files: string[]) => detectRoot(start, '/home/u', has(...files))?.root;

  test('stops at the first package.json, even when an outer one declares workspaces', () => {
    expect(root('/r/packages/a/src', '/r/package.json', '/r/packages/a/package.json')).toBe('/r/packages/a');
  });

  test('without package.json: the nearest .git, then the nearest tsconfig.json or jsconfig.json', () => {
    expect(root('/r/app/src', '/r/.git', '/r/app/tsconfig.json')).toBe('/r');
    expect(root('/r/app/src', '/r/app/jsconfig.json')).toBe('/r/app');
    expect(root('/r/app/src')).toBeUndefined();
  });

  test('deno.json and jsr.json count as project files; .hg and .svn as repository folders', () => {
    expect(root('/w/app/src', '/w/app/deno.jsonc', '/w/package.json')).toBe('/w/app');
    expect(root('/w/app/src', '/w/app/jsr.json')).toBe('/w/app');
    expect(root('/w/repo/src', '/w/repo/.hg', '/w/package.json')).toBe('/w/repo');
    expect(root('/w/repo/src', '/w/repo/.svn', '/w/package.json')).toBe('/w/repo');
  });

  test('does not go above the folder with .git', () => {
    expect(root('/w/repo/src', '/w/repo/.git', '/w/package.json')).toBe('/w/repo');
  });

  test('never goes up into the home folder', () => {
    expect(root('/home/u/docs/notes', '/home/u/package.json')).toBeUndefined();
  });

  describe('paths in more than one package', () => {
    const workspaces = (path: string) => (path === '/r/package.json' ? '{ "workspaces": ["packages/*"] }' : undefined);
    const resolve = (folders: string[], read: (path: string) => string | undefined, ...files: string[]) =>
      resolveRoot(folders, '/home/u', has(...files), read);
    const packages = ['/r/package.json', '/r/packages/a/package.json', '/r/packages/b/package.json'];

    test('inside one package: that package', () => {
      expect(resolve(['/r/packages/a/src', '/r/packages/a/lib'], workspaces, ...packages).root).toBe('/r/packages/a');
    });

    test('in different packages of one workspaces root: an error that suggests --root', () => {
      expect(() => resolve(['/r/packages/a/src', '/r/packages/b/src'], workspaces, ...packages)).toThrow(
        'Set --root /r to move between packages.',
      );
      expect(() =>
        resolve(['/r/packages/a', '/r/packages/b'], () => undefined, '/r/pnpm-workspace.yaml', ...packages),
      ).toThrow('Set --root /r');
    });

    test('in projects not connected by workspaces: an error', () => {
      expect(() => resolve(['/r/packages/a/src', '/r/packages/b/src'], () => '{}', ...packages)).toThrow(
        'belong to different projects',
      );
    });

    test('with no marker at all: the folder they share', () => {
      expect(resolve(['/r/js/lib', '/r/js/app'], () => undefined).root).toBe('/r/js');
    });
  });

  test('commonFolder is the deepest folder holding all the folders', () => {
    expect(commonFolder(['/r/apps/web', '/r/libs/x'])).toBe('/r');
    expect(commonFolder(['/r/apps/web', '/r/apps/web'])).toBe('/r/apps/web');
  });

  test('moving a path outside the root stops before changing anything', async () => {
    const root = fixture({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1;\n' });
    const other = fixture({ 'tsconfig.json': TSCONFIG });

    await expect(
      run(base(root, { moves: [{ from: join(root, 'src/a.ts'), to: join(other, 'a.ts') }] })),
    ).rejects.toThrow('outside the project root');

    expect(existsSync(join(root, 'src/a.ts'))).toBe(true);
  });
});

describe('destination contents in the error', () => {
  test('lists up to 3 names, hidden files included, then the rest as a count', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'dest/.hidden': '',
      'dest/b.ts': '',
      'dest/c.ts': '',
      'dest/d.ts': '',
      'dest/e.ts': '',
    });

    const error = await run(base(root, { moves: [move(root, 'src/a.ts', 'dest')] })).catch((e) => e);

    expect(error.message).toContain('(contains: .hidden, b.ts, c.ts, ... and 2 more)');
  });
});

describe('moves onto themselves', () => {
  const exists = () => true;

  test('onto the parent folder: merge is not supported', () => {
    expect(() => checkMoves([{ from: '/r/hoge/fuga', to: '/r/hoge' }], exists)).toThrow(
      'destination is a parent of the source (merge is not supported)',
    );
  });

  test('onto the same path', () => {
    expect(() => checkMoves([{ from: '/r/hoge', to: '/r/hoge' }], exists)).toThrow(
      'source and destination are the same',
    );
  });

  test('into itself', () => {
    expect(() => checkMoves([{ from: '/r/hoge', to: '/r/hoge/x' }], exists)).toThrow('destination is inside another source');
  });
});

describe('moving a folder onto its parent', () => {
  test('is an error even when the source is the parent\'s only entry', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/hoge/fuga/util.ts': 'export const u = 1;\n',
    });

    await expect(run(base(root, { moves: [move(root, 'src/hoge/fuga', 'src/hoge')] }))).rejects.toThrow(
      'merge is not supported',
    );

    expect(existsSync(join(root, 'src/hoge/fuga/util.ts'))).toBe(true);
  });
});
