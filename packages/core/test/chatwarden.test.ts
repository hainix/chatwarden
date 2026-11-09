import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { DecisionAction } from '../src/decide.js';
import { defineRules, STARTER_RULES } from '../src/rules.js';
import type { Logger, Matcher, Platform, RawWho } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const R = 'room';
const SUBJECT_RE = /^s_[A-Za-z0-9_-]{22}$/;

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

/** A matcher that blocks the one synthetic word. */
const blocker: Matcher = { match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null) };

async function setup(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const identified: unknown[] = [];
  const platform: Platform = {
    identify(ctx) {
      identified.push(ctx);
      return ctx as RawWho;
    },
  };
  const cw = await createChatwarden({ store, secret: 'facade-secret', platform, clock, logger, ...over });
  return { cw, store, clock, logged, identified };
}

const alice: RawWho = { clientKey: 'key-alice', ip: '198.51.100.1' };
const bob: RawWho = { clientKey: 'key-bob', ip: '198.51.100.2' };

describe('createChatwarden: seating', () => {
  it('seat gives each person their own subject and the same key the same subject', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.rooms.seat(R, 'c', alice, 'Alice again');
    const a = cw.rooms.subjectAt(R, 'a');
    expect(a).toMatch(SUBJECT_RE);
    expect(cw.rooms.subjectAt(R, 'b')).not.toBe(a);
    expect(cw.rooms.subjectAt(R, 'c')).toBe(a);
  });

  it('seatConnection asks the platform to identify the context, once, and seats the result', async () => {
    const { cw, identified } = await setup();
    cw.rooms.seatConnection(R, 'a', alice, 'Alice');
    expect(identified).toEqual([alice]);
    const a = cw.rooms.subjectAt(R, 'a');
    cw.rooms.seat(R, 'b', alice, 'Alice');
    expect(cw.rooms.subjectAt(R, 'b')).toBe(a);
  });

  it('seat does not call identify', async () => {
    const { cw, identified } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(identified).toEqual([]);
  });

  it('subjectAt is null for an empty seat, an unknown room and an unidentifiable guest', async () => {
    const { cw } = await setup();
    expect(cw.rooms.subjectAt(R, 'a')).toBeNull();
    cw.rooms.seat(R, 'g', {}, 'Guest');
    expect(cw.rooms.subjectAt(R, 'g')).toBeNull();
    expect(cw.rooms.subjectAt('nowhere', 'a')).toBeNull();
  });

  it('unseat empties the seat', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.unseat(R, 'a');
    expect(cw.rooms.subjectAt(R, 'a')).toBeNull();
    expect(cw.chat.accept(R, 'a', 'hello')).toEqual({ refuse: { reason: 'gate' } });
  });

  it('close forgets seats and drops the room evidence', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const line = cw.chat.accept(R, 'a', 'hello');
    expect('deliver' in line).toBe(true);
    cw.rooms.close(R);
    expect(cw.rooms.subjectAt(R, 'a')).toBeNull();
    // Reseat: the old line is gone from the evidence, so a report that names it cannot find it.
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    if (!('deliver' in line)) throw new Error('unreachable');
    const res = await cw.reports.submit({
      roomId: R,
      reporterSeat: 'b',
      targetSeat: 'zz',
      category: 'harassment',
      lineId: line.deliver.lineId,
    });
    expect(res).toEqual({ ok: false, refused: 'not_player' });
  });
});

describe('createChatwarden: chat', () => {
  it('delivers a line and refuses a blocked one through the injected matcher', async () => {
    const { cw } = await setup({ matcher: blocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const ok = cw.chat.accept(R, 'a', 'hello');
    expect(ok).toMatchObject({ deliver: { text: 'hello' } });
    expect(cw.chat.accept(R, 'a', 'you zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 1 } });
  });

  it('without a matcher nothing is blocked', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toMatchObject({ deliver: { text: 'zorbak' } });
  });

  it('applies the starrer to delivered text', async () => {
    const { cw } = await setup({ starrer: { star: (t) => t.replace('heck', '****') } });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'oh heck')).toMatchObject({ deliver: { text: 'oh ****' } });
  });

  it('the gate hook is passed through with the sender subject', async () => {
    const seen: unknown[] = [];
    const { cw } = await setup({
      gate: (room, subject) => {
        seen.push([room, subject]);
        return false;
      },
    });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'hello')).toEqual({ refuse: { reason: 'gate' } });
    expect(seen).toEqual([[R, cw.rooms.subjectAt(R, 'a')]]);
  });

  it('the logger reaches the components', async () => {
    const { cw, logged } = await setup({
      gate: () => {
        throw new TypeError('boom');
      },
    });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.chat.accept(R, 'a', 'hello');
    expect(logged.filter(([e]) => e !== 'chatwarden.no_matcher')).toEqual([['chat.gate_failed', { error: 'TypeError' }]]);
  });

  it('three blocked lines earn an automatic timeout and onAutoRestrict hears of it', async () => {
    const told: Array<[unknown, boolean]> = [];
    const { cw } = await setup({ matcher: blocker, onAutoRestrict: (s, second) => void told.push([s, second]) });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(told).toEqual([[cw.rooms.subjectAt(R, 'a'), false]]);
    const next = cw.chat.accept(R, 'a', 'hello');
    expect(next).toMatchObject({ refuse: { reason: 'restricted', byModerator: false } });
  });

  it('visibleTo honours a mute set through the facade', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(true);
    cw.mutes.set(R, 'a', 'b', true);
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(false);
    expect(cw.chat.visibleTo(R, 'b', 'a')).toBe(true);
    expect(cw.chat.visibleTo(R, 'a', 'a')).toBe(true);
    cw.mutes.set(R, 'a', 'b', false);
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(true);
  });
});

