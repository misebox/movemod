export const parseWorkers = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const count = Number(text);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--workers must be a positive integer: ${text}`);
  }
  return count;
};

// 1 行に "<from> <to>"。空行と、行頭が # の行は無視する。<from> <to> の順に並べた配列を返す
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
