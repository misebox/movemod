import { resolve as nativeResolve } from 'node:path';

// All internal paths are POSIX. Windows 'C:\a' becomes '/C:/a'.
// Only Windows needs conversion, so other platforms use a no-op function
export const createConverters = (isWindows: boolean) => {
  if (!isWindows) {
    const same = (text: string) => text;
    return { fromNative: same, toNative: same, toNativeText: same };
  }
  return {
    fromNative: (path: string) => {
      const posix = path.replaceAll('\\', '/');
      return /^[A-Za-z]:/.test(posix) ? `/${posix[0].toUpperCase()}${posix.slice(1)}` : posix;
    },
    toNative: (path: string) => path.replace(/^\/([A-Za-z]:)/, '$1'),
    toNativeText: (text: string) => text.replace(/(^|[\s'"(])\/([A-Za-z]:\/)/g, '$1$2'),
  };
};

export const { fromNative, toNative, toNativeText } = createConverters(
  process.platform === 'win32',
);

// Turns a path relative to cwd, or an absolute path, into an internal absolute path
export const resolveInput = (path: string): string => fromNative(nativeResolve(path));