describe('createChatwarden: mutes', () => {
  it('mutedSeats lists the seats whose occupant the viewer muted', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.rooms.seat(R, 'c', { clientKey: 'key-cy' }, 'Cy');
    cw.mutes.set(R, 'a', 'c', true);
    cw.mutes.set(R, 'a', 'b', true);
    expect(cw.mutes.mutedSeats(R, 'a')).toEqual(['b', 'c']);
    expect(cw.mutes.mutedSeats(R, 'b')).toEqual([]);
  });

  it('is a no-op when either seat is empty or has no subject', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'g', {}, 'Guest');
    cw.mutes.set(R, 'a', 'g', true);
    cw.mutes.set(R, 'a', 'empty', true);
    cw.mutes.set(R, 'empty', 'a', true);
    cw.mutes.set(R, 'g', 'a', true);
    expect(cw.mutes.mutedSeats(R, 'a')).toEqual([]);
    expect(cw.mutes.mutedSeats(R, 'g')).toEqual([]);
  });

  it('follows the person, not the seat: a new occupant of the muted seat is not muted', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.mutes.set(R, 'a', 'b', true);
    cw.rooms.seat(R, 'b', { clientKey: 'key-new' }, 'Newcomer');
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(true);
    cw.rooms.seat(R, 'b', bob, 'Bob');
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(false);
  });

  it('survives a restart on the same store', async () => {
    const store = new MemoryStore();
    const first = await setup({}, store);
    first.cw.rooms.seat(R, 'a', alice, 'Alice');
    first.cw.rooms.seat(R, 'b', bob, 'Bob');
    first.cw.mutes.set(R, 'a', 'b', true);
    await first.cw.flush();
    const second = await setup({}, store);
    second.cw.rooms.seat(R, 'a', alice, 'Alice');
    second.cw.rooms.seat(R, 'b', bob, 'Bob');
    expect(second.cw.mutes.mutedSeats(R, 'a')).toEqual(['b']);
  });
});

describe('createChatwarden: reports', () => {
  async function reportSetup(over: Partial<ChatwardenOptions> = {}) {
    const s = await setup({ matcher: blocker, ...over });
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    s.cw.rooms.seat(R, 'b', bob, 'Bob');
    return s;
  }

  it('stores a report with the blocked line in the excerpt and tells onReport', async () => {
    const heard: string[] = [];
    const { cw, store } = await reportSetup({ onReport: (r) => void heard.push(r.id) });
    cw.chat.accept(R, 'a', 'you zorbak');
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    expect(res).toMatchObject({ ok: true });
    expect(heard).toHaveLength(1);
    expect(store.loadRoomReportPairs(R)).toHaveLength(1);
  });

  it('refuses a self-report and a report from a guest', async () => {
    const { cw } = await reportSetup();
    cw.rooms.seat(R, 'g', {}, 'Guest');
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'a', targetSeat: 'a', category: 'spam' })).toEqual({
      ok: false,
      refused: 'self',
    });
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'g', targetSeat: 'a', category: 'spam' })).toEqual({
      ok: false,
      refused: 'off',
    });
  });

  it('enabled() false turns report intake off and is read per call', async () => {
    let on = false;
    const { cw } = await reportSetup({ enabled: () => on });
    const input = { roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' as const };
    expect(await cw.reports.submit(input)).toEqual({ ok: false, refused: 'off' });
    on = true;
    expect(await cw.reports.submit(input)).toMatchObject({ ok: true });
  });
});

