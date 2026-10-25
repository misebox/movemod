import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanFixtures, fixture } from './fixture.ts';

afterEach(cleanFixtures);

// The sample project that the README examples are run on
const sample = () =>
  fixture({
    'package.json': '{ "name": "sample", "private": true }',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./src/*'] } },
      include: ['src'],
    }),
    '.github/workflows/ci.yml': [
      'name: ci',
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: bun test src/components/Button',
      '',
    ].join('\n'),
    'src/components/Button/Button.css': '.button {\n  padding: 4px 8px;\n}\n',
    'src/components/Button/data.json': '{ "labels": ["ok", "cancel"] }\n',
    'src/components/Button/index.tsx': [
      "import { cn } from '@/utils/cn';",
      "import './Button.css';",
      '',
      "export const Button = (label: string) => cn('button', label);",
      '',
    ].join('\n'),
    'src/components/Card.tsx': "import { Button } from './Button';\n\nexport const Card = () => Button('card');\n",
    'src/pages/home/Hero.test.tsx':
      "vi.mock('@/components/Button');\n\ntest('Hero', () => {\n  expect(true).toBe(true);\n});\n",
    'src/pages/home/Hero.tsx':
      "import { Button } from '@/components/Button';\n\nexport const Hero = () => Button('hero');\n",
    'src/pages/home/index.tsx': "import { Hero } from './Hero';\n\nexport const Home = () => Hero();\n",
    'src/scripts/seed.ts': [
      "import { readFileSync } from 'node:fs';",
      '',
      "const labels = JSON.parse(readFileSync('src/components/Button/data.json', 'utf8'));",
      '',
      'console.log(labels);',
      '',
    ].join('\n'),
    'src/utils/cn.ts': "export const cn = (...names: string[]) => names.filter(Boolean).join(' ');\n",
  });

// Code blocks without a language, in the order they appear
const exampleBlocks = (): string[] => {
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
  const blocks: string[] = [];
  let current: string[] | undefined;
  let plain = false;
  for (const line of readme.split('\n')) {
    if (!line.startsWith('```')) {
      current?.push(line);
    } else if (current === undefined) {
      current = [];
      plain = line === '```';
    } else {
      if (plain) blocks.push(current.join('\n').trimEnd());
      current = undefined;
    }
  }
  return blocks;
};

const dryRun = (root: string): string => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const args = ['src/components/Button', 'src/components/ui/Button', '--dry-run'];
  return Bun.spawnSync([process.execPath, cli, ...args], { cwd: root }).stdout.toString().trimEnd();
};

describe('README examples', () => {
  test('the dry run example is the output, without the "Check by hand" sections', () => {
    const [example] = exampleBlocks().filter((block) => block.startsWith('$ npx movemod'));
    const expected = example.split('\n').slice(1).join('\n');

    const output = dryRun(sample())
      .split('\n\n')
      .filter((section) => !section.startsWith('Check by hand'))
      .join('\n\n');

    expect(output).toBe(expected);
  });

  test('the "Check by hand" example is part of the output', () => {
    const [example] = exampleBlocks().filter((block) => block.startsWith('Check by hand'));

    expect(dryRun(sample())).toContain(example);
  });
});
