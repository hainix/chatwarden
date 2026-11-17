import { describe, expect, it } from 'vitest';
import type { ErasureReceipt, ErasePreview } from '../src/privacy.js';
import { A, A_LINE, B_LINE, DAY, NOW, dump, fillA, mergeAlias, privacyWorld } from './privacyWorld.js';
import { fullStore } from './legalWorld.js';

// `cw.privacy.erase` (design 5.3): one store transaction, the receipt, the audit row, the dry run, the held set, and the in-memory fix-ups in privacy-memory.test.ts.

const OWNER = 'owner_ann';
const erase = async (w: Awaited<ReturnType<typeof privacyWorld>>, keep: 'safety' | 'none', over: Record<string, unknown> = {}) => {
  const out = await w.cw.privacy.erase(w.aId, { keep, actor: OWNER, ...over });
  if ('ok' in out) throw new Error(`refused: ${out.error}`);
  return out;
};
const receipt = (o: ErasureReceipt | ErasePreview): ErasureReceipt => {
  if ('dryRun' in o) throw new Error('expected a receipt');
  return o;
};

describe('erase none', () => {
  it('removes the person from every table: a dump of the whole store holds none of their ids, key, account, address, handle or lines', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const before = dump(w.store);
    for (const needle of [w.aId, A.account, A.handle, A_LINE]) expect(before, needle).toContain(needle);
    const r = receipt(await erase(w, 'none'));
    await w.cw.flush();
    const after = dump(w.store);
    for (const needle of [w.aId, A.account, A.handle, A_LINE, 'alpha note about bravo', 'alpha reports bravo']) expect(after, needle).not.toContain(needle);
    // the key and the address are stored only as keyed hashes: look for the hashes the kit stored for A
    expect(r.removed.subjects).toBe(1);
    expect(r.removed.identifiers).toBeGreaterThanOrEqual(3);
    expect(r.kept).toEqual({ identifiers: false, sanctions: 0, heldReports: 0 });
    // the other player, and his words, are still there
    expect(after).toContain(w.bId);
    expect(after).toContain('BravoHandle');
  });

  it('the hashed key and address of the person are gone too (read from the store before, looked for after)', async () => {
    const w = await privacyWorld();
    const ids = (await w.store.loadSubjects()).ids.filter((r) => r.subjectId === w.aId).map((r) => r.value);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    await fillA(w);
    await erase(w, 'none');
    const after = dump(w.store);
    for (const value of ids) expect(after, value).not.toContain(value);
  });

  it('an erased reporter\'s report stays for its target with the reporter, seat, handle and note removed; a report about the person is deleted', async () => {
    const w = await privacyWorld();
    const ids = await fillA(w);
    await erase(w, 'none');
    const filed = w.store.loadReport(ids.filed);
    expect(filed).not.toBeNull();
    expect(filed?.reporterSubject).toBe(`erased:${ids.filed}`);
    expect(filed?.reporterHandle).toBe('');
    expect(filed?.note).toBeNull();
    expect(filed?.targetSubject).toBe(w.bId);
    expect(filed?.excerpt.some((l) => l.raw.includes('alpha reports bravo'))).toBe(false);
    expect(w.store.loadReport(ids.about)).toBeNull();
    const third = w.store.loadReport(ids.third);
    expect(third?.excerpt.some((l) => l.raw.includes(A_LINE))).toBe(false);
    expect(third?.excerpt.some((l) => l.raw === '[erased]')).toBe(true);
    expect(third?.excerpt.some((l) => l.raw === 'charlie line')).toBe(true);
  });

  it('a ban in force is deleted with keep none: the ban stops applying', async () => {
    const w = await privacyWorld();
    await w.cw.sanctions.apply({ kind: 'ban', subject: w.aId, includeIp: true, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    expect(w.cw.chat.restricted({ clientKey: A.key }).restricted).toBe(true);
    const r = receipt(await erase(w, 'none'));
    expect(r.removed.sanctions).toBe(2);
    expect(w.cw.chat.restricted({ clientKey: A.key }).restricted).toBe(false);
  });

  it('erasing twice: the second says not_found and writes no receipt; an unknown person is not_found too', async () => {
    const w = await privacyWorld();
    await erase(w, 'none');
    const again = await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER });
    expect(again).toEqual({ ok: false, error: 'not_found' });
    expect(await w.cw.privacy.erase('s_nobody', { keep: 'none', actor: OWNER })).toEqual({ ok: false, error: 'not_found' });
    expect(w.store.loadPendingErasures()).toEqual([]);
    expect(w.store.erasureEpoch()).toBe(1);
  });

  it('the alias set goes together: a person merged from two subjects is erased as one and the receipt counts one person', async () => {
    const w = await privacyWorld();
    const alias = await mergeAlias(w);
    expect(w.cw.people.aliases(w.aId).length).toBe(2);
    const r = receipt(await erase(w, 'none'));
    expect(r.removed.subjects).toBe(2);
    const loaded = await w.store.loadSubjects();
    expect(loaded.subjects.map((s) => s.id)).toEqual([w.bId]);
    // asking by the alias id gives the same answer: not found now
    expect(await w.cw.privacy.erase(alias, { keep: 'none', actor: OWNER })).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('the receipt', () => {
  it('has an id, a time, the mode, counts per category and what was kept; it holds no subject id, handle, line or account', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const r = receipt(await erase(w, 'none'));
    expect(r.id).toMatch(/^e_[A-Za-z0-9_-]{20,}$/);
    expect(r.at).toBe(NOW);
    expect(r.mode).toBe('none');
    expect(Object.keys(r).sort()).toEqual(['at', 'id', 'kept', 'mode', 'removed']);
    const text = JSON.stringify(r);
    for (const needle of [w.aId, w.bId, A.account, A.handle, A_LINE, B_LINE, OWNER]) expect(text, needle).not.toContain(needle);
    expect(r.removed.strikes).toBe(1);
    expect(r.removed.reports_about).toBe(1);
    expect(r.removed.mutes).toBe(2);
    expect(r.removed.signals).toBe(1);
    expect(r.removed.workflow).toBeGreaterThanOrEqual(1);
  });

  it('is stored (counts only) and survives on the audit clock, with no pending subject once the erase is whole', async () => {
    const w = await privacyWorld();
    const r = receipt(await erase(w, 'none'));
    expect(w.store.loadPendingErasures()).toEqual([]);
    const text = dump(w.store);
    expect(text).toContain(r.id);
    await w.cw.purge({ auditMs: 365 * DAY });
    expect(dump(w.store)).toContain(r.id);
    w.clock.t = NOW + 400 * DAY;
    await w.cw.purge();
    expect(dump(w.store)).not.toContain(r.id);
  });
});

describe('the audit trail', () => {
  it('writes one privacy.erase row after the commit, by the owner, pointing at the receipt (the person is gone)', async () => {
    const w = await privacyWorld();
    const r = receipt(await erase(w, 'none'));
    const rows = w.store.listAudit({ limit: 20 }).filter((x) => x.action === 'privacy.erase');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: OWNER, role: 'owner', target: { type: 'person', ref: r.id } });
    expect(JSON.stringify(rows)).not.toContain(w.aId);
  });

  it('a dry run writes no audit row, no receipt and does not move the epoch', async () => {
    const w = await privacyWorld();
    await fillA(w);
    await w.cw.flush();
    const before = dump(w.store);
    const p = await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER, dryRun: true });
    expect('dryRun' in p && p.dryRun).toBe(true);
    expect(dump(w.store)).toBe(before);
    expect(w.store.erasureEpoch()).toBe(0);
  });

  it('dryRun returns the counts of a real run', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const preview = await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER, dryRun: true });
    if (!('dryRun' in preview)) throw new Error('expected a preview');
    const real = receipt(await erase(w, 'none'));
    expect(preview.removed).toEqual(real.removed);
    expect(preview.kept).toEqual(real.kept);
    expect(preview.mode).toBe('none');
  });

  it('auditFailed: a failing audit write after the commit is returned in the receipt and logged by class, and the erase stands', async () => {
    const store = fullStore();
    const w = await privacyWorld({}, store);
    (store as unknown as { insertAudit: () => never }).insertAudit = () => {
      throw new Error('audit disk full secret');
    };
    const r = receipt(await erase(w, 'none'));
    expect(r.auditFailed).toBe(true);
    expect(await w.cw.privacy.erase(w.aId, { keep: 'none', actor: OWNER })).toEqual({ ok: false, error: 'not_found' });
    expect(w.logged.some(([e, d]) => e === 'chatwarden.audit_failed' && d?.error === 'Error')).toBe(true);
    expect(JSON.stringify(w.logged)).not.toContain('secret');
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual([w.bId]);
  });

  it('no other audit row is ever rewritten: rows that name the person read the receipt, the rest are untouched', async () => {
    const w = await privacyWorld();
    w.store.insertAudit({ id: 'au-p', at: NOW - 5, actor: 'mod_ann', role: 'moderator', action: 'history.view', target: { type: 'person', ref: w.aId } });
    w.store.insertAudit({ id: 'au-q', at: NOW - 4, actor: 'mod_ann', role: 'moderator', action: 'history.view', target: { type: 'person', ref: w.bId } });
    w.store.insertAudit({ id: 'au-r', at: NOW - 3, actor: 'mod_ann', role: 'moderator', action: 'report.view', target: { type: 'report', ref: 'r-whatever' } });
    const r = receipt(await erase(w, 'none'));
    const rows = new Map(w.store.listAudit({ limit: 50 }).map((x) => [x.id, x]));
    expect(rows.get('au-p')?.target).toEqual({ type: 'person', ref: r.id });
    expect(rows.get('au-q')?.target).toEqual({ type: 'person', ref: w.bId });
    expect(rows.get('au-r')?.target).toEqual({ type: 'report', ref: 'r-whatever' });
  });
});

