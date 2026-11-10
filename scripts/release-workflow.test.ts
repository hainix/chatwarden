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

  it('runs ci, typecheck, lint, the tests, check:pack and smoke before it publishes', () => {
    const at = (s: string): number => wf.indexOf(s);
    const order = ['npm ci', 'npm run typecheck', 'npm run lint', 'npm test', 'npm run check:pack', 'node scripts/smoke.mjs', 'npm publish --workspace'];
    for (const s of order) expect(at(s), s).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(at(order[i] as string), order[i]).toBeGreaterThan(at(order[i - 1] as string));
  });

  it('publishes with provenance and public access, takes the order from publish-order.mjs, and never skips prepack', () => {
    expect(wf).toContain('flags=(--access public)');
    expect(wf).toContain('flags+=(--provenance)');
    expect(wf).toContain('--dry-run');
    expect(wf).toContain('node scripts/publish-order.mjs');
    expect(wf).toContain('npm publish --workspace "$name"');
    expect(wf).not.toContain('--ignore-scripts');
  });

  it('skips a version already on npm, using npm view name@version', () => {
    expect(wf).toContain('npm view "$spec" version');
    expect(wf).toContain('already on npm');
  });

  it('chooses the auth path before a real publish: NPM_TOKEN when set, else npm trusted publishing (OIDC)', () => {
    const check = wf.indexOf('Choose npm auth');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(wf.indexOf('npm publish --workspace'));
    expect(wf).toContain('if: ${{ env.DRY_RUN != \'true\' }}');
    // A missing token is no longer fatal: trusted publishing needs no secret. The notice says what happens if neither is set up.
    expect(wf).not.toMatch(/::error::The repository secret NPM_TOKEN is empty or missing/);
    expect(wf).toMatch(/::notice::No NPM_TOKEN secret: publishing through npm trusted publishing \(OIDC\)/);
    expect(wf).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
  });

  it('upgrades npm to a version with trusted publishing before it publishes', () => {
    const upgrade = wf.indexOf('npm install -g npm@^11.5.1');
    expect(upgrade).toBeGreaterThan(-1);
    expect(upgrade).toBeLessThan(wf.indexOf('npm publish --workspace'));
  });

  it('refuses a tag that does not match the package version', () => {
    expect(wf).toContain('does not match the package version');
  });

  it('has a provenance input (boolean, default true) after dry_run', () => {
    expect(wf).toMatch(/provenance:\n {8}description: .*\n {8}type: boolean\n {8}default: true/);
    const inputs = wf.slice(wf.indexOf('workflow_dispatch:'), wf.indexOf('push:'));
    expect(inputs.indexOf('dry_run:')).toBeLessThan(inputs.indexOf('provenance:'));
  });

  it('always uses provenance for a tag push, and follows the input only for a manual run', () => {
    // 'event != dispatch || inputs.provenance' is true on a tag push (the first operand) and the input on a dispatch.
    // The tempting 'dispatch && inputs.provenance || true' would turn an unticked box back into true.
    expect(wf).toContain("PROVENANCE: ${{ github.event_name != 'workflow_dispatch' || inputs.provenance }}");
    expect(wf).not.toMatch(/PROVENANCE:.*\|\| true/);
  });

  it('adds --provenance to the publish flags only when PROVENANCE is true', () => {
    expect(wf).toContain('if [ "$PROVENANCE" = "true" ]; then flags+=(--provenance); fi');
    expect(wf).not.toMatch(/flags=\([^)]*--provenance/);
  });

  it('checks the repository visibility with gh api and GITHUB_TOKEN, before it publishes', () => {
    const step = wf.indexOf('Check the repository is public');
    expect(step).toBeGreaterThan(-1);
    expect(step).toBeLessThan(wf.indexOf('npm publish --workspace'));
    expect(wf).toContain('gh api repos/${{ github.repository }} -q .private');
    expect(wf).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
  });

  const visibilityStep = (): string => wf.slice(wf.indexOf('Check the repository is public'), wf.indexOf('Use an npm with trusted publishing'));

  it('fails a real publish from a private repository, naming the owner decision, and only warns on a dry run', () => {
    const body = visibilityStep();
    expect(body).toContain('make hainix/chatwarden public');
    expect(body).toMatch(/provenance/i);
    expect(body).toContain('if [ "$DRY_RUN" = "true" ]; then');
    const warn = body.indexOf('::warning::');
    const err = body.indexOf('::error::');
    expect(warn).toBeGreaterThan(-1);
    expect(err).toBeGreaterThan(warn);
    // The dry-run branch (up to the error) never exits non-zero; the error branch does.
    expect(body.slice(warn, err)).not.toContain('exit 1');
    expect(body.indexOf('exit 1')).toBeGreaterThan(err);
  });

  it('lets a deliberate no-provenance publish from a private repository through', () => {
    expect(visibilityStep()).toContain('"$PROVENANCE" = "true"');
  });

  it('does not let a failing publish-order.mjs pass: set -euo pipefail, an assignment, a non-empty check, then the loop', () => {
    const run = wf.slice(wf.indexOf('Publish in dependency order'));
    expect(run).not.toMatch(/for spec in \$\(/);
    const order = ['set -euo pipefail', 'specs="$(node scripts/publish-order.mjs)"', '-z "$specs"', 'for spec in $specs'];
    for (const s of order) expect(run.indexOf(s), s).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(run.indexOf(order[i] as string), order[i]).toBeGreaterThan(run.indexOf(order[i - 1] as string));
  });

  it('refuses a real publish that is not on a tag ref, before anything is installed', () => {
    const step = wf.indexOf('Real publishes run on a tag');
    expect(step).toBeGreaterThan(-1);
    expect(step).toBeLessThan(wf.indexOf('npm ci'));
    const body = wf.slice(step, wf.indexOf('- uses: actions/setup-node'));
    expect(body).toContain("if: ${{ env.DRY_RUN != 'true' && github.ref_type != 'tag' }}");
    expect(body).toContain('::error::');
    expect(body).toContain('exit 1');
  });
});
