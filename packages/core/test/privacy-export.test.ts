import { describe, expect, it } from 'vitest';
import type { PrivacyExport } from '../src/privacy.js';
import { PRIVACY_REGISTRY } from '../src/privacy.js';
import { A, A_LINE, B, B_LINE, NOW, dump, fillA, mergeAlias, privacyWorld } from './privacyWorld.js';

// `cw.privacy.export`: everything held about one person as one JSON-safe object, no hash, no other player's id, handle or lines, no reporter identity, no staff ref.

const exportOf = async (w: Awaited<ReturnType<typeof privacyWorld>>, subject = w.aId): Promise<PrivacyExport> => {
  const out = await w.cw.privacy.export(subject);
  if ('ok' in out) throw new Error('expected an export');
  return out;
};

describe('export: the sections of the registry', () => {
  it('has the format, the person, the accounts as given and the sections the design lists', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const e = await exportOf(w);
    expect(e.format).toBe('chatwarden.privacy-export');
    expect(e.version).toBe(1);
    expect(e.generatedAt).toBe(NOW);
    expect(e.person.ref).toBe(w.aId);
    expect(e.person.aliases).toBe(1);
    expect(e.accounts).toEqual([A.account]);
    expect(e.identifiers).toMatchObject({ keys: 1, addresses: 1 });
    expect(Object.keys(e.sections).sort()).toEqual(['ai', 'appeals', 'audit', 'blockedNames', 'holds', 'mutes', 'notices', 'reportsAbout', 'reportsFiled', 'sanctions', 'signals', 'strikes']);
    expect(e.sections.strikes.map((s) => s.line)).toEqual([A_LINE]);
    expect(e.sections.reportsFiled.map((r) => r.note)).toEqual(['alpha note about bravo']);
    expect(e.sections.reportsAbout.length).toBe(1);
    expect(e.sections.reportsAbout[0]?.lines.map((l) => l.text)).toEqual([A_LINE, `${A_LINE} again`]);
    expect(e.sections.mutes).toEqual({ placed: 1, received: 1 });
    expect(e.sections.signals.length).toBe(1);
    expect(e.sections.notices[0]?.excerpt).toEqual([{ text: A_LINE, day: '2027-01-15' }]);
    expect(e.truncated).toEqual([]);
    expect(e.notes.length).toBeGreaterThan(0);
  });

  it('never carries a hash, a key, an address, another player\'s id, handle or lines, a reporter identity or a staff ref', async () => {
    const w = await privacyWorld();
    await fillA(w);
    await w.cw.sanctions.apply({ kind: 'chat', subject: w.aId, includeIp: true, durationMs: 3_600_000, reason: 'zorbak reason', actor: 'mod_private', source: 'moderator', automated: false, rule: 1 });
    w.store.insertAudit({ id: 'au-p', at: NOW - 5, actor: 'mod_private', role: 'moderator', action: 'history.view', target: { type: 'person', ref: w.aId } });
    const hashes = (await w.store.loadSubjects()).ids.filter((r) => r.kind !== 'account').map((r) => r.value);
    const text = JSON.stringify(await exportOf(w));
    for (const bad of [...hashes, w.bId, B.account, B.handle, B_LINE, 'bravo says alpha was rude', 'mod_ann', 'mod_private', 'senior', 'filter:', 'erased:']) {
      expect(text, bad).not.toContain(bad);
    }
    // the sanction is there, with no staff ref
    const san = (await exportOf(w)).sections.sanctions[0];
    expect(san).toMatchObject({ kind: 'chat', reason: 'zorbak reason', byStaff: true });
    expect(Object.keys(san ?? {})).not.toContain('actor');
    // the audit rows say what and when, never who
    expect((await exportOf(w)).sections.audit).toEqual([{ at: NOW - 5, action: 'history.view' }]);
  });

  it('the same person through an alias gives the same export', async () => {
    const w = await privacyWorld();
    const alias = await mergeAlias(w);
    expect(await exportOf(w, alias)).toEqual(await exportOf(w, w.cw.people.canonical(w.aId)));
    expect((await exportOf(w, alias)).person.aliases).toBe(2);
  });

  it('an unknown subject is not_found; a guest-only person (a subject with no rows) has empty sections', async () => {
    const w = await privacyWorld();
    expect(await w.cw.privacy.export('s_nobody')).toEqual({ ok: false, error: 'not_found' });
    w.cw.rooms.seat('R9', 'p1', { clientKey: 'key-lone' }, 'Lone');
    await w.cw.flush();
    const lone = w.cw.rooms.subjectAt('R9', 'p1') as string;
    const e = await exportOf(w, lone);
    expect(e.accounts).toEqual([]);
    expect(e.sections.sanctions).toEqual([]);
    expect(e.sections.strikes).toEqual([]);
    expect(e.sections.mutes).toEqual({ placed: 0, received: 0 });
  });

  it('is a read: it writes nothing, no audit row and no event (the route audits it)', async () => {
    const w = await privacyWorld();
    await fillA(w);
    await w.cw.flush();
    const before = dump(w.store);
    const seen: string[] = [];
    w.cw.on('*', (e) => void seen.push(e.type));
    await exportOf(w);
    expect(dump(w.store)).toBe(before);
    expect(seen).toEqual([]);
  });

  it('is JSON-safe and round-trips', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const e = await exportOf(w);
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });

  it('caps a section at 5 000 rows and says so: 5 001 strikes give 5 000 and truncated', async () => {
    const w = await privacyWorld();
    w.store.transaction(() => {
      for (let i = 0; i < 5001; i++) w.store.insertStrike({ id: `many${i}`, at: NOW - i, subject: w.aId, roomId: 'R', termId: 't', rawLine: `line ${i}` });
    });
    const e = await exportOf(w);
    expect(e.sections.strikes.length).toBe(5000);
    expect(e.truncated).toEqual(['strikes']);
  });

  it('flushes queued identifier writes first: an account the person was just seen with is in the export', async () => {
    const w = await privacyWorld();
    w.cw.rooms.seat('R9', 'p1', { clientKey: A.key, accountId: 'acct-a-brand-new' }, 'Alpha');
    const e = await exportOf(w);
    expect(e.accounts).toEqual([A.account, 'acct-a-brand-new']);
  });

  it('the notes come from the registry: what is never exported is said in words', async () => {
    const w = await privacyWorld();
    const e = await exportOf(w);
    for (const note of e.notes) expect(PRIVACY_REGISTRY.some((r) => r.export === note || note.length > 20)).toBe(true);
    expect(e.notes.join(' ').toLowerCase()).toContain('hash');
  });
});