describe('invalid input', () => {
  it.each([
    ['a keep that is neither', { keep: 'some' as never, actor: OWNER }],
    ['no keep', { actor: OWNER } as never],
    ['an actor with a space', { keep: 'none' as const, actor: 'owner ann' }],
    ['no actor', { keep: 'none' as const } as never],
  ])('%s is invalid and writes nothing', async (_n, input) => {
    const w = await privacyWorld();
    const before = dump(w.store);
    expect(await w.cw.privacy.erase(w.aId, input)).toEqual({ ok: false, error: 'invalid' });
    expect(dump(w.store)).toBe(before);
  });
});

describe('held reports', () => {
  it('a held report (the legal set) survives under none with its lines, and the receipt counts it', async () => {
    const w = await privacyWorld();
    const ids = await fillA(w);
    await w.cw.legal.hold(ids.about, { code: 'legal_proceeding', actor: 'senior_gus' });
    const held = w.store.loadReport(ids.about);
    const r = receipt(await erase(w, 'none'));
    expect(r.kept.heldReports).toBe(1);
    expect(w.store.loadReport(ids.about)).toEqual(held);
    expect(w.store.loadReport(ids.about)?.excerpt.some((l) => l.raw.includes(A_LINE))).toBe(true);
    // everything else of the person is gone
    expect(w.store.loadStrikes(0).some((s) => s.subject === w.aId)).toBe(false);
  });
});

