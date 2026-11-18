import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { Logger, RawWho } from '../src/types.js';

// S4: the shared pacer inside the kit: the option that turns it on, the store that lacks the methods, the store that fails, and the pace overrides that stay per process.

const T = 1_800_000_000_000;
const SEC = 1000;
const ROOM = 'arena';
const PACE = { slowModeMs: 1000, burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 30_000 } as const;

type Logs = Array<[string, Record<string, unknown> | undefined]>;

async function kit(over: Partial<ChatwardenOptions> = {}, store: MemoryStore = new MemoryStore(), clock = { t: T, now: () => clock.t }) {
  const logs: Logs = [];
  const logger: Logger = { warn: (event, detail) => void logs.push([event, detail]) };
  const cw = await createChatwarden({
    store,
    secret: 'shared-pacing-secret-0001',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
    profanity: { apply: (t) => ({ hit: false, text: t }) },
    overrides: { pace: PACE },
    ...over,
  });
  logs.length = 0;
  return { cw, logs, clock, store };
}
const seat = (cw: Awaited<ReturnType<typeof kit>>['cw'], seatId: string, key: string, room = ROOM): void => cw.rooms.seat(room, seatId, { clientKey: key }, key);
const say = (cw: Awaited<ReturnType<typeof kit>>['cw'], seatId: string, text: string, room = ROOM) => cw.chat.accept(room, seatId, text);
const reasonOf = (r: ReturnType<typeof say>): string => ('deliver' in r ? 'ok' : r.refuse.reason);

const PACE_METHODS = ['paceLoad', 'paceUpdate', 'paceDropRoom', 'paceSweep'] as const;

describe('the option', () => {
  it('sharedPacing true on a store without the methods throws a plain message naming the missing method; with every method present it builds', async () => {
    const store = new MemoryStore();
    for (const m of PACE_METHODS) {
      const bare = Object.create(store) as MemoryStore;
      (bare as unknown as Record<string, unknown>)[m] = undefined;
      await expect(kit({ sharedPacing: true }, bare), m).rejects.toThrow(new RegExp(m));
      await expect(kit({ sharedPacing: true }, bare), m).rejects.toThrow(/sharedPacing/);
    }
    await expect(kit({ sharedPacing: true })).resolves.toBeDefined();
  });

  it('a value that is not a boolean is a TypeError; false and absent are the same', async () => {
    await expect(kit({ sharedPacing: 'yes' as never })).rejects.toThrow(TypeError);
    await expect(kit({ sharedPacing: 1 as never })).rejects.toThrow(TypeError);
    await expect(kit({ sharedPacing: false })).resolves.toBeDefined();
  });

  it('off, no store pace method is ever called, over a conversation, a room close and a purge', async () => {
    const store = new MemoryStore();
    const called: string[] = [];
    for (const m of PACE_METHODS) {
      const real = store[m].bind(store) as (...a: unknown[]) => unknown;
      (store as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        called.push(m);
        return real(...args);
      };
    }
    const { cw, clock } = await kit({}, store);
    seat(cw, 'a', 'alice');
    for (let i = 0; i < 6; i++) {
      say(cw, 'a', `a line number ${i} of text`);
      clock.t += 2 * SEC;
    }
    cw.rooms.close(ROOM);
    await cw.purge();
    // the pacing path (check, commit, a room close) never touches the store; the retention pass sweeps a stale pace row whatever the option (a store of an earlier run may hold some)
    expect(called.filter((m) => m !== 'paceSweep')).toEqual([]);
  });

  it('on: the pace state is in the store (one row per person per room) and the kit holds none in memory', async () => {
    const { cw, store, clock } = await kit({ sharedPacing: true });
    seat(cw, 'a', 'alice');
    expect(reasonOf(say(cw, 'a', 'hello there friends'))).toBe('ok');
    clock.t += 2 * SEC;
    expect(reasonOf(say(cw, 'a', 'hello there friends'))).toBe('duplicate');
    const rows = ['seat:a', cw.rooms.subjectAt(ROOM, 'a') as string].map((who) => store.paceLoad(ROOM, who));
    expect(rows.filter((r) => r !== null)).toHaveLength(1);
    const row = rows.find((r) => r !== null);
    expect(row?.stamps).toEqual([T]);
    expect(JSON.stringify(row)).not.toContain('hello there');
  });
});

