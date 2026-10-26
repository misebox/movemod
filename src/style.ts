import { relative } from 'node:path/posix';
import type { Alias } from './tsconfig.ts';

// auto:     './' first; when '../' is needed, an alias (fewest segments, then fewest characters), else '../'
// shortest: './' first; when '../' is needed, the alias if it is shorter
// keep:     keeps the current form (relative or alias)
// relative: always relative; aliases are expanded
export type Style = 'auto' | 'shortest' | 'keep' | 'relative';

export type Origin = 'relative' | 'alias' | 'package';

export const isRelative = (specifier: string): boolean =>
  specifier === '.' ||
  specifier === '..' ||
  specifier.startsWith('./') ||
  specifier.startsWith('../');

export const relativeSpecifier = (fromDir: string, target: string): string => {
  const path = relative(fromDir, target);
  if (path === '') return '.';
  return isRelative(path) ? path : `./${path}`;
};

const segmentCount = (specifier: string): number => specifier.split('/').length;

// Fewer segments first, then fewer characters
const fewerSegments = (a: string, b: string): boolean =>
  segmentCount(a) < segmentCount(b) || (segmentCount(a) === segmentCount(b) && a.length < b.length);
const shorter = (a: string, b: string): boolean => a.length < b.length;

// The best alias that can name target; better(a, b) tells whether a beats b
export const aliasSpecifier = (
  aliases: Alias[],
  target: string,
  better: (a: string, b: string) => boolean = shorter,
): string | undefined => {
  let best: string | undefined;
  for (const alias of aliases) {
    for (const pattern of alias.targets) {
      let candidate: string | undefined;
      if (!pattern.wildcard) {
        if (!alias.wildcard && target === pattern.prefix) candidate = alias.prefix;
      } else if (
        alias.wildcard &&
        target.length >= pattern.prefix.length + pattern.suffix.length &&
        target.startsWith(pattern.prefix) &&
        target.endsWith(pattern.suffix)
      ) {
        const captured = target.slice(
          pattern.prefix.length,
          target.length - pattern.suffix.length,
        );
        candidate = alias.prefix + captured + alias.suffix;
      }
      if (candidate !== undefined && (best === undefined || better(candidate, best))) {
        best = candidate;
      }
    }
  }
  return best;
};

export const chooseSpecifier = (options: {
  style: Style;
  origin: Origin;
  aliases: Alias[];
  fromDir: string;
  target: string;
}): string => {
  const { style, origin, aliases, fromDir, target } = options;
  const relativeText = relativeSpecifier(fromDir, target);
  if (style === 'auto') {
    const aliasText = aliasSpecifier(aliases, target, fewerSegments);
    const noParent = relativeText === '.' || relativeText.startsWith('./');
    return noParent || aliasText === undefined ? relativeText : aliasText;
  }
  const aliasText = aliasSpecifier(aliases, target);
  if (aliasText === undefined || style === 'relative') return relativeText;
  if (style === 'keep') return origin === 'alias' ? aliasText : relativeText;
  if (relativeText.startsWith('./')) return relativeText;
  return aliasText.length < relativeText.length ? aliasText : relativeText;
};
