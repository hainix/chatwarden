import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { KitEvent } from '../src/events.js';
import { DEFAULT_REPORT_REASONS } from '../src/reporting.js';
import type { StoredReport } from '../src/types.js';
import { world } from './reportingWorld.js';

// M6: `ReportInput.entity`, a report about a clan, guild, team or deck. The report is filed against the owner's seat as always; the entity is stored on the report as `{ kind, ref, label }` and shown with it.
// Synthetic names only.

const ENTITY = { kind: 'clan', ref: 'clan-4711', label: 'Blue Wolves' };

async function kit(over: Record<string, unknown> = {}) {
  const reported: StoredReport[] = [];
  const events: KitEvent[] = [];
  const w = await world({ onReport: (r: StoredReport) => void reported.push(r), ...over } as never);
  w.cw.on('*', (e) => void events.push(e));
  return { ...w, reported, events };
}

const first = (k: Awaited<ReturnType<typeof kit>>) => k.cw.reports.list({ status: 'open' }).items[0];

describe('the grammar', () => {
  it('kind is a lowercase letter then lowercase letters and underscores, up to 24 characters', async () => {
    const k = await kit();
    for (const ok of ['clan', 'guild', 'pet_name', 'a', 'a'.repeat(24)]) {
      const t = k.table();
      const res = await k.submit(t.room, { entity: { ...ENTITY, kind: ok } });
      expect(res.ok, ok).toBe(true);
    }
    for (const bad of ['', 'Clan', '1clan', 'clan1', 'clan-x', '_clan', 'a'.repeat(25), 'cl an', 5, null, undefined, {}]) {
      const t = k.table();
      const res = await k.submit(t.room, { entity: { ...ENTITY, kind: bad } as never });
      expect(res, String(bad)).toEqual({ ok: false, refused: 'entity_invalid' });
    }
  });

  it('ref is a token of 1 to 64 characters of A-Za-z0-9_:-', async () => {
    const k = await kit();
    for (const ok of ['c', 'clan_47', 'clan:47', 'A-b_9', 'x'.repeat(64)]) {
      const t = k.table();
      expect((await k.submit(t.room, { entity: { ...ENTITY, ref: ok } })).ok, ok).toBe(true);
    }
    for (const bad of ['', 'x'.repeat(65), 'a b', 'a/b', 'a.b', 'caf\u00e9', 5, null, undefined]) {
      const t = k.table();
      expect(await k.submit(t.room, { entity: { ...ENTITY, ref: bad } as never }), String(bad)).toEqual({ ok: false, refused: 'entity_invalid' });
    }
  });

  it('label is 1 to 64 characters with no control character, trimmed; whitespace only is empty', async () => {
    const k = await kit();
    for (const ok of ['W', 'Blue Wolves', 'x'.repeat(64), 'L\u00e9gion \u2603', '  Spaced  ']) {
      const t = k.table();
      expect((await k.submit(t.room, { entity: { ...ENTITY, label: ok } })).ok, ok).toBe(true);
    }
    expect(k.cw.reports.list({ status: 'open' }).items.map((r) => r.entity?.label)).toContain('Spaced');
    for (const bad of ['', '   ', 'x'.repeat(65), 'a\u0000b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u0085b', 'a\u2028b', 5, null, undefined]) {
      const t = k.table();
      expect(await k.submit(t.room, { entity: { ...ENTITY, label: bad } as never }), String(bad)).toEqual({ ok: false, refused: 'entity_invalid' });
    }
  });

  it('the entity is an object with exactly kind, ref and label: other shapes and extra keys are refused', async () => {
    const k = await kit();
    for (const bad of ['clan', 5, [], [ENTITY], { kind: 'clan', ref: 'x' }, { ...ENTITY, extra: 1 }, { ...ENTITY, owner: 's_1' }, Object.assign(Object.create({ kind: 'clan' }) as object, { ref: 'a', label: 'b' })]) {
      const t = k.table();
      expect(await k.submit(t.room, { entity: bad as never }), JSON.stringify(bad)).toEqual({ ok: false, refused: 'entity_invalid' });
    }
  });

  it('no entity, undefined and null are the same: a report with none, stored as null', async () => {
    const k = await kit();
    for (const given of [{}, { entity: undefined }, { entity: null }]) {
      const t = k.table();
      expect((await k.submit(t.room, given as never)).ok).toBe(true);
    }
    for (const r of k.cw.reports.list({ status: 'open' }).items) expect(r.entity).toBeNull();
  });

  it('a refusal says entity_invalid and never echoes the label, ref or kind', async () => {
    const k = await kit();
    const t = k.table();
    const res = await k.submit(t.room, { entity: { kind: 'Clan!', ref: 'PRIVATE-REF', label: 'PRIVATE LABEL\u0000' } });
    expect(JSON.stringify(res)).not.toContain('PRIVATE');
    expect(JSON.stringify(k.logged)).not.toContain('PRIVATE');
  });
});

