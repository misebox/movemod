// 使い方:
//   bun bench/run.ts --cmd '<コマンド>' [--files 10000] [--moves 100] [--runs 5]
//
// --cmd の {root} {tsconfig} {moves} は、生成したリポジトリのパスに置き換わる。
// 作業フォルダは終了時（成功・失敗・Ctrl+C）に必ず削除する。
// コマンドは同じリポジトリに対して --runs 回実行するので、dry-run で動かすこと。
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { generateRepo } from './generate.ts';
import { cleanWorkDir, createWorkDir } from './workDir.ts';

const { values } = parseArgs({
  options: {
    cmd: { type: 'string' },
    files: { type: 'string', default: '10000' },
    moves: { type: 'string', default: '100' },
    runs: { type: 'string', default: '5' },
    imports: { type: 'string', default: '8' },
    alias: { type: 'string', default: '0.3' },
    seed: { type: 'string', default: '1' },
    show: { type: 'boolean' },
  },
});

if (!values.cmd) {
  console.error('--cmd を指定してください');
  process.exit(1);
}

const median = (sorted: number[]) => sorted[Math.floor(sorted.length / 2)];

const measure = (command: string, runs: number): number[] =>
  Array.from({ length: runs }, () => {
    const start = performance.now();
    const result = spawnSync(command, { shell: true, encoding: 'utf8' });
    const elapsed = performance.now() - start;
    if (result.status !== 0) {
      throw new Error(`コマンドが失敗しました (${result.status}):\n${result.stderr}`);
    }
    if (values.show) console.log(result.stdout);
    return elapsed;
  });

const stop = (code: number) => () => {
  cleanWorkDir();
  process.exit(code);
};
process.on('SIGINT', stop(130));
process.on('SIGTERM', stop(143));

try {
  const root = createWorkDir();
  const started = performance.now();
  const repo = generateRepo(root, {
    files: Number(values.files),
    moves: Number(values.moves),
    importsPerFile: Number(values.imports),
    aliasRatio: Number(values.alias),
    seed: Number(values.seed),
  });
  console.log(
    `生成: ${values.files} ファイル、移動 ${repo.moves} 件 (${Math.round(performance.now() - started)} ms)`,
  );

  const command = values.cmd
    .replaceAll('{root}', `"${repo.root}"`)
    .replaceAll('{tsconfig}', `"${repo.tsconfig}"`)
    .replaceAll('{moves}', `"${repo.movesFile}"`);
  const times = measure(command, Number(values.runs)).sort((a, b) => a - b);
  console.log(
    `実行 ${times.length} 回: min ${Math.round(times[0])} ms / median ${Math.round(median(times))} ms / max ${Math.round(times[times.length - 1])} ms`,
  );
} finally {
  cleanWorkDir();
  console.log('作業フォルダを削除しました。');
}