describe('createChatwarden: sanctions and doors', () => {
  const chatSanction = (subject: string) => ({
    kind: 'chat' as const,
    subject,
    includeIp: false,
    durationMs: H,
    reason: 'private note',
    actor: 'mod@example.test',
    source: 'moderator' as const,
    automated: false,
    rule: 1,
  });

  it('a chat sanction refuses the next line as restricted, with a time and no identifiers; revoke lifts it', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    const { groupId, refCode } = await cw.sanctions.apply(chatSanction(subject));
    expect(refCode).toMatch(/^M-/);
    const refused = cw.chat.accept(R, 'a', 'hello');
    expect(refused).toEqual({ refuse: { reason: 'restricted', until: NOW + H, byModerator: true, rule: 1 } });
    expect(JSON.stringify(refused)).not.toContain(subject);
    expect(await cw.sanctions.revoke(groupId, 'mod@example.test', 'mistake')).toBe(true);
    expect(await cw.sanctions.revoke(groupId, 'mod@example.test', 'again')).toBe(false);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
    clock.t += H;
  });

  it('a ban closes the doors for that person, found by a fresh connection with the same key', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toBeNull();
    const { groupId, refCode } = await cw.sanctions.apply({ ...chatSanction(subject), kind: 'ban' });
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toEqual({ kind: 'ban', until: NOW + H, refCode });
    expect(cw.doors.check('join', { clientKey: 'key-bob' })).toBeNull();
    await cw.sanctions.revoke(groupId, 'mod@example.test', 'mistake');
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toBeNull();
  });

  it('enabled() false switches enforcement off for chat and doors (the kill switch)', async () => {
    let on = true;
    const { cw } = await setup({ enabled: () => on });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    await cw.sanctions.apply({ ...chatSanction(subject), kind: 'ban' });
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ refuse: { reason: 'restricted' } });
    on = false;
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toBeNull();
  });

  it('rejects a non-positive duration', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    await expect(cw.sanctions.apply({ ...chatSanction(subject), durationMs: 0 })).rejects.toThrow();
  });
});

describe('createChatwarden: lifecycle', () => {
  it('loads stored sanctions before it returns: the first line on a restarted kit is already refused', async () => {
    const store = new MemoryStore();
    const first = await setup({}, store);
    first.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = first.cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    await first.cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: H,
      reason: 'r',
      actor: 'mod',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    await first.cw.flush();

    const second = await setup({}, store);
    second.cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(second.cw.chat.accept(R, 'a', 'hello')).toMatchObject({ refuse: { reason: 'restricted' } });
  });

  it('works with the default clock when none is given', async () => {
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: 's',
      platform: { identify: () => ({ clientKey: 'k' }) },
    });
    cw.rooms.seatConnection(R, 'a', null, 'Alice');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ deliver: { text: 'hi' } });
    await cw.close();
  });

  it('purge runs against the store with the injected clock and the given policy', async () => {
    const { cw } = await setup();
    expect(await cw.purge()).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0 });
    await expect(cw.purge({ reportsMs: -1 })).rejects.toThrow(/invalid reportsMs/);
  });

  it('flush waits for identity writes; close flushes then closes the store', async () => {
    const order: string[] = [];
    class SpyStore extends MemoryStore {
      override async saveSubject(...args: Parameters<MemoryStore['saveSubject']>): Promise<void> {
        await Promise.resolve();
        order.push('saveSubject');
        return super.saveSubject(...args);
      }
      override close(): void {
        order.push('close');
      }
    }
    const { cw } = await setup({}, new SpyStore());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    await cw.close();
    expect(order).toEqual(['saveSubject', 'close']);
  });
});