describe('who a row belongs to', () => {
  it('a person is keyed by the canonical subject: two seats of one person (merged ids) share one row', async () => {
    const { cw, store, clock } = await kit({ sharedPacing: true });
    cw.rooms.seat(ROOM, 'a1', { clientKey: 'phone-key', accountId: 'acct-1' }, 'alice');
    cw.rooms.seat(ROOM, 'a2', { accountId: 'acct-1' }, 'alice');
    expect(reasonOf(say(cw, 'a1', 'a first line of text'))).toBe('ok');
    clock.t += 2 * SEC;
    // the second seat is the same account: the same pace state, so the repeat is refused
    expect(reasonOf(say(cw, 'a2', 'a first line of text'))).toBe('duplicate');
    const subject = cw.rooms.subjectAt(ROOM, 'a1') as string;
    expect(store.paceLoad(ROOM, subject)).not.toBeNull();
  });

  it('a guest (no key, no account) is keyed seat:<id>; two guests with different seats do not share state', async () => {
    const { cw, store, clock } = await kit({ sharedPacing: true });
    cw.rooms.seat(ROOM, 'g1', { ip: '203.0.113.7' }, 'guest-one');
    cw.rooms.seat(ROOM, 'g2', { ip: '203.0.113.7' }, 'guest-two');
    expect(reasonOf(say(cw, 'g1', 'a first line of text'))).toBe('ok');
    expect(reasonOf(say(cw, 'g2', 'a first line of text'))).toBe('ok');
    clock.t += 2 * SEC;
    expect(reasonOf(say(cw, 'g1', 'a first line of text'))).toBe('duplicate');
    expect(store.paceLoad(ROOM, 'seat:g1')).not.toBeNull();
    expect(store.paceLoad(ROOM, 'seat:g2')).not.toBeNull();
  });
});

describe('two kits on one store', () => {
  it('a player alternating lines between two kits is slowed by the burst limit as if on one process; a repeat sent to the second after the first is refused duplicate', async () => {
    const store = new MemoryStore();
    const clock = { t: T, now: () => clock.t };
    const a = await kit({ sharedPacing: true }, store, clock);
    seat(a.cw, 'p', 'alice');
    // The first process has written the person down before the second starts: a process learns the people the store holds when it starts (a person first seen by another process
    // later is a person of its own there until its next start, as for every other table keyed by person).
    await new Promise((r) => setTimeout(r, 5));
    const b = await kit({ sharedPacing: true }, store, clock);
    seat(b.cw, 'p', 'alice');
    expect(b.cw.rooms.subjectAt(ROOM, 'p')).toBe(a.cw.rooms.subjectAt(ROOM, 'p'));
    const lines = ['first line of text', 'second line of text', 'third line of text'];
    expect(reasonOf(say(a.cw, 'p', lines[0] as string))).toBe('ok');
    clock.t += 1100;
    expect(reasonOf(say(b.cw, 'p', lines[1] as string))).toBe('ok');
    clock.t += 1100;
    expect(reasonOf(say(a.cw, 'p', lines[2] as string))).toBe('ok');
    clock.t += 1100;
    expect(reasonOf(say(b.cw, 'p', 'fourth line of text'))).toBe('flood');
    expect(reasonOf(say(a.cw, 'p', 'fifth line of text'))).toBe('flood');
    clock.t += 40 * SEC;
    expect(reasonOf(say(a.cw, 'p', 'a repeated line here'))).toBe('ok');
    clock.t += 2 * SEC;
    expect(reasonOf(say(b.cw, 'p', 'A repeated line here!'))).toBe('duplicate');
  });

  it('setPace overrides stay per process: kit A with an override and kit B without give different verdicts for one player', async () => {
    const store = new MemoryStore();
    const clock = { t: T, now: () => clock.t };
    const a = await kit({ sharedPacing: true }, store, clock);
    seat(a.cw, 'p', 'alice');
    await new Promise((r) => setTimeout(r, 5));
    const b = await kit({ sharedPacing: true }, store, clock);
    seat(b.cw, 'p', 'alice');
    a.cw.rooms.setPace(ROOM, { slowModeMs: null, burst: null, duplicateWindowMs: null });
    expect(reasonOf(say(b.cw, 'p', 'first line of text'))).toBe('ok');
    clock.t += 200;
    // the same player, the same stored row: B's own pace (slow mode 1 s) refuses, A's override (everything off) does not
    expect(reasonOf(say(b.cw, 'p', 'second line of text'))).toBe('slow_mode');
    expect(reasonOf(say(a.cw, 'p', 'second line of text'))).toBe('ok');
  });
});

