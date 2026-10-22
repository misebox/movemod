import { dirname, relative, resolve } from 'node:path/posix';
import type { FsIndex } from './fsIndex.ts';
import type { Packages } from './packages.ts';
import { aliasCandidates, resolveAlias, resolvePath, specifierTarget, type Resolved } from './resolve.ts';
import { buildAstTrigger, collectSpecifiers } from './specifiers.ts';
import { chooseSpecifier, isRelative, relativeSpecifier, type Origin, type Style } from './style.ts';
import { findSuspects, type Suspect } from './suspects.ts';
import type { Alias } from './tsconfig.ts';

// line / before / after are set only when RewriterOptions detail is true
export type Change = {
  file: string;
  from: string;
  to: string;
  line?: number;
  before?: string;
  after?: string;
};

export type FileResult = {
  // This file was left unchanged because of a syntax error etc.
  skipped?: boolean;
  text?: string;
  changes: Change[];
  suspects: Suspect[];
  warnings: string[];
};

// implicit is set when the target is named in the baseUrl form ('components/Button')
type Target = { resolved: Resolved; origin: Origin; implicit?: boolean };

// State per tsconfig. A specifier's resolution is computed only once per identical specifier
export type ProjectContext = {
  // Aliases from paths, and implicit aliases derived from baseUrl
  aliases: Alias[];
  implicitAliases: Alias[];
  prefilter: RegExp;
  cache: Map<string, Target | null>;
};

type Replacement = { start: number; end: number; text: string };

export type RewriterOptions = {
  fs: FsIndex;
  map: (path: string) => string;
  packages: Packages;
  style: Style;
  calls: string[];
  root: string;
  // Rewrites every specifier to match the style rule, even without moves
  realign: boolean;
  suspects: boolean;
  // Compute the line number and the lines before and after for each change
  detail: boolean;
};

const escapeRegExp = (text: string) => text.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');

// Files with no string starting with a relative path, alias, or package name are not parsed
// For an alias with an empty prefix ("*" or baseUrl), only strings starting with a file or folder name in the target folder are checked
const entryHeads = (fs: FsIndex, alias: Alias): string[] =>
  alias.targets
    .filter((target) => target.wildcard && target.prefix.endsWith('/'))
    .flatMap((target) => [...fs.entries(target.prefix.slice(0, -1)).keys()])
    .map((name) => escapeRegExp(name.replace(/\.[^.]+$/, '')))
    .filter((head) => head !== '');

export const createProjectContext = (
  all: Alias[],
  packageNames: string[],
  fs: FsIndex,
): ProjectContext => {
  const heads = [
    '\\.{1,2}(?:\\/|[\'"`])',
    ...all.map((alias) => escapeRegExp(alias.prefix)).filter((head) => head !== ''),
    ...all.filter((alias) => alias.prefix === '').flatMap((alias) => entryHeads(fs, alias)),
    ...packageNames.map(escapeRegExp),
  ];
  return {
    aliases: all.filter((alias) => !alias.implicit),
    implicitAliases: all.filter((alias) => alias.implicit),
    prefilter: new RegExp(`['"\`](?:${heads.join('|')})|///\\s*<reference\\s+path`),
    cache: new Map(),
  };
};

const describeLine = (source: string, start: number, end: number, text: string) => {
  let line = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < start; i = source.indexOf('\n', i + 1)) {
    line++;
  }
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const lineEndAt = source.indexOf('\n', end);
  const lineEnd = lineEndAt === -1 ? source.length : lineEndAt;
  return {
    line,
    before: source.slice(lineStart, lineEnd).trim(),
    after: (source.slice(lineStart, start) + text + source.slice(end, lineEnd)).trim(),
  };
};

