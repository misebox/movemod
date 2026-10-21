const escapeRegExp = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const segmentToRegExp = (segment: string): string =>
  [...segment]
    .map((char) => {
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return escapeRegExp(char);
    })
    .join('');

const normalize = (pattern: string) =>
  pattern.replace(/^\.\//, '').replace(/\/+$/, '');

// tsconfig の include / exclude と同じ規則。拡張子も glob も無い最後の要素は、フォルダとして中身を含む
export const compilePattern = (pattern: string): RegExp => {
  const segments = normalize(pattern).split('/');
  const last = segments[segments.length - 1];
  const body = segments
    .map((segment, index) => {
      const isLast = index === segments.length - 1;
      if (segment === '**') return isLast ? '.*' : '(?:[^/]+/)*';
      return segmentToRegExp(segment) + (isLast ? '' : '/');
    })
    .join('');
  const includesChildren = !/[*?.]/.test(last);
  return new RegExp(`^${body}${includesChildren ? '(?:/.*)?' : ''}$`);
};

// glob を含まない先頭部分。走査の起点になる
export const staticPrefix = (pattern: string): string => {
  const segments = normalize(pattern).split('/');
  const index = segments.findIndex((segment) => /[*?]/.test(segment));
  return (index === -1 ? segments : segments.slice(0, index)).join('/');
};
