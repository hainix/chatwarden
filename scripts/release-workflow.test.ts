import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The release workflow cannot run on a laptop, so these checks pin the properties that matter: it publishes with provenance,
// never skips prepack, is a dry run by default, and fails clearly when the token is missing.

const root = fileURLToPath(new URL('..', import.meta.url));
const wf = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');

describe('.github/workflows/release.yml', () => {
  it('runs on manual dispatch (dry_run, default true) and on v* tags only', () => {
    expect(wf).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}dry_run:/);
    expect(wf).toMatch(/type: boolean\n {8}default: true/);
    expect(wf).toMatch(/push:\n {4}tags:\n {6}- 'v\*'/);
    expect(wf).not.toMatch(/pull_request/);
    expect(wf).not.toMatch(/branches:/);
  });

  it('treats a tag push as a real publish: DRY_RUN is true only for a dispatch with dry_run on', () => {
    expect(wf).toContain("DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || false }}");
  });

  it('has contents: read and id-token: write, and nothing wider', () => {
    expect(wf).toMatch(/permissions:\n {2}contents: read\n {2}id-token: write/);
    expect(wf).not.toMatch(/contents: write/);
  });

  it('uses Node 24 and the npm registry', () => {
    expect(wf).toContain('node-version: 24');
    expect(wf).toContain('registry-url: https://registry.npmjs.org');
  });

  it('runs ci, typecheck, check:pack and smoke before it publishes', () => {
    const at = (s: string): number => wf.indexOf(s);
    const order = ['npm ci', 'npm run typecheck', 'npm run check:pack', 'node scripts/smoke.mjs', 'npm publish --workspace'];
    for (const s of order) expect(at(s), s).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(at(order[i] as string), order[i]).toBeGreaterThan(at(order[i - 1] as string));
  });

  it('publishes with provenance and public access, takes the order from publish-order.mjs, and never skips prepack', () => {
    expect(wf).toContain('--provenance --access public');
    expect(wf).toContain('--dry-run');
    expect(wf).toContain('node scripts/publish-order.mjs');
    expect(wf).toContain('npm publish --workspace "$name"');
    expect(wf).not.toContain('--ignore-scripts');
  });

  it('skips a version already on npm, using npm view name@version', () => {
    expect(wf).toContain('npm view "$spec" version');
    expect(wf).toContain('already on npm');
  });

  it('fails with a clear message when NPM_TOKEN is empty, before publishing a real release', () => {
    const check = wf.indexOf('Require NPM_TOKEN');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(wf.indexOf('npm publish --workspace'));
    expect(wf).toContain('if: ${{ env.DRY_RUN != \'true\' }}');
    expect(wf).toMatch(/::error::The repository secret NPM_TOKEN is empty or missing/);
    expect(wf).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
  });

  it('refuses a tag that does not match the package version', () => {
    expect(wf).toContain('does not match the package version');
  });
});
