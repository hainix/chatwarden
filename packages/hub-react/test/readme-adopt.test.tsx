import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import * as React from 'react';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import * as hub from '../src/index.js';
import { exportsOf } from './apiNames.js';
import { hubWorld } from './world.js';

// The README's "Three ways to adopt" is the product an adopter copies from, so its snippets are compiled against the real sources
// and RUN, as written, on the real routes (as the headless example is). Only the imports are swapped for the test's own.

const root = process.cwd();
const readme = readFileSync(join(root, 'packages', 'hub-react', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const start = readme.indexOf('\n## Three ways to adopt\n');
const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
const snippets = [...section.matchAll(/```tsx\n([\s\S]*?)```/g)].map((m) => m[1] as string);

describe('the section', () => {
  it('has three ways, the chill one first and shortest, then pieces, then the hooks and the controller', () => {
    expect(start).toBeGreaterThan(0);
    const ways = [...section.matchAll(/\n### (\d)\. (.*)\n/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(ways).toEqual(['1 Drop in `<Hub>`', '2 Pieces in your own dashboard', '3 Headless hooks, or the controller']);
    expect(snippets).toHaveLength(3);
    expect(snippets[0]?.split('\n').length).toBeLessThan((snippets[1] as string).split('\n').length);
    expect(snippets[0]?.split('\n').length).toBeLessThan(8);
  });

  it('says React is optional only for /headless, and lists the experimental names', () => {
    expect(section).toMatch(/optional peer dependencies of this package for one reason only: the `\/headless` entry needs no React/);
    expect(section).toMatch(/### Experimental until 0\.2/);
  });

  it('lists exactly the names the API lock marks @experimental', () => {
    const list = section.slice(section.indexOf('### Experimental until 0.2'));
    const named = new Set([...list.matchAll(/`([A-Za-z*][A-Za-z.*]*)`/g)].map((m) => m[1] as string));
    const marked = exportsOf('packages/hub-react/src/index.ts').experimental;
    const wildcard = [...named].filter((n) => n.startsWith('*'));
    // `*Props` stands for each piece's props type; everything else is named.
    const ownProps = marked.filter((n) => /^(AuditLog|BlockedList|CaseCard|CaseList|CaseWorkbench|Guide|LadderSettings|PersonRecord|RecentActions|RuleGaps|TermsManager)Props$/.test(n));
    expect(wildcard.length).toBe(1);
    expect(ownProps).toHaveLength(11);
    for (const name of marked.filter((n) => !ownProps.includes(n))) expect(named, name).toContain(name);
    const headless = exportsOf('packages/hub-react/src/headless/index.ts');
    for (const name of [...headless.experimental, ...headless.experimentalMembers]) expect(named, name).toContain(name);
  });
});

/** Compiles the snippets against the package sources, with the adopter's own `./client` stubbed. */
function diagnostics(extra: Array<[string, string]> = []): Map<string, string[]> {
  const dir = join(root, 'packages', 'hub-react', '__snippets__').replaceAll('\\', '/');
  const cfg = ts.readConfigFile(join(root, 'tsconfig.base.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const src = (rel: string): string[] => [`packages/${rel}`];
  const options: ts.CompilerOptions = {
    ...parsed.options,
    pathsBasePath: root,
    paths: {
      '@chatwarden/core': src('core/src/index.ts'),
      '@chatwarden/http': src('http/src/index.ts'),
      '@chatwarden/hub-react': src('hub-react/src/index.ts'),
      '@chatwarden/hub-react/headless': src('hub-react/src/headless/index.ts'),
    },
    // An adopter's React app is bundled (Vite, webpack): `./client` needs no extension there.
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
  };
  const virtual = new Map<string, string>();
  virtual.set(`${dir}/client.ts`, "import type { HubClient } from '@chatwarden/hub-react';\nexport declare const client: HubClient;\n");
  virtual.set(`${dir}/css.d.ts`, "declare module '*.css';\n");
  const names = [`${dir}/css.d.ts`];
  const all: Array<[string, string]> = [...snippets.map((code, i): [string, string] => [`snippet-${i}.tsx`, code]), ...extra];
  for (const [file, code] of all) {
    virtual.set(`${dir}/${file}`, `${code}\nexport {};\n`);
    names.push(`${dir}/${file}`);
  }
  const host = ts.createCompilerHost(options);
  const norm = (f: string): string => f.replaceAll('\\', '/');
  const realFile = host.fileExists.bind(host);
  const realRead = host.readFile.bind(host);
  const realSource = host.getSourceFile.bind(host);
  const realDirectory = host.directoryExists?.bind(host);
  host.fileExists = (f) => virtual.has(norm(f)) || realFile(f);
  host.directoryExists = (d) => [...virtual.keys()].some((k) => k.startsWith(`${norm(d)}/`)) || realDirectory?.(d) === true;
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

describe('the snippets compile', () => {
  it('all three compile against the package sources, and a deliberate error is caught (control)', { timeout: 120_000 }, () => {
    const found = diagnostics([['control.tsx', "const n: number = 'not a number';"]]);
    expect(found.get('control.tsx')?.[0]).toContain("Type 'string' is not assignable to type 'number'");
    found.delete('control.tsx');
    expect(JSON.stringify(Object.fromEntries(found), null, 1)).toBe('{}');
  });

  it('a wrong prop in a snippet would be caught: the XOR of client and controller holds in the compiler too (control)', { timeout: 120_000 }, () => {
    const found = diagnostics([
      ['xor.tsx', "import { HubProvider } from '@chatwarden/hub-react';\nimport { client } from './client';\nexport const x = <HubProvider client={client} controller={undefined as never}>{null}</HubProvider>;\nexport const y = <HubProvider>{null}</HubProvider>;"],
    ]);
    expect(found.get('xor.tsx')?.length).toBeGreaterThanOrEqual(1);
  });
});

type Module = Record<string, unknown>;

/** Runs a snippet's module with the imports it names swapped for the test's own, and returns what it exports. */
async function load(code: string, client: unknown): Promise<Module> {
  // esbuild's transform does not run under jsdom, so the compiler that checked the snippet also turns it into code.
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: 'snippet.tsx' }).outputText;
  const modules: Record<string, Module> = {
    '@chatwarden/hub-react': hub as unknown as Module,
    '@chatwarden/hub-react/styles.css': {},
    react: React as unknown as Module,
    'react/jsx-runtime': (await import('react/jsx-runtime')) as unknown as Module,
    './client': { client },
  };
  const exports: Module = {};
  const run = new Function('require', 'exports', 'module', js);
  run(
    (name: string) => {
      const found = modules[name];
      if (found === undefined) throw new Error(`the snippet imports ${name}, which the test does not provide`);
      return found;
    },
    exports,
    { exports },
  );
  return exports;
}

describe('the snippets run on the real routes', () => {
  beforeAll(() => {
    window.location.hash = '';
  });

  it('1. drop in <Hub>: the hub comes up with the open cases', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const { ModeratorPage } = (await load(snippets[0] as string, w.client)) as { ModeratorPage: React.ComponentType };
    render(<ModeratorPage />);
    const queue = await screen.findByRole('region', { name: 'Open cases' });
    await within(queue).findByText('Alpha');
  });

  it('2. pieces: choosing a case in the list shows it as a card, and nothing moves the page', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { Moderation } = (await load(snippets[1] as string, w.client)) as { Moderation: React.ComponentType };
    const user = userEvent.setup();
    const { container } = render(<Moderation />);
    await screen.findByText('Alpha');
    expect(screen.queryByRole('region', { name: 'Case against Alpha' })).toBeNull();
    await user.click(container.querySelector('.cw-case-link') as HTMLElement);
    await screen.findByRole('region', { name: 'Case against Alpha' });
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    expect(window.location.hash).toBe('');
    await screen.findByRole('heading', { level: 2, name: 'All actions' });
  });

  it('3. hooks: the cases are listed, and a decision is held for Undo', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { Dashboard } = (await load(snippets[2] as string, w.client)) as { Dashboard: React.ComponentType };
    const user = userEvent.setup();
    render(<Dashboard />);
    await screen.findByText(/Alpha: 1 open/);
    await user.click(screen.getByRole('button', { name: 'No action' }));
    const toasts = await screen.findByRole('region', { name: 'Notifications' });
    await user.click(await within(toasts).findByRole('button', { name: 'Undo' }));
    expect(w.sent.filter((r) => /\/decide$/.test(r.path))).toHaveLength(0);
    expect((await w.client.getReport(f.id)).report.status).toBe('open');
    await act(async () => undefined);
  });
});
