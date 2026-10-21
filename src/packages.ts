import { readFileSync } from 'node:fs';
import { dirname } from 'node:path/posix';
import { toNative } from './paths.ts';

export type Pkg = { name: string; dir: string };

export type Packages = {
  byName: Map<string, Pkg>;
  names: string[];
  // 移動前・移動後のパスを含む、いちばん近いパッケージ
  nearestBefore: (path: string) => Pkg | undefined;
  nearestAfter: (path: string) => Pkg | undefined;
  dirAfter: (pkg: Pkg) => string;
};

export const readPackage = (packageJson: string): Pkg | undefined => {
  try {
    const { name } = JSON.parse(readFileSync(toNative(packageJson), 'utf8')) as { name?: unknown };
    return typeof name === 'string' ? { name, dir: dirname(packageJson) } : undefined;
  } catch {
    return undefined;
  }
};

export const createPackages = (
  list: Pkg[],
  map: (path: string) => string,
): Packages => {
  const before = new Map(list.map((pkg) => [pkg.dir, pkg]));
  const after = new Map(list.map((pkg) => [map(pkg.dir), pkg]));

  const nearest = (index: Map<string, Pkg>, path: string): Pkg | undefined => {
    let dir = dirname(path);
    while (true) {
      const found = index.get(dir);
      if (found) return found;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  };

  return {
    byName: new Map(list.map((pkg) => [pkg.name, pkg])),
    names: list.map((pkg) => pkg.name),
    nearestBefore: (path) => nearest(before, path),
    nearestAfter: (path) => nearest(after, path),
    dirAfter: (pkg) => map(pkg.dir),
  };
};
