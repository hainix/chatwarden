import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { setVersion, syncVersions, versionProblems } from './sync-version.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake repo root with packages/<name>/package.json and packages/<name>/src/index.ts. */
function fakeRepo(pkgs: Record<string, { version: string; index: string | null; versionFile?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), 'cw-sync-version-'));
  dirs.push(root);
  for (const [name, { version, index, versionFile }] of Object.entries(pkgs)) {
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@chatwarden/${name}`, version }));
    if (index !== null) writeFileSync(join(root, 'packages', name, 'src', 'index.ts'), index);
    if (versionFile !== undefined) writeFileSync(join(root, 'packages', name, 'src', 'version.ts'), versionFile);
  }
  return root;
}
const index = (root: string, name: string): string => readFileSync(join(root, 'packages', name, 'src', 'index.ts'), 'utf8');
const versionTs = (root: string, name: string): string => readFileSync(join(root, 'packages', name, 'src', 'version.ts'), 'utf8');

describe('setVersion', () => {
  it('rewrites the VERSION constant and nothing else', () => {
    const src = "export const VERSION = '0.0.0';\nexport { a } from './a.js';\n";
    expect(setVersion(src, '0.2.0')).toBe("export const VERSION = '0.2.0';\nexport { a } from './a.js';\n");
  });
  it('finds the constant on any line', () => {
    const src = "export { a } from './a.js';\nexport const VERSION = '1.0.0';\nexport { b } from './b.js';\n";
    expect(setVersion(src, '1.0.1')).toContain("export const VERSION = '1.0.1';");
    expect(setVersion(src, '1.0.1')).toContain("export { b } from './b.js';");
  });
  it('is idempotent', () => {
    const once = setVersion("export const VERSION = '0.0.0';\n", '0.3.0');
    expect(setVersion(once, '0.3.0')).toBe(once);
  });
  it('accepts a pre-release version', () => {
    expect(setVersion("export const VERSION = '0.0.0';\n", '1.0.0-beta.1')).toBe("export const VERSION = '1.0.0-beta.1';\n");
  });
  it('keeps CRLF line endings', () => {
    expect(setVersion("export const VERSION = '0.0.0';\r\nexport {};\r\n", '0.1.0')).toBe("export const VERSION = '0.1.0';\r\nexport {};\r\n");
  });
  it('throws when there is no VERSION constant', () => {
    expect(() => setVersion("export const OTHER = '0.0.0';\n", '0.1.0')).toThrow(/VERSION/);
  });
  it('refuses a version that is not semver', () => {
    expect(() => setVersion("export const VERSION = '0.0.0';\n", '')).toThrow(/version/i);
    expect(() => setVersion("export const VERSION = '0.0.0';\n", "0.1.0'; process.exit(1); '")).toThrow(/version/i);
  });
  it('does not touch a similar constant', () => {
    const src = "const VERSION_KEY = 'schema_version';\nexport const VERSION = '0.0.0';\n";
    expect(setVersion(src, '0.1.0')).toBe("const VERSION_KEY = 'schema_version';\nexport const VERSION = '0.1.0';\n");
  });
});

describe('syncVersions', () => {
  it('sets every package src/index.ts to its own manifest version', () => {
    const root = fakeRepo({
      a: { version: '0.4.0', index: "export const VERSION = '0.0.0';\n" },
      b: { version: '0.4.0', index: "export const VERSION = '0.1.0';\nexport {};\n" },
    });
    const changed: string[] = syncVersions(root);
    expect(index(root, 'a')).toBe("export const VERSION = '0.4.0';\n");
    expect(index(root, 'b')).toBe("export const VERSION = '0.4.0';\nexport {};\n");
    expect(changed.sort()).toEqual(['packages/a', 'packages/b']);
  });
  it('reports only the packages it changed', () => {
    const root = fakeRepo({
      a: { version: '0.4.0', index: "export const VERSION = '0.4.0';\n" },
      b: { version: '0.4.0', index: "export const VERSION = '0.1.0';\n" },
    });
    expect(syncVersions(root)).toEqual(['packages/b']);
    expect(syncVersions(root)).toEqual([]);
  });
  it('fails on a package with no src/index.ts', () => {
    const root = fakeRepo({ a: { version: '0.4.0', index: null } });
    expect(() => syncVersions(root)).toThrow(/packages\/a/);
  });
  it('fails on a package whose index has no VERSION constant, naming the package', () => {
    const root = fakeRepo({ a: { version: '0.4.0', index: 'export {};\n' } });
    expect(() => syncVersions(root)).toThrow(/packages\/a/);
  });
});

describe('versionProblems', () => {
  it('is empty when every constant matches its manifest', () => {
    const root = fakeRepo({ a: { version: '0.4.0', index: "export const VERSION = '0.4.0';\n" } });
    expect(versionProblems(root)).toEqual([]);
  });
  it('names a package whose constant is stale, without writing', () => {
    const root = fakeRepo({ a: { version: '0.4.0', index: "export const VERSION = '0.0.0';\n" } });
    const problems: string[] = versionProblems(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/packages\/a/);
    expect(index(root, 'a')).toBe("export const VERSION = '0.0.0';\n");
  });
});

describe('a package with a src/version.ts (the constant lives there; index.ts re-exports it)', () => {
  const REEXPORT = "export { VERSION } from './version.js';\nexport {};\n";
  it('syncVersions writes version.ts and leaves index.ts alone', () => {
    const root = fakeRepo({ a: { version: '0.5.0', index: REEXPORT, versionFile: "export const VERSION = '0.1.0';\n" } });
    expect(syncVersions(root)).toEqual(['packages/a']);
    expect(versionTs(root, 'a')).toBe("export const VERSION = '0.5.0';\n");
    expect(index(root, 'a')).toBe(REEXPORT);
    expect(syncVersions(root)).toEqual([]);
  });
  it('versionProblems checks version.ts, not index.ts, and names the package', () => {
    const stale = fakeRepo({ a: { version: '0.5.0', index: REEXPORT, versionFile: "export const VERSION = '0.1.0';\n" } });
    const problems: string[] = versionProblems(stale);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/packages\/a/);
    expect(versionTs(stale, 'a')).toBe("export const VERSION = '0.1.0';\n");
    const fresh = fakeRepo({ a: { version: '0.5.0', index: REEXPORT, versionFile: "export const VERSION = '0.5.0';\n" } });
    expect(versionProblems(fresh)).toEqual([]);
  });
  it('fails, naming the package, when version.ts has no VERSION constant', () => {
    const root = fakeRepo({ a: { version: '0.5.0', index: REEXPORT, versionFile: 'export {};\n' } });
    expect(() => syncVersions(root)).toThrow(/packages\/a/);
    expect(versionProblems(root)[0]).toMatch(/packages\/a/);
  });
  it('a package with neither file is still reported', () => {
    const root = fakeRepo({ a: { version: '0.5.0', index: null } });
    expect(() => syncVersions(root)).toThrow(/packages\/a/);
  });
  it('a package without version.ts keeps its constant in index.ts, as before', () => {
    const root = fakeRepo({ a: { version: '0.5.0', index: "export const VERSION = '0.1.0';\n" } });
    expect(syncVersions(root)).toEqual(['packages/a']);
    expect(index(root, 'a')).toBe("export const VERSION = '0.5.0';\n");
  });
});
