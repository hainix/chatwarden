import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AuditService } from '../src/audit.js';
import { PRIVACY_CATEGORIES, PRIVACY_REGISTRY } from '../src/privacy.js';
import { RETENTION_DEFAULTS } from '../src/retention.js';
import { MemoryStore } from '@chatwarden/store-memory';
import { DAY, privacyWorld } from './privacyWorld.js';

// The vocabulary privacy requests add: six audit actions appended LAST (the list only grows at the end), their target rules, and the live statement.

const SIX = ['privacy.find', 'privacy.export', 'privacy.erase', 'legal.hold', 'legal.release', 'legal.bundle'] as const;

describe('the six audit actions', () => {
  it('are in AUDIT_ACTIONS, each once, contiguous and in order after the AI acting actions (the urgent-lane actions follow); every earlier action is still there', () => {
    for (const a of SIX) expect(AUDIT_ACTIONS.filter((x) => x === a).length).toBe(1);
    const at = AUDIT_ACTIONS.indexOf('privacy.find');
    expect(AUDIT_ACTIONS.slice(at, at + 6)).toEqual([...SIX]);
    expect(AUDIT_ACTIONS[at - 1]).toBe('ai.undo_all');
    for (const old of ['report.view', 'report.decide', 'ai.undo_all', 'person.automation', 'policy.update']) expect(AUDIT_ACTIONS).toContain(old);
  });

  const audit = () => {
    const store = new MemoryStore();
    return { store, audit: new AuditService({ store, clock: { now: () => 1 } }) };
  };
  const rec = (a: AuditService, action: string, target?: { type: string; ref: string }, role: 'owner' | 'senior' = 'owner') =>
    a.record({ actor: 'owner_ann', role, action: action as never, ...(target === undefined ? {} : { target: target as never }) });

  it('privacy.export, privacy.erase need a person target; privacy.find needs none and takes none', () => {
    const { audit: a } = audit();
    expect(rec(a, 'privacy.export')).toBe(false);
    expect(rec(a, 'privacy.export', { type: 'report', ref: 'r1' })).toBe(false);
    expect(rec(a, 'privacy.export', { type: 'person', ref: 's_a' })).toBe(true);
    expect(rec(a, 'privacy.erase')).toBe(false);
    expect(rec(a, 'privacy.erase', { type: 'person', ref: 'e_receipt' })).toBe(true);
    expect(rec(a, 'privacy.find')).toBe(true);
    expect(rec(a, 'privacy.find', { type: 'person', ref: 's_a' })).toBe(false);
  });

  it('legal.hold, legal.release and legal.bundle need a report target', () => {
    const { audit: a } = audit();
    for (const action of ['legal.hold', 'legal.release', 'legal.bundle']) {
      expect(rec(a, action, undefined, 'senior'), action).toBe(false);
      expect(rec(a, action, { type: 'person', ref: 's_a' }, 'senior'), action).toBe(false);
      expect(rec(a, action, { type: 'report', ref: 'r1' }, 'senior'), action).toBe(true);
    }
  });

  it('no detail is allowed on any of the six', () => {
    const { audit: a } = audit();
    for (const action of SIX) {
      const target = action.startsWith('legal') ? { type: 'report', ref: 'r1' } : action === 'privacy.find' ? undefined : { type: 'person', ref: 's_a' };
      expect(a.record({ actor: 'owner_ann', role: 'owner', action, ...(target === undefined ? {} : { target }), detail: { sections: ['filters'], reason: 'why' } } as never), action).toBe(false);
    }
  });

  it('the rows are stored and read back with their action and target (the sqlite action list is the same list)', () => {
    const { audit: a, store } = audit();
    rec(a, 'legal.bundle', { type: 'report', ref: 'r1' });
    rec(a, 'privacy.find');
    expect(store.listAudit({ limit: 10 }).map((r) => r.action).sort()).toEqual(['legal.bundle', 'privacy.find']);
  });
});

describe('statement(): every category with the live retention clock', () => {
  it('lists every category once with the words of the registry and a retention that is null or a number of ms', async () => {
    const w = await privacyWorld();
    const st = w.cw.privacy.statement();
    expect(st.categories.map((c) => c.category)).toEqual([...PRIVACY_CATEGORIES]);
    for (const c of st.categories) {
      const rule = PRIVACY_REGISTRY.find((r) => r.category === c.category)!;
      expect([c.export, c.eraseSafety, c.eraseNone]).toEqual([rule.export, rule.eraseSafety, rule.eraseNone]);
      expect(c.retentionMs === null || (typeof c.retentionMs === 'number' && c.retentionMs > 0)).toBe(true);
    }
    expect(st.categories.find((c) => c.category === 'strikes')?.retentionMs).toBe(RETENTION_DEFAULTS.strikesMs);
    expect(st.categories.find((c) => c.category === 'holds')?.retentionMs).toBeNull();
    expect(st.disclaimer.toLowerCase()).toContain('not legal advice');
  });

  it('changes when retention changes', async () => {
    const w = await privacyWorld({ retention: { strikesMs: 7 * DAY, reportsMs: 20 * DAY } });
    const st = w.cw.privacy.statement();
    expect(st.categories.find((c) => c.category === 'strikes')?.retentionMs).toBe(7 * DAY);
    expect(st.categories.find((c) => c.category === 'reports_about')?.retentionMs).toBe(20 * DAY);
  });

  it('names the welfare clock beside the reports clock for the three report categories, and null elsewhere', async () => {
    const w = await privacyWorld();
    const st = w.cw.privacy.statement();
    for (const c of st.categories) {
      const isReport = ['reports_filed', 'reports_about', 'report_lines'].includes(c.category);
      expect(c.retentionWelfareMs, c.category).toBe(isReport ? RETENTION_DEFAULTS.welfareReportsMs : null);
      if (isReport) expect(c.retentionMs, c.category).toBe(RETENTION_DEFAULTS.reportsMs);
    }
    expect(RETENTION_DEFAULTS.welfareReportsMs).toBe(30 * DAY);
    expect(RETENTION_DEFAULTS.reportsMs).toBeGreaterThan(RETENTION_DEFAULTS.welfareReportsMs);
  });

  it('reads the live welfare clock, and never says more than the reports clock: the earlier deletion wins', async () => {
    const shorter = (await privacyWorld({ retention: { welfareReportsMs: 7 * DAY } })).cw.privacy.statement();
    expect(shorter.categories.find((c) => c.category === 'reports_about')?.retentionWelfareMs).toBe(7 * DAY);
    expect(shorter.categories.find((c) => c.category === 'reports_about')?.retentionMs).toBe(RETENTION_DEFAULTS.reportsMs);
    // Reports are kept 20 days and welfare reports 45: the general purge takes a welfare report at 20, so the statement says 20.
    const longer = (await privacyWorld({ retention: { reportsMs: 20 * DAY, welfareReportsMs: 45 * DAY } })).cw.privacy.statement();
    for (const cat of ['reports_filed', 'reports_about', 'report_lines']) {
      expect(longer.categories.find((c) => c.category === cat)?.retentionMs, cat).toBe(20 * DAY);
      expect(longer.categories.find((c) => c.category === cat)?.retentionWelfareMs, cat).toBe(20 * DAY);
    }
    expect(longer.categories.find((c) => c.category === 'strikes')?.retentionWelfareMs).toBeNull();
  });

  it('a copy: editing the answer changes nothing', async () => {
    const w = await privacyWorld();
    const st = w.cw.privacy.statement();
    st.categories[0]!.export = 'changed';
    expect(w.cw.privacy.statement().categories[0]!.export).not.toBe('changed');
  });
});
