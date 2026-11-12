import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import type { FakeScript } from '../../src/ai/fake.js';
import { AIError } from '../../src/ai/types.js';
import { world } from '../reportingWorld.js';
import { aiWorld } from './aiWorld.js';

// Fail-soft is the top rule: with the AI throwing, hanging, refusing, returning garbage or over budget, a player's report, the queue,
// the case page and a decision behave exactly as with the AI off, and the player's ack never waits for a model call.

describe('the ack path', () => {
  it('submit resolves before the adapter is called', async () => {
    const w = await aiWorld();
    const t = w.table();
    w.cw.chat.accept(t.room, 'p2', 'rude words');
    const res = await w.submit(t.room);
    expect(res.ok).toBe(true);
    expect(w.adapter.callCount).toBe(0);
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('submit resolves while the adapter hangs', async () => {
    const w = await aiWorld({ script: [{ hang: true }], ai: { timeoutMs: 60_000 } });
    const t = w.table();
    w.cw.chat.accept(t.room, 'p2', 'rude words');
    const res = await w.submit(t.room);
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(w.adapter.callCount).toBe(1));
    // A second player files while the first call is still hanging: also at once.
    const second = await w.file({ reason: 'harassment' });
    expect(second.id).toBeTruthy();
    await w.cw.close();
  });

  it('the listener only enqueues: it does no store read of the AI tables on the submit path', async () => {
    const w = await aiWorld();
    const store = w.store as MemoryStore;
    const spies = (['reserveAiRead', 'loadAiRead', 'loadAiReads', 'aiSpendSince'] as const).map((n) => vi.spyOn(store as never, n as never));
    const t = w.table();
    w.cw.chat.accept(t.room, 'p2', 'rude words');
    await w.submit(t.room);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    await w.idle();
    expect(spies[0]).toHaveBeenCalled();
  });

  it('a follow-up resolves before its read, too', async () => {
    const w = await aiWorld();
    const r = await w.report();
    await w.idle();
    const before = w.adapter.callCount;
    expect(await w.cw.reports.addDetail(r.id, 'p1', { note: 'more words' })).toEqual({ ok: true });
    expect(w.adapter.callCount).toBe(before);
  });
});

/** Everything about the queue, the case page and a decision that does not depend on random ids. */
let shapes = 0;
async function shape(w: Awaited<ReturnType<typeof world>>) {
  shapes += 1;
  const t = w.table({ reporter: `key-shape-reporter-${shapes}` });
  w.cw.chat.accept(t.room, 'p2', 'rude words');
  const res = await w.submit(t.room);
  if (!res.ok) throw new Error('refused');
  const mine = (items: Array<{ id: string }>) => items.filter((i) => i.id === res.reportId);
  const list = mine(w.cw.reports.list({ status: 'open' }).items);
  const page = w.cw.reports.get(res.reportId);
  const decided = await w.cw.decide({ reportId: res.reportId, verdict: 'no_action', actions: [], actor: 'mod_ann' });
  const after = mine(w.cw.reports.list({ status: 'open' }).items);
  return {
    res: Object.keys(res).sort(),
    list: list.map((i) => Object.keys(i).sort()),
    page: page === null ? null : Object.keys(page).sort(),
    decided: decided.ok ? { ok: true, replay: decided.replay, groups: decided.groups } : decided,
    after: after.length,
  };
}

describe('fail-soft: the AI misbehaves and nothing else notices', () => {
  const off = world();
  const cases: Array<[string, FakeScript, Record<string, unknown>?]> = [
    ['throws an AIError', () => Promise.reject(new AIError('retryable'))],
    ['throws something else', () => Promise.reject(new TypeError('boom'))],
    ['throws synchronously', () => {
      throw new Error('sync boom');
    }],
    ['refuses', [{ error: new AIError('declined') }]],
    ['fails fatally', [{ error: new AIError('fatal') }]],
    ['returns garbage', [{ output: { totally: 'wrong' } }]],
    ['returns a non-object', [{ output: null }]],
    ['returns a huge garbage string', [{ output: 'x'.repeat(200_000) }]],
    ['hangs', [{ hang: true }], { timeoutMs: 20 }],
    ['has a cap of zero', [], { dailyBudgetMicros: 0 }],
    ['is limited to no calls a minute', [], { perMinuteCalls: 1 }],
  ];

  for (const [name, script, ai] of cases) {
    it(`with an adapter that ${name}, submit, the queue, the case page and decide are as with the AI off`, async () => {
      const baseline = await shape(await off);
      const w = await aiWorld({ level: 2, script, ai: ai as never });
      // A few reports first, so a per-minute cap is exceeded and a breaker may open.
      for (let i = 0; i < 3; i += 1) await w.report();
      await w.idle();
      const got = await shape(w);
      await w.idle();
      expect(got).toEqual(baseline);
      // The case page and the read are quiet, never an error.
      expect(() => w.cw.ai.read('anything', { open: true })).not.toThrow();
      expect(() => w.cw.ai.briefs(['a', 'b'])).not.toThrow();
      await w.cw.close();
    });
  }

  it('an AI store method that throws changes nothing for the player or the moderator', async () => {
    const baseline = await shape(await off);
    const w = await aiWorld({ level: 2 });
    const store = w.store as MemoryStore;
    for (const name of ['reserveAiRead', 'completeAiRead', 'failAiRead', 'loadAiRead', 'loadAiReads', 'listAiRetries', 'aiSpendSince', 'aiTeachableCount', 'insertAiOutcome', 'loadAiOutcome'] as const) {
      vi.spyOn(store as never as Record<string, () => unknown>, name).mockImplementation((() => {
        throw new Error('disk gone');
      }) as never);
    }
    const got = await shape(w);
    await w.idle();
    await w.cw.ai.sweep();
    expect(got).toEqual(baseline);
    expect(w.cw.ai.read('x', { open: true })).toBeNull();
    expect(w.cw.ai.briefs(['x']).size).toBe(0);
    expect(() => w.cw.ai.status()).not.toThrow();
    expect(() => w.cw.ai.stats({})).not.toThrow();
  });

  it('readAgain never throws either', async () => {
    const w = await aiWorld({ level: 2, script: () => Promise.reject(new Error('x')) });
    const r = await w.report();
    await w.idle();
    const answer = await w.cw.ai.readAgain(r.id, 'mod_ann');
    expect(['pending', 'off', 'budget']).toContain(answer);
    expect(await w.cw.ai.readAgain('no-such-report', 'mod_ann')).toBe('off');
  });

  it('close() aborts a call in flight and leaves no timer behind', async () => {
    const w = await aiWorld({ script: [{ hang: true }], ai: { timeoutMs: 60_000 } });
    await w.report();
    await vi.waitFor(() => expect(w.adapter.callCount).toBe(1));
    await w.cw.close();
    expect(w.adapter.signals[0]?.aborted).toBe(true);
    await w.cw.ai.idle();
  });
});
