import { describe, expect, test } from 'bun:test';
import { createConverters } from '../src/paths.ts';

describe('Windows path conversion', () => {
  const { fromNative, toNative, toNativeText } = createConverters(true);

  test('converts drive-letter paths to POSIX form and back', () => {
    expect(fromNative('c:\\Users\\a\\src')).toBe('/C:/Users/a/src');
    expect(toNative('/C:/Users/a/src')).toBe('C:/Users/a/src');
  });

  test('changes only the separators of paths without a drive letter', () => {
    expect(fromNative('src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(toNative('src/a/b.ts')).toBe('src/a/b.ts');
  });

  test('converts paths in messages back to native form', () => {
    expect(toNativeText('warn: /C:/x/a.ts: 解決できません')).toBe('warn: C:/x/a.ts: 解決できません');
    expect(toNativeText('./a/b と /usr/local')).toBe('./a/b と /usr/local');
  });
});

describe('mac / linux path conversion', () => {
  test('changes nothing', () => {
    const { fromNative, toNative, toNativeText } = createConverters(false);
    expect(fromNative('/a/b')).toBe('/a/b');
    expect(toNative('/C:/a')).toBe('/C:/a');
    expect(toNativeText('/C:/a')).toBe('/C:/a');
  });
});
