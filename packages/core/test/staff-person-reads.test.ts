import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { RawWho, Store, SubjectId } from '../src/types.js';
import { appealsKit, HOUR } from './appealsWorld.js';
import { world } from './reportingWorld.js';

// Three small staff reads the HTTP routes need so a hub can show them: cw.names.renamesEnabled (the same capability test requireRename
// applies, so a hub never offers a rename that always answers off), cw.names.renamesOf (a person's rename requests, newest first) and
// cw.appeals.forPerson (a person's appeals as summaries, newest first, moot left out).

const ACTOR = 'mod_ann';
const REASON = 'private note: a name against the rules';

/** A store that cannot withdraw one notice: a rename could never be released, so renames read as off. */
function noWithdraw(): Store {
  const s = new MemoryStore();
  (s as unknown as { withdrawNotice?: unknown }).withdrawNotice = undefined;
  return s;
}

async function namesKit(names: Record<string, unknown>, store: Store = new MemoryStore()) {
  const w = await world({ overrides: { names }, platform: { identify: (ctx: unknown) => ctx as RawWho } } as never, store);
  const seat = async (key: string, extra: RawWho = {}): Promise<{ who: RawWho; subject: SubjectId }> => {
    const who: RawWho = { clientKey: key, ...extra };
    w.cw.rooms.seat(`room-${key}`, 'p1', who, 'Name');
    await w.cw.flush();
    return { who, subject: w.cw.rooms.subjectAt(`room-${key}`, 'p1') as SubjectId };
  };
  return { ...w, seat };
}

describe('names.renamesEnabled', () => {
  it('is false with the setting off, true with it on and a store that can withdraw', async () => {
    expect((await namesKit({})).cw.names.renamesEnabled()).toBe(false);
    expect((await namesKit({ renames: false })).cw.names.renamesEnabled()).toBe(false);
    expect((await namesKit({ renames: true })).cw.names.renamesEnabled()).toBe(true);
  });

  it('is false when the store cannot withdraw a notice, whatever the setting says', async () => {
    const k = await namesKit({ renames: true }, noWithdraw());
    expect(k.cw.names.renamesEnabled()).toBe(false);
    const p = await k.seat('k1');
    // The same capability requireRename uses: the two never disagree.
    expect(k.cw.names.requireRename({ subject: p.subject, actor: ACTOR, reason: REASON })).toEqual({ ok: false, error: 'off' });
  });

  it('is read live: turning the setting on in the policy takes effect at once', async () => {
    const k = await namesKit({});
    expect(k.cw.names.renamesEnabled()).toBe(false);
    k.cw.policy.save({ names: { renames: true } }, { version: 0, actor: 'owner', reason: 'family game' });
    expect(k.cw.names.renamesEnabled()).toBe(true);
  });
});

