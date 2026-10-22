export const parseWorkers = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const count = Number(text);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--workers must be a positive integer: ${text}`);
  }
  return count;
};

// One "<from> <to>" per line. Blank lines and lines starting with # are ignored. Returns an array ordered <from> <to>
export const parseBulkList = (text: string): string[] => {
  const paths: string[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [from, to, ...rest] = trimmed.split(/\s+/);
    if (!to || rest.length > 0) {
      throw new Error(`bulk list line ${index + 1}: expected "<from> <to>": ${trimmed}`);
    }
    paths.push(from, to);
  }
  return paths;
};
