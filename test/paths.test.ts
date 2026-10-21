import { describe, expect, test } from 'bun:test';
import { createConverters } from '../src/paths.ts';

describe('Windows のパス変換', () => {
  const { fromNative, toNative, toNativeText } = createConverters(true);

  test('ドライブ文字つきのパスを POSIX 形式にして、元に戻せる', () => {
    expect(fromNative('c:\\Users\\a\\src')).toBe('/C:/Users/a/src');
    expect(toNative('/C:/Users/a/src')).toBe('C:/Users/a/src');
  });

  test('ドライブ文字のないパスは区切りだけ変える', () => {
    expect(fromNative('src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(toNative('src/a/b.ts')).toBe('src/a/b.ts');
  });

  test('メッセージ中のパスをネイティブ形式に戻す', () => {
    expect(toNativeText('warn: /C:/x/a.ts: 解決できません')).toBe('warn: C:/x/a.ts: 解決できません');
    expect(toNativeText('./a/b と /usr/local')).toBe('./a/b と /usr/local');
  });
});

describe('mac / linux のパス変換', () => {
  test('何も変えない', () => {
    const { fromNative, toNative, toNativeText } = createConverters(false);
    expect(fromNative('/a/b')).toBe('/a/b');
    expect(toNative('/C:/a')).toBe('/C:/a');
    expect(toNativeText('/C:/a')).toBe('/C:/a');
  });
});
