import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorClass, safeWarn, ThrottledWarn } from '../src/log.js';
import type { Logger } from '../src/types.js';
import * as pkg from '../src/index.js';

describe('safeWarn', () => {
  it('is exported from the package entry', () => {
    expect(pkg.safeWarn).toBe(safeWarn);
  });


  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the event and detail to the logger', () => {
    const calls: unknown[][] = [];
    const logger: Logger = { warn: (...a) => void calls.push(a) };
    safeWarn(logger, 'x.y', { error: 'TypeError' });
    expect(calls).toEqual([['x.y', { error: 'TypeError' }]]);
  });

  it('passes an undefined detail through when none is given', () => {
    const calls: unknown[][] = [];
    safeWarn({ warn: (...a) => void calls.push(a) }, 'x.y');
    expect(calls).toEqual([['x.y', undefined]]);
  });

  it('swallows a logger that throws', () => {
    const logger: Logger = {
      warn() {
        throw new Error('boom');
      },
    };
    expect(() => safeWarn(logger, 'x.y', { a: 1 })).not.toThrow();
  });

  it('swallows a logger that throws a non-Error', () => {
    const logger: Logger = {
      warn() {
        throw 'plain string';
      },
    };
    expect(() => safeWarn(logger, 'x.y')).not.toThrow();
  });

  it('swallows an async logger that rejects (no unhandled rejection)', async () => {
    const seen: unknown[] = [];
    const onRej = (r: unknown): void => void seen.push(r);
    process.on('unhandledRejection', onRej);
    try {
      const logger = { warn: () => Promise.reject(new Error('async boom')) } as unknown as Logger;
      expect(() => safeWarn(logger, 'x.y')).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });

  it('falls back to console.warn with no logger (event only, or event and detail)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    safeWarn(undefined, 'a.b');
    safeWarn(undefined, 'a.c', { error: 'RangeError' });
    expect(spy.mock.calls).toEqual([['a.b'], ['a.c', { error: 'RangeError' }]]);
  });

  it('swallows a console.warn that throws when there is no logger', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console broke');
    });
    expect(() => safeWarn(undefined, 'a.b')).not.toThrow();
  });
});

describe('errorClass', () => {
  it('is exported from the package entry', () => {
    expect(pkg.errorClass).toBe(errorClass);
  });

  it('is the error name for an Error, a subclass and an error with a custom name', () => {
    class QueryError extends Error {
      constructor() {
        super('secret detail that must never be logged');
        this.name = 'QueryError';
      }
    }
    expect(errorClass(new Error('x'))).toBe('Error');
    expect(errorClass(new TypeError('x'))).toBe('TypeError');
    expect(errorClass(new RangeError('x'))).toBe('RangeError');
    expect(errorClass(new QueryError())).toBe('QueryError');
  });

  it('is the typeof for anything that is not an Error, never its content', () => {
    expect(errorClass('boom with an id s_abc')).toBe('string');
    expect(errorClass(42)).toBe('number');
    expect(errorClass(undefined)).toBe('undefined');
    expect(errorClass(null)).toBe('object');
    expect(errorClass({ message: 'm' })).toBe('object');
    expect(errorClass(() => 1)).toBe('function');
    expect(errorClass(Symbol('s'))).toBe('symbol');
  });

  it('never throws: a hostile name getter or a revoked proxy is "unknown"', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error('no');
      },
    });
    expect(errorClass(hostile)).toBe('unknown');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(errorClass(proxy)).toBe('unknown');
  });
});

describe('ThrottledWarn', () => {
  const make = (intervalMs?: number) => {
    const clock = { t: 1000, now: () => clock.t };
    const lines: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
    const logger: Logger = { warn: (event, detail) => void lines.push([event, detail]) };
    return { clock, lines, w: new ThrottledWarn(logger, clock, intervalMs) };
  };

  it('logs the first failure as given, with no suppressed field', () => {
    const { w, lines } = make();
    w.warn('e', { error: 'X' });
    expect(lines).toEqual([['e', { error: 'X' }]]);
  });

  it('holds back repeats inside the interval and reports their count on the next line', () => {
    const { w, lines, clock } = make();
    for (let i = 0; i < 5; i++) w.warn('e', { error: 'X' });
    expect(lines).toHaveLength(1);
    clock.t += 60_000;
    w.warn('e', { error: 'X' });
    expect(lines[1]).toEqual(['e', { error: 'X', suppressed: 4 }]);
    clock.t += 60_000;
    w.warn('e', { error: 'X' });
    expect(lines[2]).toEqual(['e', { error: 'X' }]); // the count starts over
  });

  it('one millisecond short of the interval is still held back', () => {
    const { w, lines, clock } = make();
    w.warn('e', { error: 'X' });
    clock.t += 59_999;
    w.warn('e', { error: 'X' });
    expect(lines).toHaveLength(1);
  });

  it('a clock that goes backwards does not wedge it forever', () => {
    const { w, lines, clock } = make();
    w.warn('e', { error: 'X' });
    clock.t -= 10_000;
    w.warn('e', { error: 'X' });
    expect(lines).toHaveLength(2);
  });

  it('a throwing logger or clock never throws', () => {
    const bad = new ThrottledWarn(
      {
        warn: () => {
          throw new Error('x');
        },
      },
      {
        now: () => {
          throw new Error('y');
        },
      },
    );
    expect(() => bad.warn('e', { error: 'X' })).not.toThrow();
  });

  it('honours a custom interval', () => {
    const { w, lines, clock } = make(1000);
    w.warn('e', { error: 'X' });
    clock.t += 1000;
    w.warn('e', { error: 'X' });
    expect(lines).toHaveLength(2);
  });
});
