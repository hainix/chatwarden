import { describe, expect, it } from 'vitest';
import type { ResolvedFilters } from '../src/filters.js';
import { delivered, F, refusal, setup, who } from './filtersChatWorld.js';

// Filters are a safeguard, not access control: whatever breaks inside them, the line goes on unfiltered, the class is logged (at most once
// a minute) and accept never throws.

const broken = (): ResolvedFilters => {
  const f = F({ links: { action: 'refuse' } });
  // The scan itself is fenced and never throws; a settings object that blows up when the engine reads it is the failure this stands for.
  Object.defineProperty(f.links!, 'action', {
    get: () => {
      throw new TypeError('boom vlemmo.com');
    },
  });
  return f;
};

const events = (t: ReturnType<typeof setup>): string[] => t.logs.map((l) => l.event);

describe('fail open', () => {
  it('a settings getter that throws lets the line through and logs the class', () => {
    const t = setup({
      settings: () => {
        throw new RangeError('x');
      },
    });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    expect(t.logs).toEqual([{ event: 'chatwarden.filter_failed', detail: { error: 'RangeError' } }]);
  });

  it('a settings getter that returns nothing is a failure of the same kind', () => {
    for (const bad of [undefined, null, 5, 'x']) {
      const t = setup({ settings: () => bad as never });
      t.sit('p1', who('k1'));
      expect(delivered(t.say('p1', 'see vlemmo.com')), String(bad)).toBe('see vlemmo.com');
      expect(events(t), String(bad)).toEqual(['chatwarden.filter_failed']);
    }
  });

  it('an engine that throws mid-scan lets the line through unfiltered', () => {
    const t = setup({ settings: broken });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    expect(t.logs).toEqual([{ event: 'chatwarden.filter_failed', detail: { error: 'TypeError' } }]);
    expect(t.calls.counted).toEqual([]);
  });

  it('a count hook that throws still delivers (or refuses) the line, and is logged', () => {
    const t = setup({
      filters: { links: { action: 'refuse' } },
      count: () => {
        throw new TypeError('x');
      },
    });
    t.sit('p1', who('k1'));
    expect(refusal(t.say('p1', 'see vlemmo.com')).reason).toBe('link');
    expect(events(t)).toEqual(['chatwarden.filter_failed']);
    const masked = setup({
      filters: { links: { action: 'mask' } },
      count: () => {
        throw new TypeError('x');
      },
    });
    masked.sit('p1', who('k1'));
    expect(delivered(masked.say('p1', 'see vlemmo.com'))).toBe('see **********');
  });

  it('an onFilterFlag hook that throws or rejects does not change the verdict', async () => {
    const t = setup({
      filters: { links: { action: 'flag' } },
      onFlag: () => {
        throw new TypeError('x');
      },
    });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    expect(events(t)).toEqual(['chatwarden.filter_failed']);
    const rejecting = setup({ filters: { links: { action: 'flag' } }, onFlag: () => Promise.reject(new RangeError('x')) as never });
    rejecting.sit('p1', who('k1'));
    expect(delivered(rejecting.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    await new Promise((r) => setTimeout(r, 0));
    expect(events(rejecting)).toEqual(['chatwarden.filter_failed']);
  });

  it('an account-age hook that throws or answers a promise reads as not new', () => {
    const f = { links: { action: 'refuse' as const, unlisted: 'allow' as const, newAccountDays: 3 } };
    const throwing = setup({
      filters: f,
      accountIsNew: () => {
        throw new TypeError('x');
      },
    });
    throwing.sit('p1', who('k1'));
    expect(delivered(throwing.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    expect(events(throwing)).toEqual(['chatwarden.filter_failed']);
    const promised = setup({ filters: f, accountIsNew: (() => Promise.resolve(true)) as never });
    promised.sit('p1', who('k1'));
    expect(delivered(promised.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
  });

  it('logs at most once a minute, with the count of those held back, and again after the minute', () => {
    const t = setup({
      settings: () => {
        throw new RangeError('x');
      },
    });
    t.sit('p1', who('k1'));
    for (let i = 0; i < 5; i++) {
      t.clock.t += 6000;
      t.say('p1', `line ${i}`);
    }
    expect(t.logs).toHaveLength(1);
    t.clock.t += 61_000;
    t.say('p1', 'one more');
    expect(t.logs).toHaveLength(2);
    expect(t.logs[1]!.detail).toEqual({ error: 'RangeError', suppressed: 4 });
  });

  it('never throws out of accept, whatever the hooks do', () => {
    const t = setup({
      filters: { links: { action: 'refuse' }, personalInfo: { action: 'flag' } },
      count: () => {
        throw new Error('x');
      },
      onFlag: () => {
        throw new Error('y');
      },
      accountIsNew: () => {
        throw new Error('z');
      },
    });
    t.sit('p1', who('k1'));
    for (const text of ['see vlemmo.com', 'mail a@b.com', 'plain']) {
      t.clock.t += 10_000;
      expect(() => t.say('p1', text)).not.toThrow();
    }
  });

  it('a spy logger sees event names and error classes only: no line, domain, pattern or id', () => {
    const t = setup({
      settings: broken,
      count: () => {
        throw new TypeError('secret-zorbak-thing');
      },
    });
    t.sit('p1', who('k1'));
    t.say('p1', 'see vlemmo.com and a@b.com');
    const t2 = setup({
      filters: { phrases: [{ id: 'adsrule', action: 'flag', phrases: ['quissel drakkuun'] }] },
      onFlag: () => {
        throw new TypeError('secret-drakkuun-thing');
      },
    });
    t2.sit('p1', who('k1'));
    t2.say('p1', 'quissel drakkuun');
    const text = JSON.stringify([...t.logs, ...t2.logs]);
    for (const secret of ['vlemmo', 'a@b', 'zorbak', 'quissel', 'drakkuun', 'adsrule', 'secret', 'boom']) expect(text, secret).not.toContain(secret);
    for (const l of [...t.logs, ...t2.logs]) {
      expect(l.event).toMatch(/^chatwarden\.[a-z_]+$/);
      expect(Object.keys(l.detail ?? {}).every((k) => k === 'error' || k === 'suppressed')).toBe(true);
    }
  });
});
