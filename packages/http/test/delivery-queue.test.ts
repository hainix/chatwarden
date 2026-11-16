import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_TIMEOUT_MS,
  BACKOFF_BASE_MS,
  MAX_RETRIES,
  QUEUE_MAX,
  RETRY_AFTER_CAP_MS,
  RETRY_AFTER_FLOOR_MS,
  createDeliveryQueue,
} from '../src/internal/deliveryQueue.js';
import type { Attempt } from '../src/internal/deliveryQueue.js';
import * as out from '../src/webhooks/out.js';

// The shared delivery queue (K5 task A4): the retry, backoff, ordering, bounding and drop-logging rules `webhooksOut` has always had, as a
// queue of any job, so the Coop and EOS adapters follow the same rules and they cannot drift. `webhooks/out.test.ts` (unedited) is the proof
// that webhooksOut still behaves as before; these tests drive the queue on its own with a scripted `send`.

const NOW = 1_800_000_000_000;
const clock = { now: () => Date.now() };
type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

afterEach(() => {
  vi.useRealTimers();
});

const tick = async (ms: number): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms));

interface Job {
  id: string;
}
const job = (id: string): Job => ({ id });

/** A queue whose `send` answers from `plan` (by job id and call number), recording every call. */
function rig(plan: (j: Job, n: number) => Attempt | 'throw' | 'hang', over: { random?: () => number; max?: number; event?: string; detail?: (j: Job) => Record<string, string | number | boolean> } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const logged: Logged = [];
  const calls: Array<{ id: string; at: number; signal: AbortSignal }> = [];
  const perJob = new Map<string, number>();
  const queue = createDeliveryQueue<Job>({
    send: (j, signal) => {
      const n = (perJob.get(j.id) ?? 0) + 1;
      perJob.set(j.id, n);
      calls.push({ id: j.id, at: Date.now() - NOW, signal });
      const step = plan(j, n);
      if (step === 'throw') return Promise.reject(new TypeError('zorbak-secret-message'));
      if (step === 'hang') return new Promise<Attempt>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return Promise.resolve(step);
    },
    clock,
    random: over.random ?? (() => 0.5),
    logger: { warn: (e, d) => void logged.push([e, d]) },
    event: over.event ?? 'test.delivery',
    ...(over.max === undefined ? {} : { max: over.max }),
    ...(over.detail === undefined ? {} : { detail: over.detail }),
  });
  return { queue, logged, calls };
}

const OK: Attempt = { kind: 'ok' };
const RETRY_503: Attempt = { kind: 'retry', status: 503 };

describe('the constants', () => {
  it('are the values webhooksOut has always had, and webhooks/out.ts still exports the same ones', () => {
    expect([MAX_RETRIES, ATTEMPT_TIMEOUT_MS, BACKOFF_BASE_MS, RETRY_AFTER_FLOOR_MS, RETRY_AFTER_CAP_MS, QUEUE_MAX]).toEqual([5, 10_000, 1000, 1000, 60_000, 1000]);
    expect(out.MAX_RETRIES).toBe(MAX_RETRIES);
    expect(out.ATTEMPT_TIMEOUT_MS).toBe(ATTEMPT_TIMEOUT_MS);
    expect(out.BACKOFF_BASE_MS).toBe(BACKOFF_BASE_MS);
    expect(out.RETRY_AFTER_FLOOR_MS).toBe(RETRY_AFTER_FLOOR_MS);
    expect(out.RETRY_AFTER_CAP_MS).toBe(RETRY_AFTER_CAP_MS);
    expect(out.QUEUE_MAX).toBe(QUEUE_MAX);
  });
});