describe('what is stored and shown', () => {
  it('the report stores the entity and the staff list shows it; one without is unchanged', async () => {
    const k = await kit();
    const t = k.table();
    expect((await k.submit(t.room, { entity: ENTITY })).ok).toBe(true);
    expect(first(k)?.entity).toEqual(ENTITY);
    expect(first(k)).toMatchObject({ targetPerson: t.target, status: 'open' });
    const plain = k.table();
    await k.submit(plain.room);
    const rows = k.cw.reports.list({ status: 'open' }).items;
    expect(rows.map((r) => r.entity)).toEqual(expect.arrayContaining([ENTITY, null]));
  });

  it('get by id carries it, and the store row has it (onReport hands the stored report to staff channels)', async () => {
    const k = await kit();
    const t = k.table();
    const res = await k.submit(t.room, { entity: ENTITY });
    if (!res.ok) throw new Error('refused');
    expect(k.cw.reports.get(res.reportId)?.entity).toEqual(ENTITY);
    expect(k.reported[0]?.entity).toEqual(ENTITY);
    expect(k.store.loadReport(res.reportId)?.entity).toEqual(ENTITY);
  });

  it('the stored entity is a copy: changing the input afterwards changes nothing', async () => {
    const k = await kit();
    const t = k.table();
    const entity = { ...ENTITY };
    await k.submit(t.room, { entity });
    entity.label = 'Changed';
    expect(first(k)?.entity?.label).toBe('Blue Wolves');
  });

  it('the report is still filed against the owner of the seat, with the same excerpt, people and room', async () => {
    const k = await kit();
    const t = k.table();
    k.cw.chat.accept(t.room, 'p2', 'hello there');
    await k.submit(t.room, { entity: ENTITY });
    expect(first(k)).toMatchObject({ targetPerson: t.target, targetSeat: 'p2', roomId: t.room });
    expect(first(k)?.excerpt.map((l) => l.raw)).toEqual(['hello there']);
  });

  it('no event holds the label, ref or kind', async () => {
    const k = await kit();
    const t = k.table();
    await k.submit(t.room, { entity: ENTITY });
    const text = JSON.stringify(k.events);
    for (const leak of ['Blue Wolves', 'clan-4711']) expect(text).not.toContain(leak);
  });

  it('a filter report or a system report has no entity', async () => {
    const k = await kit();
    const t = k.table();
    const lineId = (k.cw.chat.accept(t.room, 'p1', 'hello') as { deliver: { lineId: string } }).deliver.lineId;
    expect(await k.cw.reports.fileSystem({ origin: 'filter', originKey: 'link.unlisted', roomId: t.room, target: t.reporter, lineId, reportedReason: 'spam' })).toBe('filed');
    expect(first(k)?.entity).toBeNull();
  });
});

