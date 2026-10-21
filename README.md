# tsmv

Move TS/JS files and folders, and rewrite the imports that point to them.

```sh
npx tsmv src/components/Button src/ui/Button
```

Every file that refers to `Button` is updated, whether it uses a relative path, an alias, `vi.mock`, `import()` or `require`. The moved files are updated too. Add `--dry-run` to see the changes without making them:

```
$ npx tsmv src/components/Button src/ui/Button --dry-run
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

Check by hand: paths in strings that are not imports (1)
  src/scripts/seed.ts:3  'src/components/Button/data.json'  (relative to the working directory; points to a moved path)

Check by hand: moved paths in config files (1)
  .github/workflows/ci.yml:8  - run: bun test src/components/Button

Dry run: 5 files, 6 imports would change (7 files scanned). Nothing was written.
```

Paths that tsmv cannot rewrite safely are listed under "Check by hand".

Normalize the import style inside a folder:

```sh
npx tsmv src
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

## Options

| Option | Description |
|---|---|
| `--dry-run` | Show what would change; change nothing |
| `--tsconfig <path>` | tsconfig that selects the files to rewrite. Default: `./tsconfig.json` |
| `--bulk-list <path>` | File with a list of moves, one `<from> <to>` per line. Lines starting with `#` are ignored |
| `--call <name>` | Function whose first argument is a module path (`vi.mock` and `jest.mock` are built in) |
