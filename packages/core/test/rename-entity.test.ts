import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { KitEvent } from '../src/events.js';
import type { NoticeRow, RawWho, SubjectId } from '../src/types.js';
import { world } from './reportingWorld.js';

// M6: renaming an ENTITY (a clan, guild, team, deck, pet, item). The kit has no screen for one, so it creates no notice and sets no pending flag: it emits `rename.required` with `entity: { kind, ref }` (never the label) and the
// game tells the owner in its own UI. The audit row `name.rename_required` is the route's (see http admin.entity).

const ACTOR = 'mod_ann';
const REASON = 'private note: the clan name impersonates staff';
const ENTITY = { kind: 'clan', ref: 'clan-4711' };

async function kit(names: Record<string, unknown> = { renames: true }) {
  const w = await world({ overrides: { names } } as never);
  const events: KitEvent[] = [];
  w.cw.on('*', (e) => void events.push(e));
  const seat = async (key: string): Promise<{ who: RawWho; subject: SubjectId }> => {
    const who: RawWho = { clientKey: key };
    w.cw.rooms.seat(`room-${key}`, 'p1', who, 'Name');
    await w.cw.flush();
    return { who, subject: w.cw.rooms.subjectAt(`room-${key}`, 'p1') as SubjectId };
  };
  const rows = (): NoticeRow[] => (w.store as MemoryStore).rawNotices();
  return { ...w, events, seat, rows };
}
const ask = (k: Awaited<ReturnType<typeof kit>>, subject: SubjectId, over: Record<string, unknown> = {}) =>
  k.cw.names.requireRename({ subject, actor: ACTOR, reason: REASON, rule: 2, ...over } as never);

describe('a rename with an entity', () => {
  it('creates no notice and sets no pending flag, and answers ok with no notice id', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    expect(ask(k, p.subject, { entity: ENTITY })).toEqual({ ok: true, noticeId: null });
    expect(k.rows()).toEqual([]);
    expect(k.cw.names.pendingRename(p.who)).toBe(false);
    expect(k.cw.notices.pending(p.who)).toEqual([]);
    expect(k.cw.names.renamesOf(p.subject)).toEqual([]);
  });

  it('emits rename.required with entity { kind, ref } and no label, and nothing else about it', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    ask(k, p.subject, { entity: ENTITY });
    const [event] = k.events.filter((e) => e.type === 'rename.required');
    expect(event).toEqual({ type: 'rename.required', at: expect.any(Number) as number, target: p.subject, rule: 2, entity: ENTITY });
    const text = JSON.stringify(k.events);
    expect(text).not.toContain('label');
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain('impersonates');
  });

  it('a rename without an entity is exactly as before: a notice, a pending flag, no entity key on the event', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    const out = ask(k, p.subject);
    expect(out).toMatchObject({ ok: true, noticeId: expect.any(String) as string });
    expect(k.rows()).toHaveLength(1);
    expect(k.cw.names.pendingRename(p.who)).toBe(true);
    const [event] = k.events.filter((e) => e.type === 'rename.required');
    expect(Object.hasOwn(event as object, 'entity')).toBe(false);
  });

  it('a player rename and an entity rename do not block each other, and an entity rename can repeat (it is never pending)', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    expect(ask(k, p.subject)).toMatchObject({ ok: true });
    expect(ask(k, p.subject, { entity: ENTITY })).toMatchObject({ ok: true });
    expect(ask(k, p.subject, { entity: ENTITY })).toMatchObject({ ok: true });
    expect(ask(k, p.subject, { entity: { kind: 'guild', ref: 'g-1' } })).toMatchObject({ ok: true });
    expect(ask(k, p.subject)).toEqual({ ok: false, error: 'pending' });
    expect(k.events.filter((e) => e.type === 'rename.required')).toHaveLength(4);
    expect(k.rows()).toHaveLength(1);
  });

  it('is off while names.renames is off, not_found for a person the kit does not hold, invalid for a bad rule or reason', async () => {
    const off = await kit({});
    const q = await off.seat('k1');
    expect(ask(off, q.subject, { entity: ENTITY })).toEqual({ ok: false, error: 'off' });
    const k = await kit();
    expect(ask(k, 's_nobody', { entity: ENTITY })).toEqual({ ok: false, error: 'not_found' });
    const p = await k.seat('k2');
    expect(ask(k, p.subject, { entity: ENTITY, reason: '' })).toEqual({ ok: false, error: 'invalid' });
    expect(ask(k, p.subject, { entity: ENTITY, rule: 9999 })).toEqual({ ok: false, error: 'invalid' });
    expect(k.events).toEqual([]);
  });

  it('the entity must be { kind, ref } and nothing else: a label, a bad kind or ref and other shapes are invalid, and nothing is emitted', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    const bad: unknown[] = [
      { ...ENTITY, label: 'Blue Wolves' },
      { kind: 'Clan', ref: 'x' },
      { kind: '', ref: 'x' },
      { kind: 'clan', ref: '' },
      { kind: 'clan', ref: 'a b' },
      { kind: 'clan', ref: 'x'.repeat(65) },
      { kind: 'clan' },
      { ref: 'x' },
      'clan',
      5,
      [],
      [ENTITY],
      { ...ENTITY, extra: true },
    ];
    for (const entity of bad) expect(ask(k, p.subject, { entity }), JSON.stringify(entity)).toEqual({ ok: false, error: 'invalid' });
    expect(k.events).toEqual([]);
    expect(k.rows()).toEqual([]);
  });

  it('entity undefined or null is a rename of the player (as if none was given)', async () => {
    const k = await kit();
    const a = await k.seat('k1');
    const b = await k.seat('k2');
    expect(ask(k, a.subject, { entity: undefined })).toMatchObject({ ok: true, noticeId: expect.any(String) as string });
    expect(ask(k, b.subject, { entity: null })).toMatchObject({ ok: true, noticeId: expect.any(String) as string });
  });

  it('the person the rename is about is the owner, followed through a merge', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    ask(k, p.subject, { entity: ENTITY });
    const [event] = k.events.filter((e) => e.type === 'rename.required') as Array<{ target: string }>;
    expect(event?.target).toBe(k.cw.people.canonical(p.subject));
  });
});
