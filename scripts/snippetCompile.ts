import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Compile TypeScript snippets (README blocks, recipe pages) in one program against the workspace packages' SOURCE, with no prior `tsc -b`.
// Shared by scripts/readme.test.ts and scripts/recipes.test.ts. Returns the diagnostics per snippet file name; a snippet that compiles has no entry.

const root = fileURLToPath(new URL('..', import.meta.url));

export function compileSnippets(files: ReadonlyArray<{ file: string; code: string }>, stubs: string): Map<string, string[]> {
  const dir = join(root, 'scripts', '__snippets__').replaceAll('\\', '/');
  const cfg = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  // The workspace packages resolve to their TypeScript source (the same map vitest.config.ts uses), so this check needs no
  // prior `tsc -b` and never reads a stale `dist`. Exact keys, so a subpath such as `/express` is not taken by the bare name.
  const src = (rel: string): string[] => [`packages/${rel}`];
  const options: ts.CompilerOptions = {
    ...parsed.options,
    pathsBasePath: root,
    paths: {
      '@chatwarden/core': src('core/src/index.ts'),
      '@chatwarden/store-sqlite': src('store-sqlite/src/index.ts'),
      '@chatwarden/store-memory': src('store-memory/src/index.ts'),
      '@chatwarden/store-memory/testing': src('store-memory/src/testing/index.ts'),
      '@chatwarden/matcher': src('matcher/src/index.ts'),
      '@chatwarden/matcher/corpus': src('matcher/src/corpus/index.ts'),
      '@chatwarden/matcher/corpus/node': src('matcher/src/corpus/node/index.ts'),
      '@chatwarden/matcher/fixtures': src('matcher/src/fixtures/index.ts'),
      '@chatwarden/matcher/test-fixtures': src('matcher/src/fixtures/testFixtures.ts'),
      '@chatwarden/profanity': src('profanity/src/index.ts'),
      '@chatwarden/discord': src('discord/src/index.ts'),
      '@chatwarden/http': src('http/src/index.ts'),
      '@chatwarden/http/admin': src('http/src/admin-entry.ts'),
      '@chatwarden/http/chat': src('http/src/chat/index.ts'),
      '@chatwarden/http/discord': src('http/src/discord/index.ts'),
      '@chatwarden/http/coop': src('http/src/coop/index.ts'),
      '@chatwarden/http/eos': src('http/src/eos/index.ts'),
      '@chatwarden/hub-element': src('hub-element/src/index.ts'),
      '@chatwarden/hub-element/standalone': src('hub-element/src/standalone.ts'),
      '@chatwarden/hub-react': src('hub-react/src/index.ts'),
      '@chatwarden/hub-react/headless': src('hub-react/src/headless/index.ts'),
      '@chatwarden/player-react': src('player-react/src/index.ts'),
      '@chatwarden/player-react/chat': src('player-react/src/chat/index.ts'),
      '@chatwarden/player-react/appeal': src('player-react/src/appeal/index.ts'),
      '@chatwarden/http/express': src('http/src/express.ts'),
      '@chatwarden/http/fetch': src('http/src/fetch.ts'),
      '@chatwarden/http/cli': src('http/src/cli/index.ts'),
    },
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
  };
  const virtual = new Map<string, string>();
  const stubsPath = `${dir}/stubs.d.ts`;
  virtual.set(stubsPath, stubs);
  const names: string[] = [stubsPath];
  for (const s of files) {
    const path = `${dir}/${s.file}`;
    virtual.set(path, `${s.code}\nexport {};\n`);
    names.push(path);
  }
  const host = ts.createCompilerHost(options);
  const realFile = host.fileExists.bind(host);
  const realRead = host.readFile.bind(host);
  const realSource = host.getSourceFile.bind(host);
  const norm = (f: string): string => f.replaceAll('\\', '/');
  host.fileExists = (f) => virtual.has(norm(f)) || realFile(f);
  host.readFile = (f) => virtual.get(norm(f)) ?? realRead(f);
  host.getSourceFile = (f, lang, onError, shouldCreate) => {
    const text = virtual.get(norm(f));
    return text === undefined ? realSource(f, lang, onError, shouldCreate) : ts.createSourceFile(f, text, lang, true);
  };
  const program = ts.createProgram({ rootNames: names, options, host });
  const byFile = new Map<string, string[]>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const file = d.file === undefined ? undefined : norm(d.file.fileName);
    if (file === undefined || !file.includes('/__snippets__/')) continue;
    const name = file.split('/').at(-1) as string;
    byFile.set(name, [...(byFile.get(name) ?? []), ts.flattenDiagnosticMessageText(d.messageText, '\n')]);
  }
  return byFile;
}