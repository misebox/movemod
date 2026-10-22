# movemod

Move TS/JS files and folders, and rewrite the imports that point to them.

```sh
npx movemod src/components/Button src/ui/Button
```

Every file that refers to `Button` is updated, whether it uses a relative path, an alias, `vi.mock`, `import()` or `require`. The moved files are updated too. Add `--dry-run` to see the changes without making them:

```
$ npx movemod src/components/Button src/ui/Button --dry-run
root: . (nearest package.json)
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

## What is rewritten

- `import`, `export ... from`, `import()`, `require`, `require.resolve`, `import.meta.resolve`, `new URL(..., import.meta.url)`, `/// <reference path>`, and `vi.mock` / `jest.mock` calls.
- Relative paths, tsconfig `paths` and `baseUrl` aliases, and workspace package names (`@scope/pkg/src/x`).
- Paths in `package.json` and `tsconfig*.json`.

Files that are not valid UTF-8 or have syntax errors are skipped with a `warning:` line. With `--strict`, warnings stop the run before anything is changed and exit with 1.

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

## Project root and tsconfig

Both are detected from the paths you give. Use `--root` and `--tsconfig` only to override.

Root: for each path, start at the folder that holds it, go up, and stop at the first folder that matches (priority order):

1. A folder with `package.json`, `deno.json`, `deno.jsonc` or `jsr.json`
2. A folder with `.git`, `.hg` or `.svn` (the repository boundary: it never goes above it)
3. A folder with `tsconfig.json` or `jsconfig.json`
4. None of the above: the folder that contains all the paths

If the paths give different roots (a move between packages or projects), movemod stops with an error. When a workspaces root (`"workspaces"` in `package.json`, or `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, `rush.json`) contains them, the error names it:

```
They are in the workspaces root /r. Set --root /r to move between packages.
```

A move inside one package does not look above that package. Sibling packages that import it by name (`@scope/pkg/src/x`) are not updated; pass `--root <monorepo root>` to include them.

It never goes up into the home folder. The chosen root and the rule are printed first:

```
root: apps/web (nearest package.json)
```

tsconfig: from each path, go up to the root and use the first folder that has one. In that folder, the order is `tsconfig.json`, `tsconfig.*.json`, `jsconfig.json`. `references` are followed. With none, all files are rewritten and aliases are not resolved.

## Options

| Option | Description |
|---|---|
| `--dry-run` | Show what would change; change nothing |
| `--tsconfig <path>` | tsconfig or jsconfig that selects the files to rewrite. Repeatable. Default: detected (see above) |
| `--bulk-list <path>` | File with a list of moves, one `<from> <to>` per line. Lines starting with `#` are ignored |
| `--style <shortest\|keep>` | Import style. See above. Default: `shortest` |
| `--func <name>` | Also rewrite the path in the first argument of this function, e.g. `loadModule('./foo')`. `require`, `require.resolve`, `import()`, `import.meta.resolve`, `new URL(..., import.meta.url)`, `vi.*` and `jest.*` mocks are built in. Repeatable |
| `--include <path>` | Extra file or folder to rewrite that the tsconfig does not cover. Repeatable |
| `--root <dir>` | Project root: where to look for `package.json` and config files. Moving a path outside it is an error. Default: detected (see above) |
| `--workers <n>` | Worker threads. `1` disables. Default: chosen from the file count |
| `--verbose` | List every changed line |
| `--timing` | Show the time of each stage |
| `--json` | Print the result as JSON |
| `--strict` | With warnings (skipped files, unresolved imports): change nothing and exit with 1 |
