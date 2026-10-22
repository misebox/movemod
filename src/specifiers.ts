import { parseSync } from 'oxc-parser';

// text is the string inside the quotes. start and end are also the range inside the quotes
// relativeOnly is a form that cannot be an alias or package name and is always read as a path relative to the file
export type Specifier = { text: string; start: number; end: number; relativeOnly?: boolean };

// syntaxError is the message and line of the first error the parser reported
export type Collected = { specifiers: Specifier[]; syntaxError?: string };

// Functions whose first argument is treated as a module specifier
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

// Detect files likely to contain forms that module info alone (no AST) cannot capture
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

// start and end include the quotes
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
    add({ text, start, end: start + text.length, relativeOnly: true });
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
          add({ ...first, relativeOnly: true });
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
