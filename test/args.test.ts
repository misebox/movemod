import { describe, expect, test } from 'bun:test';
import { parseBulkList, parseWorkers } from '../src/args.ts';

describe('parseWorkers', () => {
  test('省略すると undefined、正の整数はそのまま返す', () => {
    expect(parseWorkers(undefined)).toBeUndefined();
    expect(parseWorkers('3')).toBe(3);
  });

  test.each(['abc', '2.5', '0', '-1', ''])('%s は拒否する', (text) => {
    expect(() => parseWorkers(text)).toThrow('--workers must be a positive integer');
  });
});

describe('parseBulkList', () => {
  test('空行と行頭が # の行を飛ばし、from と to を順に返す', () => {
    const text = '# moves\n\nsrc/a src/b\n  src/c   src/d  \n';
    expect(parseBulkList(text)).toEqual(['src/a', 'src/b', 'src/c', 'src/d']);
  });

  test('行の途中の # はコメントにならず、エラーにする', () => {
    expect(() => parseBulkList('src/a src/b # note\n')).toThrow('line 1');
  });

  test('1 語だけの行は、行番号つきでエラーにする', () => {
    expect(() => parseBulkList('src/a src/b\nsrc/c\n')).toThrow('line 2');
  });
});