describe('createChatwarden: retention on by default', () => {
  const DAY = 24 * H;
  const SIX_H = 6 * H;
  afterEach(() => {
    vi.useRealTimers();
  });

  const oldReport = (id: string) => ({
    id,
    createdAt: NOW - 100 * DAY,
    roomId: `room-${id}`,
    tags: {},
    reporterSubject: `s_rep_${id}`,
    reporterSeat: 'p1',
    reporterHandle: 'A',
    targetSubject: `s_tgt_${id}`,
    targetSeat: 'p2',
    targetHandle: 'B',
    category: 'harassment' as const,
    note: null,
    lineId: null,
    excerpt: [],
    people: [],
    status: 'open' as const,
  });

  it('purges every 6 h by default, not before', async () => {
    vi.useFakeTimers();
    const { cw, store, clock } = await setup();
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(SIX_H - 1);
    expect(store.rawReports()).toHaveLength(1);
    clock.t += SIX_H;
    await vi.advanceTimersByTimeAsync(1);
    expect(store.rawReports()).toHaveLength(0);
    // And again on the next tick.
    store.insertReport(oldReport('r2'));
    await vi.advanceTimersByTimeAsync(SIX_H);
    expect(store.rawReports()).toHaveLength(0);
    await cw.close();
  });

  it('everyMs and the policy fields are honoured', async () => {
    vi.useFakeTimers();
    const { cw, store, clock } = await setup({ retention: { everyMs: 1000, reportsMs: 10 * DAY } });
    store.insertReport({ ...oldReport('r1'), createdAt: NOW - 20 * DAY });
    store.insertReport({ ...oldReport('r2'), createdAt: NOW - 5 * DAY });
    await vi.advanceTimersByTimeAsync(999);
    expect(store.rawReports()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.rawReports().map((r) => r.id)).toEqual(['r2']);
    expect(clock.t).toBe(NOW);
    await cw.close();
  });

  it('a policy object without everyMs keeps the 6 h default', async () => {
    vi.useFakeTimers();
    const { cw, store } = await setup({ retention: { reportsMs: DAY } });
    store.insertReport({ ...oldReport('r1'), createdAt: NOW - 2 * DAY });
    await vi.advanceTimersByTimeAsync(SIX_H - 1);
    expect(store.rawReports()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.rawReports()).toHaveLength(0);
    await cw.close();
  });

  it('retention: false starts no timer and never purges', async () => {
    vi.useFakeTimers();
    const { cw, store } = await setup({ retention: false });
    expect(vi.getTimerCount()).toBe(0);
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(1000 * H);
    expect(store.rawReports()).toHaveLength(1);
    await cw.close();
  });

  it('the default starts exactly one timer, and it does not keep the process alive (unref)', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { cw } = await setup();
    expect(vi.getTimerCount()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0]?.value as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
    await cw.close();
    spy.mockRestore();
  });

  it('close stops the timer: no purge afterwards', async () => {
    vi.useFakeTimers();
    const { cw, store } = await setup();
    await cw.close();
    expect(vi.getTimerCount()).toBe(0);
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(100 * H);
    expect(store.rawReports()).toHaveLength(1);
  });

  it('close twice is harmless', async () => {
    vi.useFakeTimers();
    const { cw } = await setup();
    await cw.close();
    await expect(cw.close()).resolves.toBeUndefined();
  });

  it('a failing purge is logged (event and error class only), never thrown, and the timer keeps going', async () => {
    vi.useFakeTimers();
    class Flaky extends MemoryStore {
      fail = true;
      override purgeReports(before: number, keepBadFaithSince: number): number {
        if (this.fail) throw new RangeError('secret-detail disk full');
        return super.purgeReports(before, keepBadFaithSince);
      }
    }
    const store = new Flaky();
    const { cw, logged } = await setup({ retention: { everyMs: 1000 } }, store);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged.filter(([e]) => e === 'chatwarden.purge_failed')).toEqual([
      ['chatwarden.purge_failed', { error: 'RangeError' }],
    ]);
    expect(JSON.stringify(logged)).not.toContain('secret-detail');
    store.fail = false;
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.rawReports()).toHaveLength(0);
    await cw.close();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects retention.everyMs = %s at creation', async (bad) => {
    await expect(setup({ retention: { everyMs: bad } })).rejects.toThrow(/retention\.everyMs/);
  });

  it('a manual purge() uses the configured policy unless the caller overrides it', async () => {
    const { cw, store } = await setup({ retention: false });
    store.insertReport({ ...oldReport('r1'), createdAt: NOW - 2 * DAY });
    expect((await cw.purge()).reports).toBe(0);
    expect((await cw.purge({ reportsMs: DAY })).reports).toBe(1);
  });
});

