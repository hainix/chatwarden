import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeWarn } from '../src/log.js';
import type { Logger } from '../src/types.js';

describe('safeWarn', () => {
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
