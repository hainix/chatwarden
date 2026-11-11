import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { StoredReportRow } from '@chatwarden/store-memory';
import { REPORT_CATEGORIES } from '../src/reports.js';
import type { ReportRefusal } from '../src/reports.js';
import type { PolicyLayer } from '../src/profile.js';
import type { ReportCategory } from '../src/types.js';
import { staffReport } from '../src/staffReports.js';
import { OWNER, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// Report intake with the reporting settings: the three flows, reason ids and the 0.1.1 category alias, every refusal, and what is stored.

const flowLayer = (flow: 'one_tap' | 'reason_first' | 'reason_required'): PolicyLayer => ({ reporting: { flow } });
const setLayer = (w: World, layer: PolicyLayer): void => {
  const res = w.cw.policy.save(layer, { version: w.cw.policy.get().version, ...OWNER });
  if (!res.ok) throw new Error(`save failed: ${JSON.stringify(res)}`);
};
const rawOf = (w: World, i = 0): StoredReportRow => {
  const row = (w.store as MemoryStore).rawReports()[i];
  if (row === undefined) throw new Error('no stored report');
  return row;
};

describe('the default flow, one_tap', () => {
  it('a report with no reason is accepted and stored with reportedReason null', async () => {
    const w = await world();
    const t = w.table();
    const res = await w.submit(t.room);
    expect(res).toMatchObject({ ok: true });
    expect(rawOf(w).reportedReason).toBeNull();
    expect(rawOf(w).category).toBe('other');
  });

  it.each([[undefined], [null], [''], ['   '], ['\n\t']])('a missing reason (%j) is no reason', async (reason) => {
    const w = await world();
    const t = w.table();
    expect(await w.submit(t.room, { reason: reason as never })).toMatchObject({ ok: true });
    expect(rawOf(w).reportedReason).toBeNull();
  });

  it('a reason is stored as sent (trimmed)', async () => {
    const w = await world();
    const a = w.table();
    await w.submit(a.room, { reason: 'hate' });
    const b = w.table();
    await w.submit(b.room, { reason: '  spam  ' });
    expect([rawOf(w, 0).reportedReason, rawOf(w, 1).reportedReason]).toEqual(['hate', 'spam']);
  });

  it('every default reason id is accepted', async () => {
    const w = await world();
    for (const id of ['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'cheating', 'griefing', 'afk', 'other']) {
      const t = w.table();
      expect(await w.submit(t.room, { reason: id }), id).toMatchObject({ ok: true });
    }
    expect((w.store as MemoryStore).rawReports().map((r) => r.reportedReason)).toEqual([
      'harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'cheating', 'griefing', 'afk', 'other',
    ]);
  });

  it('a note is kept beside a reason and beside none', async () => {
    const w = await world();
    const a = w.table();
    await w.submit(a.room, { note: 'they keep following me' });
    const b = w.table();
    await w.submit(b.room, { reason: 'threat', note: 'said they would find me' });
    expect(rawOf(w, 0)).toMatchObject({ reportedReason: null, note: 'they keep following me' });
    expect(rawOf(w, 1)).toMatchObject({ reportedReason: 'threat', note: 'said they would find me' });
  });

  it('the stored category is the old one the reason reads as, so consumers of `category` keep working', async () => {
    const w = await world();
    const cases: Array<[string | undefined, ReportCategory]> = [
      [undefined, 'other'], ['harassment', 'harassment'], ['hate', 'hate'], ['spam', 'spam'], ['cheating', 'cheating'], ['griefing', 'disruption'],
      ['afk', 'disruption'], ['threat', 'harassment'], ['sexual', 'other'], ['personal_info', 'other'], ['other', 'other'],
    ];
    for (const [i, [reason]] of cases.entries()) {
      const t = w.table({ reporter: `key-rep-${i}` });
      await w.submit(t.room, reason === undefined ? {} : { reason });
    }
    expect((w.store as MemoryStore).rawReports().map((r) => r.category)).toEqual(cases.map(([, c]) => c));
    for (const c of (w.store as MemoryStore).rawReports().map((r) => r.category)) expect(REPORT_CATEGORIES).toContain(c);
  });
});

describe('reason_first behaves like one_tap in the kit (only the screen differs)', () => {
  it('a report with no reason is accepted; a reason is stored; an unknown one is refused', async () => {
    const w = await world({ overrides: { reporting: { flow: 'reason_first' } } });
    expect(w.cw.profile.reporting.flow).toBe('reason_first');
    const a = w.table();
    expect(await w.submit(a.room)).toMatchObject({ ok: true });
    const b = w.table();
    expect(await w.submit(b.room, { reason: 'cheating' })).toMatchObject({ ok: true });
    const c = w.table();
    expect(await w.submit(c.room, { reason: 'nope' })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect((w.store as MemoryStore).rawReports().map((r) => r.reportedReason)).toEqual([null, 'cheating']);
  });
});

describe('reason_required', () => {
  const required = () => world({ overrides: { reporting: { flow: 'reason_required' } } });

  it.each([[undefined], [null], [''], ['  ']])('a missing reason (%j) is refused with reason_required and nothing is stored', async (reason) => {
    const w = await required();
    const t = w.table();
    expect(await w.submit(t.room, { reason: reason as never })).toEqual({ ok: false, refused: 'reason_required' });
    expect((w.store as MemoryStore).rawReports()).toHaveLength(0);
  });

  it('a category given alone satisfies it (the alias), and a valid reason is accepted', async () => {
    const w = await required();
    const a = w.table();
    expect(await w.submit(a.room, { category: 'hate' })).toMatchObject({ ok: true });
    const b = w.table();
    expect(await w.submit(b.room, { reason: 'afk' })).toMatchObject({ ok: true });
  });

  it('an unknown or disabled reason is reason_unknown, not reason_required', async () => {
    const w = await world({
      overrides: { reporting: { flow: 'reason_required', reasons: [{ id: 'lag', label: 'Lag', enabled: false }, { id: 'rude', label: 'Rude' }, { id: 'other', label: 'Else' }] } },
    });
    for (const reason of ['lag', 'harassment', 'nope']) {
      const t = w.table();
      expect(await w.submit(t.room, { reason }), reason).toEqual({ ok: false, refused: 'reason_unknown' });
    }
    const t = w.table();
    expect(await w.submit(t.room, { reason: 'rude' })).toMatchObject({ ok: true });
  });

  it('the flow is live: saving the layer turns it on and resetting turns it off', async () => {
    const w = await world();
    const a = w.table();
    expect(await w.submit(a.room)).toMatchObject({ ok: true });
    setLayer(w, flowLayer('reason_required'));
    const b = w.table();
    expect(await w.submit(b.room)).toEqual({ ok: false, refused: 'reason_required' });
    const reset = w.cw.policy.reset('reporting');
    expect(reset).toMatchObject({ ok: true, changed: ['reporting'] });
    const c = w.table();
    expect(await w.submit(c.room)).toMatchObject({ ok: true });
  });
});

describe('reason_unknown, in every flow', () => {
  const bads: unknown[] = ['bogus', 'HATE', 'Hate', 'hate ish', 7, 0, true, {}, ['hate'], 'none', '__proto__', 'constructor', 'toString'];
  it.each(['one_tap', 'reason_first', 'reason_required'] as const)('flow %s: an unknown, wrong-case or non-text reason is refused', async (flow) => {
    const w = await world({ overrides: { reporting: { flow } } });
    for (const reason of bads) {
      const t = w.table();
      expect(await w.submit(t.room, { reason: reason as never }), String(reason)).toEqual({ ok: false, refused: 'reason_unknown' });
    }
    expect((w.store as MemoryStore).rawReports()).toHaveLength(0);
  });

  it('a switched-off reason is refused, and it is accepted again when switched on', async () => {
    const w = await world();
    const reasons = w.cw.profile.reporting.reasons.map((r) => (r.id === 'spam' ? { ...r, enabled: false } : { ...r }));
    setLayer(w, { reporting: { reasons } });
    const a = w.table();
    expect(await w.submit(a.room, { reason: 'spam' })).toEqual({ ok: false, refused: 'reason_unknown' });
    setLayer(w, {});
    const b = w.table();
    expect(await w.submit(b.room, { reason: 'spam' })).toMatchObject({ ok: true });
  });

  it('a studio reason is accepted, and a default one the studio left out is not', async () => {
    const w = await world({ overrides: { reporting: { reasons: [{ id: 'lag_switch', label: 'Lag switching' }, { id: 'other', label: 'Else' }] } } });
    const a = w.table();
    expect(await w.submit(a.room, { reason: 'lag_switch' })).toMatchObject({ ok: true });
    const b = w.table();
    expect(await w.submit(b.room, { reason: 'hate' })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(rawOf(w).reportedReason).toBe('lag_switch');
    expect(rawOf(w).category).toBe('other');
  });
});

describe('the 0.1.1 `category` input', () => {
  it('stays accepted as an alias of reason: the five old ids are themselves, disruption is griefing', async () => {
    const w = await world();
    for (const category of ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'] as const) {
      const t = w.table();
      expect(await w.submit(t.room, { category }), category).toMatchObject({ ok: true });
    }
    const rows = (w.store as MemoryStore).rawReports();
    expect(rows.map((r) => r.reportedReason)).toEqual(['harassment', 'hate', 'cheating', 'spam', 'griefing', 'other']);
    // The stored category is what a 0.1.1 consumer expected, unchanged.
    expect(rows.map((r) => r.category)).toEqual(['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other']);
  });

  it('reason wins when both are given, even when they disagree', async () => {
    const w = await world();
    const t = w.table();
    await w.submit(t.room, { reason: 'cheating', category: 'hate' });
    expect(rawOf(w).reportedReason).toBe('cheating');
  });

  it('keeps its 0.1.1 behaviour: an unknown or non-text category is taken and stored as other, in every flow', async () => {
    for (const flow of ['one_tap', 'reason_first', 'reason_required'] as const) {
      const w = await world({ overrides: { reporting: { flow } } });
      for (const category of ['bogus', 'HATE', 7, {}, ['hate'], true]) {
        const t = w.table();
        expect(await w.submit(t.room, { category: category as never }), `${flow} ${String(category)}`).toMatchObject({ ok: true });
      }
      const rows = (w.store as MemoryStore).rawReports();
      expect(rows).toHaveLength(6);
      for (const r of rows) expect([r.category, r.reportedReason]).toEqual(['other', 'other']);
    }
  });

  it('only the new reason field is refused: reason bogus is reason_unknown, and reason wins over category', async () => {
    const w = await world();
    const a = w.table();
    expect(await w.submit(a.room, { reason: 'bogus' })).toEqual({ ok: false, refused: 'reason_unknown' });
    const b = w.table();
    expect(await w.submit(b.room, { reason: 'bogus', category: 'hate' })).toEqual({ ok: false, refused: 'reason_unknown' });
    const c = w.table();
    expect(await w.submit(c.room, { reason: 'cheating', category: 'bogus' })).toMatchObject({ ok: true });
    expect(rawOf(w).reportedReason).toBe('cheating');
  });

  it('a blank reason falls back to the category (a blank category is still no reason)', async () => {
    const w = await world();
    for (const reason of ['', '   ', null, undefined]) {
      const t = w.table();
      expect(await w.submit(t.room, { reason, category: 'hate' } as never)).toMatchObject({ ok: true });
    }
    expect((w.store as MemoryStore).rawReports().map((r) => r.reportedReason)).toEqual(['hate', 'hate', 'hate', 'hate']);
    const blank = await world({ overrides: { reporting: { flow: 'reason_required' } } });
    const t = blank.table();
    expect(await blank.submit(t.room, { reason: '', category: '  ' } as never)).toEqual({ ok: false, refused: 'reason_required' });
  });

  it('a missing category with no reason is a report with no reason', async () => {
    const w = await world();
    const t = w.table();
    expect(await w.submit(t.room, { category: undefined })).toMatchObject({ ok: true });
    expect(rawOf(w).reportedReason).toBeNull();
  });

  it('an old id the studio switched off or left out becomes other (as in 0.1.1), an old id they redefined is theirs', async () => {
    const off = await world({ overrides: { reporting: { reasons: [{ id: 'griefing', label: 'Griefing', enabled: false }, { id: 'other', label: 'Else' }] } } });
    const a = off.table();
    expect(await off.submit(a.room, { category: 'disruption' })).toMatchObject({ ok: true });
    expect([rawOf(off).category, rawOf(off).reportedReason]).toEqual(['other', 'other']);
    // The same through the new field is a refusal.
    const b0 = off.table();
    expect(await off.submit(b0.room, { reason: 'disruption' })).toEqual({ ok: false, refused: 'reason_unknown' });
    const own = await world({ overrides: { reporting: { reasons: [{ id: 'disruption', label: 'Disruption' }, { id: 'other', label: 'Else' }] } } });
    const b = own.table();
    expect(await own.submit(b.room, { category: 'disruption' })).toMatchObject({ ok: true });
    expect(rawOf(own).reportedReason).toBe('disruption');
    expect(rawOf(own).category).toBe('disruption');
  });

  it('works for a reason_required flow and for a reason_first flow', async () => {
    for (const flow of ['reason_required', 'reason_first'] as const) {
      const w = await world({ overrides: { reporting: { flow } } });
      const t = w.table();
      expect(await w.submit(t.room, { category: 'spam' })).toMatchObject({ ok: true });
    }
  });
});

describe('refusal order', () => {
  const order: ReportRefusal[] = ['off', 'not_player', 'self', 'suspended', 'rate', 'duplicate'];

  it('the new refusals are part of the ReportRefusal type', () => {
    const all: ReportRefusal[] = [...order, 'reason_required', 'reason_unknown'];
    expect(all).toHaveLength(8);
  });

  it('off comes first: with the kit off a bad reason is off', async () => {
    let on = true;
    const w = await world({ enabled: () => on, overrides: { reporting: { flow: 'reason_required' } } });
    on = false;
    const t = w.table();
    expect(await w.submit(t.room, { reason: 'bogus' })).toEqual({ ok: false, refused: 'off' });
    expect(await w.submit(t.room)).toEqual({ ok: false, refused: 'off' });
  });

  it('a reporter with no seat is off before the reason is looked at', async () => {
    const w = await world({ overrides: { reporting: { flow: 'reason_required' } } });
    const t = w.table();
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'ghost', targetSeat: 'p2' })).toEqual({ ok: false, refused: 'off' });
  });

  it('the reason is checked before the target: a missing reason with a vacant target seat is reason_required', async () => {
    const w = await world({ overrides: { reporting: { flow: 'reason_required' } } });
    const t = w.table();
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'empty' })).toEqual({ ok: false, refused: 'reason_required' });
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'empty', reason: 'bogus' })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'empty', reason: 'hate' })).toEqual({ ok: false, refused: 'not_player' });
  });

  it('a refused reason never uses up the daily allowance and never counts as a duplicate', async () => {
    const w = await world({ overrides: { reporting: { flow: 'reason_required' } } });
    const t = w.table();
    for (let i = 0; i < 15; i++) expect(await w.submit(t.room, { reason: 'bogus' })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(await w.submit(t.room, { reason: 'hate' })).toMatchObject({ ok: true, remaining: 9 });
  });

  it('the reason is checked before the limits: a bad reason is reason_unknown even for a duplicate or past the daily allowance', async () => {
    const w = await world({ overrides: { reporting: { flow: 'reason_required' } } });
    const t = w.table();
    expect(await w.submit(t.room, { reason: 'hate' })).toMatchObject({ ok: true });
    expect(await w.submit(t.room, { reason: 'bogus' })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(await w.submit(t.room)).toEqual({ ok: false, refused: 'reason_required' });
    for (let i = 0; i < 9; i++) await w.file({ reason: 'spam' }, { reporter: 'key-reporter' });
    const late = w.table();
    expect(await w.submit(late.room, { reason: 'hate' })).toEqual({ ok: false, refused: 'rate', remaining: 0 });
    expect(await w.submit(late.room, { reason: 'bogus' })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(await w.submit(late.room)).toEqual({ ok: false, refused: 'reason_required' });
  });

  it('a valid reason does not bypass the later refusals: self, duplicate, rate still apply', async () => {
    const w = await world();
    const t = w.table();
    expect(await w.submit(t.room, { reason: 'hate' })).toMatchObject({ ok: true });
    expect(await w.submit(t.room, { reason: 'spam' })).toEqual({ ok: false, refused: 'duplicate' });
    expect(await w.cw.reports.submit({ roomId: t.room, reporterSeat: 'p1', targetSeat: 'p1', reason: 'hate' })).toEqual({ ok: false, refused: 'self' });
  });
});

describe('what is stored and announced', () => {
  it('the stored row has reportedReason and no follow-up yet', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate' });
    expect(rawOf(w)).toMatchObject({ id: f.id, reportedReason: 'hate', detailAt: null });
  });

  it('report.created and onReport carry the reported reason (an id or null), never the note', async () => {
    const seen: Array<unknown> = [];
    const heard: Array<unknown> = [];
    const w = await world({ onReport: (r) => void heard.push(r.reportedReason) });
    w.cw.on('*', (e) => void seen.push(e));
    await w.file({ reason: 'afk', note: 'planted-note-5520' });
    await w.file({});
    const created = seen.filter((e) => (e as { type: string }).type === 'report.created') as Array<Record<string, unknown>>;
    expect(created.map((e) => e['reportedReason'])).toEqual(['afk', null]);
    expect(created.map((e) => e['category'])).toEqual(['disruption', 'other']);
    expect(heard).toEqual(['afk', null]);
    expect(JSON.stringify(created)).not.toContain('planted-note-5520');
  });

  it('the staff record reads the reason as reportedReason', async () => {
    const w = await world();
    const a = await w.file({ reason: 'sexual' });
    const b = await w.file({});
    expect(w.cw.reports.get(a.id)?.reportedReason).toBe('sexual');
    expect(w.cw.reports.get(b.id)?.reportedReason).toBeNull();
  });
});

