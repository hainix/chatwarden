import { describe, expect, it } from 'vitest';
import { createInertAi } from '../../src/ai/inert.js';
import { AIError } from '../../src/ai/types.js';
import { world } from '../reportingWorld.js';
import { aiWorld } from './aiWorld.js';

// `cw.ai.expected(reportId)`: whether a read of this report is on its way now, so the case page may wait for it. True only at level 1 or 2
// with an adapter, a closed breaker, both daily caps open, and a report that is open and whose read has not ended without an answer.

describe('expected', () => {
  it('is true for an open report while the AI is on and healthy, before and after its read', async () => {
    const w = await aiWorld({ level: 1 });
    const r = await w.report();
    expect(w.cw.ai.expected(r.id)).toBe(true);
    await w.idle();
    expect(w.cw.ai.read(r.id)).not.toBeNull();
    expect(w.cw.ai.expected(r.id)).toBe(true);
  });

  it('is true at level 2 too', async () => {
    const w = await aiWorld({ level: 2 });
    const r = await w.report();
    expect(w.cw.ai.expected(r.id)).toBe(true);
  });

  it('is false at level 0', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report();
    expect(w.cw.ai.expected(r.id)).toBe(false);
  });

  it('is false with no adapter configured, even when the profile says level 2', async () => {
    const w = await world({ overrides: { ai: { level: 2 } } });
    expect(w.cw.ai.expected('rep_none')).toBe(false);
    expect(createInertAi().expected('rep_none')).toBe(false);
  });

  it('is false when the breaker is open, for every report', async () => {
    const w = await aiWorld({ level: 1, script: [{ error: new AIError('fatal') }] });
    const a = await w.report();
    await w.idle();
    expect(w.cw.ai.status().state).toBe('unavailable');
    const b = await w.report();
    expect(w.cw.ai.expected(a.id)).toBe(false);
    expect(w.cw.ai.expected(b.id)).toBe(false);
  });

  it('is false once the daily call ceiling is reached, and true again the next UTC day', async () => {
    const w = await aiWorld({ level: 1, dailyCalls: 1 });
    const a = await w.report();
    await w.idle();
    const b = await w.report();
    expect(w.cw.ai.status().state).toBe('paused_budget');
    expect(w.cw.ai.expected(b.id)).toBe(false);
    w.clock.t += 24 * 3_600_000;
    expect(w.cw.ai.status().state).toBe('ok');
    expect(w.cw.ai.expected(b.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  it('is false once the daily money cap is reached', async () => {
    const w = await aiWorld({ level: 1, ai: { dailyBudgetMicros: 1000 } });
    const a = await w.report();
    await w.idle();
    const b = await w.report();
    expect(w.cw.ai.status().state).toBe('paused_budget');
    expect(w.cw.ai.expected(b.id)).toBe(false);
    expect(a.id).not.toBe(b.id);
  });

  it('is false for a read that ended without an answer (declined), and still true for another report', async () => {
    const w = await aiWorld({ level: 1, script: [{ error: new AIError('declined') }] });
    const a = await w.report();
    await w.idle();
    expect(w.cw.ai.status().state).toBe('ok');
    const b = await w.report();
    expect(w.cw.ai.expected(a.id)).toBe(false);
    expect(w.cw.ai.expected(b.id)).toBe(true);
  });

  it('is false for an unknown report and for a report that is decided', async () => {
    const w = await aiWorld({ level: 1 });
    const r = await w.report();
    await w.idle();
    expect(w.cw.ai.expected('rep_unknown')).toBe(false);
    expect(w.cw.ai.expected(undefined as never)).toBe(false);
    await w.cw.decide({ reportId: r.id, verdict: 'no_action', actions: [], actor: 'mod_ann' });
    expect(w.cw.ai.expected(r.id)).toBe(false);
  });
});
