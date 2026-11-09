import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
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
    expect(cw.chat.accept(R, 'a', 'you zorbak')).toEqual({ refuse: { reason: 'blocked' } });
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
  });

  it('a chat sanction refuses the next line as restricted, with a time and no identifiers; revoke lifts it', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    const { groupId, refCode } = await cw.sanctions.apply(chatSanction(subject));
    expect(refCode).toMatch(/^M-/);
    const refused = cw.chat.accept(R, 'a', 'hello');
    expect(refused).toEqual({ refuse: { reason: 'restricted', until: NOW + H, byModerator: true } });
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
    expect(await cw.purge()).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0 });
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
      override purgeReports(before: number): number {
        if (this.fail) throw new RangeError('secret-detail disk full');
        return super.purgeReports(before);
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
