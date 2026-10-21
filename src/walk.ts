import { basename } from 'node:path/posix';
import type { FsIndex } from './fsIndex.ts';

const ALWAYS_SKIPPED = new Set(['node_modules', '.git']);

export const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

// root 以下のファイルを列挙する。root がファイルのときは、そのファイルだけ
export const walk = (
  fs: FsIndex,
  root: string,
  skipDirectory: (path: string) => boolean,
  onFile: (path: string, name: string) => void,
): void => {
  if (fs.isFile(root)) {
    onFile(root, basename(root));
    return;
  }
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for (const [name, kind] of fs.entries(dir)) {
      const path = `${dir}/${name}`;
      if (kind === 'file') {
        onFile(path, name);
      } else if (!ALWAYS_SKIPPED.has(name) && !skipDirectory(path)) {
        stack.push(path);
      }
    }
  }
};