describe('keep safety (the remainder and its finish are in privacy-finish.test.ts)', () => {
  it('a person with no sanction in force loses the identifiers too and has no pending subject', async () => {
    const w = await privacyWorld();
    await fillA(w);
    const r = receipt(await erase(w, 'safety'));
    expect(r.kept.identifiers).toBe(false);
    expect(w.store.loadPendingErasures()).toEqual([]);
    expect((await w.store.loadSubjects()).subjects.map((s) => s.id)).not.toContain(w.aId);
  });

  it('with a ban in force the receipt says identifiers are kept and the receipt row has the pending subject; the person\'s other rows are gone', async () => {
    const w = await privacyWorld();
    await fillA(w);
    await w.cw.sanctions.apply({ kind: 'ban', subject: w.aId, includeIp: true, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    const r = receipt(await erase(w, 'safety'));
    expect(r.kept).toEqual({ identifiers: true, sanctions: 2, heldReports: 0 });
    expect(w.store.loadPendingErasures().map((p) => [p.id, p.pendingSubject])).toEqual([[r.id, w.aId]]);
    expect(w.store.loadStrikes(0).some((s) => s.subject === w.aId)).toBe(false);
    // the audit row of the erase still names the person while the remainder stands
    expect(w.store.listAudit({ limit: 20 }).find((x) => x.action === 'privacy.erase')?.target).toEqual({ type: 'person', ref: w.aId });
  });
});
