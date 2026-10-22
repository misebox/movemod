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

// Same rules as tsconfig include / exclude. A last element with no extension or glob is a folder and includes its contents
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

// Leading part without a glob. The starting point of the scan
export const staticPrefix = (pattern: string): string => {
  const segments = normalize(pattern).split('/');
  const index = segments.findIndex((segment) => /[*?]/.test(segment));
  return (index === -1 ? segments : segments.slice(0, index)).join('/');
};
