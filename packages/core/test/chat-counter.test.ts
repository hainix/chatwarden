import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { ChatCounter, utcDay } from '../src/chatCounter.js';
import type { Logger } from '../src/types.js';
import { MIN, NOW, world } from './reportingWorld.js';

// U7: the daily line counter behind the report rate. In memory per process, flushed when the minute changes or at flush(), and only while desk.insights is on.

const MIDNIGHT = Date.UTC(2027, 0, 15, 0, 0, 0);

class SpyStore extends MemoryStore {
  writes: Array<[string, number, number]> = [];
  override addChatCounts(day: string, delivered: number, refused: number): void {
    this.writes.push([day, delivered, refused]);
    super.addChatCounts(day, delivered, refused);
  }
}

function counter(over: { enabled?: () => boolean; store?: SpyStore; start?: number; logger?: Logger } = {}) {
  const store = over.store ?? new SpyStore();
  const clock = { t: over.start ?? MIDNIGHT + 10 * MIN, now: () => clock.t };
  const c = new ChatCounter({ clock, store, enabled: over.enabled ?? (() => true), ...(over.logger === undefined ? {} : { logger: over.logger }) });
  return { c, store, clock };
}

describe('the counter', () => {
  it('delivered and refused are counted per UTC day and written when the minute rolls', () => {
    const { c, store, clock } = counter();
    c.delivered();
    c.delivered();
    c.refused();
    expect(store.writes).toEqual([]);
    clock.t += MIN;
    c.delivered();
    expect(store.writes).toEqual([['2027-01-15', 2, 1]]);
    expect(store.chatCounts('2027-01-15', '2027-01-15')).toEqual([{ day: '2027-01-15', delivered: 2, refused: 1 }]);
  });

  it('a minute roll flushes once: nothing more until the next roll', () => {
    const { c, store, clock } = counter();
    c.delivered();
    clock.t += MIN;
    c.delivered();
    c.delivered();
    c.refused();
    expect(store.writes).toHaveLength(1);
    clock.t += MIN;
    c.refused();
    expect(store.writes).toEqual([['2027-01-15', 1, 0], ['2027-01-15', 2, 1]]);
  });

  it('the same minute never writes, however many lines', () => {
    const { c, store, clock } = counter();
    for (let i = 0; i < 500; i += 1) {
      c.delivered();
      clock.t += 50;
    }
    expect(store.writes).toEqual([]);
  });

  it('a crash loses at most the current minute: without flush the open minute is not in the store', () => {
    const { c, store, clock } = counter();
    c.delivered();
    clock.t += MIN;
    c.delivered();
    c.delivered();
    // the first minute was written when the roll came; the open minute (2 lines) is only in memory
    expect(store.chatCounts('2027-01-15', '2027-01-15')).toEqual([{ day: '2027-01-15', delivered: 1, refused: 0 }]);
  });

  it('flush writes what is held at once, and a second flush writes nothing', () => {
    const { c, store } = counter();
    c.delivered();
    c.refused();
    c.flush();
    c.flush();
    expect(store.writes).toEqual([['2027-01-15', 1, 1]]);
  });

  it('a pending count that spans midnight is written as two days', () => {
    const { c, store, clock } = counter({ start: MIDNIGHT - 1000 });
    c.delivered();
    clock.t += 2000;
    c.refused();
    c.flush();
    expect(store.writes).toEqual([['2027-01-14', 1, 0], ['2027-01-15', 0, 1]]);
  });

  it('counting is off when the setting is off: nothing is held and the store sees no write, even at flush', () => {
    let on = false;
    const { c, store, clock } = counter({ enabled: () => on });
    c.delivered();
    clock.t += MIN;
    c.delivered();
    c.flush();
    expect(store.writes).toEqual([]);
    // switched on later: only what happens after counts
    on = true;
    c.delivered();
    c.flush();
    expect(store.writes).toEqual([['2027-01-15', 1, 0]]);
  });

  it('turned off mid-minute, what is held is dropped and not written', () => {
    let on = true;
    const { c, store, clock } = counter({ enabled: () => on });
    c.delivered();
    on = false;
    clock.t += MIN;
    c.delivered();
    c.flush();
    expect(store.writes).toEqual([]);
  });

  it('two processes add correctly', () => {
    const store = new SpyStore();
    const a = counter({ store });
    const b = counter({ store });
    a.c.delivered();
    a.c.delivered();
    b.c.delivered();
    b.c.refused();
    a.c.flush();
    b.c.flush();
    expect(store.chatCounts('2027-01-15', '2027-01-15')).toEqual([{ day: '2027-01-15', delivered: 3, refused: 1 }]);
  });

  it('a store that throws is logged by class and never throws; the counts are kept and written at the next flush', () => {
    const logged: Array<[string, unknown]> = [];
    const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
    class Flaky extends SpyStore {
      fail = true;
      override addChatCounts(day: string, d: number, r: number): void {
        if (this.fail) throw new Error('disk full: SENTINEL-path');
        super.addChatCounts(day, d, r);
      }
    }
    const store = new Flaky();
    const { c } = counter({ store, logger });
    c.delivered();
    expect(() => c.flush()).not.toThrow();
    expect(logged).toEqual([['chatwarden.chat_counts_failed', { error: 'Error' }]]);
    expect(JSON.stringify(logged)).not.toContain('SENTINEL');
    store.fail = false;
    c.flush();
    expect(store.chatCounts('2027-01-15', '2027-01-15')).toEqual([{ day: '2027-01-15', delivered: 1, refused: 0 }]);
  });

  it('a store without the method is a counter that does nothing, never an error', () => {
    const clock = { now: () => MIDNIGHT };
    const c = new ChatCounter({ clock, store: {} as never, enabled: () => true });
    expect(() => {
      c.delivered();
      c.flush();
    }).not.toThrow();
  });

  it('utcDay is the UTC date', () => {
    expect(utcDay(MIDNIGHT)).toBe('2027-01-15');
    expect(utcDay(MIDNIGHT - 1)).toBe('2027-01-14');
  });
});

