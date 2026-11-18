import { describe, expect, it } from 'vitest';
import { canonicalJson, signBundle, verifyBundle } from '../src/canonical.js';
import type { EvidenceBundle } from '../src/legalService.js';
import { VERSION } from '../src/version.js';
import { DAY, NOW, legalWorld, seedFullReport } from './legalWorld.js';

// A golden file: the canonical bytes of one bundle built from FIXED ids, a fixed clock and a fixed secret. Any change to what a bundle holds, to its order or to the
// canonical rules changes these bytes and fails here, on purpose: a verifier outside the kit depends on them. Review the diff before updating the file.

const SECRET = 'golden-secret-golden-secret-golden-32';

describe('the golden bundle', () => {
  it('has the same canonical bytes as the file, and verifies', async () => {
    const w = await legalWorld({ bundleSecret: SECRET });
    seedFullReport(w, 'r-gold', NOW - DAY);
    await w.cw.legal.hold('r-gold', { code: 'legal_proceeding', actor: 'senior_gus' });
    const out = await w.cw.legal.bundle('r-gold', { actor: 'owner_ann', includeAccounts: true });
    if ('ok' in out) throw new Error('expected a bundle');
    expect(verifyBundle(out, SECRET)).toEqual({ sha256: true, hmac: true });
    expect(out.kit.version).toBe(VERSION);
    // The package version moves every release: the golden bytes are made with a fixed one, re-signed, so the file does not change when the version does.
    const fixed = signBundle({ ...out, kit: { ...out.kit, version: '0.0.0-golden' } }, SECRET, out.integrity.signedAt);
    await expect(`${canonicalJson(fixed)}\n`).toMatchFileSnapshot('./__snapshots__/legal-bundle.golden.json');
  });

  it('the file itself parses and verifies with the secret (a stored bundle stays checkable)', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('./__snapshots__/legal-bundle.golden.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(text) as EvidenceBundle;
    expect(verifyBundle(parsed, SECRET)).toEqual({ sha256: true, hmac: true });
    expect(canonicalJson(parsed)).toBe(text.trimEnd());
  });
});