describe('the rules are the same', () => {
  it('the reporter budget counts a report with an entity like any other', async () => {
    const k = await kit();
    const a = k.table();
    const withEntity = await k.submit(a.room, { entity: ENTITY });
    const b = k.table();
    const without = await k.submit(b.room);
    if (!withEntity.ok || !without.ok) throw new Error('refused');
    expect(withEntity.remaining - 1).toBe(without.remaining);
  });

  it('an invalid entity is refused before anything is spent: no row, no budget, no duplicate lock', async () => {
    const k = await kit();
    const t = k.table();
    expect(await k.submit(t.room, { entity: { ...ENTITY, label: '' } })).toEqual({ ok: false, refused: 'entity_invalid' });
    expect(k.cw.reports.list({ status: 'open' }).items).toHaveLength(0);
    const ok = await k.submit(t.room, { entity: ENTITY });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.remaining).toBe(k.cw.limits.reports.perDay - 1);
  });

  it('the same reporter, target and room is a duplicate whatever the entity says', async () => {
    const k = await kit();
    const t = k.table();
    expect((await k.submit(t.room, { entity: ENTITY })).ok).toBe(true);
    expect(await k.submit(t.room, { entity: { ...ENTITY, ref: 'other' } })).toMatchObject({ ok: false, refused: 'duplicate' });
    expect(await k.submit(t.room)).toMatchObject({ ok: false, refused: 'duplicate' });
  });

  it('reason and entity are checked in that order, and an entity with a bad reason is a reason refusal', async () => {
    const k = await kit();
    const t = k.table();
    expect(await k.submit(t.room, { reason: 'nope', entity: ENTITY })).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(await k.submit(t.room, { reason: 'nope', entity: { ...ENTITY, kind: '' } })).toEqual({ ok: false, refused: 'reason_unknown' });
  });

  it('a report that is off (kill switch) stays off with an entity', async () => {
    const k = await kit({ enabled: () => false });
    const t = k.table();
    expect(await k.submit(t.room, { entity: ENTITY })).toEqual({ ok: false, refused: 'off' });
  });
});

describe('the impersonation reason', () => {
  it('is present in the default reasons, disabled, in the Chat group, mapped to Community Rule 2', () => {
    const r = DEFAULT_REPORT_REASONS.find((x) => x.id === 'impersonation');
    expect(r).toMatchObject({ id: 'impersonation', label: 'Pretending to be staff or someone else', group: 'Chat', rules: [2], enabled: false, urgent: false, asksNote: false, showResources: false });
    expect(r?.hint.length).toBeGreaterThan(0);
  });

  it('a report with it is refused reason_unknown until an owner enables it, then it is taken', async () => {
    const k = await kit();
    const t = k.table();
    expect(await k.submit(t.room, { reason: 'impersonation' })).toEqual({ ok: false, refused: 'reason_unknown' });
    const reasons = k.cw.profile.reporting.reasons.map((x) => (x.id === 'impersonation' ? { ...x, enabled: true } : x));
    expect(k.cw.policy.save({ reporting: { reasons } }, { version: 0, actor: 'owner_ann', reason: 'staff names' })).toMatchObject({ ok: true });
    expect(await k.submit(t.room, { reason: 'impersonation' })).toMatchObject({ ok: true });
    expect(first(k)).toMatchObject({ reportedReason: 'impersonation' });
  });

  it('it does not show in the player-facing reasons while it is disabled', async () => {
    const k = await kit();
    expect(k.cw.profile.reporting.reasons.filter((x) => x.enabled).map((x) => x.id)).not.toContain('impersonation');
  });

  it('it is not urgent and does not map to the welfare resources', () => {
    const r = DEFAULT_REPORT_REASONS.find((x) => x.id === 'impersonation');
    expect(r?.urgent).toBe(false);
    expect(r?.showResources).toBe(false);
  });
});

describe('the store keeps it', () => {
  it('a memory store round-trips the entity as a copy, and a row inserted without one reads null', () => {
    const store = new MemoryStore();
    const base = {
      id: 'r1', createdAt: 1, roomId: 'x', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A', targetSubject: 's_b', targetSeat: 'p2', targetHandle: 'B',
      category: 'other' as const, note: null, lineId: null, excerpt: [], people: [], status: 'open' as const,
    };
    expect(store.insertReport({ ...base, entity: ENTITY })).toBe(true);
    expect(store.insertReport({ ...base, id: 'r2', reporterSubject: 's_c' })).toBe(true);
    expect(store.loadReport('r1')?.entity).toEqual(ENTITY);
    expect(store.loadReport('r2')?.entity).toBeNull();
    const held = store.loadReport('r1');
    if (held?.entity) held.entity.label = 'changed';
    expect(store.loadReport('r1')?.entity?.label).toBe('Blue Wolves');
  });
});
