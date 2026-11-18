import { describe, expect, it } from 'vitest';
import { createInertAi } from '../../src/ai/inert.js';
import { aiWorld } from './aiWorld.js';

// The AI reads chat only (0.2.2, ruling 2, audit S6, S7, S8, S9): a report about play or a name is not read, so the model is never told it is reading chat, never
// judges a name, and can never be "unable to recommend" for want of a chat line. Chat and neutral reports are read as before.

const ONE_PLAY = { reason: 'afk' };
const calls = (w: Awaited<ReturnType<typeof aiWorld>>): number => w.adapter.calls.length;

describe('a report about play or a name is not read', () => {
  it.each(['afk', 'cheating', 'griefing', 'name'] as const)('%s: no call, no read, nothing expected, and the case says why', async (reason) => {
    for (const level of [1, 2] as const) {
      const w = await aiWorld({ level });
      const r = await w.report(['Hello', 'back soon'], { reason });
      await w.idle();
      expect(calls(w), `${reason} level ${level}`).toBe(0);
      expect(w.cw.ai.read(r.id, { open: true })).toBeNull();
      await w.idle();
      expect(calls(w)).toBe(0);
      expect(w.cw.ai.expected(r.id)).toBe(false);
      expect(w.cw.ai.chatOnly(r.id)).toBe(true);
    }
  });

  it('"read again" is not a way round it: no call, and the answer is off', async () => {
    const w = await aiWorld({ level: 2 });
    const r = await w.report(['Hello'], ONE_PLAY);
    await w.idle();
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toBe('off');
    await w.idle();
    expect(calls(w)).toBe(0);
  });

  it('a name is never sent: with a flagged name in the report the adapter still hears nothing', async () => {
    const w = await aiWorld({ level: 2 });
    await w.report(['zorbak vlemmo'], { reason: 'name' });
    await w.idle();
    expect(calls(w)).toBe(0);
  });

  it('nothing is written to the AI tables for it: no read row, no spend, no audit of a call', async () => {
    const w = await aiWorld({ level: 2 });
    await w.report(['Hello'], ONE_PLAY);
    await w.idle();
    expect(w.cw.ai.status().reads).toBe(0);
    expect(w.cw.ai.status().spentMicros).toBe(0);
  });
});

describe('everything else is read as before', () => {
  it.each(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info'] as const)('a %s report is read', async (reason) => {
    const w = await aiWorld({ level: 1 });
    const r = await w.report(['you are trash'], { reason });
    expect(w.cw.ai.expected(r.id)).toBe(true);
    expect(w.cw.ai.chatOnly(r.id)).toBe(false);
    await w.idle();
    expect(calls(w)).toBe(1);
    expect(w.cw.ai.read(r.id)).not.toBeNull();
  });

  it('a report with no reason and a report under other are read (neutral is not skipped)', async () => {
    const w = await aiWorld({ level: 1 });
    const a = await w.report(['you are trash']);
    const b = await w.report(['you are trash too'], { reason: 'other' });
    await w.idle();
    expect(calls(w)).toBe(2);
    expect(w.cw.ai.chatOnly(a.id)).toBe(false);
    expect(w.cw.ai.chatOnly(b.id)).toBe(false);
  });

  it('level 0 is unchanged: no call, and nothing to say about chat only', async () => {
    const w = await aiWorld({ level: 0 });
    const r = await w.report(['Hello'], ONE_PLAY);
    await w.idle();
    expect(calls(w)).toBe(0);
    expect(w.cw.ai.chatOnly(r.id)).toBe(false);
  });
});

describe('the reason decides, as it is now', () => {
  it('a custom reason that says play is skipped; one that says chat is read; one with none is read', async () => {
    const reasons = [
      { id: 'zorbak', label: 'Zorbak', evidence: 'play' as const },
      { id: 'vlemmo', label: 'Vlemmo', evidence: 'chat' as const },
      { id: 'quissel', label: 'Quissel' },
      { id: 'other', label: 'Something else' },
    ];
    const w = await aiWorld({ level: 1, over: { overrides: { ai: { level: 1 }, reporting: { reasons } } } });
    const a = await w.report(['x'], { reason: 'zorbak' });
    const b = await w.report(['y'], { reason: 'vlemmo' });
    const c = await w.report(['z'], { reason: 'quissel' });
    await w.idle();
    expect(w.cw.ai.chatOnly(a.id)).toBe(true);
    expect(w.cw.ai.chatOnly(b.id)).toBe(false);
    expect(w.cw.ai.chatOnly(c.id)).toBe(false);
    expect(calls(w)).toBe(2);
  });

  it('an old category call reads as its reason: disruption is play', async () => {
    const w = await aiWorld({ level: 1 });
    const r = await w.report(['x'], { category: 'disruption' });
    await w.idle();
    expect(w.cw.ai.chatOnly(r.id)).toBe(true);
    expect(calls(w)).toBe(0);
  });

  it('an unknown or decided report is not chat only', async () => {
    const w = await aiWorld({ level: 1 });
    expect(w.cw.ai.chatOnly('no_such_report')).toBe(false);
    expect(w.cw.ai.chatOnly('')).toBe(false);
  });
});

describe('the inert facade', () => {
  it('says false and imports nothing', () => {
    expect(createInertAi().chatOnly('x')).toBe(false);
  });
});