describe('createChatwarden: retention timer hardening', () => {
  const throwingLogger: Logger = {
    warn() {
      throw new Error('logger broke');
    },
  };
  const asyncBadLogger = { warn: () => Promise.reject(new Error('async')) } as unknown as Logger;
  const rejections: unknown[] = [];
  const onRejection = (r: unknown): void => void rejections.push(r);
  const settle = (): Promise<void> => new Promise<void>((r) => process.nextTick(r));
  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  class FailingStore extends MemoryStore {
    override purgeReports(): number {
      throw new RangeError('disk full');
    }
  }

  it('a throwing logger inside the purge failure path never produces an unhandledRejection', async () => {
    vi.useFakeTimers();
    const { cw } = await setup(
      { retention: { everyMs: 10 }, logger: throwingLogger, matcher: blocker },
      new FailingStore(),
    );
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('an async logger that rejects inside the purge failure path never produces an unhandledRejection', async () => {
    vi.useFakeTimers();
    const { cw } = await setup(
      { retention: { everyMs: 10 }, logger: asyncBadLogger, matcher: blocker },
      new FailingStore(),
    );
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('a throwing clock inside the timer is caught, logged, and the timer keeps going', async () => {
    vi.useFakeTimers();
    let broken = false;
    const clock = {
      now: () => {
        if (broken) throw new TypeError('clock broke');
        return NOW;
      },
    };
    const { cw, logged } = await setup({ retention: { everyMs: 10 }, clock, matcher: blocker });
    broken = true;
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    expect(logged.filter(([e]) => e === 'chatwarden.purge_failed')).toEqual([
      ['chatwarden.purge_failed', { error: 'TypeError' }],
      ['chatwarden.purge_failed', { error: 'TypeError' }],
      ['chatwarden.purge_failed', { error: 'TypeError' }],
    ]);
    await cw.close();
  });

  it('a throwing clock AND a throwing logger inside the timer is silent', async () => {
    vi.useFakeTimers();
    let broken = false;
    const clock = {
      now: () => {
        if (broken) throw new TypeError('clock broke');
        return NOW;
      },
    };
    const { cw } = await setup({ retention: { everyMs: 10 }, clock, logger: throwingLogger, matcher: blocker });
    broken = true;
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('everyMs 2_147_483_648 throws RangeError', async () => {
    const err = await setup({ retention: { everyMs: 2_147_483_648 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toBe('retention.everyMs must be at most 2147483647');
  });

  it.each([2_147_483_649, 1e12])('everyMs %s also throws RangeError', async (big) => {
    await expect(setup({ retention: { everyMs: big } })).rejects.toBeInstanceOf(RangeError);
  });

  it('everyMs 2_147_483_647 is accepted and schedules at exactly that interval', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { cw } = await setup({ retention: { everyMs: 2_147_483_647 }, matcher: blocker });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(2_147_483_647);
    await cw.close();
  });

  it('the no_matcher warning with a throwing logger does not reject createChatwarden', async () => {
    const { cw } = await setup({ logger: throwingLogger, retention: false });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'hello')).toBeDefined();
    await cw.close();
  });

  it('the no_matcher warning with an async-rejecting logger does not reject or leak', async () => {
    const { cw } = await setup({ logger: asyncBadLogger, retention: false });
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('the no_matcher warning with the default logger and a throwing console.warn does not reject', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console broke');
    });
    const { cw } = await setup({ logger: undefined, retention: false });
    await cw.close();
  });
});

describe('createChatwarden: no matcher warning', () => {
  it('logs chatwarden.no_matcher once at creation when no matcher is given', async () => {
    const { cw, logged } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.chat.accept(R, 'a', 'hello');
    cw.chat.accept(R, 'a', 'hello again');
    expect(logged.filter(([e]) => e === 'chatwarden.no_matcher')).toEqual([['chatwarden.no_matcher', undefined]]);
  });

  it('logs nothing about it when a matcher is given', async () => {
    const { logged } = await setup({ matcher: blocker });
    expect(logged.filter(([e]) => e === 'chatwarden.no_matcher')).toEqual([]);
  });
});

// --- K2: rules, decisions and notices ------------------------------------------------------------------------

const ID_RE = /s_[A-Za-z0-9_-]{22}|[0-9a-f]{32}/;
const DAY = 86_400_000;

/** A registry where slurs are CR 3 and CR 1 is something else, so a hard-coded "1" cannot pass by luck. */
const customRules = () =>
  defineRules([
    { number: 1, title: 'Be kind', text: 'Be kind.' },
    { number: 2, title: 'No spam', text: 'No spam.' },
    { number: 3, title: 'No slurs', text: 'No slurs.' },
    { number: 4, title: 'Old rule', text: 'Retired.', retired: true },
  ]);

const spanBlocker: Matcher = {
  match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null),
  spans: (t) => {
    const i = t.toLowerCase().indexOf('zorbak');
    return i < 0 ? [] : [{ start: i, end: i + 6, termId: 'syn:zorbak' }];
  },
};

/** Alice and Bob seated, Alice has written one clean and one blocked line, Bob has reported her. */
async function reported(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const s = await setup({ matcher: spanBlocker, ...over }, store);
  const { cw } = s;
  cw.rooms.seat(R, 'a', alice, 'Alice');
  cw.rooms.seat(R, 'b', bob, 'Bob');
  const clean = cw.chat.accept(R, 'a', 'hello there');
  cw.chat.accept(R, 'a', 'you zorbak');
  cw.chat.accept(R, 'b', 'bob line');
  if (!('deliver' in clean)) throw new Error('expected a delivered line');
  const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  if (!res.ok) throw new Error('expected the report to be stored');
  const report = store.loadReport(res.reportId);
  if (report === null) throw new Error('expected a stored report');
  const own = report.excerpt.filter((l) => l.seatId === 'a').map((l) => l.lineId);
  const bobLine = report.excerpt.find((l) => l.seatId === 'b')?.lineId;
  const a = cw.rooms.subjectAt(R, 'a');
  const b = cw.rooms.subjectAt(R, 'b');
  if (a === null || b === null) throw new Error('expected subjects');
  return { ...s, reportId: res.reportId, own, bobLine, a, b, cleanLineId: clean.deliver.lineId };
}

type Reported = Awaited<ReturnType<typeof reported>>;

const warnAlice = (r: Reported, over: Partial<DecisionAction> = {}) =>
  r.cw.decide({
    reportId: r.reportId,
    verdict: 'fair',
    actor: 'mod@example.test',
    reason: 'private reason text',
    actions: [{ subject: r.a, kind: 'warning', durationMs: null, rule: 2, lineIds: r.own, ...over }],
  });

describe('createChatwarden: rules', () => {
  it('exposes the starter registry by default', async () => {
    const { cw } = await setup();
    expect(cw.rules.active().map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cw.rules.get(1)?.title).toBe(STARTER_RULES[0]?.title);
  });

  it('exposes the registry the adopter passed, as given', async () => {
    const rules = customRules();
    const { cw } = await setup({ rules });
    expect(cw.rules).toBe(rules);
  });
});

describe('createChatwarden: autoRestrictRule', () => {
  it('defaults to CR 1 for the blocked refusal, the stored timeout and its notice', async () => {
    const { cw } = await setup({ matcher: spanBlocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 1 } });
    cw.chat.accept(R, 'a', 'zorbak');
    cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted', rule: 1 } });
    expect(cw.notices.pending(alice).map((n) => n.rule)).toEqual([1]);
  });

  it('a custom registry where slurs are CR 3 makes blocked refusals, auto timeouts and their notices cite 3', async () => {
    const { cw, store } = await setup({ matcher: spanBlocker, rules: customRules(), autoRestrictRule: 3 });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 3 } });
    cw.chat.accept(R, 'a', 'zorbak');
    cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted', rule: 3 } });
    const subject = cw.rooms.subjectAt(R, 'a');
    const stored = store.loadSanctions(NOW).filter((r) => r.value === subject);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((r) => r.rule === '3')).toBe(true);
    const notices = cw.notices.pending(alice);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'chat', rule: 3, ruleLabel: 'Community Rule 3: No slurs' });
  });

  it('the in-memory fallback restriction cites the configured rule too (and still has no notice id)', async () => {
    class FailingSanctions extends MemoryStore {
      override insertSanctionGroup(): boolean {
        throw new Error('disk full');
      }
    }
    const { cw } = await setup({ matcher: spanBlocker, rules: customRules(), autoRestrictRule: 3 }, new FailingSanctions());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    const r = cw.chat.accept(R, 'a', 'hi');
    expect(r).toEqual({ refuse: { reason: 'restricted', until: expect.any(Number), byModerator: false, rule: 3 } });
  });

  it('is validated at creation: a retired, unknown, zero, fractional or non-finite number throws the same RangeError', async () => {
    const messages = new Set<string>();
    for (const bad of [4, 9, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await setup({ rules: customRules(), autoRestrictRule: bad }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      messages.add((err as RangeError).message);
    }
    expect([...messages]).toHaveLength(1);
    expect([...messages][0]).not.toMatch(/\d/);
  });

  it('a rejected option closes nothing', async () => {
    const store = new MemoryStore();
    const closed = vi.spyOn(store, 'close');
    await expect(setup({ autoRestrictRule: 99 }, store)).rejects.toThrow(RangeError);
    expect(closed).not.toHaveBeenCalled();
  });

  it('a registry without CR 1 needs an explicit autoRestrictRule', async () => {
    const rules = defineRules([{ number: 2, title: 'Only', text: 'Only rule.' }]);
    await expect(setup({ rules })).rejects.toThrow(RangeError);
    const { cw } = await setup({ rules, autoRestrictRule: 2, matcher: spanBlocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 2 } });
  });
});

