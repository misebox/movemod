import { parseSync } from 'oxc-parser';

// text は、クォートの内側の文字列。start と end も、クォートの内側の範囲
export type Specifier = { text: string; start: number; end: number };

// syntaxError は、パーサーが最初に報告したエラーの内容と行
export type Collected = { specifiers: Specifier[]; syntaxError?: string };

// 第 1 引数をモジュール指定子として扱う関数
export const DEFAULT_CALLS = [
  'vi.mock',
  'vi.doMock',
  'vi.unmock',
  'vi.importActual',
  'vi.importMock',
  'jest.mock',
  'jest.doMock',
  'jest.unmock',
  'jest.requireActual',
  'jest.requireMock',
];

const MODULE_PATH_CALLS = ['require.resolve', 'import.meta.resolve'];

type AstNode = { type?: string; start?: number; end?: number; [key: string]: unknown };

const escapeRegExp = (text: string) => text.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');

// module 情報（AST を作らない）だけでは取れない書き方を含みそうなファイルを見分ける
export const buildAstTrigger = (calls: string[]): RegExp =>
  new RegExp(
    [
      '\\brequire\\b',
      'import\\.meta\\.resolve',
      'new\\s+URL\\b',
      ...calls.map(escapeRegExp),
    ].join('|'),
  );

const IMPORT_CALL = /\bimport\s*\(/g;

const countImportCalls = (source: string) => source.match(IMPORT_CALL)?.length ?? 0;

const REFERENCE_PATH = /^\/\/\/\s*<reference\s+path=(["'])(.*?)\1/gm;

// start と end は、クォートを含む範囲
const quoted = (source: string, start: number, end: number): Specifier | undefined => {
  const open = source[start];
  if (open !== '"' && open !== "'" && open !== '`') return undefined;
  const text = source.slice(start + 1, end - 1);
  if (open === '`' && text.includes('${')) return undefined;
  return { text, start: start + 1, end: end - 1 };
};

const collectReferences = (source: string, add: (specifier: Specifier | undefined) => void) => {
  if (!source.includes('/// <reference')) return;
  for (const match of source.matchAll(REFERENCE_PATH)) {
    const text = match[2];
    const start = match.index + match[0].lastIndexOf(text);
    add({ text, start, end: start + text.length });
  }
};

const asNode = (value: unknown): AstNode | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;

export const collectSpecifiers = (
  file: string,
  source: string,
  trigger: RegExp,
  calls: string[],
): Collected => {
  const result = parseSync(file, source);
  const firstError = result.errors[0];
  if (firstError) {
    const offset = firstError.labels[0]?.start ?? 0;
    const line = source.slice(0, offset).split('\n').length;
    return { specifiers: [], syntaxError: `${firstError.message} (line ${line})` };
  }
  const specifiers: Specifier[] = [];
  const seen = new Set<number>();

  const add = (specifier: Specifier | undefined) => {
    if (!specifier || seen.has(specifier.start)) return;
    seen.add(specifier.start);
    specifiers.push(specifier);
  };
  const addRange = (range: { start: number; end: number }) =>
    add(quoted(source, range.start, range.end));

  collectReferences(source, add);

  const module = result.module;
  const needsAst =
    trigger.test(source) || countImportCalls(source) !== module.dynamicImports.length;

  if (!needsAst) {
    for (const item of module.staticImports) addRange(item.moduleRequest);
    for (const item of module.staticExports) {
      for (const entry of item.entries) {
        if (entry.moduleRequest) addRange(entry.moduleRequest);
      }
    }
    for (const item of module.dynamicImports) addRange(item.moduleRequest);
    return { specifiers };
  }

  const calleeNames = new Set([...MODULE_PATH_CALLS, ...calls]);
  const stringOf = (value: unknown): Specifier | undefined => {
    const node = asNode(value);
    if (!node || node.start === undefined || node.end === undefined) return undefined;
    const isString = node.type === 'Literal' && typeof node.value === 'string';
    const isPlainTemplate =
      node.type === 'TemplateLiteral' &&
      Array.isArray(node.expressions) &&
      node.expressions.length === 0;
    return isString || isPlainTemplate ? quoted(source, node.start, node.end) : undefined;
  };
  const textOf = (value: unknown) => {
    const node = asNode(value);
    return node?.start === undefined || node.end === undefined
      ? ''
      : source.slice(node.start, node.end).replace(/\s+/g, '');
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = asNode(value);
    if (!node) return;

    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
      case 'TSImportType':
        add(stringOf(node.source));
        break;
      case 'TSExternalModuleReference':
        add(stringOf(node.expression));
        break;
      case 'CallExpression': {
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const callee = textOf(node.callee);
        if (callee === 'require' || calleeNames.has(callee)) add(stringOf(args[0]));
        break;
      }
      case 'NewExpression': {
        const args = Array.isArray(node.arguments) ? node.arguments : [];
        const first = stringOf(args[0]);
        if (
          textOf(node.callee) === 'URL' &&
          textOf(args[1]) === 'import.meta.url' &&
          first?.text.startsWith('.')
        ) {
          add(first);
        }
        break;
      }
    }
    for (const key in node) {
      const child = node[key];
      if (typeof child === 'object' && child !== null) visit(child);
    }
  };

  visit(result.program);
  return { specifiers };
};