describe('delivery and retries', () => {
  it('retries 5 times after 1, 2, 4, 8, 16 s with jitter, then logs once and goes on to the next job', async () => {
    const { queue, logged, calls } = rig((j) => (j.id === 'a' ? RETRY_503 : OK));
    queue.push(job('a'));
    queue.push(job('b'));
    await tick(0);
    expect(calls.map((c) => c.at)).toEqual([0]);
    for (const [i, wait] of [1000, 2000, 4000, 8000, 16_000].entries()) {
      await tick(wait - 1);
      expect(calls.filter((c) => c.id === 'a')).toHaveLength(i + 1);
      await tick(1);
      expect(calls.filter((c) => c.id === 'a')).toHaveLength(i + 2);
    }
    // six attempts at 0, 1, 3, 7, 15 and 31 s; then the failure is logged once and the next job goes
    expect(calls.filter((c) => c.id === 'a').map((c) => c.at)).toEqual([0, 1000, 3000, 7000, 15_000, 31_000]);
    expect(logged).toEqual([['test.delivery_failed', { status: 503, attempts: 6 }]]);
    expect(calls.filter((c) => c.id === 'b')).toHaveLength(1);
    await tick(10 * 60_000);
    expect(calls.filter((c) => c.id === 'a')).toHaveLength(6);
    expect(logged).toHaveLength(1);
    expect(queue.size()).toBe(0);
  });

  it('the wait is the backoff with plus or minus 20 percent jitter: the edges of the band', async () => {
    for (const [random, factor] of [[0, 0.8], [0.5, 1], [0.999, 1.1996]] as const) {
      const { queue, calls } = rig(() => RETRY_503, { random: () => random });
      queue.push(job('a'));
      await tick(0);
      await tick(Math.round(1000 * factor) - 1);
      expect(calls, `random ${random}`).toHaveLength(1);
      await tick(1);
      expect(calls, `random ${random}`).toHaveLength(2);
      queue.dispose();
      vi.useRealTimers();
    }
  });

  it('a success is final: no retry, no log, and the next job goes at once', async () => {
    const { queue, logged, calls } = rig(() => OK);
    queue.push(job('a'));
    queue.push(job('b'));
    await tick(0);
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(logged).toEqual([]);
  });

  it('stops retrying once an attempt succeeds', async () => {
    const { queue, logged, calls } = rig((_j, n) => (n < 3 ? RETRY_503 : OK));
    queue.push(job('a'));
    await tick(0);
    await tick(1000);
    await tick(2000);
    expect(calls).toHaveLength(3);
    await tick(60_000);
    expect(calls).toHaveLength(3);
    expect(logged).toEqual([]);
  });

  it('a 4xx is final at once: one call, one log with the status and the one attempt', async () => {
    const { queue, logged, calls } = rig((j) => (j.id === 'a' ? { kind: 'final', status: 404 } : OK));
    queue.push(job('a'));
    queue.push(job('b'));
    await tick(0);
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(logged).toEqual([['test.delivery_failed', { status: 404, attempts: 1 }]]);
  });

  it('a retry with only an error class logs the class; a retry with neither logs the attempts alone', async () => {
    const a = rig(() => ({ kind: 'retry', error: 'TimeoutError' }));
    a.queue.push(job('a'));
    await tick(60_000);
    expect(a.logged).toEqual([['test.delivery_failed', { error: 'TimeoutError', attempts: 6 }]]);
    a.queue.dispose();
    vi.useRealTimers();
    const b = rig(() => ({ kind: 'retry' }));
    b.queue.push(job('a'));
    await tick(60_000);
    expect(b.logged).toEqual([['test.delivery_failed', { attempts: 6 }]]);
  });

  it('the log event names follow `event`, and `detail` adds the job\'s own short fields', async () => {
    const { queue, logged } = rig(() => ({ kind: 'final', status: 400 }), { event: 'chatwarden.thing', detail: (j) => ({ type: `kind-${j.id}` }) });
    queue.push(job('a'));
    await tick(0);
    expect(logged).toEqual([['chatwarden.thing_failed', { type: 'kind-a', status: 400, attempts: 1 }]]);
  });

  it('a detail function that throws is ignored: the failure is still logged', async () => {
    const { queue, logged } = rig(() => ({ kind: 'final', status: 400 }), {
      detail: () => {
        throw new Error('nope');
      },
    });
    queue.push(job('a'));
    await tick(0);
    expect(logged).toEqual([['test.delivery_failed', { status: 400, attempts: 1 }]]);
  });

  it('send gets the same job on every attempt', async () => {
    const seen: Job[] = [];
    vi.useFakeTimers();
    const queue = createDeliveryQueue<Job>({
      send: (j) => {
        seen.push(j);
        return Promise.resolve(seen.length < 3 ? RETRY_503 : OK);
      },
      clock,
      random: () => 0.5,
      event: 'test.delivery',
    });
    const j = job('a');
    queue.push(j);
    await tick(10_000);
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s === j)).toBe(true);
  });
});