describe('createChatwarden: decide and the player notices', () => {
  it('warning with the reported lines: the target gets a notice with their own lines only; the reporter gets an outcome', async () => {
    const r = await reported();
    const { cw } = r;
    expect(cw.notices.pending(alice)).toEqual([]);
    expect(cw.notices.pendingWarning(alice)).toBe(false);
    expect((await warnAlice(r)).ok).toBe(true);
    const [n] = cw.notices.pending(alice);
    expect(cw.notices.pending(alice)).toHaveLength(1);
    expect(n).toMatchObject({ kind: 'warning', rule: 2, mustAcknowledge: true, until: null });
    expect(n?.excerpt.map((l) => l.text)).toEqual(['hello there', 'you ******']);
    expect(r.own).toContain(r.cleanLineId);
    expect(r.bobLine).toBeDefined();
    expect(cw.notices.pendingWarning(alice)).toBe(true);
    const outcome = cw.notices.pending(bob);
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({ kind: 'report_outcome', excerpt: [], rule: null, refCode: null });
    const text = JSON.stringify([cw.notices.pending(alice), outcome, cw.notices.record(alice)]);
    expect(text).not.toMatch(ID_RE);
    expect(text).not.toContain('private reason text');
    expect(text).not.toContain('bob line');
    expect(text).not.toContain('mod@example.test');
    expect(text).not.toContain('zorbak');
  });

  it('ack removes it from pending, clears pendingWarning, and keeps it in the record', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    const [n] = cw.notices.pending(alice);
    if (n === undefined) throw new Error('expected a notice');
    expect(cw.notices.record(alice).map((x) => x.id)).toEqual([n.id]);
    expect(cw.notices.ack(alice, n.id)).toBe(true);
    expect(cw.notices.ack(alice, n.id)).toBe(true);
    expect(cw.notices.pending(alice)).toEqual([]);
    expect(cw.notices.pendingWarning(alice)).toBe(false);
    expect(cw.notices.record(alice).map((x) => x.id)).toEqual([n.id]);
  });

  it("one player cannot ack another player's notice, and an unknown id is false", async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    const [n] = cw.notices.pending(alice);
    if (n === undefined) throw new Error('expected a notice');
    expect(cw.notices.ack(bob, n.id)).toBe(false);
    expect(cw.notices.ack(alice, 'nope')).toBe(false);
    expect(cw.notices.ack(alice, '')).toBe(false);
    expect(cw.notices.pending(alice)).toHaveLength(1);
  });

  it('an unknown person gets empty lists and false, and is not created', async () => {
    const { cw, store } = await setup();
    const ghost: RawWho = { clientKey: 'key-ghost', accountId: 'acct-ghost', ip: '198.51.100.9' };
    const before = (await store.loadSubjects()).subjects.length;
    expect(cw.notices.pending(ghost)).toEqual([]);
    expect(cw.notices.record(ghost)).toEqual([]);
    expect(cw.notices.pendingWarning(ghost)).toBe(false);
    expect(cw.notices.ack(ghost, 'anything')).toBe(false);
    expect(cw.notices.pending({})).toEqual([]);
    await cw.flush();
    expect((await store.loadSubjects()).subjects.length).toBe(before);
    // Control: once seated they are known.
    cw.rooms.seat(R, 'g', ghost, 'Ghost');
    await cw.flush();
    expect((await store.loadSubjects()).subjects.length).toBe(before + 1);
  });

  it('an IP alone never finds a notice', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    expect(cw.notices.pending({ ip: '198.51.100.1' })).toEqual([]);
    expect(cw.notices.pending({ clientKey: 'other', ip: '198.51.100.1' })).toEqual([]);
    expect(cw.notices.pending(alice)).toHaveLength(1);
  });

  it('a notice follows the person across an account link', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    cw.rooms.seat(R, 'a2', { clientKey: 'key-alice', accountId: 'acct-alice' }, 'Alice');
    await cw.flush();
    expect(cw.notices.pending({ accountId: 'acct-alice' })).toHaveLength(1);
  });

  it('decide is idempotent: the same decision twice is a replay and sends no second notice', async () => {
    const r = await reported();
    const first = await warnAlice(r);
    const second = await warnAlice(r);
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: true });
    expect(r.cw.notices.pending(alice)).toHaveLength(1);
    expect(r.cw.notices.pending(bob)).toHaveLength(1);
  });

  it('refuses to put another player line in a notice', async () => {
    const r = await reported();
    const res = await warnAlice(r, { lineIds: [r.bobLine ?? 'x'] });
    expect(res).toEqual({ ok: false, error: 'invalid' });
    expect(r.cw.notices.pending(alice)).toEqual([]);
  });

  it('a decide store failure rejects with the store error and writes nothing (documented pass-through)', async () => {
    class FailingDecision extends MemoryStore {
      fail = false;
      override insertDecision(...args: Parameters<MemoryStore['insertDecision']>): void {
        if (this.fail) throw new Error('disk full');
        super.insertDecision(...args);
      }
    }
    const store = new FailingDecision();
    const r = await reported({}, store);
    store.fail = true;
    await expect(warnAlice(r)).rejects.toThrow('disk full');
    expect(r.cw.notices.pending(alice)).toEqual([]);
    expect(r.cw.notices.pending(bob)).toEqual([]);
  });

  it('an uncovered decision needs a gap note and shows up in gaps.list without a subject id', async () => {
    const r = await reported();
    const { cw, a } = r;
    expect(await warnAlice(r, { rule: 'uncovered', lineIds: [] })).toEqual({ ok: false, error: 'invalid' });
    const ok = await warnAlice(r, { rule: 'uncovered', gapNote: 'trading accounts', lineIds: [] });
    if (!ok.ok) throw new Error('expected ok');
    const rows = cw.gaps.list();
    expect(rows).toEqual([
      {
        groupId: ok.groups[0]?.groupId,
        refCode: ok.groups[0]?.refCode,
        at: NOW,
        actor: 'mod@example.test',
        note: 'trading accounts',
        rule: 'uncovered',
        status: 'open',
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(ID_RE);
    expect(JSON.stringify(rows)).not.toContain(a);
    // The player never sees the note.
    expect(JSON.stringify(cw.notices.pending(alice))).not.toContain('trading accounts');
    // Closing: once, then false; an unknown group is false.
    const g = ok.groups[0]?.groupId ?? '';
    expect(cw.gaps.close(g, 'ruled', '9', 'boss')).toBe(true);
    expect(cw.gaps.close(g, 'not_a_rule', null, 'boss')).toBe(false);
    expect(cw.gaps.close('nope', 'ruled', '9', 'boss')).toBe(false);
    expect(cw.gaps.list()[0]).toMatchObject({ status: 'ruled' });
  });

  it('gaps.list is empty when nothing is uncovered', async () => {
    const { cw } = await setup();
    expect(cw.gaps.list()).toEqual([]);
  });
});

describe('createChatwarden: revoke withdraws the notice (R16)', () => {
  it('revoke: the pending notice is gone and it is no longer in the record', async () => {
    const r = await reported();
    const { cw } = r;
    const res = await warnAlice(r, { kind: 'chat', durationMs: H });
    if (!res.ok) throw new Error('expected ok');
    expect(cw.notices.pending(alice)).toHaveLength(1);
    expect(cw.notices.record(alice)).toHaveLength(1);
    expect(await cw.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod', 'mistake')).toBe(true);
    expect(cw.notices.pending(alice)).toEqual([]);
    expect(cw.notices.record(alice)).toEqual([]);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
  });

  it('a seen notice leaves the record on revoke too, and a second revoke is false', async () => {
    const r = await reported();
    const { cw } = r;
    const res = await warnAlice(r);
    if (!res.ok) throw new Error('expected ok');
    const [n] = cw.notices.pending(alice);
    cw.notices.ack(alice, n?.id ?? '');
    const g = res.groups[0]?.groupId ?? '';
    expect(await cw.sanctions.revoke(g, 'mod', 'mistake')).toBe(true);
    expect(cw.notices.record(alice)).toEqual([]);
    expect(await cw.sanctions.revoke(g, 'mod', 'again')).toBe(false);
  });

  it('revoking an unknown group is false and changes nothing', async () => {
    const r = await reported();
    await warnAlice(r);
    expect(await r.cw.sanctions.revoke('nope', 'mod', 'x')).toBe(false);
    expect(r.cw.notices.pending(alice)).toHaveLength(1);
  });

  it('a revoke of a sanction applied directly (no notice) still works', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a') ?? '';
    const { groupId } = await cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: H,
      reason: 'private note',
      actor: 'mod',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    expect(await cw.sanctions.revoke(groupId, 'mod', 'x')).toBe(true);
  });
});

describe('createChatwarden: platform.notify', () => {
  it('feeds the one notice service: decide notifies the target and the reporter with a count', async () => {
    const told: Array<[string, unknown]> = [];
    const platform: Platform = {
      identify: (ctx) => ctx as RawWho,
      notify(who, event) {
        told.push([who, event]);
      },
    };
    const r = await reported({ platform });
    await warnAlice(r);
    expect(told).toHaveLength(2);
    expect(told).toEqual(
      expect.arrayContaining([
        [r.a, { type: 'notice_pending', count: 1 }],
        [r.b, { type: 'notice_pending', count: 1 }],
      ]),
    );
  });

  it('the chat auto timeout notifies too (the same service)', async () => {
    const told: string[] = [];
    const platform: Platform = { identify: (ctx) => ctx as RawWho, notify: (who) => void told.push(who) };
    const { cw } = await setup({ platform, matcher: spanBlocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(told).toEqual([cw.rooms.subjectAt(R, 'a')]);
  });

  it('is called with the platform as this', async () => {
    let self: unknown;
    const platform: Platform = {
      identify: (ctx) => ctx as RawWho,
      notify(this: Platform) {
        self = [this.identify, typeof this.notify];
      },
    };
    const r = await reported({ platform });
    await warnAlice(r);
    expect(self).toEqual([platform.identify, 'function']);
  });

  it('a throwing or rejecting notify never fails decide', async () => {
    for (const make of [
      () => {
        throw new TypeError('boom');
      },
      () => Promise.reject(new TypeError('async boom')),
    ]) {
      const platform: Platform = { identify: (ctx) => ctx as RawWho, notify: make };
      const r = await reported({ platform });
      const res = await warnAlice(r);
      expect(res.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(r.logged.some(([e]) => e === 'notices.notify_failed')).toBe(true);
      expect(r.cw.notices.pending(alice)).toHaveLength(1);
    }
  });

  it('works with no notify at all (control)', async () => {
    const r = await reported();
    expect((await warnAlice(r)).ok).toBe(true);
  });
});

describe('createChatwarden: doors point at the notice', () => {
  it('a decided ban refuses at the door with that person own noticeId', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r, { kind: 'ban', durationMs: DAY });
    const [n] = cw.notices.pending(alice);
    expect(cw.doors.check('join', alice)).toMatchObject({ kind: 'ban', noticeId: n?.id });
    expect(cw.doors.check('join', bob)).toBeNull();
  });
});

describe('createChatwarden: history and suggest', () => {
  it('a fresh person has no history and the ladder suggests a warning for a low rule', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const a = cw.rooms.subjectAt(R, 'a') ?? '';
    expect(cw.history(a)).toEqual([]);
    expect(cw.suggest(a, 'low', 2)).toMatchObject({ kind: 'warning', durationMs: null });
    expect(cw.suggest(a, null, 2)).toMatchObject({ kind: 'warning' });
    expect(cw.suggest(a, 'high', 1)).toMatchObject({ kind: 'chat', durationMs: 7 * DAY });
  });

  it('a decided warning shows in the history and moves the suggestion up the ladder', async () => {
    const r = await reported();
    const { cw, a } = r;
    await warnAlice(r);
    expect(cw.history(a)).toHaveLength(1);
    expect(cw.history(a)[0]).toMatchObject({ kind: 'warning' });
    expect(cw.suggest(a, 'medium', 2)).toMatchObject({ kind: 'chat', durationMs: DAY });
  });

  it('a record older than the 90-day lookback no longer counts', async () => {
    const r = await reported();
    const { cw, clock, a } = r;
    await warnAlice(r);
    clock.t += 91 * DAY;
    expect(cw.history(a)).toEqual([]);
    expect(cw.suggest(a, 'medium', 2)).toMatchObject({ kind: 'warning' });
  });
});
