import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createConverters } from '../src/paths.ts';
import { run } from '../src/engine.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

describe('書き換える書き方', () => {
  test('type import・export *・reference・new URL も直り、コメントと変数は直さない', async () => {
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

  test('tsconfig のコメントの中のパスは、書き換えない', async () => {
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

describe('--strict の元になる警告', () => {
  test('警告が無い通常の移動では、warnings が空', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/a.ts': 'export const a = 1;\n',
      'src/u.ts': "import { a } from './a';\nexport const u = a;\n",
    });

    const result = await run(base(root, { moves: [{ from: join(root, 'src/a.ts'), to: join(root, 'src/b.ts') }] }));

    expect(result.warnings).toEqual([]);
  });
});

describe('Windows のパス変換', () => {
  const windows = createConverters(true);

  test('小文字のドライブ文字は大文字にそろう', () => {
    expect(windows.fromNative('c:\\a\\b')).toBe('/C:/a/b');
    expect(windows.fromNative('C:\\a\\b\\')).toBe('/C:/a/b/');
  });

  test('ドライブ文字のないパスは、そのまま区切りだけ変わる', () => {
    expect(windows.fromNative('a\\b')).toBe('a/b');
    expect(windows.toNative('/a/b')).toBe('/a/b');
  });

  test('画面に出す文字列では、引用符の中のパスも戻る', () => {
    expect(windows.toNativeText("warning: '/C:/a/b' (/C:/x)")).toBe("warning: 'C:/a/b' (C:/x)");
  });
});
