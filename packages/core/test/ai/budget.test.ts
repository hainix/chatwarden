import { describe, expect, it } from 'vitest';
import { CallWindow, nextUtcMidnight, startOfUtcDay, utcDayLabel } from '../../src/ai/budget.js';
import { MemoryStore } from '@chatwarden/store-memory';
import { createFakeModerationAI } from '../../src/ai/fake.js';
import { createChatwarden } from '../../src/chatwarden.js';
import { aiWorld, MIN as MINUTE } from './aiWorld.js';

const DAY = 24 * 3_600_000;
// 2027-01-15 13:45:10 UTC
const T = Date.UTC(2027, 0, 15, 13, 45, 10);

describe('the UTC day', () => {
  it('starts at 00:00 UTC and ends at the next midnight', () => {
    expect(startOfUtcDay(T)).toBe(Date.UTC(2027, 0, 15));
    expect(nextUtcMidnight(T)).toBe(Date.UTC(2027, 0, 16));
  });

  it('the first and last millisecond of a day belong to it', () => {
    expect(startOfUtcDay(Date.UTC(2027, 0, 15))).toBe(Date.UTC(2027, 0, 15));
    expect(startOfUtcDay(Date.UTC(2027, 0, 16) - 1)).toBe(Date.UTC(2027, 0, 15));
    expect(nextUtcMidnight(Date.UTC(2027, 0, 15))).toBe(Date.UTC(2027, 0, 16));
  });

  it('is a label of YYYY-MM-DD, and crosses a month and a year', () => {
    expect(utcDayLabel(T)).toBe('2027-01-15');
    expect(utcDayLabel(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
    expect(utcDayLabel(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('2027-01-01');
    expect(nextUtcMidnight(T) - startOfUtcDay(T)).toBe(DAY);
  });
});

describe('the call window', () => {
  it('allows the limit within a minute and refuses the next', () => {
    const w = new CallWindow(3);
    expect(w.tryTake(1000)).toBe(true);
    expect(w.tryTake(1001)).toBe(true);
    expect(w.tryTake(1002)).toBe(true);
    expect(w.tryTake(1003)).toBe(false);
  });

  it('frees a slot exactly one window after it was taken', () => {
    const w = new CallWindow(1);
    expect(w.tryTake(0)).toBe(true);
    expect(w.tryTake(59_999)).toBe(false);
    expect(w.tryTake(60_000)).toBe(true);
  });

  it('gives a slot back', () => {
    const w = new CallWindow(1);
    expect(w.tryTake(500)).toBe(true);
    w.giveBack(500);
    expect(w.tryTake(501)).toBe(true);
  });

  it('peek says whether a slot is free without taking it', () => {
    const w = new CallWindow(1);
    expect(w.peek(0)).toBe(true);
    expect(w.peek(0)).toBe(true);
    expect(w.tryTake(0)).toBe(true);
    expect(w.peek(1)).toBe(false);
    expect(w.peek(60_000)).toBe(true);
  });

  it('a limit of 0 never allows a call', () => {
    expect(new CallWindow(0).tryTake(0)).toBe(false);
  });
});

// --- the budget at work in the service -------------------------------------------------------------------------------------------

describe('the daily cap in the service', () => {
  it('the daily cap stops calls and marks reads skipped; the next UTC day resumes', async () => {
    const w = await aiWorld({ ai: { dailyBudgetMicros: 1000 } });
    const a = await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    expect(w.cw.ai.status()).toMatchObject({ spentMicros: 1000, capMicros: 1000, state: 'paused_budget' });
    const b = await w.report();
    await w.idle();
    // At the cap: nothing is called, and the read is marked skipped (not lost).
    expect(w.adapter.callCount).toBe(1);
    expect(w.cw.ai.read(b.id)).toBeNull();
    const retries = (w.store as MemoryStore).listAiRetries(Date.UTC(2100, 0, 1), 50);
    expect(retries.filter((r) => r.status === 'skipped' && r.errorKind === 'budget')).toHaveLength(1);
    // Later the same day: still paused, and the skipped read is not asked again.
    w.clock.t += 2 * MINUTE;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    // The next UTC day: the cap is fresh and the sweeper resumes.
    w.clock.t = Date.UTC(2027, 0, 16, 0, 0, 1);
    expect(w.cw.ai.status().state).toBe('ok');
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    expect(w.cw.ai.read(b.id)).not.toBeNull();
    expect(w.cw.ai.read(a.id)).not.toBeNull();
  });

  it('a skipped read does not write an ai.read audit row (it is not an outcome yet)', async () => {
    const w = await aiWorld({ ai: { dailyBudgetMicros: 0 } });
    await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(0);
    expect(w.cw.audit.list({ limit: 20, action: 'ai.read' }).items).toHaveLength(0);
  });

  it('spend survives a new service instance on the same store', async () => {
    const store = new MemoryStore();
    const a = await aiWorld({ store, ai: { dailyBudgetMicros: 1500 } });
    await a.report();
    await a.idle();
    expect(a.cw.ai.status().spentMicros).toBe(1000);
    const adapter = createFakeModerationAI();
    const b = await createChatwarden({
      store,
      secret: 'reporting-secret',
      platform: { identify: (ctx) => ctx as never },
      clock: a.clock,
      retention: false,
      logger: { warn: () => undefined },
      overrides: { ai: { level: 1 } },
      ai: { adapter, dailyBudgetMicros: 1500 },
    });
    expect(b.ai.status().spentMicros).toBe(1000);
    // 1000 spent of 1500: one more call fits, then the cap holds.
    const t = a.table();
    a.cw.chat.accept(t.room, 'p2', 'rude words');
    await a.submit(t.room);
    await b.ai.sweep();
    await b.ai.idle();
    await b.ai.sweep();
    await b.ai.idle();
    expect(adapter.callCount).toBeLessThanOrEqual(2);
    expect(b.ai.status().spentMicros).toBeLessThanOrEqual(3000);
    expect(b.ai.status().state).toBe('paused_budget');
    await b.close();
  });

  it('the in-flight estimate counts against the cap, so a burst cannot overshoot it', async () => {
    const w = await aiWorld({ script: [{ hang: true }], ai: { dailyBudgetMicros: 1000, concurrency: 2, timeoutMs: 40 } });
    await w.report();
    await w.report();
    await w.idle();
    // The first call was in flight (estimated 1 000) when the second job looked: only one adapter call.
    expect(w.adapter.callCount).toBe(1);
  });

  it('a failed call that was billed counts toward the cap (a refusal with usage is not free)', async () => {
    const w = await aiWorld({ script: [{ output: 'junk', usage: { costMicros: 2000 } }], ai: { dailyBudgetMicros: 2000 } });
    await w.report();
    await w.idle();
    expect(w.cw.ai.status()).toMatchObject({ spentMicros: 2000, state: 'paused_budget' });
    await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });
});

describe('the per-minute cap in the service', () => {
  it('the per-minute cap defers jobs', async () => {
    const w = await aiWorld({ ai: { perMinuteCalls: 2 } });
    for (let i = 0; i < 4; i += 1) await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    // Deferred, not lost: a minute later the sweeper reads the rest.
    w.clock.t += MINUTE;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(4);
  });

  it('the window is a sliding minute', async () => {
    const w = await aiWorld({ ai: { perMinuteCalls: 1 } });
    await w.report();
    await w.idle();
    // (A report takes 13 seconds to file in this world.) 53 seconds after the first call: still inside its minute.
    w.clock.t += 40_000;
    await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    w.clock.t += 10_000;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
  });
});
