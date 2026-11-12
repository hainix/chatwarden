import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, withMemoryAi } from '@chatwarden/store-memory';
import type { MemoryAiStore } from '@chatwarden/store-memory';
import { createFakeModerationAI, fakeRead } from '../../src/ai/fake.js';
import { AIError } from '../../src/ai/types.js';
import { createChatwarden } from '../../src/chatwarden.js';
import { defineRules, starterRules } from '../../src/rules.js';
import type { Store } from '../../src/types.js';
import { aiWorld, MIN, NOW, OWNER } from './aiWorld.js';

// The service around the worker: levels, stale reads, the sweeper, follow-ups, status, and the one rule the AI module keeps.

const platform = { identify: (ctx: unknown) => ctx as never };

describe('levels', () => {
  it('level 0 never calls the adapter and never reads the AI tables', async () => {
    const w = await aiWorld({ level: 0 });
    const store = w.store as MemoryAiStore;
    const touched: string[] = [];
    for (const name of ['reserveAiRead', 'completeAiRead', 'failAiRead', 'loadAiRead', 'loadAiReads', 'listAiRetries', 'aiSpendSince', 'loadAiOutcome', 'aiExamples', 'aiTeachableCount', 'aiStats'] as const) {
      const original = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!.bind(store);
      vi.spyOn(store as never as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(((...a: unknown[]) => {
        touched.push(name);
        return original(...a);
      }) as never);
    }
    const r = await w.report();
    await w.idle();
    await w.cw.ai.sweep();
    expect(w.cw.ai.read(r.id, { open: true })).toBeNull();
    expect(w.cw.ai.briefs([r.id]).size).toBe(0);
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('off');
    await w.idle();
    expect(w.adapter.callCount).toBe(0);
    expect(touched).toEqual([]);
    expect(w.cw.ai.level()).toBe(0);
  });

  it('the effective level is the lower of the policy level and maxLevel', async () => {
    const w = await aiWorld({ level: 2, ai: { maxLevel: 1 } });
    expect(w.cw.ai.level()).toBe(1);
    const r = await w.report();
    await w.idle();
    expect(w.cw.ai.read(r.id)?.recommendation).toBeNull();
    expect(w.cw.ai.status()).toMatchObject({ level: 1, maxLevel: 1 });
  });

  it('turning the level up in the hub takes effect at once', async () => {
    const w = await aiWorld({ level: 0 });
    expect(w.cw.ai.level()).toBe(0);
    expect(w.cw.policy.save({ ai: { level: 2 } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(w.cw.ai.level()).toBe(2);
    const r = await w.report();
    await w.idle();
    expect(w.cw.ai.read(r.id)?.recommendation).not.toBeNull();
  });

  it('without an adapter the AI is off: level 0, not available, nothing stored', async () => {
    const { world } = await import('../reportingWorld.js');
    const w = await world({ overrides: { ai: { level: 2 } } });
    expect(w.cw.ai.level()).toBe(0);
    expect(w.cw.ai.status()).toMatchObject({ available: false, level: 0, maxLevel: 0, state: 'off', spentMicros: 0, reads: 0, cacheHitRate: null });
    const t = w.table();
    w.cw.chat.accept(t.room, 'p2', 'rude words');
    const res = await w.submit(t.room);
    expect(res.ok).toBe(true);
    expect(w.cw.ai.read((res as { reportId: string }).reportId)).toBeNull();
    expect(await w.cw.ai.readAgain('x', 'mod_ann')).toBe('off');
    expect(w.cw.ai.briefs(['x']).size).toBe(0);
    await w.cw.ai.idle();
    expect(w.cw.ai.stats({})).toMatchObject({ decided: 0, rules: [] });
  });

  describe('a store without the AI methods (createMemoryStore carries none)', () => {
    const EVENT = 'chatwarden.ai_store_unsupported';
    const make = async (store: Store, ai: boolean) => {
      const warned: Array<[string, unknown]> = [];
      const adapter = createFakeModerationAI();
      const cw = await createChatwarden({
        store,
        secret: 's',
        platform,
        retention: false,
        logger: { warn: (event, detail) => void warned.push([event, detail]) },
        ...(ai ? { ai: { adapter } } : {}),
      });
      return { cw, warned, adapter };
    };

    it('stays inert and logs the event once, instead of failing creation', async () => {
      const { cw, warned, adapter } = await make(new MemoryStore(), true);
      expect(warned.filter(([e]) => e === EVENT)).toHaveLength(1);
      expect(warned.find(([e]) => e === EVENT)?.[1]).toMatchObject({ missing: expect.stringContaining('reserveAiRead') });
      expect(cw.ai.level()).toBe(0);
      expect(cw.ai.status()).toMatchObject({ available: false, level: 0, state: 'off' });
      expect(cw.ai.read('x')).toBeNull();
      expect(await cw.ai.readAgain('x', 'mod')).toBe('off');
      expect(cw.ai.stats({})).toMatchObject({ decided: 0 });
      await cw.ai.idle();
      expect(adapter.callCount).toBe(0);
      await cw.close();
    });

    it('still takes reports and decisions, and never says it again however much is done', async () => {
      const { cw, warned, adapter } = await make(new MemoryStore(), true);
      cw.rooms.seat('room', 'p1', { clientKey: 'k1' }, 'One');
      cw.rooms.seat('room', 'p2', { clientKey: 'k2' }, 'Two');
      cw.chat.accept('room', 'p2', 'you are rude');
      const res = await cw.reports.submit({ roomId: 'room', reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
      expect(res.ok).toBe(true);
      await cw.ai.sweep();
      await cw.ai.idle();
      expect(adapter.callCount).toBe(0);
      expect(warned.filter(([e]) => e === EVENT)).toHaveLength(1);
      await cw.close();
    });

    it('a second kit over another bare store says it again (once per kit)', async () => {
      const a = await make(new MemoryStore(), true);
      const b = await make(new MemoryStore(), true);
      expect(a.warned.filter(([e]) => e === EVENT)).toHaveLength(1);
      expect(b.warned.filter(([e]) => e === EVENT)).toHaveLength(1);
    });

    it('is quiet when no adapter is given, and when the store has the methods (controls)', async () => {
      expect((await make(new MemoryStore(), false)).warned.filter(([e]) => e === EVENT)).toEqual([]);
      const ok = await make(withMemoryAi(new MemoryStore()), true);
      expect(ok.warned.filter(([e]) => e === EVENT)).toEqual([]);
      expect(ok.cw.ai.status().available).toBe(true);
    });

    it('a store that has only some of the methods is inert too, and names what is missing', async () => {
      const part = withMemoryAi(new MemoryStore()) as unknown as Record<string, unknown>;
      Object.defineProperty(part, 'aiStats', { value: undefined });
      const { cw, warned } = await make(part as unknown as Store, true);
      expect(cw.ai.status().available).toBe(false);
      expect(String((warned.find(([e]) => e === EVENT)?.[1] as { missing: string }).missing)).toBe('aiStats');
    });

    it('a bad option is still refused at creation, whatever the store', async () => {
      await expect(createChatwarden({ store: new MemoryStore(), secret: 's', platform, retention: false, ai: { adapter: { id: 'x' } as never } })).rejects.toThrow(/adapter/);
    });
  });

  it('refuses a bad AI option at creation', async () => {
    const adapter = createFakeModerationAI();
    for (const ai of [
      { adapter: undefined as never },
      { adapter: { id: 'x' } as never },
      { adapter, maxLevel: 3 as never },
      { adapter, dailyBudgetMicros: -1 },
      { adapter, dailyBudgetMicros: Number.NaN },
      { adapter, perMinuteCalls: 0 },
      { adapter, concurrency: 0 },
      { adapter, timeoutMs: 0 },
      { adapter, blockedLines: 'hide' as never },
      { adapter, contextTags: 'x' as never },
    ]) {
      await expect(createChatwarden({ store: withMemoryAi(new MemoryStore()), secret: 's', platform, retention: false, ai })).rejects.toThrow();
    }
  });
});

describe('stale reads', () => {
  const edited = starterRules('standard').map((r) => (r.number === 2 ? { ...r, text: `${r.text} Also in voice.` } : r));

  it('a changed rule text marks the read stale and does not re-read all open reports', async () => {
    const store = withMemoryAi(new MemoryStore());
    const a = await aiWorld({ store });
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push((await a.report()).id);
    await a.idle();
    expect(a.adapter.callCount).toBe(8);
    expect(ids.every((id) => a.cw.ai.read(id)?.stale === false)).toBe(true);
    // The studio edits a rule and restarts: a new service on the same store.
    const adapter = createFakeModerationAI();
    const b = await createChatwarden({
      store,
      secret: 'reporting-secret',
      platform,
      clock: a.clock,
      retention: false,
      logger: { warn: () => undefined },
      overrides: { ai: { level: 1 } },
      rules: defineRules(edited),
      ai: { adapter },
    });
    expect(ids.every((id) => b.ai.read(id)?.stale === true)).toBe(true);
    await b.ai.idle();
    expect(adapter.callCount).toBe(0);
    // The sweeper brings them up to date a few at a time, not all at once.
    await b.ai.sweep();
    await b.ai.idle();
    expect(adapter.callCount).toBeGreaterThan(0);
    expect(adapter.callCount).toBeLessThan(8);
    await b.close();
  });

  it('opening a stale case re-reads once', async () => {
    const store = withMemoryAi(new MemoryStore());
    const a = await aiWorld({ store });
    const r = await a.report();
    await a.idle();
    a.clock.t += MIN;
    const adapter = createFakeModerationAI();
    const b = await createChatwarden({
      store,
      secret: 'reporting-secret',
      platform,
      clock: a.clock,
      retention: false,
      logger: { warn: () => undefined },
      overrides: { ai: { level: 1 } },
      rules: defineRules(edited),
      ai: { adapter },
    });
    expect(b.ai.read(r.id, { open: true })?.stale).toBe(true);
    // Opened again while the first re-read is queued or running: still one call.
    expect(b.ai.read(r.id, { open: true })?.stale).toBe(true);
    await b.ai.idle();
    expect(adapter.callCount).toBe(1);
    a.clock.t += MIN;
    expect(b.ai.read(r.id, { open: true })?.stale).toBe(false);
    await b.ai.idle();
    expect(adapter.callCount).toBe(1);
    await b.close();
  });

  it('opening a case without a read at level 1 queues one', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report();
    w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    expect(w.cw.ai.read(r.id, { open: true })).toBeNull();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    expect(w.cw.ai.read(r.id)).not.toBeNull();
  });

  it('a read without { open } never queues anything', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report();
    w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    expect(w.cw.ai.read(r.id)).toBeNull();
    expect(w.cw.ai.briefs([r.id]).size).toBe(0);
    await w.idle();
    expect(w.adapter.callCount).toBe(0);
  });

  it('a ladder change does not mark anything stale', async () => {
    const w = await aiWorld({ level: 1 });
    const r = await w.report();
    await w.idle();
    const ladder = w.cw.profile.ladder.map((row) => ({ step: row.step, lowMedium: { ...row.lowMedium }, high: { ...row.high } }));
    ladder[1] = { ...ladder[1]!, lowMedium: { kind: 'chat', durationMs: 7_200_000, label: 'Restrict chat 2 hours' } };
    expect(w.cw.policy.save({ ladder: ladder as never }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(w.cw.ai.read(r.id)?.stale).toBe(false);
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('a new adapter id is a new read, the old one stays as history', async () => {
    const store = withMemoryAi(new MemoryStore());
    const a = await aiWorld({ store });
    const r = await a.report();
    await a.idle();
    a.clock.t += MIN;
    const adapter = createFakeModerationAI([], { id: 'fake:model-two' });
    const b = await createChatwarden({
      store,
      secret: 'reporting-secret',
      platform,
      clock: a.clock,
      retention: false,
      logger: { warn: () => undefined },
      overrides: { ai: { level: 1 } },
      ai: { adapter },
    });
    expect(b.ai.read(r.id)?.stale).toBe(true);
    b.ai.read(r.id, { open: true });
    await b.ai.idle();
    expect(adapter.callCount).toBe(1);
    a.clock.t += MIN;
    expect(b.ai.read(r.id)?.stale).toBe(false);
    await b.close();
  });
});

describe('a reporter follow-up', () => {
  it('a reporter follow-up queues exactly one new read, and the old read stays until it arrives', async () => {
    const w = await aiWorld();
    const r = await w.report(['you are trash']);
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
    const first = w.cw.ai.read(r.id);
    w.clock.t += 60_000;
    expect(await w.cw.reports.addDetail(r.id, 'p1', { reason: 'harassment', note: 'kept going after I muted' })).toEqual({ ok: true });
    // Visible and marked stale until the new read lands.
    expect(w.cw.ai.read(r.id)?.id).toBe(first?.id);
    expect(w.cw.ai.read(r.id)?.stale).toBe(true);
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
    expect(w.cw.ai.read(r.id)?.id).not.toBe(first?.id);
    expect(w.cw.ai.read(r.id)?.stale).toBe(false);
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
  });

  it('a refused follow-up queues nothing', async () => {
    const w = await aiWorld();
    const r = await w.report(['you are trash']);
    await w.idle();
    expect((await w.cw.reports.addDetail(r.id, 'p2', { note: 'not the reporter' })).ok).toBe(false);
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('the note reaches the adapter redacted', async () => {
    const w = await aiWorld();
    const r = await w.report(['you are trash']);
    await w.idle();
    await w.cw.reports.addDetail(r.id, 'p1', { note: 'he said call me at 555 123 4567' });
    await w.idle();
    const note = w.adapter.calls[1]?.report.note ?? '';
    expect(note).not.toMatch(/555/);
    expect(note).toContain('[phone]');
  });
});

describe('the sweeper', () => {
  it('the sweeper picks up an unread open report after a restart, newest first, at most 20', async () => {
    const store = withMemoryAi(new MemoryStore());
    const a = await aiWorld({ store, level: 0 });
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push((await a.report()).id);
      a.clock.t += 1000;
    }
    // A restart with the AI on: no event was seen for these reports.
    const adapter = createFakeModerationAI();
    const b = await createChatwarden({
      store,
      secret: 'reporting-secret',
      platform,
      clock: a.clock,
      retention: false,
      logger: { warn: () => undefined },
      overrides: { ai: { level: 1 } },
      ai: { adapter },
    });
    await b.ai.sweep();
    await b.ai.idle();
    expect(adapter.callCount).toBe(20);
    const has = (id: string) => (store.loadAiRead(id) ?? null) !== null;
    expect(ids.slice(5).every(has)).toBe(true);
    expect(ids.slice(0, 5).some(has)).toBe(false);
    await b.close();
  });

  it('turning the level from 0 to 1 fills the open queue gradually', async () => {
    const w = await aiWorld({ level: 0 });
    for (let i = 0; i < 45; i += 1) {
      await w.report();
      w.clock.t += 1000;
    }
    expect(w.adapter.callCount).toBe(0);
    w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(20);
    // The sweeper runs once a minute (and the default is 30 calls a minute).
    w.clock.t += MIN;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(40);
    w.clock.t += MIN;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(45);
    w.clock.t += MIN;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(45);
  });

  it('does not read decided reports', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report();
    await w.cw.decide({ reportId: r.id, verdict: 'no_action', actions: [], actor: 'mod_ann' });
    w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(0);
  });

  it('a refusal does not make the sweeper starve older unread reports', async () => {
    const w = await aiWorld({ level: 0 });
    const ids: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      ids.push((await w.report()).id);
      w.clock.t += 1000;
    }
    w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    w.adapter.push(...Array.from({ length: 20 }, () => ({ error: new AIError('declined') })));
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(20);
    await w.cw.ai.sweep();
    await w.idle();
    // The 20 refused are not asked again; the remaining 4 are read.
    expect(w.adapter.callCount).toBe(24);
  });

  it('the timer runs the sweeper and close() stops it', async () => {
    vi.useFakeTimers();
    try {
      const w = await aiWorld({ level: 0 });
      await w.report();
      w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.advanceTimersByTimeAsync(10);
      await w.cw.ai.idle();
      expect(w.adapter.callCount).toBe(1);
      await w.cw.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('status', () => {
  it('reports the day, the cap, the spend, the reads and the cache hit rate', async () => {
    const w = await aiWorld({
      script: [{ usage: { costMicros: 1500, inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 } }],
      ai: { dailyBudgetMicros: 50_000 },
    });
    await w.report();
    await w.idle();
    const s = w.cw.ai.status();
    expect(s).toMatchObject({ available: true, level: 1, maxLevel: 2, state: 'ok', spentMicros: 1500, capMicros: 50_000, reads: 1, day: new Date(NOW).toISOString().slice(0, 10), invalid: {} });
    expect(s.cacheHitRate).toBeCloseTo(0.9, 5);
  });

  it('has no cache hit rate before any call', async () => {
    const w = await aiWorld();
    expect(w.cw.ai.status().cacheHitRate).toBeNull();
  });

  it('defaults: a $1.00 cap, maxLevel 2', async () => {
    const w = await aiWorld();
    expect(w.cw.ai.status()).toMatchObject({ capMicros: 1_000_000, maxLevel: 2 });
  });
});

describe('read again', () => {
  it('returns the stored read without a call when the input has not changed', async () => {
    const w = await aiWorld({ level: 2 });
    const r = await w.report();
    await w.idle();
    const answer = await w.cw.ai.readAgain(r.id, 'mod_ann');
    expect(typeof answer).toBe('object');
    expect((answer as { id: string }).id).toBe(w.cw.ai.read(r.id)?.id);
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('answers pending and makes one call when the read is stale', async () => {
    const w = await aiWorld({ level: 2 });
    const r = await w.report();
    await w.idle();
    await w.cw.reports.addDetail(r.id, 'p1', { note: 'extra detail' });
    // Make the follow-up's own queued read the one we are asking about: read-again before it runs is still one call.
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.adapter.callCount).toBe(2);
  });

  it('answers pending when nothing was read yet', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report();
    w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('answers off at level 0 and budget at the cap, and calls nothing', async () => {
    const off = await aiWorld({ level: 0 });
    const a = await off.report();
    expect(await off.cw.ai.readAgain(a.id, 'mod_ann')).toBe('off');
    const capped = await aiWorld({ level: 1, ai: { dailyBudgetMicros: 0 } });
    const b = await capped.report();
    expect(await capped.cw.ai.readAgain(b.id, 'mod_ann')).toBe('budget');
    await capped.idle();
    expect(capped.adapter.callCount).toBe(0);
  });

  it('rate limit per actor: 10 a minute, whatever the answer, and each actor has their own', async () => {
    const w = await aiWorld({ level: 2 });
    const r = await w.report();
    await w.idle();
    for (let i = 0; i < 10; i += 1) expect(typeof (await w.cw.ai.readAgain(r.id, 'mod_ann'))).toBe('object');
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('rate');
    expect(typeof (await w.cw.ai.readAgain(r.id, 'mod_bob'))).toBe('object');
    // A minute later the window has moved on.
    w.clock.t += 60_000;
    expect(typeof (await w.cw.ai.readAgain(r.id, 'mod_ann'))).toBe('object');
    await w.idle();
    expect(w.adapter.callCount).toBe(1);
  });

  it('a refused ask (off) does not use up the actor allowance', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report();
    for (let i = 0; i < 20; i += 1) expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('off');
    w.cw.policy.save({ ai: { level: 1 } }, { version: 0, ...OWNER });
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('pending');
  });

  it('answers off for an unknown report', async () => {
    const w = await aiWorld();
    expect(await w.cw.ai.readAgain('nope', 'mod_ann')).toBe('off');
  });
});

describe('briefs', () => {
  it('give the queue a brief per read report, and nothing for the rest', async () => {
    const w = await aiWorld({ level: 2 });
    const a = await w.report();
    await w.idle();
    const b = await w.report();
    w.adapter.push({ error: new AIError('declined') });
    await w.idle();
    const briefs = w.cw.ai.briefs([a.id, b.id, 'nope']);
    expect(briefs.get(a.id)).toEqual({ severity: 'rude', confidence: 'medium', rule: 1, stale: false, injectionSuspected: false, hasRecommendation: true });
    expect(briefs.has('nope')).toBe(false);
  });

  it('at level 1 hasRecommendation is false', async () => {
    const w = await aiWorld({ level: 1 });
    const a = await w.report();
    await w.idle();
    expect(w.cw.ai.briefs([a.id]).get(a.id)?.hasRecommendation).toBe(false);
  });

  it('an unclear recommendation is not one', async () => {
    const w = await aiWorld({ level: 2, script: (input) => ({ output: fakeRead(input, { recommendation: { verdict: 'unclear', severity: 'rude', rule: null, evidence: [] } }) }) });
    const a = await w.report();
    await w.idle();
    expect(w.cw.ai.briefs([a.id]).get(a.id)?.hasRecommendation).toBe(false);
  });
});

describe('the AI module keeps to advice', () => {
  it('no file in core/src/ai imports decide, sanctions, strikes, mutes or notices', () => {
    const dir = fileURLToPath(new URL('../../src/ai', import.meta.url));
    const banned = /(?:^|\/)(decide|sanctions|strikes|mutes|notices)(?:\.js)?$/;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? '';
        if (spec.startsWith('.') && banned.test(spec)) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and stays free of node: imports', () => {
    const dir = fileURLToPath(new URL('../../src/ai', import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/from\s+'node:/);
    }
  });
});

void MIN;
