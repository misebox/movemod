# movemod

Move TS/JS files and folders, and rewrite the imports that point to them.

```sh
npx movemod src/components/Button src/components/ui/Button
```

Every file that refers to `Button` is updated, whether it uses a relative path, an alias, `vi.mock`, `import()` or `require`. The moved files are updated too. Add `--dry-run` to see the changes without making them:

```
$ npx movemod src/components/Button src/components/ui/Button --dry-run
root: . (nearest package.json)
tsconfig: tsconfig.json (aliases: @/*)
src/components/Button -> src/components/ui/Button

src/components/Card.tsx:1
- import { Button } from './Button';
+ import { Button } from './ui/Button';

src/pages/home/Hero.test.tsx:1
- vi.mock('@/components/Button');
+ vi.mock('@/components/ui/Button');

src/pages/home/Hero.tsx:1
- import { Button } from '@/components/Button';
+ import { Button } from '@/components/ui/Button';

Dry run: 3 files, 3 imports would change (7 files scanned). Nothing was written.
```

## What is rewritten

With no options, in TS/JS files (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`):

- Every import that points to a moved path, and the imports inside the moved files.
- Syntax: `import`, `export ... from`, `import()`, `require`, `require.resolve`, `import.meta.resolve`, `new URL(..., import.meta.url)`, `/// <reference path>`, and `vi` / `jest` mock functions (`vi.mock`, `jest.doMock`, ...).
- Paths: relative paths, tsconfig `paths` / `baseUrl` aliases, and workspace package subpaths (`@scope/pkg/src/x`).
- Style: see [Import style](#import-style). A package subpath stays a package subpath.

Not changed, but listed under [Check by hand](#check-by-hand): paths in strings, `package.json`, `tsconfig*.json`, `jsconfig*.json`, and other config files such as CI workflows.

Files that are not valid UTF-8 or have syntax errors are skipped with a `warning:` line.

With options:

- `--rewrite-config`: also rewrite the paths in `package.json`, `tsconfig*.json` and `jsconfig*.json` (`main`, `exports`, `paths`, `include`, `extends`, ...). A moved config file also gets its own relative paths fixed.
- `--func <name>`: also rewrite the first argument of your own function, e.g. `loadModule('./foo')`.
- `--include <path>`: also rewrite files that the tsconfig does not cover.

## Warnings

Any warning stops the run before anything is changed, and the exit code is 1. A dry run shows the warnings and exits with 1 too. Add `--force` to apply anyway.

## Import style

Imports that movemod rewrites follow one rule:

- Use a relative path when `./` works.
- When `../` is needed, use a tsconfig `paths` alias if it is shorter.

To apply the rule to a folder without moving anything:

```sh
npx movemod src
```

With `"paths": { "@/*": ["./src/*"] }`, in `src/a/b/c/file.ts`:

```ts
import { x } from './x';          // same folder: relative
import { y } from '../y';         // '@/a/b/y' is longer: relative
import { z } from '@/lib/z';      // '../../../lib/z' is longer: alias
```

- `--style keep`: keep each import's current style.
- `--style relative`: always relative; aliases are expanded. An alias is expanded only when its `paths` are found (see [tsconfig](#tsconfig)).

## Check by hand

Moved paths that movemod does not rewrite are listed under "Check by hand":

```
Check by hand: paths in strings that point to moved files (1)
  src/scripts/seed.ts:3  readFileSync('src/components/Button/data.json')

Check by hand: moved paths in config files (1)
  .github/workflows/ci.yml:8  - run: bun test src/components/Button
```

- Strings: a path inside a string that is not an import. Use `--func <name>` to rewrite the first argument of a function you name.
- Config files: a moved path in `package.json`, `tsconfig*.json`, `jsconfig*.json` (`--rewrite-config` rewrites these) or in a file such as a CI workflow (never rewritten).

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

## Project root

Detected from the paths you give. Override with `--root`.

From the folder that holds each path, go up and stop at the first match:

1. `package.json`, `deno.json`, `deno.jsonc` or `jsr.json`
2. `.git`, `.hg` or `.svn` (never goes above it)
3. `tsconfig.json` or `jsconfig.json`
4. None: the folder shared by the paths

It never goes above the home folder. The root is printed first:

```
root: apps/web (nearest package.json)
```

Paths in different packages or projects stop with an error. If one workspaces root contains them (`"workspaces"` in `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json` or `rush.json`), the error gives the `--root`:

```
They are in the workspaces root /r. Set --root /r to move between packages.
```

A move inside one package does not update sibling packages that import it by name (`@scope/pkg/src/x`). Pass `--root <monorepo root>` to include them.

## tsconfig

Detected from the paths you give. Override with `--tsconfig`.

From each path, go up to the root and use the first folder that has `tsconfig.json`, else `tsconfig.*.json`, else `jsconfig.json`. `references` are followed. With none, all files are rewritten and aliases are not resolved.

Every tsconfig that was read is printed after `root:`, with its `paths` keys (`baseUrl` if it sets one). `extends` is followed. `aliases: none` means no alias is applied:

```
tsconfig: apps/web/tsconfig.json (aliases: none)
tsconfig: apps/web/tsconfig.app.json (referenced; aliases: @/*)
```

## Options

| Option | Description |
|---|---|
| `--dry-run` | Show what would change; change nothing |
| `--tsconfig <path>` | tsconfig or jsconfig that selects the files to rewrite. Repeatable. Default: detected (see above) |
| `--bulk-list <path>` | File with a list of moves, one `<from> <to>` per line. Lines starting with `#` are ignored |
| `--style <shortest\|keep\|relative>` | Import style. See above. Default: `shortest` |
| `--func <name>` | Also rewrite the path in the first argument of this function, e.g. `loadModule('./foo')`. `require`, `require.resolve`, `import()`, `import.meta.resolve`, `new URL(..., import.meta.url)`, `vi.*` and `jest.*` mocks are built in. Repeatable |
| `--include <path>` | Extra file or folder to rewrite that the tsconfig does not cover. Repeatable |
| `--root <dir>` | Project root: where to look for `package.json` and config files. Moving a path outside it is an error. Default: detected (see above) |
| `--workers <n>` | Worker threads. `1` disables. Default: chosen from the file count |
| `--verbose` | List every changed line |
| `--timing` | Show the time of each stage |
| `--json` | Print the result as JSON |
| `--rewrite-config` | Also rewrite paths in `package.json`, `tsconfig*.json` and `jsconfig*.json`. Without it they are only reported |
| `--force` | Apply even with warnings. Without it, warnings stop the run before any change |

## Release

For maintainers. CI publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) when a `v*` tag is pushed.

1. Bump `version` in `package.json` and commit.
2. `bun run release`: on `main` with a clean tree, runs the tests and the build, then creates the tag `v<version>`.
3. `git push --follow-tags`

One-time setup on npmjs.com: add a Trusted Publisher for this package (repository `misebox/movemod`, workflow `release.yml`).
