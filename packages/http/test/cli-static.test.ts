import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { createWorld } from './cli-world.js';

// What the CLI may touch (design 3, ruling 3; Review Focus 5): no network, no dependency, one file for the one child process, and none of it in a
// browser-safe entry. These read the sources, so a new import that breaks a rule fails here.

const root = fileURLToPath(new URL('..', import.meta.url));
const cliDir = join(root, 'src', 'cli');
/** True for src/cli itself or a file under it: a sibling that merely starts with the same letters (src/clientAddress.ts) is not in it. */
const inCli = (path: string): boolean => path === cliDir || path.startsWith(cliDir + sep);

function sourcesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourcesIn(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const files = sourcesIn(cliDir);
const rel = (path: string): string => relative(cliDir, path).replaceAll('\\', '/');
const textOf = (path: string): string => readFileSync(path, 'utf8');

/** Every module specifier a file imports (static, re-exported or dynamic). */
function specifiers(text: string): string[] {
  const found: string[] = [];
  // Only a statement that starts at the beginning of a line is an import of this file: the generated code a template writes sits in strings, indented
  // or after a quote, and a command line in a string (plan.ts's SECRET_COMMAND) is not an import either.
  for (const m of text.matchAll(/^(?:import|export)\b[^'"`;]*?from\s*['"]([^'"]+)['"]/gm)) found.push(m[1] as string);
  for (const m of text.matchAll(/^import\s*['"]([^'"]+)['"]/gm)) found.push(m[1] as string);
  return found;
}
/** The code of a file with its comments and string contents left in (the checks below look at imports and calls, not prose). */
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

describe('the CLI is offline', () => {
  it('there are CLI sources to look at', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.map(rel)).toEqual(expect.arrayContaining(['bin.ts', 'index.ts', 'install.ts', 'prompts.ts', 'check.ts', 'env.ts', 'templates/index.ts']));
  });

  it('no src/cli file imports node:http, node:https, node:http2, node:net, node:dns, node:tls or node:dgram, or uses fetch, XMLHttpRequest or WebSocket', () => {
    const forbidden = /^(node:)?(http|https|http2|net|dns|tls|dgram|inspector|worker_threads|cluster|vm)(\/.*)?$/;
    for (const file of files) {
      const text = textOf(file);
      // The generated text a template writes may mention these (the starter's own code does); a template is checked for its own imports and calls only.
      for (const spec of specifiers(text)) {
        if (!rel(file).startsWith('templates/') || !text.includes('`')) expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(forbidden);
        else expect(spec.startsWith('.') || spec.startsWith('@chatwarden/'), `${rel(file)} imports ${spec}`).toBe(true);
      }
      if (rel(file).startsWith('templates/')) continue;
      const code = withoutComments(text);
      expect(code, `${rel(file)} calls fetch`).not.toMatch(/(?<![\w.$])fetch\s*\(/);
      expect(code, `${rel(file)} uses globalThis.fetch`).not.toMatch(/globalThis\.fetch|XMLHttpRequest|new WebSocket|\bEventSource\b/);
    }
  });

  it('no CLI code (a template writes generated code, and may contain one) uses a dynamic import(), which the scan of the imports would not see', () => {
    for (const file of files.filter((f) => !rel(f).startsWith('templates/'))) expect(withoutComments(textOf(file)), rel(file)).not.toMatch(/(?<![\w.'"`$])import\(/);
  });

  it('node:child_process appears only in install.ts', () => {
    const using = files.filter((file) => specifiers(textOf(file)).some((spec) => /^(node:)?child_process$/.test(spec)));
    expect(using.map(rel)).toEqual(['install.ts']);
  });

  it('node:readline appears only in prompts.ts', () => {
    const using = files.filter((file) => specifiers(textOf(file)).some((spec) => /^(node:)?readline(\/promises)?$/.test(spec)));
    expect(using.map(rel)).toEqual(['prompts.ts']);
  });

  it('the only Node modules the CLI imports are util, readline/promises, fs/promises, path, process and child_process, each in its own file', () => {
    const allowed: Record<string, string[]> = {
      'args.ts': ['node:util'],
      'env.ts': ['node:fs/promises', 'node:path', 'node:process'],
      'install.ts': ['node:child_process'],
      'prompts.ts': ['node:readline/promises'],
    };
    for (const file of files) {
      const nodeSpecs = specifiers(textOf(file)).filter((spec) => spec.startsWith('node:'));
      if (rel(file).startsWith('templates/')) {
        // A template writes `import ... from 'node:crypto'` into the generated file: those are inside strings, and no template imports a Node module itself.
        expect(nodeSpecs.filter((spec) => !/^node:/.test(spec)), rel(file)).toEqual([]);
        continue;
      }
      expect(nodeSpecs.sort(), rel(file)).toEqual((allowed[rel(file)] ?? []).sort());
    }
  });

  it('with a throwing global fetch (and the other network globals) installed, a full interactive run completes', async () => {
    const saved = { fetch: globalThis.fetch };
    const calls: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      throw new Error('the CLI must not touch the network');
    }) as typeof fetch;
    try {
      const world = createWorld({
        files: { 'package.json': JSON.stringify({ type: 'module', dependencies: { express: '^5.1.0' } }), 'tsconfig.json': '{}' },
        isTTY: true,
        stdin: 'kids\nmemory\nbox\nelement\ny\n',
      });
      expect(await runCli(['init'], world.env)).toBe(0);
      expect(world.has('chatwarden/kit.ts')).toBe(true);
      const check = createWorld({ files: Object.fromEntries(world.files().map((f) => [f, world.read(f)!])) });
      expect(await runCli(['init', '--check'], check.env)).toBe(1);
      // The answers differ from the first run's (no Discord, the default standard), so the files that differ are skipped: exit 2, still offline.
      expect(await runCli(['init', '--dry-run', '--json'], check.env)).toBe(2);
      const fresh = createWorld({ files: { 'package.json': '{}' } });
      expect(await runCli(['init', '--yes', '--install'], fresh.env)).toBe(0);
    } finally {
      globalThis.fetch = saved.fetch;
    }
    expect(calls).toEqual([]);
  });
});

describe('the package', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;

  it('packages/http/package.json has no dependencies entry (the CLI adds none: zero runtime dependencies)', () => {
    expect(manifest.dependencies).toBeUndefined();
  });

  it('the chatwarden bin points at a compiled file of this package, and ./cli is an export', () => {
    expect(manifest.bin).toEqual({ chatwarden: './dist/src/cli/bin.js' });
    const exportsField = manifest.exports as Record<string, { types: string; default: string }>;
    expect(exportsField['./cli']).toEqual({ types: './dist/src/cli/index.d.ts', default: './dist/src/cli/index.js' });
    expect((manifest.typesVersions as { '*': Record<string, string[]> })['*'].cli).toEqual(['dist/src/cli/index.d.ts']);
  });

  it('the bin file starts with the shebang line', () => {
    expect(textOf(join(cliDir, 'bin.ts')).split('\n')[0]).toBe('#!/usr/bin/env node');
    // And it is the only file that does.
    for (const file of files.filter((f) => rel(f) !== 'bin.ts')) expect(textOf(file).startsWith('#!'), rel(file)).toBe(false);
  });

  it('every src/cli file uses LF line endings', () => {
    for (const file of files) expect(textOf(file).includes('\r'), rel(file)).toBe(false);
  });
});

describe('what it reaches', () => {
  it('src/cli imports nothing from @chatwarden/core (or any other @chatwarden package): a template is text, and the version is this package\'s own', () => {
    for (const file of files) {
      const real = specifiers(textOf(file)).filter((spec) => spec.startsWith('@chatwarden/'));
      // A template's own import lines are inside template strings, which `specifiers` does not read as imports of the file.
      expect(real, rel(file)).toEqual([]);
    }
    // The relative imports out of src/cli are the VERSION constant of this package, from src/version.ts (not the package root, which loads core), and `chatwarden serve`'s launcher,
    // service/launch.ts, which holds only types and loads the process (and the kit with it) with a dynamic import when `serve` is the command.
    const outside = files.flatMap((file) => specifiers(textOf(file)).filter((spec) => spec.startsWith('..') && !inCli(resolve(dirname(file), spec))).map((spec) => `${rel(file)} -> ${spec}`));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((line) => line.endsWith(' -> ../version.js') || line.endsWith(' -> ../service/launch.js')), outside.join('\n')).toBe(true);
  });

  it('the bin loads only src/cli, src/version.ts and the serve launcher: the http root, core and every other package stay out of its start-up', () => {
    const seen = new Set<string>();
    const external = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of specifiers(textOf(file))) {
        if (!spec.startsWith('.')) {
          if (!spec.startsWith('node:')) external.add(spec);
          continue;
        }
        walk(resolve(dirname(file), spec).replace(/\.js$/, '.ts'));
      }
    };
    walk(join(cliDir, 'bin.ts'));
    const outside = [...seen].filter((file) => !inCli(file)).map((file) => relative(join(root, 'src'), file).replaceAll('\\', '/'));
    expect(outside.sort()).toEqual(['service/launch.ts', 'version.ts']);
    expect([...external]).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  });

  it('src/version.ts holds the VERSION constant and imports nothing; the package root re-exports that one', () => {
    const version = textOf(join(root, 'src', 'version.ts'));
    expect(version).toMatch(/^export const VERSION = '\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?';$/m);
    expect(specifiers(version)).toEqual([]);
    const index = textOf(join(root, 'src', 'index.ts'));
    expect(index).toMatch(/^export \{ VERSION \} from '\.\/version\.js';$/m);
    expect(index).not.toMatch(/^export const VERSION/m);
  });

  it('no browser-safe entry (./chat, ./admin, ./fetch, and the root entry) reaches src/cli', () => {
    const srcDir = join(root, 'src');
    const entries = ['chat/index.ts', 'admin-entry.ts', 'fetch.ts', 'index.ts'].map((p) => join(srcDir, p));
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of specifiers(textOf(file))) {
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
        walk(target);
      }
    };
    for (const entry of entries) walk(entry);
    expect(seen.size).toBeGreaterThan(10);
    expect([...seen].filter(inCli)).toEqual([]);
  });

  it('the src/cli prefix check is by directory: a sibling file named like it is outside, a file under it is inside', () => {
    expect(inCli(join(root, 'src', 'clientAddress.ts'))).toBe(false);
    expect(inCli(join(root, 'src', 'cli.ts'))).toBe(false);
    expect(inCli(join(root, 'src', 'cli-extra', 'a.ts'))).toBe(false);
    expect(inCli(join(root, 'src', 'cli', 'bin.ts'))).toBe(true);
    expect(inCli(join(root, 'src', 'cli', 'templates', 'auth.ts'))).toBe(true);
    expect(inCli(cliDir)).toBe(true);
  });
});
