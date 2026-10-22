import { dirname, relative, resolve } from 'node:path/posix';
import type { FsIndex } from './fsIndex.ts';
import type { Packages } from './packages.ts';
import { resolveAlias, resolvePath, specifierTarget, type Resolved } from './resolve.ts';
import { buildAstTrigger, collectSpecifiers } from './specifiers.ts';
import { chooseSpecifier, isRelative, type Origin, type Style } from './style.ts';
import { findSuspects, type Suspect } from './suspects.ts';
import type { Alias } from './tsconfig.ts';

// line / before / after は、RewriterOptions の detail が true のときだけ入る
export type Change = {
  file: string;
  from: string;
  to: string;
  line?: number;
  before?: string;
  after?: string;
};

export type FileResult = {
  text?: string;
  changes: Change[];
  suspects: Suspect[];
  warnings: string[];
};

type Target = { resolved: Resolved; origin: Origin };

// tsconfig ごとの状態。指定子の解決結果は、同じ指定子なら 1 回だけ求める
export type ProjectContext = {
  aliases: Alias[];
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
  // 移動が無くても、すべての指定子を書き方の規則に合わせて書き直す
  realign: boolean;
  suspects: boolean;
  // 変更ごとに、行番号と書き換え前後の行を求める
  detail: boolean;
};

const escapeRegExp = (text: string) => text.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');

// 相対パスか alias かパッケージ名で始まる文字列が無いファイルは、パースしない
export const createProjectContext = (
  aliases: Alias[],
  packageNames: string[],
): ProjectContext => {
  const heads = [
    '\\.{1,2}(?:\\/|[\'"`])',
    ...aliases.map((alias) => escapeRegExp(alias.prefix)).filter((head) => head !== ''),
    ...packageNames.map(escapeRegExp),
  ];
  return {
    aliases,
    prefilter: new RegExp(`['"\`](?:${heads.join('|')})`),
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

// 後ろの置換から適用して、前の置換の位置がずれないようにする
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
  ): Target | undefined => {
    const relativeText = isRelative(text);
    const key = relativeText ? `${dir}\0${text}` : text;
    const cached = project.cache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    let target: Target | undefined;
    if (relativeText) {
      const resolved = resolvePath(fs, resolve(dir, text));
      if (resolved) target = { resolved, origin: 'relative' };
    } else {
      const aliased = resolveAlias(fs, project.aliases, text);
      if (aliased) {
        target = { resolved: aliased, origin: 'alias' };
      } else {
        const packaged = resolvePackage(text);
        if (packaged) target = { resolved: packaged, origin: 'package' };
      }
    }
    project.cache.set(key, target ?? null);
    return target;
  };

  const isAliasOrPackage = (project: ProjectContext, text: string) =>
    project.aliases.some((alias) => alias.prefix !== '' && text.startsWith(alias.prefix)) ||
    packages.names.some((name) => text.startsWith(`${name}/`));

  // ワークスペース内のパッケージ名で書かれた、パッケージの中身への指定子
  const resolvePackage = (text: string): Resolved | undefined => {
    const parts = text.split('/');
    const nameLength = text.startsWith('@') ? 2 : 1;
    if (parts.length <= nameLength) return undefined;
    const pkg = packages.byName.get(parts.slice(0, nameLength).join('/'));
    if (!pkg) return undefined;
    return resolvePath(fs, `${pkg.dir}/${parts.slice(nameLength).join('/')}`);
  };

  const nextSpecifier = (
    project: ProjectContext,
    file: string,
    newPath: string,
    { resolved, origin }: Target,
  ): string => {
    const targetNew = map(resolved.file);
    const target = specifierTarget(resolved, targetNew);

    const importerBefore = packages.nearestBefore(file);
    const importerAfter = packages.nearestAfter(newPath);
    const targetPackage = packages.nearestAfter(targetNew);
    const crossesPackages =
      importerAfter !== undefined &&
      targetPackage !== undefined &&
      importerAfter !== targetPackage;
    const importerPackageChanged = importerBefore !== importerAfter;
    if (crossesPackages && (origin === 'package' || importerPackageChanged)) {
      const inside = relative(packages.dirAfter(targetPackage), target);
      return inside === '' ? targetPackage.name : `${targetPackage.name}/${inside}`;
    }

    return chooseSpecifier({
      style,
      origin,
      aliases: project.aliases,
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
        return result;
      }

      for (const specifier of specifiers) {
        known.add(specifier.start);
        const target = resolveSpecifier(project, dir, specifier.text);
        if (!target) {
          if (isRelative(specifier.text)) {
            const base = resolve(dir, specifier.text);
            if (fileMoved || map(base) !== base) {
              result.warnings.push(`${file}: cannot resolve: ${specifier.text}`);
            }
          } else if (!realign && isAliasOrPackage(project, specifier.text)) {
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

        const next = nextSpecifier(project, file, newPath, target);
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
