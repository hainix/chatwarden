import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The export names of an entry point, read from its source by the TypeScript checker, so a type-only export counts too.

/** The repository root, found from this file (not from where the tests were started). */
export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The entry points that are locked. */
export const ENTRIES = ['packages/hub-react/src/index.ts', 'packages/hub-react/src/headless/index.ts', 'packages/player-react/src/index.ts'] as const;

export interface Names {
  values: string[];
  types: string[];
  /** The names whose TSDoc says `@experimental`: they may change before 0.2. */
  experimental: string[];
  /** The `@experimental` members of the exports (`HubController.configure`), as `Export.member`. */
  experimentalMembers: string[];
}

// One program for all of them, built once: reading each entry's exports is then a lookup, not a compile.
let built: { program: ts.Program; checker: ts.TypeChecker } | undefined;
function build(): { program: ts.Program; checker: ts.TypeChecker } {
  if (built !== undefined) return built;
  const cfg = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const src = (rel: string): string[] => [`packages/${rel}`];
  const options: ts.CompilerOptions = {
    ...parsed.options,
    pathsBasePath: root,
    paths: {
      '@chatwarden/core': src('core/src/index.ts'),
      '@chatwarden/http': src('http/src/index.ts'),
      '@chatwarden/http/admin': src('http/src/admin-entry.ts'),
      '@chatwarden/matcher': src('matcher/src/index.ts'),
    },
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
  };
  const program = ts.createProgram({ rootNames: ENTRIES.map((e) => join(root, e)), options });
  built = { program, checker: program.getTypeChecker() };
  return built;
}

export function exportsOf(entry: string): Names {
  const file = join(root, entry);
  const { program, checker } = build();
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`no source for ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${entry} exports nothing`);
  const values: string[] = [];
  const types: string[] = [];
  const experimental: string[] = [];
  const experimentalMembers: string[] = [];
  const marked = (symbol: ts.Symbol): boolean => symbol.getJsDocTags(checker).some((tag) => tag.name === 'experimental');
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const real = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    if ((real.flags & ts.SymbolFlags.Value) !== 0) values.push(exported.name);
    else types.push(exported.name);
    if (marked(real)) experimental.push(exported.name);
    for (const [name, member] of real.members ?? []) if (marked(member)) experimentalMembers.push(`${exported.name}.${String(name)}`);
  }
  return { values: values.sort(), types: types.sort(), experimental: experimental.sort(), experimentalMembers: experimentalMembers.sort() };
}
