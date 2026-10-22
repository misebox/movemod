// 単体実行ファイルを作る。使い方: bun scripts/build-bin.ts [<os>-<cpu>]（省略すると実行中の OS）
// 対象 OS の oxc-parser のネイティブバイナリを埋め込む。入っていなければ npm から取る
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CACHE_DIR = join(ROOT, 'node_modules', '.cache', 'movemod-bindings');

// <os>-<cpu> から、oxc-parser のバインディング名を引く
const BINDINGS: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-arm64': 'linux-arm64-gnu',
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64-musl': 'linux-arm64-musl',
  'linux-x64-musl': 'linux-x64-musl',
  'win32-arm64': 'win32-arm64-msvc',
  'win32-x64': 'win32-x64-msvc',
};

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const binding = BINDINGS[target];
if (!binding) {
  console.error(`unknown target: ${target} (one of: ${Object.keys(BINDINGS).join(', ')})`);
  process.exit(1);
}

const nodeFileIn = (dir: string) => {
  const file = existsSync(dir) ? readdirSync(dir).find((entry) => entry.endsWith('.node')) : undefined;
  return file ? join(dir, file) : undefined;
};

const fetchBinding = async (): Promise<string> => {
  const installed = nodeFileIn(join(ROOT, 'node_modules', '@oxc-parser', `binding-${binding}`));
  if (installed) return installed;

  const cached = join(CACHE_DIR, binding, 'package');
  const cachedFile = nodeFileIn(cached);
  if (cachedFile) return cachedFile;

  const { version } = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'oxc-parser', 'package.json'), 'utf8'));
  const destination = join(CACHE_DIR, binding);
  mkdirSync(destination, { recursive: true });
  const spec = `@oxc-parser/binding-${binding}@${version}`;
  const pack = Bun.spawnSync(['npm', 'pack', spec, '--pack-destination', destination, '--silent'], { stderr: 'inherit' });
  if (!pack.success) throw new Error(`cannot download ${spec}`);
  const tarball = readdirSync(destination).find((entry) => entry.endsWith('.tgz'));
  if (!tarball) throw new Error(`no tarball for ${spec}`);
  const extract = Bun.spawnSync(['tar', '-xzf', join(destination, tarball), '-C', destination], { stderr: 'inherit' });
  if (!extract.success) throw new Error(`cannot extract ${tarball}`);
  const file = nodeFileIn(cached);
  if (!file) throw new Error(`no .node file in ${spec}`);
  return file;
};

const nodeFile = await fetchBinding();
const outfile = join(ROOT, 'dist', `movemod-${target}${target.startsWith('win32') ? '.exe' : ''}`);

const result = await Bun.build({
  entrypoints: [join(ROOT, 'src', 'main.ts'), join(ROOT, 'src', 'worker.ts')],
  compile: { target: `bun-${target}` as Bun.Build.Target, outfile },
  plugins: [
    {
      name: 'native-binding',
      setup: (build) => {
        build.onResolve({ filter: /^native-binding$/ }, () => ({ path: nodeFile }));
        build.onLoad({ filter: /\.node$/ }, () => ({ contents: readFileSync(nodeFile), loader: 'file' }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(outfile);
