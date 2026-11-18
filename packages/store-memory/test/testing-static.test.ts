import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The test kit is browser-safe and runner-neutral, and nothing in the package's main entry reaches it (design 10; Review Focus: the kit's size).

const root = fileURLToPath(new URL('..', import.meta.url));
const testingDir = join(root, 'src', 'testing');

function sourcesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourcesIn(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const files = sourcesIn(testingDir);
const text = (path: string): string => readFileSync(path, 'utf8');

/** The module specifiers a file imports or re-exports (statements that start a line). */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/^(?:import|export)\b[^'"`;]*?from\s*['"]([^'"]+)['"]/gm)) found.push(m[1] as string);
  for (const m of source.matchAll(/^import\s*['"]([^'"]+)['"]/gm)) found.push(m[1] as string);
  return found;
}

describe('the testing entry', () => {
  it('has the files the design names', () => {
    expect(files.map((f) => f.slice(testingDir.length + 1).replaceAll('\\', '/')).sort()).toEqual(['clock.ts', 'duration.ts', 'index.ts', 'kit.ts', 'room.ts', 'script.ts', 'words.ts']);
  });

  it('imports no node: module, no vitest or jest, no @chatwarden/matcher', () => {
    for (const file of files) {
      for (const spec of specifiers(text(file))) {
        expect(spec, file).not.toMatch(/^node:/);
        expect(spec, file).not.toMatch(/^(vitest|jest|@jest|mocha|chai|ava|tap|node:test|@vitest)(\/|$)/);
        expect(spec, file).not.toMatch(/^@chatwarden\/(matcher|http|store-sqlite|discord|profanity|hub|player)/);
        expect(spec.startsWith('.') || spec === '@chatwarden/core', `${file} imports ${spec}`).toBe(true);
      }
      // No Node built-in by its bare name either, and no call that needs the runtime.
      const code = text(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
      expect(code, file).not.toMatch(/\b(?:describe|it|test|expect|beforeEach|afterEach)\s*\(/);
      expect(code, file).not.toMatch(/\bBuffer\b|\bsetImmediate\b|\bprocess\b|\brequire\b/);
    }
  });

  it('no timestamp comes from the machine: the kit reads the fake clock only', () => {
    for (const file of files) {
      const code = text(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
      expect(code, file).not.toMatch(/Date\.now\(|new Date\(|performance\.now|Math\.random/);
    }
  });

  it('every file uses LF line endings', () => {
    for (const file of files) expect(text(file).includes('\r'), file).toBe(false);
  });

  it('the public names carry no @experimental tag (0.2.0 settled them)', () => {
    const index = text(join(testingDir, 'index.ts'));
    for (const name of ['durationMs', 'createFakeClock', 'wordMatcher', 'wordFilter', 'createTestKit', 'expectOutcomes', 'checkLines', 'ScriptMismatch']) {
      const all = files.map(text).join('\n');
      expect(all, name).toMatch(new RegExp(`(?:function|class)\\s+${name}\\b`));
      expect(all, name).not.toContain('@experimental');
    }
    expect(index).toContain('export');
  });
});

describe('the main entry', () => {
  it('the store-memory main entry does not import src/testing (its bundle size is unchanged)', () => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of specifiers(text(file))) {
        if (spec.startsWith('.')) walk(resolve(dirname(file), spec).replace(/\.js$/, '.ts'));
      }
    };
    walk(join(root, 'src', 'index.ts'));
    expect(seen.size).toBeGreaterThan(3);
    expect([...seen].filter((file) => file.startsWith(testingDir))).toEqual([]);
  });

  it('./testing is an export with its types, in exports and typesVersions', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, unknown>; typesVersions: { '*': Record<string, string[]> } };
    expect(manifest.exports['./testing']).toEqual({ types: './dist/src/testing/index.d.ts', default: './dist/src/testing/index.js' });
    expect(manifest.typesVersions['*'].testing).toEqual(['dist/src/testing/index.d.ts']);
    expect(manifest.exports['.']).toEqual({ types: './dist/src/index.d.ts', default: './dist/src/index.js' });
  });
});
