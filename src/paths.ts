import { resolve as nativeResolve } from 'node:path';

// 内部のパスはすべて POSIX 形式で持つ。Windows の 'C:\a' は '/C:/a' にする。
// 変換が要るのは Windows だけなので、他の環境では何もしない関数を使う
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

// cwd からの相対パスか絶対パスを、内部の絶対パスにする
export const resolveInput = (path: string): string => fromNative(nativeResolve(path));