describe('a 429\'s retry-after', () => {
  const waits = async (afterMs: number | undefined, random: () => number = () => 0.5): Promise<number> => {
    const { queue, calls } = rig((_j, n) => (n === 1 ? { kind: 'retry', status: 429, ...(afterMs === undefined ? {} : { afterMs }) } : OK), { random });
    queue.push(job('a'));
    await tick(0);
    await tick(10 * 60_000);
    const second = calls[1];
    queue.dispose();
    vi.useRealTimers();
    return second === undefined ? -1 : second.at;
  };

  it('is clamped to 1..60 s', async () => {
    expect(await waits(5000)).toBe(5000);
    expect(await waits(1000)).toBe(1000);
    expect(await waits(60_000)).toBe(60_000);
    expect(await waits(0)).toBe(1000);
    expect(await waits(250)).toBe(1000);
    expect(await waits(-5000)).toBe(1000);
    expect(await waits(61_000)).toBe(60_000);
    expect(await waits(3_600_000)).toBe(60_000);
  });

  it('uses the backoff when no usable wait is given (absent or not a number)', async () => {
    const shortest = () => 0; // the backoff is then 800 ms, which tells it from the 1 s floor
    expect(await waits(undefined, shortest)).toBe(800);
    expect(await waits(Number.NaN, shortest)).toBe(800);
    expect(await waits(Infinity, shortest)).toBe(800);
    expect(await waits(0, shortest)).toBe(1000); // a given wait of 0 is the floor, not the backoff
  });

  it('a given wait replaces the backoff for that retry only: the next retry backs off by its own count', async () => {
    const { queue, calls } = rig((_j, n) => (n === 1 ? { kind: 'retry', status: 429, afterMs: 30_000 } : n === 2 ? RETRY_503 : OK));
    queue.push(job('a'));
    await tick(0);
    await tick(30_000);
    expect(calls.map((c) => c.at)).toEqual([0, 30_000]);
    await tick(2000); // the second retry waits the backoff for retry number 2 (2 s)
    expect(calls.map((c) => c.at)).toEqual([0, 30_000, 32_000]);
  });
});

describe('a throw in send', () => {
  it('is a retry, logged by class only', async () => {
    const { queue, logged, calls } = rig(() => 'throw');
    queue.push(job('a'));
    await tick(60_000);
    expect(calls).toHaveLength(6);
    expect(logged).toEqual([['test.delivery_failed', { error: 'TypeError', attempts: 6 }]]);
    expect(JSON.stringify(logged)).not.toContain('zorbak-secret-message');
  });

  it('a send that throws synchronously is the same', async () => {
    vi.useFakeTimers();
    const logged: Logged = [];
    let n = 0;
    const queue = createDeliveryQueue<Job>({
      send: () => {
        n += 1;
        throw new RangeError('zorbak-sync-message');
      },
      clock,
      random: () => 0.5,
      logger: { warn: (e, d) => void logged.push([e, d]) },
      event: 'test.delivery',
    });
    queue.push(job('a'));
    await tick(60_000);
    expect(n).toBe(6);
    expect(logged).toEqual([['test.delivery_failed', { error: 'RangeError', attempts: 6 }]]);
  });

  it('an attempt that outlives 10 s is aborted through the signal and retried', async () => {
    const { queue, logged, calls } = rig(() => 'hang');
    queue.push(job('a'));
    await tick(0);
    await tick(ATTEMPT_TIMEOUT_MS - 1);
    expect(calls[0]?.signal.aborted).toBe(false);
    await tick(1);
    expect(calls[0]?.signal.aborted).toBe(true);
    await tick(1000);
    expect(calls).toHaveLength(2);
    await tick(10 * 60_000);
    expect(calls).toHaveLength(6);
    expect(logged).toEqual([['test.delivery_failed', { error: 'TimeoutError', attempts: 6 }]]);
  });

  it('a logger that throws never breaks delivery', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const queue = createDeliveryQueue<Job>({
      send: (j) => {
        sent.push(j.id);
        return Promise.resolve(j.id === 'a' ? ({ kind: 'final', status: 400 } as Attempt) : OK);
      },
      clock,
      random: () => 0.5,
      logger: {
        warn: () => {
          throw new Error('logger down');
        },
      },
      event: 'test.delivery',
    });
    queue.push(job('a'));
    queue.push(job('b'));
    await tick(0);
    expect(sent).toEqual(['a', 'b']);
  });
});

