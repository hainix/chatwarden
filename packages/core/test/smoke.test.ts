import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import { lengthLabel, outcomeLabel, VERSION } from '../src/index.js';

describe('@chatwarden/core smoke', () => {
  // core may import no node: module but node:crypto, so it cannot read its package.json here; scripts/manifests.test.ts
  // checks that VERSION equals the manifest version (and scripts/sync-version.mjs keeps it so).
  it('exports a semver VERSION, not the 0.0.0 placeholder', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).not.toBe('0.0.0');
  });

  it('exports the ladder label helpers the staff hub needs', () => {
    expect(outcomeLabel('none')).toBe('No action');
    expect(outcomeLabel('note')).toBe('Note');
    expect(outcomeLabel('warning')).toBe('Warning');
    expect(outcomeLabel({ kind: 'chat', durationMs: 24 * 3_600_000 })).toBe('Restrict chat 24 hours');
    expect(outcomeLabel({ kind: 'ban', durationMs: null })).toBe('Full ban permanent');
    expect(lengthLabel(null)).toBe('permanent');
    expect(lengthLabel(7 * 24 * 3_600_000)).toBe('7 days');
  });

  it('does not export the implementation classes behind cw.on and cw.audit (adopters use the facade)', () => {
    for (const name of ['EventBus', 'AuditService']) expect(Object.keys(api), name).not.toContain(name);
    // The things adopters do use from those modules stay.
    for (const name of ['KIT_EVENT_TYPES', 'ROLES', 'isValidAuditActor', 'AUDIT_ACTIONS', 'AuditQueryError', 'safeWarn', 'errorClass']) {
      expect(Object.keys(api), name).toContain(name);
    }
  });
});
