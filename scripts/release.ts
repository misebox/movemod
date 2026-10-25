// Checks the repository and tags the version. Publishing is done by CI (.github/workflows/release.yml)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const output = (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const show = (command: string, args: string[]) => execFileSync(command, args, { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;

if (output('git', ['branch', '--show-current']) !== 'main') fail('Release from main');
if (output('git', ['status', '--porcelain']) !== '') fail('Commit or stash your changes first');
if (output('git', ['tag', '--list', tag]) !== '') fail(`Tag ${tag} already exists. Bump the version in package.json`);

show('bun', ['test', './test']);
show('bun', ['run', 'build']);
// An annotated tag: git push --follow-tags sends only these
show('git', ['tag', '-a', tag, '-m', tag]);

console.log(`\nTagged ${tag}. Push it to publish:\n  git push --follow-tags`);
