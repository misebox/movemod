import { describe, expect, test } from 'bun:test';
import { parseBulkList, parseWorkers } from '../src/args.ts';

describe('parseWorkers', () => {
  test('returns undefined when omitted and positive integers as is', () => {
    expect(parseWorkers(undefined)).toBeUndefined();
    expect(parseWorkers('3')).toBe(3);
  });

  test.each(['abc', '2.5', '0', '-1', ''])('rejects %s', (text) => {
    expect(() => parseWorkers(text)).toThrow('--workers must be a positive integer');
  });
});

describe('parseBulkList', () => {
  test('skips blank and # lines and returns from and to in order', () => {
    const text = '# moves\n\nsrc/a src/b\n  src/c   src/d  \n';
    expect(parseBulkList(text)).toEqual(['src/a', 'src/b', 'src/c', 'src/d']);
  });

  test('treats a # in the middle of a line as an error, not a comment', () => {
    expect(() => parseBulkList('src/a src/b # note\n')).toThrow('line 1');
  });

  test('errors with the line number on a one-word line', () => {
    expect(() => parseBulkList('src/a src/b\nsrc/c\n')).toThrow('line 2');
  });
});
