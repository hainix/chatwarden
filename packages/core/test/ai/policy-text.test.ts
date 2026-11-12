import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER, aiWorld } from './aiWorld.js';

// The stable text of the prompt (rules, levels, standard) is rendered once per profile in force, not on every call: a queue poll asks
// `briefs` for 200 reports and each one needs to know whether the policy changed. A saved change builds a new profile, so it is rendered again.

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/ai/prompt.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/ai/prompt.js')>();
  return {
    ...original,
    aiPolicyText: (...args: Parameters<typeof original.aiPolicyText>) => {
      calls.n += 1;
      return original.aiPolicyText(...args);
    },
  };
});

beforeEach(() => {
  calls.n = 0;
});

describe('the prompt policy text', () => {
  it('is rendered once for many reads of the same profile, however many reports are asked about', async () => {
    const w = await aiWorld({ level: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await w.report()).id);
    await w.idle();
    calls.n = 0;
    for (let i = 0; i < 5; i += 1) {
      w.cw.ai.briefs(ids);
      for (const id of ids) w.cw.ai.read(id);
    }
    expect(calls.n).toBeLessThanOrEqual(1);
    expect(w.cw.ai.briefs(ids).size).toBe(4);
  });

  it('is rendered again after a saved policy change, and the new profile is then cached too', async () => {
    const w = await aiWorld({ level: 1 });
    const r = await w.report();
    await w.idle();
    w.cw.ai.read(r.id);
    calls.n = 0;
    expect(w.cw.policy.save({ ai: { level: 2 } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    w.cw.ai.read(r.id);
    const afterSave = calls.n;
    expect(afterSave).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 5; i += 1) w.cw.ai.read(r.id);
    expect(calls.n).toBe(afterSave);
  });

  it('a read made before a change to the rules or the standard is still marked stale', async () => {
    const w = await aiWorld({ level: 1 });
    const r = await w.report();
    await w.idle();
    expect(w.cw.ai.read(r.id)?.stale).toBe(false);
    await w.cw.reports.addDetail(r.id, 'p1', { note: 'it kept going' });
    expect(w.cw.ai.read(r.id)?.stale).toBe(true);
  });
});
