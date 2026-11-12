import { describe, expect, it } from 'vitest';
import { DAY, OWNER, world } from './reportingWorld.js';

// `cw.policy.get().limits`: the kit's own numbers the settings screens need, read only. The chat rate in force (the built-in limit that
// pacing sits beside) and how long signal rows are kept (the longest window a feed may ask for).

describe('PolicyState.limits', () => {
  it('a kit with defaults reports the built-in chat rate and the 90-day signal retention', async () => {
    const { cw } = await world();
    expect(cw.policy.get().limits).toEqual({ chatRate: { count: 3, windowMs: 5000 }, signalsMs: 90 * DAY });
  });

  it('follows what the adopter configured: limits.chatRate and retention.signalsMs', async () => {
    const { cw } = await world({ limits: { chatRate: { count: 10, windowMs: 8000 } }, retention: { signalsMs: 30 * DAY } });
    expect(cw.policy.get().limits).toEqual({ chatRate: { count: 10, windowMs: 8000 }, signalsMs: 30 * DAY });
  });

  it('a partial chatRate keeps the other half of the default', async () => {
    const { cw } = await world({ limits: { chatRate: { count: 6 } } });
    expect(cw.policy.get().limits.chatRate).toEqual({ count: 6, windowMs: 5000 });
  });

  it('is deep-frozen, and a caller changing a copy changes nothing', async () => {
    const { cw } = await world();
    const { limits } = cw.policy.get();
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(limits.chatRate)).toBe(true);
    expect(() => {
      (limits.chatRate as { count: number }).count = 99;
    }).toThrow();
    expect(cw.policy.get().limits.chatRate.count).toBe(3);
  });

  it('is not part of the stored layer: a save and a reset leave it where it was, and a layer that names it is refused', async () => {
    const { cw } = await world({ limits: { chatRate: { count: 10, windowMs: 8000 } } });
    const read = cw.policy.get();
    expect(cw.policy.save({ ...read.layer, pace: { slowModeMs: 2000 } }, { version: read.version, ...OWNER })).toMatchObject({ ok: true });
    expect(cw.policy.get().limits.chatRate).toEqual({ count: 10, windowMs: 8000 });
    expect(cw.policy.reset()).toMatchObject({ ok: true });
    expect(cw.policy.get().limits.chatRate).toEqual({ count: 10, windowMs: 8000 });
    expect(cw.policy.save({ limits: { chatRate: { count: 1, windowMs: 1 } } } as never, { version: cw.policy.get().version, ...OWNER })).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('is present on a kit whose store cannot save settings, too', async () => {
    const { cw } = await world();
    expect(cw.policy.get().canSave).toBe(true);
    expect(cw.policy.get().limits.signalsMs).toBe(90 * DAY);
  });
});