describe('over the chat pipeline', () => {
  const room = async (w: Awaited<ReturnType<typeof world>>) => {
    w.cw.rooms.seat('R1', 'p1', { clientKey: 'key-one-aaaaaaaaaaaa' }, 'One');
    return 'R1';
  };

  it('with desk.insights on, accept counts a delivered and a refused line once each; an empty line is not a line', async () => {
    const store = new SpyStore();
    const w = await world({ overrides: { desk: { insights: true } } }, store);
    const r = await room(w);
    expect('deliver' in w.cw.chat.accept(r, 'p1', 'hello')).toBe(true);
    w.clock.t += 6000;
    expect(w.cw.chat.accept(r, 'p1', 'x'.repeat(500))).toEqual({ refuse: { reason: 'length' } });
    expect(w.cw.chat.accept(r, 'p1', '   ')).toEqual({ refuse: { reason: 'empty' } });
    expect(w.cw.chat.accept(r, 'nobody', 'hi')).toEqual({ refuse: { reason: 'gate' } });
    w.cw.insights.flush();
    const [today] = store.chatCounts('2000-01-01', '2100-01-01');
    expect(today).toEqual({ day: utcDay(NOW + 6000), delivered: 1, refused: 2 });
  });

  it('with desk.insights off the store sees no write and accept answers as before', async () => {
    const store = new SpyStore();
    const w = await world({}, store);
    const r = await room(w);
    for (let i = 0; i < 5; i += 1) {
      w.clock.t += 6000;
      w.cw.chat.accept(r, 'p1', `line ${i}`);
    }
    w.clock.t += 2 * MIN;
    w.cw.chat.accept(r, 'p1', 'one more');
    w.cw.insights.flush();
    expect(store.writes).toEqual([]);
  });

  it('accept is as fast with the counter on: a spy store sees at most one write a minute', async () => {
    const store = new SpyStore();
    const w = await world({ overrides: { desk: { insights: true } } }, store);
    const r = await room(w);
    for (let i = 0; i < 300; i += 1) {
      w.clock.t += 100;
      w.cw.chat.accept(r, 'p1', `line ${i}`);
    }
    // 30 s of lines, one minute: no write yet
    expect(store.writes).toEqual([]);
    w.clock.t += MIN;
    w.cw.chat.accept(r, 'p1', 'after the roll');
    expect(store.writes).toHaveLength(1);
  });

  it('a counter that throws never changes the answer', async () => {
    class Boom extends SpyStore {
      override addChatCounts(): void {
        throw new Error('nope');
      }
    }
    const w = await world({ overrides: { desk: { insights: true } } }, new Boom());
    const r = await room(w);
    w.cw.chat.accept(r, 'p1', 'one');
    w.clock.t += 2 * MIN;
    expect('deliver' in w.cw.chat.accept(r, 'p1', 'two')).toBe(true);
    expect(w.logged.map(([e]) => e)).toContain('chatwarden.chat_counts_failed');
  });
});