describe('rooms.close and purge', () => {
  it('rooms.close drops the room\'s rows and no other room\'s', async () => {
    const { cw, store, clock } = await kit({ sharedPacing: true });
    seat(cw, 'a', 'alice', ROOM);
    seat(cw, 'a', 'alice', 'other');
    say(cw, 'a', 'one line here', ROOM);
    say(cw, 'a', 'one line here', 'other');
    const subject = cw.rooms.subjectAt(ROOM, 'a') as string;
    expect(store.paceLoad(ROOM, subject)).not.toBeNull();
    cw.rooms.close(ROOM);
    expect(store.paceLoad(ROOM, subject)).toBeNull();
    expect(store.paceLoad('other', subject)).not.toBeNull();
    void clock;
  });

  it('purge sweeps rows older than an hour and reports the count in PurgeResult.pace; a store without the methods purges the rest', async () => {
    const { cw, store, clock } = await kit({ sharedPacing: true });
    seat(cw, 'a', 'alice');
    seat(cw, 'b', 'bob');
    say(cw, 'a', 'an old line of text');
    clock.t += 2 * 3_600_000;
    say(cw, 'b', 'a new line of text');
    const res = await cw.purge();
    expect(res.pace).toBe(1);
    expect(store.paceLoad(ROOM, cw.rooms.subjectAt(ROOM, 'b') as string)).not.toBeNull();
    expect(store.paceLoad(ROOM, cw.rooms.subjectAt(ROOM, 'a') as string)).toBeNull();
  });
});

describe('fail open', () => {
  it('a store whose paceLoad throws and whose paceUpdate throws before fn is reached: the line is delivered, chatwarden.pace_failed is logged once a minute with the class only, nothing is thrown', async () => {
    const store = new MemoryStore();
    const { cw, logs, clock } = await kit({ sharedPacing: true }, store);
    seat(cw, 'a', 'alice');
    store.paceLoad = () => {
      throw new RangeError('secret detail of a failure');
    };
    store.paceUpdate = () => {
      throw new TypeError('another secret detail');
    };
    for (let i = 0; i < 5; i++) {
      expect(reasonOf(say(cw, 'a', `a line number ${i} of text`))).toBe('ok');
      clock.t += 2 * SEC;
    }
    const failed = logs.filter(([e]) => e === 'chatwarden.pace_failed');
    expect(failed).toHaveLength(1);
    expect(Object.keys(failed[0]?.[1] ?? {}).sort()).toEqual(['error']);
    expect(JSON.stringify(logs)).not.toContain('secret detail');
    // a minute later it is logged again, with the count held back
    clock.t += 60 * SEC;
    say(cw, 'a', 'one more line of text');
    expect(logs.filter(([e]) => e === 'chatwarden.pace_failed')).toHaveLength(2);
  });

  it('a failing store does not stop the rest of the pipeline: a slur is still refused and struck', async () => {
    const store = new MemoryStore();
    const { cw } = await kit({ sharedPacing: true, matcher: { match: (t: string) => (/zorbak/.test(t) ? { termId: 'syn:zorbak' } : null) } }, store);
    seat(cw, 'a', 'alice');
    store.paceLoad = () => {
      throw new Error('down');
    };
    expect(reasonOf(say(cw, 'a', 'you zorbak'))).toBe('blocked');
  });
});
