import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import type { Matcher } from '../src/types.js';
import { world } from './reportingWorld.js';

// The automatic restriction keeps the term of the strike that tipped it (0.2.1): the third strike's term. The key `termId` is the kit's own, like `reportId`.

const H = 3_600_000;
const ROOM = 'room-term';

/** Blocks three synthetic words, each with its own term id. */
const matcher: Matcher = {
  match: (t) => {
    const s = t.toLowerCase();
    if (s.includes('zorbak')) return { termId: 'syn:zorbak' };
    if (s.includes('vlemmo')) return { termId: 'syn:vlemmo' };
    if (s.includes('quissel')) return { termId: 'syn:quissel' };
    return null;
  },
};

async function kit(over: Parameters<typeof world>[0] = {}) {
  const store = withMemoryAppeals(new MemoryStore());
  const w = await world({ matcher, ...over }, store);
  w.cw.rooms.seat(ROOM, 'p1', { clientKey: 'key-speaker' }, 'Spk');
  w.cw.rooms.seat(ROOM, 'p2', { clientKey: 'key-other' }, 'Oth');
  const subject = w.cw.rooms.subjectAt(ROOM, 'p1') as string;
  const autoRows = () => store.rawSanctions().filter((r) => r.source === 'auto_filter');
  return { ...w, store, subject, autoRows };
}

describe('the automatic restriction carries the tipping term', () => {
  it('the subject row has the term id of the third strike, three different terms', async () => {
    const k = await kit();
    k.cw.chat.accept(ROOM, 'p1', 'zorbak');
    k.cw.chat.accept(ROOM, 'p1', 'vlemmo');
    expect(k.autoRows()).toEqual([]);
    k.cw.chat.accept(ROOM, 'p1', 'quissel');
    const [row, ...rest] = k.autoRows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ targetType: 'subject', value: k.subject, kind: 'chat', automated: true, termId: 'syn:quissel' });
    expect(k.store.loadSanctionSubjectRow(row?.groupId as string)?.termId).toBe('syn:quissel');
  });

  it('the same term three times gives that term; the order of the terms decides which one tipped', async () => {
    const a = await kit();
    for (let i = 0; i < 3; i += 1) a.cw.chat.accept(ROOM, 'p1', 'zorbak');
    expect(a.autoRows()[0]).toMatchObject({ termId: 'syn:zorbak' });
    const b = await kit();
    b.cw.chat.accept(ROOM, 'p1', 'quissel');
    b.cw.chat.accept(ROOM, 'p1', 'quissel');
    b.cw.chat.accept(ROOM, 'p1', 'vlemmo');
    expect(b.autoRows()[0]).toMatchObject({ termId: 'syn:vlemmo' });
  });

  it('a second restriction carries its own tipping term, not the first one', async () => {
    const k = await kit();
    for (const t of ['zorbak', 'zorbak', 'zorbak']) k.cw.chat.accept(ROOM, 'p1', t);
    k.clock.t += 2 * H; // the first restriction (30 minutes) is over
    for (const t of ['vlemmo', 'vlemmo', 'quissel']) k.cw.chat.accept(ROOM, 'p1', t);
    expect(k.autoRows().map((r) => r.termId)).toEqual(['syn:zorbak', 'syn:quissel']);
  });

  it('only the subject row has it: an address row of the group does not', async () => {
    const k = await kit();
    for (let i = 0; i < 3; i += 1) k.cw.chat.accept(ROOM, 'p1', 'vlemmo');
    for (const r of k.autoRows().filter((x) => x.targetType === 'ip')) expect(r).not.toHaveProperty('termId');
  });

  it('a moderator sanction and a decision carry no term id', async () => {
    const k = await kit();
    const f = await k.file();
    await k.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: f.target, kind: 'chat', durationMs: H, rule: 2, lineIds: [] }] } as never);
    await k.cw.sanctions.apply({ kind: 'ban', subject: f.target, includeIp: false, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    for (const r of k.store.rawSanctions()) expect(Object.keys(r), r.groupId).not.toContain('termId');
  });

  it('the strikes themselves are unchanged: three rows, each with its own term, in order', async () => {
    const k = await kit();
    for (const t of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(ROOM, 'p1', t);
    expect(k.store.loadStrikes(0).map((s) => s.termId)).toEqual(['syn:zorbak', 'syn:vlemmo', 'syn:quissel']);
  });
});

describe('a restriction written without the internal key rejects termId', () => {
  it('sanctions.apply from outside is the same RangeError as reportId, and nothing is written', async () => {
    const k = await kit();
    const f = await k.file();
    const input = { kind: 'chat', subject: f.target, includeIp: false, durationMs: H, reason: 'r', actor: 'm', source: 'moderator', automated: false, rule: 1 };
    await expect(k.cw.sanctions.apply({ ...input, termId: 'syn:zorbak' } as never)).rejects.toThrow(RangeError);
    await expect(k.cw.sanctions.apply({ ...input, reportId: 'rep_x' } as never)).rejects.toThrow(RangeError);
    expect(k.store.rawSanctions()).toEqual([]);
    // an undefined value is only refused when it has one
    await expect(k.cw.sanctions.apply({ ...input, termId: undefined } as never)).resolves.toBeDefined();
  });

  it('an inherited termId is refused as well', async () => {
    const k = await kit();
    const f = await k.file();
    const inherited = Object.assign(Object.create({ termId: 'syn:zorbak' }) as object, { kind: 'chat', subject: f.target, includeIp: false, durationMs: H, reason: 'r', actor: 'm', source: 'moderator', automated: false, rule: 1 });
    await expect(k.cw.sanctions.apply(inherited as never)).rejects.toThrow(RangeError);
  });
});

describe('the kill switch', () => {
  it('with sanctions enforcement off no row is written, so no term id is kept anywhere', async () => {
    const k = await kit({ enabled: () => false });
    for (const t of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(ROOM, 'p1', t);
    expect(k.autoRows()).toEqual([]);
    expect(k.store.loadStrikes(0)).toHaveLength(3);
  });
});
