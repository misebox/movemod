# movemod

Move TS/JS files and folders, and rewrite the imports that point to them.

```sh
npx movemod src/components/Button src/ui/Button
```

Every file that refers to `Button` is updated, whether it uses a relative path, an alias, `vi.mock`, `import()` or `require`. The moved files are updated too. Add `--dry-run` to see the changes without making them:

```
$ npx movemod src/components/Button src/ui/Button --dry-run
src/components/Button -> src/ui/Button

src/components/Button/index.tsx:1
- import { cn } from '../../utils/cn';
+ import { cn } from '@/utils/cn';

src/components/Card.tsx:1
- import { Button } from './Button';
+ import { Button } from '@/ui/Button';

src/pages/home/Hero.test.tsx:1
- vi.mock('../../components/Button');
+ vi.mock('@/ui/Button');

src/pages/home/Hero.test.tsx:3
- const { Button } = await import('../../components/Button');
+ const { Button } = await import('@/ui/Button');

src/pages/home/Hero.tsx:1
- import { Button } from '@/components/Button';
+ import { Button } from '@/ui/Button';

src/pages/home/index.tsx:1
- import { Button } from '../../components/Button';
+ import { Button } from '@/ui/Button';

Check by hand: paths in strings that point to moved files (1)
  src/scripts/seed.ts:3  readFileSync('src/components/Button/data.json')

Check by hand: moved paths in config files (1)
  .github/workflows/ci.yml:8  - run: bun test src/components/Button

Dry run: 5 files, 6 imports would change (7 files scanned). Nothing was written.
```

Paths that movemod cannot rewrite safely are listed under "Check by hand".

Normalize the import style inside a folder:

```sh
npx movemod src
```

## Import style

Use a relative path when `./` works. When `../` is needed, use a tsconfig `paths` alias if it is shorter.

With `"paths": { "@/*": ["./src/*"] }`, in `src/a/b/c/file.ts`:

```ts
import { x } from './x';          // same folder: relative
import { y } from '../y';         // '@/a/b/y' is longer: relative
import { z } from '@/lib/z';      // '../../../lib/z' is longer: alias
```

Use `--style keep` to keep each import's current style.

## Faster standalone binary

Not published. Build it yourself (about 65-100 MB):

```sh
git clone https://github.com/misebox/movemod
cd movemod
bun install
bun run build:bin             # for this machine: dist/movemod-<os>-<cpu>
bun run build:bin linux-x64   # for another machine
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `linux-arm64-musl`, `linux-x64-musl` (Alpine), `win32-arm64`, `win32-x64`.

## Options

| Option | Description |
|---|---|
| `--dry-run` | Show what would change; change nothing |
| `--tsconfig <path>` | tsconfig or jsconfig that selects the files to rewrite. Repeatable. Default: `./tsconfig.json`, else `./jsconfig.json`. With neither, all files are rewritten and aliases are not resolved |
| `--bulk-list <path>` | File with a list of moves, one `<from> <to>` per line. Lines starting with `#` are ignored |
| `--style <shortest\|keep>` | Import style. See above. Default: `shortest` |
| `--func <name>` | Also rewrite the path in the first argument of this function, e.g. `loadModule('./foo')`. `require`, `require.resolve`, `import()`, `import.meta.resolve`, `new URL(..., import.meta.url)`, `vi.*` and `jest.*` mocks are built in. Repeatable |
| `--include <path>` | Extra file or folder to rewrite that the tsconfig does not cover. Repeatable |
| `--root <dir>` | Where to look for `package.json` and config files. Default: working directory |
| `--workers <n>` | Worker threads. `1` disables. Default: chosen from the file count |
| `--verbose` | List every changed line |
| `--timing` | Show the time of each stage |
| `--json` | Print the result as JSON |
