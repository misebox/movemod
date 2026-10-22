// Usage:
//   bun bench/run.ts --cmd '<command>' [--files 10000] [--moves 100] [--runs 5]
//
// {root} {tsconfig} {moves} in --cmd are replaced with paths in the generated repo.
// The work folder is always deleted on exit (success, failure, Ctrl+C).
// The command runs --runs times on the same repo, so run it as a dry-run.
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
  console.error('--cmd is required');
  process.exit(1);
}

const median = (sorted: number[]) => sorted[Math.floor(sorted.length / 2)];

const measure = (command: string, runs: number): number[] =>
  Array.from({ length: runs }, () => {
    const start = performance.now();
    const result = spawnSync(command, { shell: true, encoding: 'utf8' });
    const elapsed = performance.now() - start;
    if (result.status !== 0) {
      throw new Error(`Command failed (${result.status}):\n${result.stderr}`);
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
    `Generated: ${values.files} files, ${repo.moves} moves (${Math.round(performance.now() - started)} ms)`,
  );

  const command = values.cmd
    .replaceAll('{root}', `"${repo.root}"`)
    .replaceAll('{tsconfig}', `"${repo.tsconfig}"`)
    .replaceAll('{moves}', `"${repo.movesFile}"`);
  const times = measure(command, Number(values.runs)).sort((a, b) => a - b);
  console.log(
    `${times.length} runs: min ${Math.round(times[0])} ms / median ${Math.round(median(times))} ms / max ${Math.round(times[times.length - 1])} ms`,
  );
} finally {
  cleanWorkDir();
  console.log('Work folder deleted.');
}
