import { describe, expect, it } from 'vitest';
import { resolveDesk } from '../src/desk.js';
import { ProfileError } from '../src/profileError.js';

// The `desk` settings: workflow and insights (both off) and the report-surge window. Validation names the path and never echoes the value.

const DEFAULTS = { workflow: false, insights: false, surge: { enabled: false, reports: 5, windowMinutes: 10, newAccountDays: 2 } };

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

describe('resolveDesk', () => {
  it('defaults: workflow and insights off; surge off at 5 reports, 10 minutes, 2 days', () => {
    expect(resolveDesk(undefined)).toEqual(DEFAULTS);
    expect(resolveDesk({})).toEqual(DEFAULTS);
    expect(resolveDesk({ surge: {} })).toEqual(DEFAULTS);
  });

  it('the result is fresh each time and shares nothing with the input', () => {
    const input = { workflow: true, surge: { enabled: true, reports: 7 } };
    const a = resolveDesk(input);
    const b = resolveDesk(input);
    expect(a).toEqual({ workflow: true, insights: false, surge: { enabled: true, reports: 7, windowMinutes: 10, newAccountDays: 2 } });
    expect(a).not.toBe(b);
    expect(a.surge).not.toBe(b.surge);
    a.surge.reports = 99;
    expect(resolveDesk(input).surge.reports).toBe(7);
  });

  it('a resolved desk is valid input again', () => {
    const once = resolveDesk({ workflow: true, insights: true, surge: { enabled: true, reports: 9, windowMinutes: 30, newAccountDays: 4 } });
    expect(resolveDesk(once)).toEqual(once);
  });

  it.each([
    ['surge.reports', 3, 100],
    ['surge.windowMinutes', 1, 120],
    ['surge.newAccountDays', 1, 30],
  ] as const)('%s: both edges accepted, one outside refused with the path', (key, lo, hi) => {
    const name = key.split('.')[1] as string;
    for (const v of [lo, hi]) expect(resolveDesk({ surge: { [name]: v } }).surge).toMatchObject({ [name]: v });
    for (const v of [lo - 1, hi + 1]) expect(failure(() => resolveDesk({ surge: { [name]: v } })).path, `${key} ${v}`).toBe(`desk.${key}`);
  });

  it.each([2.5, Number.NaN, Infinity, '5', null, true, {}, []])('surge.reports %j is refused with the path', (v) => {
    const err = failure(() => resolveDesk({ surge: { reports: v as never } }));
    expect(err.path).toBe('desk.surge.reports');
    expect(err.message).not.toContain('NaN');
  });

  it('workflow, insights and surge.enabled must be booleans', () => {
    for (const key of ['workflow', 'insights'] as const) {
      for (const v of ['yes', 1, null, {}]) expect(failure(() => resolveDesk({ [key]: v } as never)).path).toBe(`desk.${key}`);
    }
    expect(failure(() => resolveDesk({ surge: { enabled: 'on' } as never })).path).toBe('desk.surge.enabled');
  });

  it('an unknown key is refused with its path, at the top and inside surge', () => {
    expect(failure(() => resolveDesk({ nope: 1 } as never)).path).toBe('desk.nope');
    expect(failure(() => resolveDesk({ surge: { nope: 1 } } as never)).path).toBe('desk.surge.nope');
  });

  it('a non-object is refused; a custom path names the error', () => {
    for (const v of ['x', 3, [], null]) expect(failure(() => resolveDesk(v as never)).path).toBe('desk');
    expect(failure(() => resolveDesk({ surge: 3 } as never)).path).toBe('desk.surge');
    expect(failure(() => resolveDesk({ surge: { reports: 2 } }, 'profile.desk')).path).toBe('profile.desk.surge.reports');
  });

  it('never echoes a refused value', () => {
    const err = failure(() => resolveDesk({ surge: { windowMinutes: 987654 } }));
    expect(err.message).not.toContain('987654');
  });

  it('reads each value once (a getter cannot show one value to the check and another to the result)', () => {
    let reads = 0;
    const input = {
      get workflow() {
        reads += 1;
        return reads === 1;
      },
    };
    expect(resolveDesk(input).workflow).toBe(true);
    expect(reads).toBe(1);
  });
});
