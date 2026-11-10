import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { licenseProblems, syncLicense } from './sync-license.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageDirs = (): string[] =>
  readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

describe('package LICENSE copies', () => {
  const rootLicense = readFileSync(join(root, 'LICENSE'));
  it('finds the published packages', () => {
    expect(packageDirs().length).toBeGreaterThanOrEqual(6);
  });
  it.each(packageDirs())('packages/%s/LICENSE is byte-identical to the root LICENSE', (dir) => {
    const copy = readFileSync(join(root, 'packages', dir, 'LICENSE'));
    expect(Buffer.compare(copy, rootLicense)).toBe(0);
  });
  it('licenseProblems reports nothing for the real repo', () => {
    expect(licenseProblems(root)).toEqual([]);
  });
});

describe('syncLicense', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const fixture = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'cw-license-'));
    dirs.push(d);
    writeFileSync(join(d, 'LICENSE'), 'ROOT LICENSE\r\nbytes\n');
    for (const p of ['a', 'b']) {
      mkdirSync(join(d, 'packages', p), { recursive: true });
      writeFileSync(join(d, 'packages', p, 'package.json'), '{}');
    }
    return d;
  };

  it('copies the root LICENSE into every package, byte for byte', () => {
    const d = fixture();
    syncLicense(d);
    for (const p of ['a', 'b']) {
      expect(readFileSync(join(d, 'packages', p, 'LICENSE'), 'utf8')).toBe('ROOT LICENSE\r\nbytes\n');
    }
  });
  it('overwrites a stale copy', () => {
    const d = fixture();
    writeFileSync(join(d, 'packages', 'a', 'LICENSE'), 'old');
    expect(licenseProblems(d).join('\n')).toContain('packages/a');
    syncLicense(d);
    expect(licenseProblems(d)).toEqual([]);
  });
  it('reports a missing copy', () => {
    const d = fixture();
    expect(licenseProblems(d).length).toBe(2);
  });
  it('skips directories that are not packages', () => {
    const d = fixture();
    mkdirSync(join(d, 'packages', 'not-a-package'));
    syncLicense(d);
    expect(licenseProblems(d)).toEqual([]);
  });
});