describe('order and the one in flight', () => {
  it('one at a time and in order; a slow job holds the next', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const resolvers = new Map<string, (a: Attempt) => void>();
    const started: string[] = [];
    const queue = createDeliveryQueue<Job>({
      send: (j) =>
        new Promise<Attempt>((resolve) => {
          started.push(j.id);
          resolvers.set(j.id, resolve);
        }),
      clock,
      random: () => 0.5,
      event: 'test.delivery',
    });
    for (const id of ['a', 'b', 'c']) queue.push(job(id));
    await tick(0);
    expect(started).toEqual(['a']);
    expect(queue.size()).toBe(2);
    await tick(5000); // a is slow: b has not started
    expect(started).toEqual(['a']);
    resolvers.get('a')?.(OK);
    await tick(0);
    expect(started).toEqual(['a', 'b']);
    expect(queue.size()).toBe(1);
    resolvers.get('b')?.(OK);
    await tick(0);
    resolvers.get('c')?.(OK);
    await tick(0);
    expect(started).toEqual(['a', 'b', 'c']);
    expect(queue.size()).toBe(0);
  });

  it('a retrying job holds the jobs behind it for its whole backoff', async () => {
    const { queue, calls } = rig((j, n) => (j.id === 'a' && n === 1 ? RETRY_503 : OK));
    queue.push(job('a'));
    queue.push(job('b'));
    await tick(500);
    expect(calls.map((c) => c.id)).toEqual(['a']);
    await tick(500);
    expect(calls.map((c) => c.id)).toEqual(['a', 'a', 'b']);
  });

  it('a job pushed while idle goes at once, and the queue goes back to idle afterwards', async () => {
    const { queue, calls } = rig(() => OK);
    queue.push(job('a'));
    await tick(0);
    expect(calls).toHaveLength(1);
    await tick(5000);
    queue.push(job('b'));
    await tick(0);
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('the bound', () => {
  /** A queue whose first job is held open, so the others wait. */
  function held(max?: number) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logged: Logged = [];
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const queue = createDeliveryQueue<Job>({
      send: (j) => {
        sent.push(j.id);
        // Every attempt of the first job is held (an attempt is cut off after 10 s and retried, and the retry waits too).
        return j.id === 'in-flight' ? gate.then(() => OK) : Promise.resolve(OK);
      },
      clock,
      random: () => 0.5,
      logger: { warn: (e, d) => void logged.push([e, d]) },
      event: 'test.delivery',
      ...(max === undefined ? {} : { max }),
    });
    return { queue, logged, sent, release: () => release?.() };
  }

  it('overflow drops the oldest and logs one coalesced count per minute', async () => {
    const { queue, logged, sent, release } = held(3);
    queue.push(job('in-flight'));
    await tick(0);
    for (const id of ['1', '2', '3']) queue.push(job(id)); // exactly fills
    expect(logged).toEqual([]);
    expect(queue.size()).toBe(3);
    queue.push(job('4')); // drops 1: logged at once
    expect(logged).toEqual([['test.delivery_dropped', { count: 1 }]]);
    queue.push(job('5')); // drops 2
    queue.push(job('6')); // drops 3: not logged yet, inside the minute
    expect(logged).toHaveLength(1);
    expect(queue.size()).toBe(3);
    await tick(59_999);
    expect(logged).toHaveLength(1);
    await tick(1);
    expect(logged).toEqual([['test.delivery_dropped', { count: 1 }], ['test.delivery_dropped', { count: 2 }]]);
    release();
    await tick(0);
    // The dropped jobs (1, 2, 3) were never sent; the held job was sent once per attempt (the retry count), not as the others.
    expect(sent.filter((id) => id !== 'in-flight')).toEqual(['4', '5', '6']);
    expect(sent.filter((id) => id === 'in-flight').length).toBeGreaterThanOrEqual(1);
  });

  it('after a quiet minute a new drop logs at once again', async () => {
    const { queue, logged, release } = held(1);
    queue.push(job('in-flight'));
    await tick(0);
    queue.push(job('1'));
    queue.push(job('2'));
    expect(logged).toHaveLength(1);
    await tick(61_000);
    queue.push(job('3'));
    expect(logged).toEqual([['test.delivery_dropped', { count: 1 }], ['test.delivery_dropped', { count: 1 }]]);
    release();
  });

  it('is 1000 by default', async () => {
    const { queue, logged, sent, release } = held();
    queue.push(job('in-flight'));
    await tick(0);
    for (let i = 1; i <= QUEUE_MAX; i += 1) queue.push(job(`j${i}`));
    expect(logged).toEqual([]);
    queue.push(job('over'));
    expect(logged).toEqual([['test.delivery_dropped', { count: 1 }]]);
    expect(queue.size()).toBe(QUEUE_MAX);
    release();
    for (let i = 0; i < QUEUE_MAX + 5; i += 1) await tick(0);
    expect(sent).toHaveLength(1 + QUEUE_MAX);
    expect(sent).not.toContain('j1');
    expect(sent[1]).toBe('j2');
    expect(sent.at(-1)).toBe('over');
  });

  it('a drop count carries a count and nothing else', async () => {
    const { queue, logged, release } = held(1);
    queue.push(job('in-flight'));
    await tick(0);
    queue.push(job('secret-job-zorbak'));
    queue.push(job('next'));
    expect(JSON.stringify(logged)).not.toContain('zorbak');
    expect(Object.keys(logged[0]?.[1] ?? {})).toEqual(['count']);
    release();
  });
});

describe('dispose', () => {
  it('aborts the attempt in flight, clears the timers and ignores later pushes', async () => {
    const { queue, logged, calls } = rig(() => 'hang');
    queue.push(job('a'));
    queue.push(job('b'));
    await tick(0);
    expect(calls).toHaveLength(1);
    queue.dispose();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(queue.size()).toBe(0);
    queue.push(job('c'));
    expect(queue.size()).toBe(0);
    await tick(10 * 60_000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    // the abort caused by dispose is not a delivery failure
    expect(logged).toEqual([]);
  });

  it('clears a retry timer: nothing is sent after dispose', async () => {
    const { queue, calls } = rig(() => RETRY_503);
    queue.push(job('a'));
    await tick(0);
    expect(calls).toHaveLength(1);
    queue.dispose();
    await tick(10 * 60_000);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes the drops not yet logged, once, and leaves no timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logged: Logged = [];
    const queue = createDeliveryQueue<Job>({
      send: () => new Promise<Attempt>(() => undefined),
      clock,
      random: () => 0.5,
      logger: { warn: (e, d) => void logged.push([e, d]) },
      event: 'test.delivery',
      max: 1,
    });
    queue.push(job('in-flight'));
    await tick(0);
    queue.push(job('1'));
    queue.push(job('2')); // logs 1 at once
    queue.push(job('3'));
    queue.push(job('4')); // two more, pending
    expect(logged).toHaveLength(1);
    queue.dispose();
    expect(logged).toEqual([['test.delivery_dropped', { count: 1 }], ['test.delivery_dropped', { count: 2 }]]);
    queue.dispose();
    expect(logged).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs nothing when nothing is unlogged, and is idempotent', async () => {
    const { queue, logged } = rig(() => OK);
    queue.push(job('a'));
    await tick(0);
    queue.dispose();
    queue.dispose();
    expect(logged).toEqual([]);
  });

  it('a job that finishes after dispose starts nothing new', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let finish: ((a: Attempt) => void) | undefined;
    const queue = createDeliveryQueue<Job>({
      send: (j) => {
        sent.push(j.id);
        return new Promise<Attempt>((resolve) => (finish = resolve));
      },
      clock,
      random: () => 0.5,
      event: 'test.delivery',
    });
    queue.push(job('a'));
    queue.push(job('b'));
    await tick(0);
    queue.dispose();
    finish?.(OK);
    await tick(0);
    expect(sent).toEqual(['a']);
  });
});

describe('two queues', () => {
  it('each has its own order, its own bound and its own drop window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logged: Logged = [];
    const make = (event: string) => {
      const sent: string[] = [];
      const q = createDeliveryQueue<Job>({
        send: (j) => {
          sent.push(j.id);
          return new Promise<Attempt>(() => undefined);
        },
        clock,
        random: () => 0.5,
        logger: { warn: (e, d) => void logged.push([e, d]) },
        event,
        max: 1,
      });
      return { q, sent };
    };
    const a = make('one');
    const b = make('two');
    a.q.push(job('a1'));
    b.q.push(job('b1'));
    await tick(0);
    a.q.push(job('a2'));
    a.q.push(job('a3'));
    expect(logged).toEqual([['one_dropped', { count: 1 }]]);
    b.q.push(job('b2'));
    b.q.push(job('b3'));
    expect(logged).toEqual([['one_dropped', { count: 1 }], ['two_dropped', { count: 1 }]]);
    expect(a.sent).toEqual(['a1']);
    expect(b.sent).toEqual(['b1']);
  });
});

describe('a send that ignores its signal (K5a review 4)', () => {
  const stuck = () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logged: Logged = [];
    const sent: string[] = [];
    const queue = createDeliveryQueue<Job>({
      // Never settles, never looks at the signal.
      send: (j) => {
        sent.push(j.id);
        return j.id === 'stuck' ? new Promise<Attempt>(() => undefined) : Promise.resolve(OK);
      },
      clock,
      random: () => 0.5,
      logger: { warn: (e, d) => void logged.push([e, d]) },
      event: 'test.delivery',
    });
    return { queue, logged, sent };
  };

  it('the attempt timeout frees the slot: the next job is sent after the retries of the stuck one are used up', async () => {
    const { queue, logged, sent } = stuck();
    queue.push(job('stuck'));
    queue.push(job('next'));
    await tick(0);
    expect(sent).toEqual(['stuck']);
    // Six attempts, each cut off after 10 s, with the backoff between them (1, 2, 4, 8, 16 s at jitter 0.5 is exact).
    await tick(6 * ATTEMPT_TIMEOUT_MS + (1 + 2 + 4 + 8 + 16) * BACKOFF_BASE_MS + 100);
    expect(sent.filter((id) => id === 'stuck')).toHaveLength(MAX_RETRIES + 1);
    expect(sent).toContain('next');
    expect(logged).toEqual([['test.delivery_failed', { error: 'TimeoutError', attempts: MAX_RETRIES + 1 }]]);
    queue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose frees a stuck send and leaves no timer behind', async () => {
    const { queue, sent } = stuck();
    queue.push(job('stuck'));
    queue.push(job('next'));
    await tick(0);
    queue.dispose();
    await tick(10 * ATTEMPT_TIMEOUT_MS);
    expect(sent).toEqual(['stuck']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the max option (K5a review 4)', () => {
  const make = (max: unknown) => () =>
    createDeliveryQueue<Job>({ send: () => Promise.resolve(OK), clock, random: () => 0.5, event: 'x', max: max as number });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null])('refuses %s with a RangeError that does not echo it', (value) => {
    expect(make(value)).toThrow(RangeError);
    expect(() => make(value)()).toThrow('createDeliveryQueue: max must be a positive integer');
  });

  it('accepts 1, a thousand and the default', () => {
    expect(make(1)).not.toThrow();
    expect(make(1000)).not.toThrow();
    expect(make(undefined)).not.toThrow();
  });
});
