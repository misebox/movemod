import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createConverters } from '../src/paths.ts';
import { run } from '../src/engine.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

describe('rewritten forms', () => {
  test('also updates type import, export *, reference and new URL, but not comments or variables', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/m.ts': 'export type M = number;\nexport const m = 1;\n',
      'src/use.ts': [
        '/// <reference path="./m.ts" />',
        "import type { M } from './m';",
        "export * from './m';",
        "export type { M as N } from './m';",
        "const url = new URL('./m.ts', import.meta.url);",
        "// import { z } from './m';",
        "const path = './m';",
        'export const x: M = 1;',
        '',
      ].join('\n'),
    });

    await run(base(root, { style: 'keep', moves: [{ from: join(root, 'src/m.ts'), to: join(root, 'src/n/m.ts') }] }));

    expect(read(root, 'src/use.ts')).toBe(
      [
        '/// <reference path="./n/m.ts" />',
        "import type { M } from './n/m';",
        "export * from './n/m';",
        "export type { M as N } from './n/m';",
        "const url = new URL('./n/m.ts', import.meta.url);",
        "// import { z } from './m';",
        "const path = './m';",
        'export const x: M = 1;',
        '',
      ].join('\n'),
    );
  });

  test('does not rewrite paths inside tsconfig comments', async () => {
    const root = fixture({
      'tsconfig.json': '{\n  // "src/legacy"\n  /* "src/legacy" */\n  "include": ["src"]\n}\n',
      'src/index.ts': 'export {};\n',
    });

    await run(base(root, { moves: [{ from: join(root, 'src'), to: join(root, 'lib') }] }));

    expect(read(root, 'tsconfig.json')).toBe(
      '{\n  // "src/legacy"\n  /* "src/legacy" */\n  "include": ["lib"]\n}\n',
    );
  });
});

describe('warnings that stop a run without --force', () => {
  test('warnings is empty for a normal move without warnings', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/u.ts': "import { a } from './a';\nexport const u = a;\n",
    });

    const result = await run(base(root, { moves: [{ from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') }] }));

    expect(result.warnings).toEqual([]);
  });
});

describe('Windows path conversion', () => {
  const windows = createConverters(true);

  test('lowercase drive letters become uppercase', () => {
    expect(windows.fromNative('c:\\a\\b')).toBe('/C:/a/b');
    expect(windows.fromNative('C:\\a\\b\\')).toBe('/C:/a/b/');
  });

  test('paths without a drive letter change only the separators', () => {
    expect(windows.fromNative('a\\b')).toBe('a/b');
    expect(windows.toNative('/a/b')).toBe('/a/b');
  });

  test('in displayed text, paths inside quotes are converted back too', () => {
    expect(windows.toNativeText("warning: '/C:/a/b' (/C:/x)")).toBe("warning: 'C:/a/b' (C:/x)");
  });
});
