import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

export type RepoSpec = {
  files: number;
  moves: number;
  importsPerFile: number;
  // import のうち alias で書く割合（同じフォルダ内の import は常に './'）
  aliasRatio: number;
  seed: number;
};

export type GeneratedRepo = {
  root: string;
  tsconfig: string;
  movesFile: string;
  moves: number;
};

const FILES_PER_DIR = 20;

const createRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// src/dA/dB/dC を深さ 3 の葉フォルダとして、葉の数だけ作る
const leafDirectories = (files: number): string[] => {
  const count = Math.ceil(files / FILES_PER_DIR);
  const width = Math.ceil(Math.cbrt(count));
  const leaves: string[] = [];
  for (let a = 0; a < width; a++) {
    for (let b = 0; b < width; b++) {
      for (let c = 0; c < width; c++) {
        if (leaves.length < count) leaves.push(`src/d${a}/d${b}/d${c}`);
      }
    }
  }
  return leaves;
};

export const generateRepo = (root: string, spec: RepoSpec): GeneratedRepo => {
  const random = createRandom(spec.seed);
  const leaves = leafDirectories(spec.files);
  const dirOf = (index: number) => leaves[index % leaves.length];

  const specifierTo = (from: number, to: number): string => {
    const fromDir = dirOf(from);
    const toDir = dirOf(to);
    if (fromDir === toDir) return `./f${to}`;
    if (random() < spec.aliasRatio) {
      return `@/${posix.relative('src', toDir)}/f${to}`;
    }
    const relative = posix.relative(fromDir, `${toDir}/f${to}`);
    return relative.startsWith('.') ? relative : `./${relative}`;
  };

  for (let i = 0; i < spec.files; i++) {
    const targets = Array.from({ length: spec.importsPerFile }, () => {
      const target = Math.floor(random() * spec.files);
      return target === i ? (target + 1) % spec.files : target;
    });
    const imports = targets.map(
      (target) => `import { v${target} } from '${specifierTo(i, target)}';`,
    );
    const names = targets.map((target) => `v${target}`).join(', ');
    const path = join(root, dirOf(i), `f${i}.ts`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${imports.join('\n')}\nexport const v${i} = [${names}];\n`);
  }

  const tsconfig = join(root, 'tsconfig.json');
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src'],
    }),
  );

  const moves = Math.min(spec.moves, leaves.length);
  const stride = Math.floor(leaves.length / Math.max(moves, 1));
  const lines = Array.from({ length: moves }, (_, m) => {
    const leaf = leaves[m * stride];
    return `${join(root, leaf)} ${join(root, 'src/moved', leaf.split('/').slice(1).join('-'))}`;
  });
  const movesFile = join(root, 'moves.txt');
  writeFileSync(movesFile, `${lines.join('\n')}\n`);

  return { root, tsconfig, movesFile, moves };
};