describe('names.renamesOf', () => {
  it('is empty for a person never asked, an unknown id and a non-string', async () => {
    const k = await namesKit({ renames: true });
    const p = await k.seat('k1');
    expect(k.cw.names.renamesOf(p.subject)).toEqual([]);
    expect(k.cw.names.renamesOf('s_nobody')).toEqual([]);
    expect(k.cw.names.renamesOf(5 as never)).toEqual([]);
    expect(k.cw.names.renamesOf('' as never)).toEqual([]);
  });

  it('lists each request with its time and whether it is still waiting, newest first, carrying nothing else', async () => {
    const k = await namesKit({ renames: true });
    const p = await k.seat('k1');
    const t1 = k.clock.now();
    expect(k.cw.names.requireRename({ subject: p.subject, actor: ACTOR, reason: REASON })).toMatchObject({ ok: true });
    expect(k.cw.names.renamesOf(p.subject)).toEqual([{ at: t1, pending: true }]);
    expect(k.cw.names.renamed(p.who)).toBe(true);
    expect(k.cw.names.renamesOf(p.subject)).toEqual([{ at: t1, pending: false }]);
    k.clock.t += HOUR;
    const t2 = k.clock.now();
    k.cw.names.requireRename({ subject: p.subject, actor: ACTOR, reason: REASON });
    const rows = k.cw.names.renamesOf(p.subject);
    expect(rows).toEqual([
      { at: t2, pending: true },
      { at: t1, pending: false },
    ]);
    expect(JSON.stringify(rows)).not.toContain(REASON);
    expect(JSON.stringify(rows)).not.toContain(ACTOR);
  });

  it('reads through a merged alias and never counts another person or another notice kind', async () => {
    const k = await namesKit({ renames: true });
    const a = await k.seat('ka', { accountId: 'acct-m' });
    const other = await k.seat('kz');
    k.cw.names.requireRename({ subject: other.subject, actor: ACTOR, reason: REASON });
    expect(k.cw.names.renamesOf(a.subject)).toEqual([]);
    const b = await k.seat('kb', { accountId: 'acct-m' });
    k.cw.names.requireRename({ subject: b.subject, actor: ACTOR, reason: REASON });
    expect(k.cw.names.renamesOf(a.subject)).toHaveLength(1);
    expect(k.cw.names.renamesOf(b.subject)).toHaveLength(1);
  });

  it('is bounded (the newest 20)', async () => {
    const k = await namesKit({ renames: true });
    const p = await k.seat('k1');
    for (let i = 0; i < 25; i++) {
      k.clock.t += 1000;
      k.cw.names.requireRename({ subject: p.subject, actor: ACTOR, reason: REASON });
      k.cw.names.renamed(p.who);
    }
    const rows = k.cw.names.renamesOf(p.subject);
    expect(rows).toHaveLength(20);
    expect(rows[0]?.at).toBe(k.clock.now());
  });
});

describe('appeals.forPerson', () => {
  it('is empty for an unknown person, a non-string and with appeals off', async () => {
    const k = await appealsKit();
    expect(k.cw.appeals.forPerson('s_nobody')).toEqual([]);
    expect(k.cw.appeals.forPerson(5 as never)).toEqual([]);
    const off = await world({} as never);
    expect(off.cw.appeals.forPerson('s_nobody')).toEqual([]);
  });

  it('lists the person\'s appeals as summaries, newest first, and only theirs; the statement is not in them', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const a = await k.sanction({ key: 'key-a', kind: 'chat', durationMs: 6 * HOUR });
    const a2 = await k.sanction({ key: 'key-a', kind: 'ban', durationMs: null });
    const b = await k.sanction({ key: 'key-b' });
    const r1 = k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'first statement text' });
    k.clock.t += 1000;
    const r2 = k.cw.appeals.file(a2.who, { noticeId: a2.noticeId, statement: 'second statement text' });
    k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: 'someone else' });
    if (!r1.ok || !r2.ok) throw new Error('filing refused');
    const mine = k.cw.appeals.forPerson(a.subject);
    expect(mine.map((x) => x.id)).toEqual([r2.appeal.id, r1.appeal.id]);
    expect(mine[0]).toMatchObject({ person: a.subject, status: 'open', sanction: { groupId: a2.groupId, kind: 'ban' } });
    expect(JSON.stringify(mine)).not.toContain('statement text');
    expect(k.cw.appeals.forPerson(b.subject)).toHaveLength(1);
  });

  it('shows the outcome once decided, and leaves out an appeal made moot', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const a = await k.sanction({ key: 'key-a' });
    const a2 = await k.sanction({ key: 'key-a', kind: 'ban', durationMs: null });
    const r1 = k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 's one' });
    const r2 = k.cw.appeals.file(a2.who, { noticeId: a2.noticeId, statement: 's two' });
    if (!r1.ok || !r2.ok) throw new Error('filing refused');
    await k.cw.appeals.decide({ appealId: r1.appeal.id, outcome: 'uphold', actor: 'senior_bea', reason: 'r' });
    expect(k.cw.appeals.forPerson(a.subject).find((x) => x.id === r1.appeal.id)?.status).toBe('upheld');
    await k.cw.sanctions.revoke(a2.groupId, 'senior_cy', 'made a mistake');
    const after = k.cw.appeals.forPerson(a.subject);
    expect(after.map((x) => x.id)).toEqual([r1.appeal.id]);
  });
});
