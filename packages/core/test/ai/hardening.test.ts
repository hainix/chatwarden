import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { AIError } from '../../src/ai/types.js';
import { PARKED_MAX } from '../../src/ai/service.js';
import type { FakeStep } from '../../src/ai/fake.js';
import { aiWorld, MIN, NOW, OWNER } from './aiWorld.js';

// Fix round 1: the end of every road. A read again on a final row, a half-open breaker, the daily call ceiling, attempts that skips do
// not use up, and a sweeper that does not leak or starve.

const store = (w: { store: unknown }): MemoryStore => w.store as MemoryStore;
const view = (a: unknown): a is { id: string } => typeof a === 'object' && a !== null && 'id' in a;

describe('read again on a read that ended without an answer', () => {
  it.each([
    ['declined', { error: new AIError('declined') }],
    ['invalid (after its one retry)', { output: { nonsense: 1 } }],
    ['fatal', { error: new AIError('fatal') }],
  ] as Array<[string, FakeStep]>)('a final %s row is retaken once by an explicit ask; the second ask on the same row answers final', async (name, step) => {
    const steps: FakeStep[] = name.startsWith('invalid') ? [step, step, step] : [step];
    const w = await aiWorld({ level: 2, script: steps });
    const r = await w.report();
    await w.idle();
    if (name.startsWith('invalid')) {
      w.clock.t += MIN;
      await w.cw.ai.sweep();
      await w.idle();
    }
    const calls = w.adapter.callCount;
    expect(w.cw.ai.read(r.id)).toBeNull();
    // A fatal error opens the breaker; the ask waits for the probe time like any other.
    if (name === 'fatal') w.clock.t += 5 * MIN;
    w.clock.t += MIN;
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.adapter.callCount).toBe(calls + 1);
    // Whatever the retake got, the row is final again unless it answered; a second ask is refused once it is final.
    const after = w.cw.ai.read(r.id);
    if (name.startsWith('invalid')) {
      expect(after).toBeNull();
      expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('final');
      await w.idle();
      expect(w.adapter.callCount).toBe(calls + 1);
    }
  });

  it('a retake that gets an answer stores the read, and the call is charged and counted', async () => {
    const w = await aiWorld({ level: 2, script: [{ error: new AIError('declined') }] });
    const r = await w.report();
    await w.idle();
    const spent = w.cw.ai.status().spentMicros;
    w.clock.t += MIN;
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    const got = w.cw.ai.read(r.id);
    expect(got).not.toBeNull();
    expect(w.cw.ai.status().spentMicros).toBe(spent + 1000);
    expect(store(w).aiSpendSince(0).calls).toBe(2);
    // The read is there now: asking again is the ordinary "ready", no call.
    const again = await w.cw.ai.readAgain(r.id, 'mod_ann');
    expect(view(again)).toBe(true);
    expect(w.adapter.callCount).toBe(2);
    expect(w.cw.audit.list({ limit: 20, action: 'ai.read' }).items).toHaveLength(2);
  });

  it('a retake that is refused again is final, and the next ask answers final', async () => {
    const w = await aiWorld({ level: 2, script: [{ error: new AIError('declined') }, { error: new AIError('declined') }] });
    const r = await w.report();
    await w.idle();
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('final');
    expect(await w.cw.ai.readAgain(r.id, 'mod_bob')).toBe('final');
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
  });

  it('a changed case is a new row: a final row of the old input does not block it', async () => {
    const w = await aiWorld({ level: 2, script: [{ error: new AIError('declined') }, { error: new AIError('declined') }] });
    const r = await w.report();
    await w.idle();
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('final');
    w.clock.t += MIN;
    await w.cw.reports.addDetail(r.id, 'p1', { note: 'a new note' });
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.cw.ai.read(r.id)).not.toBeNull();
  });

  it('an open breaker answers unavailable with the wait, and calls nothing', async () => {
    const w = await aiWorld({ level: 2, script: [{ error: new AIError('fatal') }] });
    const r = await w.report();
    await w.idle();
    w.clock.t += 2 * MIN;
    const answer = await w.cw.ai.readAgain(r.id, 'mod_ann');
    expect(answer).toEqual({ unavailable: { retryAfterMs: 3 * MIN } });
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('a full call window answers unavailable until the first call leaves the minute', async () => {
    const w = await aiWorld({ level: 2, ai: { perMinuteCalls: 1 } });
    const a = await w.report();
    await w.idle();
    const t0 = w.clock.t;
    const b = await w.report();
    await w.idle();
    w.clock.t = t0 + 20_000;
    const answer = await w.cw.ai.readAgain(b.id, 'mod_ann');
    expect(answer).toEqual({ unavailable: { retryAfterMs: 40_000 } });
    expect(w.adapter.callCount).toBe(1);
    w.clock.t = t0 + 60_000;
    expect(await w.cw.ai.readAgain(b.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    void a;
  });

  it('the allowance is spent by an unavailable answer too, and a budget answer is checked first', async () => {
    const w = await aiWorld({ level: 2, script: [{ error: new AIError('fatal') }] });
    const r = await w.report();
    await w.idle();
    for (let i = 0; i < 10; i += 1) expect(typeof (await w.cw.ai.readAgain(r.id, 'mod_ann'))).toBe('object');
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('rate');
  });
});

describe('a half-open breaker', () => {
  it('lets one probe through and writes no skip rows for the others', async () => {
    const w = await aiWorld({ script: [{ error: new AIError('fatal') }, { hang: true }], ai: { concurrency: 3, timeoutMs: 30 } });
    await w.report();
    await w.idle();
    w.clock.t += 5 * MIN;
    // Three reports queued before the pump runs: one is the probe (it hangs), the others must not touch the store.
    await w.report();
    await w.report();
    await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    expect(store(w).listAiRetries(NOW + 99 * 24 * 60 * MIN, 50).filter((x) => x.status === 'skipped')).toEqual([]);
  });
});

describe('attempts', () => {
  it('a read skipped by the daily cap still gets all three attempts afterwards', async () => {
    const w = await aiWorld({ script: [{ usage: {} }, { error: new AIError('retryable') }, { error: new AIError('retryable') }, { error: new AIError('retryable') }], ai: { dailyBudgetMicros: 1000 } });
    await w.report();
    await w.idle();
    const b = await w.report();
    await w.idle();
    // b was skipped by the cap. The next UTC day it gets three real tries, not two.
    w.clock.t = Date.UTC(2027, 0, 16, 0, 0, 1);
    const tick = async (): Promise<void> => {
      await w.cw.ai.sweep();
      await w.idle();
    };
    await tick();
    expect(w.adapter.callCount).toBe(2);
    w.clock.t += MIN;
    await tick();
    expect(w.adapter.callCount).toBe(3);
    w.clock.t += 10 * MIN;
    await tick();
    expect(w.adapter.callCount).toBe(4);
    w.clock.t += 60 * MIN;
    await tick();
    expect(w.adapter.callCount).toBe(4);
    expect(w.cw.ai.read(b.id)).toBeNull();
  });
});

describe('the daily call ceiling', () => {
  it('a 0-cost adapter cannot run unbounded: the call ceiling stops it, and the next UTC day resumes', async () => {
    const w = await aiWorld({ dailyCalls: 2, script: () => ({ usage: { costMicros: 0 } }) });
    for (let i = 0; i < 3; i += 1) await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    expect(w.cw.ai.status()).toMatchObject({ capCalls: 2, reads: 2, state: 'paused_budget', spentMicros: 0 });
    w.clock.t = Date.UTC(2027, 0, 16, 0, 0, 1);
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(3);
    expect(w.cw.ai.status().state).toBe('ok');
  });

  it('an adapter that reports no usage at all is bounded too', async () => {
    const w = await aiWorld({ dailyCalls: 3, script: (): FakeStep => ({ output: undefined as never }) });
    for (let i = 0; i < 5; i += 1) await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(3);
  });

  it('the owner can change it live, and a read again at the ceiling answers budget', async () => {
    const w = await aiWorld({ dailyCalls: 1 });
    await w.report();
    const b = await w.report();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    expect(await w.cw.ai.readAgain(b.id, 'mod_ann')).toBe('budget');
    expect(w.cw.policy.save({ ai: { dailyCalls: 10 } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(await w.cw.ai.readAgain(b.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
  });

  it('the status names the ceiling (default 5000)', async () => {
    const w = await aiWorld();
    expect(w.cw.ai.status().capCalls).toBe(5000);
  });
});

describe('the sweeper keeps its books', () => {
  it('250 due retries of decided reports do not starve a live one', async () => {
    const w = await aiWorld({ level: 0, ai: { perMinuteCalls: 1000 } });
    const dead: string[] = [];
    for (let i = 0; i < 250; i += 1) dead.push((await w.report()).id);
    for (const id of dead) await w.cw.decide({ reportId: id, verdict: 'no_action', actions: [], actor: 'mod_ann' });
    // Rows that would be due forever: failed reads of reports nobody will read any more.
    dead.forEach((id, i) => {
      const r = store(w).reserveAiRead({ reportId: id, inputHash: `dead-${i}`, promptVersion: 2, adapter: 'fake:model' }, w.clock.t + MIN, w.clock.t);
      if (r.reserved) store(w).failAiRead(r.id, r.lease, 'failed', 'retryable', w.clock.t);
    });
    expect(w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    w.clock.t += MIN;
    w.adapter.push({ error: new AIError('retryable') });
    const live = await w.report();
    await w.idle();
    expect(w.cw.ai.read(live.id)).toBeNull();
    expect(w.adapter.callCount).toBe(1);
    w.clock.t += MIN;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    expect(w.cw.ai.read(live.id)).not.toBeNull();
  });

  it('parked entries are dropped once their report is decided', async () => {
    const w = await aiWorld({ script: [{ error: new AIError('declined') }, { error: new AIError('declined') }, { error: new AIError('declined') }] });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await w.report()).id);
    await w.idle();
    const service = w.cw.ai as unknown as { parkedSize(): number };
    expect(service.parkedSize()).toBe(3);
    for (const id of ids) await w.cw.decide({ reportId: id, verdict: 'no_action', actions: [], actor: 'mod_ann' });
    await w.cw.ai.sweep();
    expect(service.parkedSize()).toBe(0);
  });

  it('the parked list has a bound', async () => {
    const w = await aiWorld({ script: (): FakeStep => ({ error: new AIError('declined') }), ai: { perMinuteCalls: 5000, concurrency: 4 } });
    for (let i = 0; i < 30; i += 1) await w.report();
    await w.idle();
    const service = w.cw.ai as unknown as { parkedSize(): number };
    expect(service.parkedSize()).toBe(30);
    expect(PARKED_MAX).toBeGreaterThanOrEqual(1000);
  });
});