describe('reports stored before (legacy rows)', () => {
  const index = { canonical: (s: string) => s, aliasesOf: (s: string) => [s] };
  const legacyRow = (category: string): StoredReportRow =>
    ({
      id: 'old', createdAt: 1, roomId: 'r', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A', targetSubject: 's_b',
      targetSeat: 'p2', targetHandle: 'B', category, note: null, lineId: null, excerpt: [], people: [], status: 'open',
      badFaith: false, actionedAt: null, actionedBy: null, modNote: null, badFaithEvidence: null,
    }) as unknown as StoredReportRow;

  it('a record from a store that predates reportedReason reads its category as the reason; disruption is griefing', () => {
    for (const [category, reason] of [['harassment', 'harassment'], ['hate', 'hate'], ['cheating', 'cheating'], ['spam', 'spam'], ['disruption', 'griefing'], ['other', 'other']]) {
      expect(staffReport(legacyRow(category as string), index as never).reportedReason, category).toBe(reason);
    }
  });

  it('a record that has reportedReason null reads as no reason (a new report with none); the category is kept as stored', () => {
    const row = { ...legacyRow('other'), reportedReason: null, detailAt: null };
    const staff = staffReport(row, index as never);
    expect(staff.reportedReason).toBeNull();
    expect(staff.category).toBe('other');
  });

  it('a record with its own reportedReason keeps it whatever the category says', () => {
    const row = { ...legacyRow('other'), reportedReason: 'threat', detailAt: null };
    expect(staffReport(row, index as never).reportedReason).toBe('threat');
  });
});
