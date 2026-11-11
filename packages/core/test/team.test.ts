import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import {
  CLAIM_TTL_MS,
  REASON_LABEL_MAX,
  REASON_TEXT_MAX,
  REASONS_MAX,
  ReasonError,
  CLAIM_BUSY_TRIES,
  VIEWING_PER_ACTOR_MAX,
  VIEWING_TTL_MS,
  ViewingPresence,
  createChatwarden,
} from '../src/index.js';
import type { Chatwarden, RawWho, ReportCategory } from '../src/index.js';

// The team workbench facade (K4 Task 4b): cw.cases (claims, take next, viewing), cw.changes and cw.reasons, on the
// in-memory store with a clock the test drives.

const NOW = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

async function setup() {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const cw = await createChatwarden({
    store,
    secret: 'team-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    retention: false,
    logger: { warn() {} },
  });
  let n = 0;
  /** File a report against a brand-new person; returns the report id and the person (canonical subject). */
  const file = async (category: ReportCategory = 'harassment', key?: string) => {
    n += 1;
    const room = `team-room-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `reporter-key-${n}` }, 'Rep');
    cw.rooms.seat(room, 'p2', { clientKey: key ?? `target-key-${n}` }, 'Tgt');
    cw.chat.accept(room, 'p2', 'a line');
    clock.t += 1000;
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category });
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    const rep = cw.reports.get(res.reportId);
    if (rep === null) throw new Error('missing');
    return { id: res.reportId, person: rep.targetPerson, room };
  };
  /** A second report against the same person (another reporter, another room). */
  const fileAgain = async (target: { room: string; person: string }, key: string, category: ReportCategory = 'harassment') => {
    n += 1;
    const room = `team-room-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `reporter-key-${n}` }, 'Rep');
    cw.rooms.seat(room, 'p2', { clientKey: key }, 'Tgt');
    cw.chat.accept(room, 'p2', 'a line');
    clock.t += 1000;
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category });
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { id: res.reportId, person: cw.reports.get(res.reportId)!.targetPerson };
  };
  const decide = (c: Chatwarden, id: string, person: string) =>
    c.decide({ reportId: id, verdict: 'upheld', actions: [{ subject: person, kind: 'warning', durationMs: null, rule: 1 }], actor: 'ann', reason: 'r' });
  /** A report with the given reason (null: none given), against a brand-new person. */
  const fileReason = async (reason: string | null) => {
    n += 1;
    const room = `team-room-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `reporter-key-${n}` }, 'Rep');
    cw.rooms.seat(room, 'p2', { clientKey: `target-key-${n}` }, 'Tgt');
    cw.chat.accept(room, 'p2', 'a line');
    clock.t += 1000;
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', reason });
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { id: res.reportId, person: cw.reports.get(res.reportId)!.targetPerson };
  };
  return { cw, store, clock, file, fileAgain, fileReason, decide };
}

describe('constants', () => {
  it('the claim lasts 10 minutes, viewing 30 seconds, and a reason has the stated limits', () => {
    expect(CLAIM_TTL_MS).toBe(10 * MIN);
    expect(VIEWING_TTL_MS).toBe(30 * SEC);
    expect(REASON_LABEL_MAX).toBe(40);
    expect(REASON_TEXT_MAX).toBe(500);
    expect(REASONS_MAX).toBe(200);
  });
});

describe('cases.claim', () => {
  it('claims an open case: who, since when, until when (10 minutes on the injected clock)', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    const out = cw.cases.claim(r.person, 'ann');
    expect(out).toEqual({ ok: true, claim: { by: 'ann', since: clock.t, until: clock.t + CLAIM_TTL_MS }, tookOverFrom: null });
    expect(cw.cases.holder(r.person)).toEqual({ by: 'ann', since: clock.t, until: clock.t + CLAIM_TTL_MS });
  });

  it('a person with no open case cannot be claimed: unknown, never reported, and fully decided', async () => {
    const { cw, file, decide } = await setup();
    expect(cw.cases.claim('s_nobody', 'ann')).toEqual({ ok: false, error: 'no_case' });
    const r = await file();
    await decide(cw, r.id, r.person);
    expect(cw.cases.claim(r.person, 'ann')).toEqual({ ok: false, error: 'no_case' });
    expect(cw.cases.holder(r.person)).toBeNull();
  });

  it('another moderator is refused while it is live and is told who holds it', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    cw.cases.claim(r.person, 'ann');
    clock.t += 3 * MIN;
    const out = cw.cases.claim(r.person, 'bea');
    expect(out).toEqual({ ok: false, error: 'claimed', claim: { by: 'ann', since: NOW + 1000, until: NOW + 1000 + CLAIM_TTL_MS } });
  });

  it('a heartbeat from the holder extends the claim and keeps since', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    const first = cw.cases.claim(r.person, 'ann');
    clock.t += 4 * MIN;
    const beat = cw.cases.claim(r.person, 'ann');
    expect(first.ok && beat.ok).toBe(true);
    if (first.ok && beat.ok) {
      expect(beat.claim.since).toBe(first.claim.since);
      expect(beat.claim.until).toBe(clock.t + CLAIM_TTL_MS);
      expect(beat.tookOverFrom).toBeNull();
    }
    // Without the beat the claim would have lapsed at the original end; with it, the case is still held there.
    clock.t = first.ok ? first.claim.until + 1 : 0;
    expect(cw.cases.claim(r.person, 'bea')).toMatchObject({ ok: false, error: 'claimed' });
  });

  it('a claim lapses 10 minutes after the last beat, and then anyone may claim', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    cw.cases.claim(r.person, 'ann');
    clock.t += CLAIM_TTL_MS - 1;
    expect(cw.cases.holder(r.person)?.by).toBe('ann');
    expect(cw.cases.claim(r.person, 'bea').ok).toBe(false);
    clock.t += 1;
    expect(cw.cases.holder(r.person)).toBeNull();
    expect(cw.cases.claim(r.person, 'bea')).toMatchObject({ ok: true, claim: { by: 'bea' }, tookOverFrom: null });
  });

  it('take over moves a live claim to the caller and says whom it came from', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    cw.cases.claim(r.person, 'ann');
    clock.t += MIN;
    const out = cw.cases.claim(r.person, 'sam', { takeOver: true });
    expect(out).toEqual({ ok: true, claim: { by: 'sam', since: clock.t, until: clock.t + CLAIM_TTL_MS }, tookOverFrom: 'ann' });
    expect(cw.cases.claim(r.person, 'ann')).toMatchObject({ ok: false, error: 'claimed', claim: { by: 'sam' } });
  });

  it('take over of a free case is a plain claim; take over by the holder is a heartbeat', async () => {
    const { cw, file } = await setup();
    const r = await file();
    expect(cw.cases.claim(r.person, 'sam', { takeOver: true })).toMatchObject({ ok: true, tookOverFrom: null });
    expect(cw.cases.claim(r.person, 'sam', { takeOver: true })).toMatchObject({ ok: true, tookOverFrom: null });
  });

  it('claims are per person: two cases, two holders', async () => {
    const { cw, file } = await setup();
    const a = await file();
    const b = await file();
    expect(cw.cases.claim(a.person, 'ann').ok).toBe(true);
    expect(cw.cases.claim(b.person, 'bea').ok).toBe(true);
    expect(cw.cases.holder(a.person)?.by).toBe('ann');
    expect(cw.cases.holder(b.person)?.by).toBe('bea');
  });

  it('two moderators claiming back to back: exactly one wins, both orders', async () => {
    for (const order of [['ann', 'bea'], ['bea', 'ann']] as const) {
      const { cw, file } = await setup();
      const r = await file();
      const tries = await Promise.all(order.map(async (who) => Promise.resolve().then(() => cw.cases.claim(r.person, who))));
      expect(tries.filter((t) => t.ok)).toHaveLength(1);
      expect(tries.filter((t) => !t.ok && t.error === 'claimed')).toHaveLength(1);
      expect(cw.cases.holder(r.person)?.by).toBe(order[0]);
    }
  });

  it('refuses an actor the audit trail could not hold, and an empty or non-string person', async () => {
    const { cw, file } = await setup();
    const r = await file();
    for (const bad of ['', 'Ann Smith', 'x'.repeat(129), 'a/b']) {
      expect(() => cw.cases.claim(r.person, bad)).toThrow(RangeError);
      expect(() => cw.cases.release(r.person, bad)).toThrow(RangeError);
      expect(() => cw.cases.next(bad)).toThrow(RangeError);
      expect(() => cw.cases.view(r.person, bad)).toThrow(RangeError);
    }
    expect(() => cw.cases.claim('', 'ann')).toThrow(RangeError);
    expect(() => cw.cases.claim(7 as never, 'ann')).toThrow(RangeError);
    expect(cw.cases.holder(r.person)).toBeNull();
  });

  it('claims the canonical person: a claim through a merged alias is the person', async () => {
    const { cw, file } = await setup();
    const r = await file('harassment', 'alias-key-1');
    // Merge: one person seen under the key (r.person), another under an account alone; then someone shows both.
    cw.rooms.seat('merge-room', 'a', { accountId: 'acct-merge' }, 'A');
    const other = cw.rooms.subjectAt('merge-room', 'a') as string;
    cw.rooms.seat('merge-room', 'b', { clientKey: 'alias-key-1', accountId: 'acct-merge' }, 'B');
    await cw.flush();
    const canon = cw.people.canonical(r.person);
    expect(cw.people.canonical(other)).toBe(canon);
    const alias = [r.person, other].find((x) => x !== canon);
    expect(alias).toBeDefined();
    if (alias === undefined) return;
    expect(cw.cases.claim(alias, 'ann')).toMatchObject({ ok: true });
    expect(cw.cases.holder(canon)?.by).toBe('ann');
    expect(cw.cases.holder(alias)?.by).toBe('ann');
  });
});

describe('cases.release', () => {
  it('the holder releases; the case is free for the next moderator', async () => {
    const { cw, file } = await setup();
    const r = await file();
    cw.cases.claim(r.person, 'ann');
    expect(cw.cases.release(r.person, 'ann')).toBe(true);
    expect(cw.cases.holder(r.person)).toBeNull();
    expect(cw.cases.claim(r.person, 'bea').ok).toBe(true);
  });

  it("someone else cannot release it, and releasing nothing is false; a double release is true then false", async () => {
    const { cw, file } = await setup();
    const r = await file();
    cw.cases.claim(r.person, 'ann');
    expect(cw.cases.release(r.person, 'bea')).toBe(false);
    expect(cw.cases.holder(r.person)?.by).toBe('ann');
    expect(cw.cases.release('s_nobody', 'ann')).toBe(false);
    expect(cw.cases.release(r.person, 'ann')).toBe(true);
    expect(cw.cases.release(r.person, 'ann')).toBe(false);
  });
});

describe('cases.releaseWhenDone: a decision keeps the claim while the person has other open reports', () => {
  it('3 open reports: deciding one keeps the claim as it was (same holder, same expiry), the second too, the last releases it', async () => {
    const { cw, file, fileAgain, decide, clock } = await setup();
    const a = await file('harassment', 'same-target-key');
    const b = await fileAgain(a, 'same-target-key');
    const c = await fileAgain(a, 'same-target-key');
    expect(b.person).toBe(a.person);
    expect(c.person).toBe(a.person);
    cw.cases.claim(a.person, 'ann');
    const held = cw.cases.holder(a.person);

    await decide(cw, a.id, a.person);
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(false);
    expect(cw.cases.holder(a.person)).toEqual(held);

    clock.t += MIN;
    await decide(cw, b.id, a.person);
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(false);
    expect(cw.cases.holder(a.person)?.by).toBe('ann');

    await decide(cw, c.id, a.person);
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(true);
    expect(cw.cases.holder(a.person)).toBeNull();
    // Nothing left to release: false, and not an error.
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(false);
  });

  it('a kept claim carries on as normal: its heartbeat and its lapse', async () => {
    const { cw, file, fileAgain, decide, clock } = await setup();
    const a = await file('harassment', 'same-target-key');
    await fileAgain(a, 'same-target-key');
    cw.cases.claim(a.person, 'ann');
    await decide(cw, a.id, a.person);
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(false);
    clock.t += 9 * MIN;
    expect(cw.cases.claim(a.person, 'ann').ok).toBe(true);
    clock.t += CLAIM_TTL_MS;
    expect(cw.cases.holder(a.person)).toBeNull();
  });

  it('only the actor named: another moderator claim, a lapsed one and no claim are all false, and never freed', async () => {
    const { cw, file, decide, clock } = await setup();
    const a = await file();
    cw.cases.claim(a.person, 'ann');
    await decide(cw, a.id, a.person);
    expect(cw.cases.releaseWhenDone(a.person, 'bea')).toBe(false);
    expect(cw.cases.holder(a.person)?.by).toBe('ann');
    clock.t += CLAIM_TTL_MS;
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(false);
    expect(cw.cases.releaseWhenDone('s_nobody', 'ann')).toBe(false);
  });

  it('a report about someone else does not count as "another open report" of this person', async () => {
    const { cw, file, decide } = await setup();
    const a = await file();
    await file();
    cw.cases.claim(a.person, 'ann');
    await decide(cw, a.id, a.person);
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(true);
  });

  it('a report that arrives after the decision still counts: the claim is kept', async () => {
    const { cw, file, fileAgain, decide } = await setup();
    const a = await file('harassment', 'same-target-key');
    cw.cases.claim(a.person, 'ann');
    await decide(cw, a.id, a.person);
    await fileAgain(a, 'same-target-key');
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(false);
    expect(cw.cases.holder(a.person)?.by).toBe('ann');
  });

  it('the change token moves when a claim is released and not when it is kept (the decision itself moves it)', async () => {
    const { cw, file, fileAgain, decide } = await setup();
    const a = await file('harassment', 'same-target-key');
    const b = await fileAgain(a, 'same-target-key');
    cw.cases.claim(a.person, 'ann');
    await decide(cw, a.id, a.person);
    const afterDecide = cw.changes.token();
    cw.cases.releaseWhenDone(a.person, 'ann');
    expect(cw.changes.token()).toBe(afterDecide);
    await decide(cw, b.id, a.person);
    const afterLast = cw.changes.token();
    expect(afterLast).not.toBe(afterDecide);
    cw.cases.releaseWhenDone(a.person, 'ann');
    expect(cw.changes.token()).not.toBe(afterLast);
  });

  it('releases once nothing is open, and an empty actor is a RangeError', async () => {
    const { cw, file, decide } = await setup();
    const a = await file();
    cw.cases.claim(a.person, 'ann');
    await decide(cw, a.id, a.person);
    expect(cw.cases.releaseWhenDone(a.person, 'ann')).toBe(true);
    expect(() => cw.cases.releaseWhenDone(a.person, '')).toThrow(RangeError);
  });
});

describe('cases.holders', () => {
  it('answers the live claims among the people asked, keyed by person, and ignores the rest', async () => {
    const { cw, file, clock } = await setup();
    const a = await file();
    const b = await file();
    const c = await file();
    cw.cases.claim(a.person, 'ann');
    cw.cases.claim(b.person, 'bea');
    const map = cw.cases.holders([a.person, b.person, c.person, a.person]);
    expect([...map.keys()].sort()).toEqual([a.person, b.person].sort());
    expect(map.get(a.person)?.by).toBe('ann');
    expect(cw.cases.holders([])).toEqual(new Map());
    clock.t += CLAIM_TTL_MS;
    expect(cw.cases.holders([a.person, b.person]).size).toBe(0);
  });
});

describe('cases.next', () => {
  it('is null when nothing is open', async () => {
    const { cw } = await setup();
    expect(cw.cases.next('ann')).toBeNull();
  });

  it('claims and returns the oldest open case, with its newest open report', async () => {
    const { cw, file, clock } = await setup();
    const first = await file();
    await file();
    const out = cw.cases.next('ann');
    expect(out).toEqual({
      person: first.person,
      reportId: first.id,
      claim: { by: 'ann', since: clock.t, until: clock.t + CLAIM_TTL_MS },
    });
    expect(cw.cases.holder(first.person)?.by).toBe('ann');
  });

  it('a case is ranked by its OLDEST open report but opens on its NEWEST', async () => {
    const { cw, file, fileAgain } = await setup();
    const a = await file(); // oldest
    const b = await file();
    const a2 = await fileAgain({ room: a.room, person: a.person }, 'target-key-1'); // a second, newer report on the same person
    expect(a2.person).toBe(a.person);
    const out = cw.cases.next('ann');
    expect(out?.person).toBe(a.person);
    expect(out?.reportId).toBe(a2.id);
    expect(cw.cases.next('bea')?.person).toBe(b.person);
  });

  it('skips cases that are held: by another, and by the caller; takes the next free one', async () => {
    const { cw, file } = await setup();
    const a = await file();
    const b = await file();
    const c = await file();
    cw.cases.claim(a.person, 'bea');
    expect(cw.cases.next('ann')?.person).toBe(b.person);
    // Ann holds b now: her next one is c, not b again.
    expect(cw.cases.next('ann')?.person).toBe(c.person);
    expect(cw.cases.next('ann')).toBeNull();
  });

  it('a lapsed claim is free again', async () => {
    const { cw, file, clock } = await setup();
    const a = await file();
    cw.cases.claim(a.person, 'bea');
    expect(cw.cases.next('ann')).toBeNull();
    clock.t += CLAIM_TTL_MS;
    expect(cw.cases.next('ann')?.person).toBe(a.person);
  });

  it('ignores closed reports', async () => {
    const { cw, file, decide } = await setup();
    const a = await file();
    const b = await file();
    await decide(cw, a.id, a.person);
    expect(cw.cases.next('ann')?.person).toBe(b.person);
  });

  it('filters by category: the oldest case with an open report of that category', async () => {
    const { cw, file } = await setup();
    await file('harassment');
    const spam = await file('spam');
    await file('spam');
    const out = cw.cases.next('ann', { category: 'spam' });
    expect(out?.person).toBe(spam.person);
    expect(cw.cases.next('ann', { category: 'cheating' })).toBeNull();
  });

  describe('filters by reason', () => {
    it('the oldest case with an open report that gave that reason', async () => {
      const { cw, fileReason } = await setup();
      await fileReason('harassment');
      const spam = await fileReason('spam');
      await fileReason('spam');
      expect(cw.cases.next('ann', { reason: 'spam' })?.person).toBe(spam.person);
      expect(cw.cases.next('ann', { reason: 'spam' })?.person).not.toBe(spam.person);
      expect(cw.cases.next('ann', { reason: 'spam' })).toBeNull();
    });

    it('null takes a case whose report gave no reason; a reason takes none of those', async () => {
      const { cw, fileReason } = await setup();
      await fileReason('hate');
      const none = await fileReason(null);
      expect(cw.cases.next('ann', { reason: null })?.person).toBe(none.person);
      expect(cw.cases.next('ann', { reason: null })).toBeNull();
      expect(cw.cases.next('bea', { reason: 'hate' })).not.toBeNull();
    });

    it('never hands out a case outside the filter, however many there are', async () => {
      const { cw, fileReason } = await setup();
      const want = new Set<string>();
      for (let i = 0; i < 6; i += 1) {
        const f = await fileReason(i % 3 === 0 ? 'cheating' : 'harassment');
        if (i % 3 === 0) want.add(f.person);
      }
      const got: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const out = cw.cases.next('ann', { reason: 'cheating' });
        if (out !== null) got.push(out.person);
      }
      expect(got).toHaveLength(2);
      for (const p of got) expect(want.has(p)).toBe(true);
    });

    it('the old disruption id finds griefing, an unknown but well-formed id finds nothing, and a bad id is a RangeError that claims nothing', async () => {
      const { cw, fileReason } = await setup();
      const a = await fileReason('griefing');
      expect(cw.cases.next('ann', { reason: 'nobody_used_this' })).toBeNull();
      for (const bad of ['', 'Has Space', 'none', 'x'.repeat(40), 5 as never]) expect(() => cw.cases.next('ann', { reason: bad }), String(bad)).toThrow(RangeError);
      expect(cw.cases.holder(a.person)).toBeNull();
      expect(cw.cases.next('ann', { reason: 'disruption' })?.person).toBe(a.person);
    });

    it('combines with category: both must hold', async () => {
      const { cw, fileReason, file } = await setup();
      await fileReason('hate');
      await file('hate');
      expect(cw.cases.next('ann', { reason: 'hate', category: 'hate' })).not.toBeNull();
      expect(cw.cases.next('ann', { reason: 'hate', category: 'spam' })).toBeNull();
    });

    it('a case is found by the reason as it was stored, even after the studio switched that reason off', async () => {
      const { cw, fileReason } = await setup();
      const a = await fileReason('spam');
      expect(cw.policy.save({ reporting: { reasons: [{ id: 'spam', label: 'Spam', enabled: false }, { id: 'other', label: 'Else' }] } }, { version: 0, actor: 'o', reason: 'x' }).ok).toBe(true);
      expect(cw.cases.next('ann', { reason: 'spam' })?.person).toBe(a.person);
    });
  });

  it('an unknown category is a RangeError and claims nothing', async () => {
    const { cw, file } = await setup();
    const a = await file();
    expect(() => cw.cases.next('ann', { category: 'nope' as never })).toThrow(RangeError);
    expect(cw.cases.holder(a.person)).toBeNull();
  });

  it('two moderators asking back to back for the only case: exactly one gets it, the other gets null', async () => {
    const { cw, file } = await setup();
    const a = await file();
    const tries = await Promise.all(['ann', 'bea'].map(async (who) => Promise.resolve().then(() => cw.cases.next(who))));
    expect(tries.filter((t) => t !== null)).toHaveLength(1);
    expect(tries.filter((t) => t === null)).toHaveLength(1);
    expect(cw.cases.holder(a.person)).not.toBeNull();
  });

  it('three moderators asking back to back over three cases each get a different one', async () => {
    const { cw, file } = await setup();
    const cases = [await file(), await file(), await file()];
    const tries = await Promise.all(['ann', 'bea', 'cy'].map(async (who) => Promise.resolve().then(() => cw.cases.next(who))));
    const people = tries.map((t) => t?.person);
    expect(new Set(people).size).toBe(3);
    expect([...people].sort()).toEqual(cases.map((c) => c.person).sort());
  });

  it('scans past a long run of held cases (more than one page)', async () => {
    const { cw, file } = await setup();
    const held: string[] = [];
    for (let i = 0; i < 205; i++) {
      const r = await file();
      held.push(r.person);
    }
    const last = await file();
    for (const p of held) cw.cases.claim(p, 'bea');
    expect(cw.cases.next('ann')?.person).toBe(last.person);
  });

  it('records no audit row (the http layer audits take overs, not claims)', async () => {
    const { cw, file } = await setup();
    const a = await file();
    cw.cases.claim(a.person, 'ann');
    cw.cases.next('bea');
    expect(cw.audit.list({ limit: 50 }).items).toEqual([]);
  });
});

describe('viewing presence', () => {
  it('lists who has the case open, others only when asked to leave one out, sorted', async () => {
    const { cw, file } = await setup();
    const r = await file();
    cw.cases.view(r.person, 'cy');
    cw.cases.view(r.person, 'ann');
    cw.cases.view(r.person, 'bea');
    expect(cw.cases.viewers(r.person)).toEqual(['ann', 'bea', 'cy']);
    expect(cw.cases.viewers(r.person, 'bea')).toEqual(['ann', 'cy']);
  });

  it('expires 30 seconds after the last beat (strictly), and a beat extends it', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    cw.cases.view(r.person, 'ann');
    clock.t += VIEWING_TTL_MS - 1;
    expect(cw.cases.viewers(r.person)).toEqual(['ann']);
    cw.cases.view(r.person, 'ann');
    clock.t += VIEWING_TTL_MS - 1;
    expect(cw.cases.viewers(r.person)).toEqual(['ann']);
    clock.t += 1;
    expect(cw.cases.viewers(r.person)).toEqual([]);
  });

  it('each actor expires on their own clock', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    cw.cases.view(r.person, 'ann');
    clock.t += 20 * SEC;
    cw.cases.view(r.person, 'bea');
    clock.t += 15 * SEC;
    expect(cw.cases.viewers(r.person)).toEqual(['bea']);
  });

  it('is per person, and an alias is the person', async () => {
    const { cw, file } = await setup();
    const a = await file();
    const b = await file();
    cw.cases.view(a.person, 'ann');
    expect(cw.cases.viewers(b.person)).toEqual([]);
    expect(cw.cases.viewersOf([a.person, b.person], 'zed')).toEqual(new Map([[a.person, ['ann']]]));
    expect(cw.cases.viewersOf([a.person, b.person], 'ann')).toEqual(new Map());
  });

  it('is not stored and does not move the change token', async () => {
    const { cw, store, file } = await setup();
    const r = await file();
    const t = cw.changes.token();
    cw.cases.view(r.person, 'ann');
    expect(cw.changes.token()).toBe(t);
    expect(store.loadClaims([r.person], NOW + 5000)).toEqual([]);
  });

  it('viewing does not block anyone and is separate from a claim', async () => {
    const { cw, file } = await setup();
    const r = await file();
    cw.cases.view(r.person, 'ann');
    expect(cw.cases.claim(r.person, 'bea').ok).toBe(true);
    expect(cw.cases.holder(r.person)?.by).toBe('bea');
    expect(cw.cases.viewers(r.person)).toEqual(['ann']);
  });

  it('stays bounded: a flood of distinct people does not grow without limit, and live viewers still read', () => {
    const clock = { t: NOW, now: () => clock.t };
    const presence = new ViewingPresence(clock);
    for (let i = 0; i < 12_000; i++) presence.touch(`s_flood_${i}`, `actor${i % 500}`);
    clock.t += VIEWING_TTL_MS;
    presence.touch('s_real', 'bea');
    expect(presence.viewers('s_real')).toEqual(['bea']);
    expect(presence.viewers('s_flood_5')).toEqual([]);
  });
});

describe('changes.token', () => {
  it('is a string, stable while nothing happens, including across reads and heartbeats', async () => {
    const { cw, file } = await setup();
    const r = await file();
    cw.cases.claim(r.person, 'ann');
    const t = cw.changes.token();
    expect(typeof t).toBe('string');
    cw.reports.list();
    cw.reports.get(r.id);
    cw.cases.holder(r.person);
    cw.cases.holders([r.person]);
    cw.cases.claim(r.person, 'ann'); // heartbeat
    cw.cases.claim(r.person, 'bea'); // refused
    cw.cases.next('bea'); // nothing free
    cw.cases.view(r.person, 'cy');
    cw.reasons.list();
    cw.audit.record({ actor: 'ann', role: 'moderator', action: 'report.view' });
    expect(cw.changes.token()).toBe(t);
  });

  it('moves when a report is filed', async () => {
    const { cw, file } = await setup();
    const t = cw.changes.token();
    await file();
    expect(cw.changes.token()).not.toBe(t);
  });

  it('moves when a report is decided (and its sanction is written)', async () => {
    const { cw, file, decide } = await setup();
    const r = await file();
    const t = cw.changes.token();
    expect((await decide(cw, r.id, r.person)).ok).toBe(true);
    expect(cw.changes.token()).not.toBe(t);
  });

  it('moves when a sanction is applied and when it is revoked', async () => {
    const { cw, file } = await setup();
    const r = await file();
    let t = cw.changes.token();
    const made = await cw.sanctions.apply({
      kind: 'chat', subject: r.person, includeIp: false, durationMs: MIN, reason: 'r', actor: 'ann', source: 'moderator', automated: false, rule: 2,
    });
    expect(cw.changes.token()).not.toBe(t);
    t = cw.changes.token();
    expect(await cw.sanctions.revoke(made.groupId, 'ann', 'oops')).toBe(true);
    expect(cw.changes.token()).not.toBe(t);
    t = cw.changes.token();
    expect(await cw.sanctions.revoke(made.groupId, 'ann', 'again')).toBe(false);
    expect(cw.changes.token()).toBe(t);
  });

  it('moves when a rule gap is closed', async () => {
    const { cw, file } = await setup();
    const r = await file();
    const made = await cw.sanctions.apply({
      kind: 'warning', subject: r.person, includeIp: false, durationMs: null, reason: 'r', actor: 'ann', source: 'moderator', automated: false,
      rule: 'uncovered', gapNote: 'a gap',
    });
    const t = cw.changes.token();
    expect(cw.gaps.close(made.groupId, 'not_a_rule', null, 'owner')).toBe(true);
    expect(cw.changes.token()).not.toBe(t);
  });

  it('moves when a claim is taken, taken over or released, not when it is refused or beats', async () => {
    const { cw, file } = await setup();
    const r = await file();
    const seen: string[] = [cw.changes.token()];
    const step = (fn: () => unknown, moves: boolean) => {
      fn();
      const t = cw.changes.token();
      expect(t !== seen[seen.length - 1]).toBe(moves);
      if (moves) seen.push(t);
    };
    step(() => cw.cases.claim(r.person, 'ann'), true);
    step(() => cw.cases.claim(r.person, 'ann'), false);
    step(() => cw.cases.claim(r.person, 'bea'), false);
    step(() => cw.cases.claim(r.person, 'sam', { takeOver: true }), true);
    step(() => cw.cases.release(r.person, 'ann'), false);
    step(() => cw.cases.release(r.person, 'sam'), true);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('moves when a claim lapses and another moderator takes the case (the new owner), not by itself', async () => {
    const { cw, file, clock } = await setup();
    const r = await file();
    cw.cases.claim(r.person, 'ann');
    const t = cw.changes.token();
    clock.t += CLAIM_TTL_MS + 1;
    expect(cw.changes.token()).toBe(t); // lapsing alone moves nothing; clients read `until`
    cw.cases.claim(r.person, 'bea');
    expect(cw.changes.token()).not.toBe(t);
  });

  it('moves when a reason is added, edited or switched', async () => {
    const { cw } = await setup();
    let t = cw.changes.token();
    const r = cw.reasons.add({ label: 'Spam', text: 'Spamming the lobby.' });
    expect(cw.changes.token()).not.toBe(t);
    t = cw.changes.token();
    cw.reasons.update(r.id, { label: 'Spam!' });
    expect(cw.changes.token()).not.toBe(t);
    t = cw.changes.token();
    cw.reasons.setActive(r.id, false);
    expect(cw.changes.token()).not.toBe(t);
  });

  it('is shared by two kits on one store (another process): a change made through one shows in the other', async () => {
    const store = new MemoryStore();
    const mk = () =>
      createChatwarden({ store, secret: 's', platform: { identify: (c) => c as RawWho }, retention: false, logger: { warn() {} } });
    const [a, b] = await Promise.all([mk(), mk()]);
    const t = b.changes.token();
    a.reasons.add({ label: 'x', text: 'y' });
    expect(b.changes.token()).not.toBe(t);
    expect(b.reasons.list()).toHaveLength(1);
  });
});

describe('reasons', () => {
  it('starts empty; add returns the stored row with a fresh id, active, trimmed', async () => {
    const { cw } = await setup();
    expect(cw.reasons.list()).toEqual([]);
    const r = cw.reasons.add({ label: '  Spam  ', text: '  Spamming the lobby.  ' });
    expect(r).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), label: 'Spam', text: 'Spamming the lobby.', active: true });
    expect(cw.reasons.list()).toEqual([r]);
  });

  it('lists in the order added; ids are unique', async () => {
    const { cw } = await setup();
    const a = cw.reasons.add({ label: 'B', text: 'b' });
    const b = cw.reasons.add({ label: 'A', text: 'a' });
    expect(cw.reasons.list().map((r) => r.id)).toEqual([a.id, b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it('keeps the text exactly inside (newlines, quotes, non-latin)', async () => {
    const { cw } = await setup();
    const text = 'Line one\n"quoted" é中😀';
    expect(cw.reasons.add({ label: 'é', text }).text).toBe(text);
  });

  it('accepts the limits exactly and refuses one over', async () => {
    const { cw } = await setup();
    expect(() => cw.reasons.add({ label: 'l'.repeat(REASON_LABEL_MAX), text: 't'.repeat(REASON_TEXT_MAX) })).not.toThrow();
    expect(() => cw.reasons.add({ label: 'l'.repeat(REASON_LABEL_MAX + 1), text: 't' })).toThrow(ReasonError);
    expect(() => cw.reasons.add({ label: 'l', text: 't'.repeat(REASON_TEXT_MAX + 1) })).toThrow(ReasonError);
  });

  it('refuses an empty, blank or non-string label or text, and an input that is not an object', async () => {
    const { cw } = await setup();
    for (const bad of [{ label: '', text: 't' }, { label: '   ', text: 't' }, { label: 'l', text: '' }, { label: 'l', text: ' \n ' }, { label: 7, text: 't' }, { label: 'l', text: null }, {}]) {
      expect(() => cw.reasons.add(bad as never), JSON.stringify(bad)).toThrow(ReasonError);
    }
    for (const bad of [null, undefined, 'x', 3]) expect(() => cw.reasons.add(bad as never)).toThrow(ReasonError);
    expect(cw.reasons.list()).toEqual([]);
  });

  it('the error names the field and echoes nothing', async () => {
    const { cw } = await setup();
    try {
      cw.reasons.add({ label: 'SECRET'.repeat(20), text: 't' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ReasonError);
      expect((err as ReasonError).field).toBe('label');
      expect((err as Error).message).not.toContain('SECRET');
    }
  });

  it('caps the list at 200', async () => {
    const { cw } = await setup();
    for (let i = 0; i < REASONS_MAX; i++) cw.reasons.add({ label: `l${i}`, text: 't' });
    expect(() => cw.reasons.add({ label: 'one too many', text: 't' })).toThrow(ReasonError);
    expect(cw.reasons.list()).toHaveLength(REASONS_MAX);
  });

  it('update changes the label, the text or both with the same checks, and returns the row; unknown id is null', async () => {
    const { cw } = await setup();
    const r = cw.reasons.add({ label: 'A', text: 'a' });
    expect(cw.reasons.update(r.id, { label: ' B ' })).toEqual({ ...r, label: 'B' });
    expect(cw.reasons.update(r.id, { text: 'b' })).toEqual({ ...r, label: 'B', text: 'b' });
    expect(cw.reasons.update(r.id, { label: 'C', text: 'c' })).toEqual({ ...r, label: 'C', text: 'c' });
    expect(cw.reasons.update('nope', { label: 'x' })).toBeNull();
    expect(() => cw.reasons.update(r.id, { label: '' })).toThrow(ReasonError);
    expect(() => cw.reasons.update(r.id, { text: 'x'.repeat(501) })).toThrow(ReasonError);
    expect(() => cw.reasons.update(r.id, {})).toThrow(ReasonError); // nothing to change is a mistake
    expect(cw.reasons.list()[0]).toEqual({ ...r, label: 'C', text: 'c' });
  });

  it('update refuses a bad id before touching anything', async () => {
    const { cw } = await setup();
    expect(() => cw.reasons.update('', { label: 'x' })).toThrow(ReasonError);
    expect(() => cw.reasons.update(5 as never, { label: 'x' })).toThrow(ReasonError);
    expect(cw.reasons.setActive('', false)).toBeNull();
  });

  it('setActive switches a reason off and on and returns the row; unknown is null; a non-boolean is refused', async () => {
    const { cw } = await setup();
    const r = cw.reasons.add({ label: 'A', text: 'a' });
    expect(cw.reasons.setActive(r.id, false)).toEqual({ ...r, active: false });
    expect(cw.reasons.list()[0]?.active).toBe(false);
    expect(cw.reasons.setActive(r.id, true)).toEqual(r);
    expect(cw.reasons.setActive('nope', true)).toBeNull();
    expect(() => cw.reasons.setActive(r.id, 'yes' as never)).toThrow(ReasonError);
  });

  it('what list returns is a copy', async () => {
    const { cw } = await setup();
    cw.reasons.add({ label: 'A', text: 'a' });
    cw.reasons.list()[0]!.label = 'changed';
    expect(cw.reasons.list()[0]?.label).toBe('A');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1: a lost cross-process race is retried, take next reads claims once per page, viewing needs an open case,
// reasons count characters and refuse control characters.
// ---------------------------------------------------------------------------------------------------------------------

/** What node:sqlite throws when another process commits between our read and our write (SQLITE_BUSY_SNAPSHOT). */
const busy = (): Error => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 517, errstr: 'database is locked' });

/** A store whose first `failures` claim attempts fail like a lost cross-process race, after `rival` (if any) has committed. */
class BusyStore extends MemoryStore {
  failures = 0;
  calls = 0;
  rival: (() => void) | null = null;
  /** Another process's claim: written outside this transaction's journal, so the failure's rollback cannot undo it. */
  rivalWrite(person: string, by: string, since: number, until: number): void {
    this.claims.set(person, { person, by, since, until });
  }
  override claimCase(...args: Parameters<MemoryStore['claimCase']>): ReturnType<MemoryStore['claimCase']> {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      const rival = this.rival;
      this.rival = null;
      rival?.();
      throw busy();
    }
    return super.claimCase(...args);
  }
}

async function busySetup() {
  const store = new BusyStore();
  const clock = { t: NOW, now: () => clock.t };
  const cw = await createChatwarden({
    store, secret: 'team-secret', platform: { identify: (c) => c as RawWho }, clock, retention: false, logger: { warn() {} },
  });
  let n = 0;
  /** An open report against a person, written straight into the store. */
  const open = (person: string) => {
    n += 1;
    store.insertReport({
      id: `busy-r${n}`, createdAt: NOW + n, roomId: `busy-room-${n}`, tags: {}, reporterSubject: `s_reporter${n}`, reporterSeat: 'p1',
      reporterHandle: 'R', targetSubject: person, targetSeat: 'p2', targetHandle: 'T', category: 'harassment', note: null, lineId: null,
      excerpt: [], people: [], status: 'open',
    });
  };
  /** Make `by` the holder through the store, as another process would. */
  const rivalClaim = (person: string, by: string) => () => store.rivalWrite(person, by, clock.t, clock.t + 600_000);
  return { cw, store, clock, open, rivalClaim };
}

describe('a lost cross-process race is retried, not thrown', () => {
  it('claim: one busy failure is retried and then wins when nobody else took the case', async () => {
    const { cw, store, open } = await busySetup();
    open('s_a');
    store.failures = 1;
    expect(cw.cases.claim('s_a', 'ann')).toMatchObject({ ok: true, claim: { by: 'ann' } });
    expect(store.calls).toBe(2);
  });

  it('claim: the retry re-reads, so a rival who won meanwhile gives the normal claimed answer', async () => {
    const { cw, store, open, rivalClaim } = await busySetup();
    open('s_a');
    store.failures = 1;
    store.rival = rivalClaim('s_a', 'rival');
    expect(cw.cases.claim('s_a', 'ann')).toMatchObject({ ok: false, error: 'claimed', claim: { by: 'rival' } });
  });

  it('is bounded: after CLAIM_BUSY_TRIES attempts the busy error is thrown', async () => {
    const { cw, store, open } = await busySetup();
    open('s_a');
    expect(CLAIM_BUSY_TRIES).toBe(3);
    store.failures = 99;
    expect(() => cw.cases.claim('s_a', 'ann')).toThrow('database is locked');
    expect(store.calls).toBe(CLAIM_BUSY_TRIES);
  });

  it('succeeds on the last allowed attempt', async () => {
    const { cw, store, open } = await busySetup();
    open('s_a');
    store.failures = CLAIM_BUSY_TRIES - 1;
    expect(cw.cases.claim('s_a', 'ann').ok).toBe(true);
    expect(store.calls).toBe(CLAIM_BUSY_TRIES);
  });

  it('an error that is not a busy error is not retried', async () => {
    const { cw, store, open } = await busySetup();
    open('s_a');
    store.claimCase = () => {
      store.calls += 1;
      throw new Error('disk full');
    };
    expect(() => cw.cases.claim('s_a', 'ann')).toThrow('disk full');
    expect(store.calls).toBe(1);
  });

  it('recognises SQLITE_BUSY by code (5) and by message', async () => {
    for (const make of [
      () => Object.assign(new Error('x'), { errcode: 5 }),
      () => Object.assign(new Error('x'), { errcode: 261 }),
      () => new Error('SQLITE_BUSY: database is locked'),
      () => new Error('database is locked'),
    ]) {
      const { cw, store, open } = await busySetup();
      open('s_a');
      const real = store.claimCase.bind(store);
      let first = true;
      store.claimCase = (...args) => {
        if (first) {
          first = false;
          throw make();
        }
        return real(...args);
      };
      expect(cw.cases.claim('s_a', 'ann').ok).toBe(true);
    }
  });

  it('take next: a candidate lost to a busy failure is retried, sees the rival, and the next candidate is taken', async () => {
    const { cw, store, open, rivalClaim } = await busySetup();
    open('s_a');
    open('s_b');
    store.failures = 1;
    store.rival = rivalClaim('s_a', 'rival');
    expect(cw.cases.next('ann')?.person).toBe('s_b');
    expect(cw.cases.holder('s_a')?.by).toBe('rival');
    expect(cw.cases.holder('s_b')?.by).toBe('ann');
  });
});

describe('take next reads claims once per page and skips held people without a write', () => {
  it('only the free candidate costs a claim attempt', async () => {
    const { cw, store, open } = await busySetup();
    for (let i = 0; i < 6; i++) open(`s_held${i}`);
    open('s_free');
    for (let i = 0; i < 6; i++) cw.cases.claim(`s_held${i}`, 'bea');
    store.calls = 0;
    expect(cw.cases.next('ann')?.person).toBe('s_free');
    expect(store.calls).toBe(1);
  });

  it('a case the caller holds is skipped without a write too, and a lapsed claim is attempted', async () => {
    const { cw, store, open, clock } = await busySetup();
    open('s_old');
    open('s_mine');
    open('s_free');
    cw.cases.claim('s_old', 'bea');
    clock.t += 300_000;
    cw.cases.claim('s_mine', 'ann');
    clock.t += 300_000; // s_old lapsed, s_mine is still live
    store.calls = 0;
    expect(cw.cases.next('ann')?.person).toBe('s_old');
    expect(store.calls).toBe(1);
  });

  it('when everything is held: null, and no write at all', async () => {
    const { cw, store, open } = await busySetup();
    open('s_a');
    open('s_b');
    cw.cases.claim('s_a', 'bea');
    cw.cases.claim('s_b', 'bea');
    store.calls = 0;
    expect(cw.cases.next('ann')).toBeNull();
    expect(store.calls).toBe(0);
  });
});

describe('viewing needs an open case and is capped per actor', () => {
  it('view answers false and tracks nothing for a person with no open case', async () => {
    const { cw, file, decide } = await setup();
    expect(cw.cases.view('s_nobody', 'ann')).toBe(false);
    expect(cw.cases.viewers('s_nobody')).toEqual([]);
    const r = await file();
    expect(cw.cases.view(r.person, 'ann')).toBe(true);
    expect(cw.cases.viewers(r.person)).toEqual(['ann']);
    await decide(cw, r.id, r.person);
    expect(cw.cases.view(r.person, 'bea')).toBe(false);
    expect(cw.cases.viewers(r.person, 'zed')).toEqual(['ann']); // ann's earlier beat still counts until it lapses
  });

  it('a flood of made-up refs from one actor tracks none of them', async () => {
    const { cw } = await setup();
    for (let i = 0; i < 500; i++) expect(cw.cases.view(`s_made_up_${i}`, 'ann')).toBe(false);
    expect(cw.cases.viewers('s_made_up_3')).toEqual([]);
  });

  it('one actor keeps at most 20 cases open: the oldest beat is dropped, other actors are unaffected', async () => {
    const { cw, file } = await setup();
    expect(VIEWING_PER_ACTOR_MAX).toBe(20);
    const people: string[] = [];
    for (let i = 0; i < 22; i++) people.push((await file()).person);
    cw.cases.view(people[0]!, 'bea');
    for (const p of people) cw.cases.view(p, 'ann');
    expect(cw.cases.viewers(people[0]!)).toEqual(['bea']); // ann's beat on the first was dropped, bea's stays
    expect(cw.cases.viewers(people[1]!)).toEqual([]);
    expect(cw.cases.viewers(people[2]!)).toEqual(['ann']);
    expect(cw.cases.viewers(people[21]!)).toEqual(['ann']);
  });

  it('beating the same case again does not use up the cap', async () => {
    const { cw, file } = await setup();
    const people: string[] = [];
    for (let i = 0; i < 20; i++) people.push((await file()).person);
    for (let round = 0; round < 5; round++) for (const p of people) cw.cases.view(p, 'ann');
    for (const p of people) expect(cw.cases.viewers(p)).toEqual(['ann']);
  });
});

describe('reasons count characters and refuse control characters', () => {
  it('counts code points, not UTF-16 units', async () => {
    const { cw } = await setup();
    const emoji = '\u{1F600}';
    const made = cw.reasons.add({ label: emoji.repeat(REASON_LABEL_MAX), text: emoji.repeat(REASON_TEXT_MAX) });
    expect(() => cw.reasons.add({ label: emoji.repeat(REASON_LABEL_MAX + 1), text: 't' })).toThrow(ReasonError);
    expect(() => cw.reasons.add({ label: 'l', text: emoji.repeat(REASON_TEXT_MAX + 1) })).toThrow(ReasonError);
    expect(() => cw.reasons.update(made.id, { label: emoji.repeat(REASON_LABEL_MAX + 1) })).toThrow(ReasonError);
    expect(() => cw.reasons.update(made.id, { text: emoji.repeat(REASON_TEXT_MAX + 1) })).toThrow(ReasonError);
  });

  it('refuses control characters in a label, newline and tab included', async () => {
    const { cw } = await setup();
    for (const bad of ['a\nb', 'a\tb', 'a\rb', 'a\u0000b', 'a\u001fb', 'a\u007fb']) {
      expect(() => cw.reasons.add({ label: bad, text: 't' }), JSON.stringify(bad)).toThrow(ReasonError);
    }
    const ok = cw.reasons.add({ label: 'fine', text: 't' });
    expect(() => cw.reasons.update(ok.id, { label: 'a\nb' })).toThrow(ReasonError);
  });

  it('allows a newline in the text but no other control character', async () => {
    const { cw } = await setup();
    expect(cw.reasons.add({ label: 'l', text: 'line one\nline two' }).text).toBe('line one\nline two');
    for (const bad of ['a\tb', 'a\rb', 'a\u0000b', 'a\u0007b', 'a\u007fb']) {
      expect(() => cw.reasons.add({ label: 'l', text: bad }), JSON.stringify(bad)).toThrow(ReasonError);
    }
    const r = cw.reasons.add({ label: 'l2', text: 't' });
    expect(() => cw.reasons.update(r.id, { text: 'x\u0000y' })).toThrow(ReasonError);
  });

  it('trims first, so a trailing newline is not a control character problem', async () => {
    const { cw } = await setup();
    expect(cw.reasons.add({ label: ' ok \n', text: ' fine \n' })).toMatchObject({ label: 'ok', text: 'fine' });
  });
});