// Apply replacements from the end so earlier positions do not shift
const applyReplacements = (source: string, replacements: Replacement[]): string => {
  let result = source;
  for (const { start, end, text } of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
};

export const createRewriter = (options: RewriterOptions) => {
  const { fs, map, packages, style, root, realign } = options;
  const trigger = buildAstTrigger(options.calls);

  const resolveSpecifier = (
    project: ProjectContext,
    dir: string,
    text: string,
    forceRelative: boolean,
  ): Target | undefined => {
    const relativeText = forceRelative || isRelative(text);
    const key = relativeText ? `${dir}\0${text}` : text;
    const cached = project.cache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    let target: Target | undefined;
    if (relativeText) {
      const resolved = resolvePath(fs, resolve(dir, text));
      if (resolved) target = { resolved, origin: 'relative' };
    } else {
      const aliased = resolveAlias(fs, project.aliases, text);
      const bare = aliased ? undefined : resolveAlias(fs, project.implicitAliases, text);
      if (aliased) {
        target = { resolved: aliased, origin: 'alias' };
      } else if (bare) {
        target = { resolved: bare, origin: 'alias', implicit: true };
      } else {
        const packaged = resolvePackage(text);
        if (packaged) target = { resolved: packaged, origin: 'package' };
      }
    }
    project.cache.set(key, target ?? null);
    return target;
  };

  // Unresolved alias or package-name specifiers whose target is inside a moved path.
  // No warning for things unrelated to moves, such as subpaths published via exports or build outputs that do not exist yet
  const pointsIntoMovedPath = (project: ProjectContext, text: string) => {
    const candidates = [
      ...aliasCandidates([...project.aliases, ...project.implicitAliases], text),
      ...packageSubpath(text),
    ];
    return candidates.some((base) => map(base) !== base);
  };

  // Path into a package's contents, written with a workspace package name
  const packageSubpath = (text: string): string[] => {
    const parts = text.split('/');
    const nameLength = text.startsWith('@') ? 2 : 1;
    if (parts.length <= nameLength) return [];
    const pkg = packages.byName.get(parts.slice(0, nameLength).join('/'));
    return pkg ? [`${pkg.dir}/${parts.slice(nameLength).join('/')}`] : [];
  };

  const resolvePackage = (text: string): Resolved | undefined => {
    const [base] = packageSubpath(text);
    return base === undefined ? undefined : resolvePath(fs, base);
  };

  // Use a relative path, not an alias or package name, keeping the original form (with or without ./)
  const relativeOnlySpecifier = (
    original: string,
    newPath: string,
    resolved: Resolved,
    mapPath: (path: string) => string,
  ): string => {
    const text = relativeSpecifier(dirname(newPath), specifierTarget(resolved, mapPath(resolved.file)));
    return isRelative(original) || text.startsWith('../') ? text : text.replace(/^\.\//, '');
  };

  const nextSpecifier = (
    project: ProjectContext,
    file: string,
    newPath: string,
    { resolved, origin, implicit }: Target,
  ): string => {
    const targetNew = map(resolved.file);
    const target = specifierTarget(resolved, targetNew);

    const importerBefore = packages.nearestBefore(file);
    const importerAfter = packages.nearestAfter(newPath);
    const targetPackage = packages.nearestAfter(targetNew);
    const importerPackageChanged = importerAfter !== undefined && importerBefore !== importerAfter;
    if (
      targetPackage !== undefined &&
      importerAfter !== targetPackage &&
      (origin === 'package' || importerPackageChanged)
    ) {
      const inside = relative(packages.dirAfter(targetPackage), target);
      return inside === '' ? targetPackage.name : `${targetPackage.name}/${inside}`;
    }

    return chooseSpecifier({
      style,
      origin,
      aliases: implicit ? [...project.aliases, ...project.implicitAliases] : project.aliases,
      fromDir: dirname(newPath),
      target,
    });
  };

  return (file: string, source: string, project: ProjectContext): FileResult | undefined => {
    const newPath = map(file);
    const fileMoved = newPath !== file;
    const dir = dirname(file);
    const result: FileResult = { changes: [], suspects: [], warnings: [] };
    const replacements: Replacement[] = [];
    const known = new Set<number>();

    if (project.prefilter.test(source)) {
      const { specifiers, syntaxError } = collectSpecifiers(
        file,
        source,
        trigger,
        options.calls,
      );
      if (syntaxError) {
        result.warnings.push(`${file}: skipped, syntax error: ${syntaxError}`);
        result.skipped = true;
        return result;
      }

      for (const specifier of specifiers) {
        known.add(specifier.start);
        const relativeOnly = specifier.relativeOnly === true;
        const target = resolveSpecifier(project, dir, specifier.text, relativeOnly);
        if (!target) {
          if (relativeOnly || isRelative(specifier.text)) {
            const base = resolve(dir, specifier.text);
            if (fileMoved || map(base) !== base) {
              result.warnings.push(`${file}: cannot resolve: ${specifier.text}`);
            }
          } else if (!realign && pointsIntoMovedPath(project, specifier.text)) {
            result.warnings.push(`${file}: cannot resolve: ${specifier.text}`);
          }
          continue;
        }

        const targetMoved = map(target.resolved.file) !== target.resolved.file;
        const affected =
          target.origin === 'relative'
            ? fileMoved || targetMoved
            : targetMoved || (fileMoved && target.origin === 'package');
        if (!realign && !affected) continue;

        const next = relativeOnly
          ? relativeOnlySpecifier(specifier.text, newPath, target.resolved, map)
          : nextSpecifier(project, file, newPath, target);
        if (next === specifier.text) continue;
        replacements.push({ start: specifier.start, end: specifier.end, text: next });
        result.changes.push({
          file,
          from: specifier.text,
          to: next,
          ...(options.detail && describeLine(source, specifier.start, specifier.end, next)),
        });
      }
    }

    if (options.suspects) {
      result.suspects = findSuspects({ file, source, known, fileMoved, root, fs, map });
    }
    if (replacements.length > 0) result.text = applyReplacements(source, replacements);

    const hasResult =
      result.text !== undefined || result.suspects.length > 0 || result.warnings.length > 0;
    return hasResult ? result : undefined;
  };
};
