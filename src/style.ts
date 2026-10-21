import { relative } from 'node:path/posix';
import type { Alias } from './tsconfig.ts';

// shortest: './' を最優先し、'../' が必要なときは alias が短ければ alias
// keep:     今の書き方（相対か alias か）を保つ
export type Style = 'shortest' | 'keep';

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

// target を名指しできる alias のうち、いちばん短いもの
export const aliasSpecifier = (aliases: Alias[], target: string): string | undefined => {
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
      if (candidate !== undefined && (best === undefined || candidate.length < best.length)) {
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
  const aliasText = aliasSpecifier(aliases, target);
  if (aliasText === undefined) return relativeText;
  if (style === 'keep') return origin === 'alias' ? aliasText : relativeText;
  if (relativeText.startsWith('./')) return relativeText;
  return aliasText.length < relativeText.length ? aliasText : relativeText;
};
