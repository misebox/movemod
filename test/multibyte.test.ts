import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/engine.ts';
import { base, cleanFixtures, fixture, read, TSCONFIG } from './fixture.ts';

afterEach(cleanFixtures);

describe('multibyte folder and file names', () => {
  test('moving a Japanese-named folder updates imports and keeps the Japanese names', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'src/日本語/部品.ts': 'export const 部品 = 1;\n',
      'src/使う.ts': "import { 部品 } from './日本語/部品';\nexport const 使う = 部品;\n",
    });

    await run(
      base(root, { style: 'keep', moves: [{ from: join(root, 'src/日本語'), to: join(root, 'src/ふぉるだ/日本語') }] }),
    );

    expect(existsSync(join(root, 'src/ふぉるだ/日本語/部品.ts'))).toBe(true);
    expect(read(root, 'src/使う.ts')).toBe(
      "import { 部品 } from './ふぉるだ/日本語/部品';\nexport const 使う = 部品;\n",
    );
  });
});
