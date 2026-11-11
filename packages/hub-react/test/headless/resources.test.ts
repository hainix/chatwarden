// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../../src/client.js';
import { createAction, createPagedList, createResource } from '../../src/headless/resources.js';
import { settle } from './kit.js';

// The read, write and paged-list helpers every screen (and every non-React adopter) builds on, with no React.

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const boom = (code = 'internal', status = 500): HubError => new HubError({ status, code, message: `failed: ${code}` });

describe('createResource', () => {
  it('starts loading, and loads once for a key, then has the data', async () => {
    const load = vi.fn(() => Promise.resolve('hello'));
    const r = createResource(load, 'k');
    expect(r.getSnapshot()).toEqual({ key: 'k', data: undefined, error: null, loading: true });
    r.start('k');
    await settle(1);
    expect(r.getSnapshot()).toEqual({ key: 'k', data: 'hello', error: null, loading: false });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a new key starts over and never shows the old key\'s data under it', async () => {
    const gate = deferred<string>();
    const r = createResource(() => gate.promise, 'a');
    r.setLoader(() => Promise.resolve('A'));
    r.start('a');
    await settle(1);
    expect(r.getSnapshot().data).toBe('A');
    r.setLoader(() => gate.promise);
    r.start('b');
    expect(r.getSnapshot()).toEqual({ key: 'b', data: undefined, error: null, loading: true });
    gate.resolve('B');
    await settle(1);
    expect(r.getSnapshot()).toMatchObject({ key: 'b', data: 'B', loading: false });
  });

  it('a slow answer for an old request never overwrites a newer one, nor does an old error', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    let n = 0;
    const r = createResource(() => (++n === 1 ? slow.promise : fast.promise));
    r.start('k');
    r.reload();
    fast.resolve('FAST');
    await settle(1);
    slow.reject(boom());
    await settle(1);
    expect(r.getSnapshot()).toMatchObject({ data: 'FAST', error: null });
  });

  it('a failure is a HubError with no data; a non-HubError is wrapped as unexpected', async () => {
    const a = createResource(() => Promise.reject(boom('forbidden', 403)));
    a.start('k');
    await settle(1);
    expect(a.getSnapshot()).toMatchObject({ error: { status: 403, code: 'forbidden' }, data: undefined, loading: false });
    const b = createResource(() => Promise.reject(new TypeError('x')));
    b.start('k');
    await settle(1);
    expect(b.getSnapshot().error).toBeInstanceOf(HubError);
    expect(b.getSnapshot().error?.code).toBe('unexpected');
  });

  it('keeps the last good data when a reload fails, with the error beside it, and a good reload clears the error', async () => {
    let n = 0;
    const r = createResource(() => (++n === 2 ? Promise.reject(boom('network', 0)) : Promise.resolve(`v${n}`)));
    r.start('k');
    await settle(1);
    r.reload();
    expect(r.getSnapshot()).toMatchObject({ data: 'v1', loading: true });
    await settle(1);
    expect(r.getSnapshot()).toMatchObject({ data: 'v1', error: { code: 'network' }, loading: false });
    r.reload();
    await settle(1);
    expect(r.getSnapshot()).toMatchObject({ data: 'v3', error: null });
  });

  it('a loader thrown synchronously is a failed load, not a throw', async () => {
    const r = createResource((): Promise<string> => {
      throw new RangeError('now');
    });
    expect(() => r.start('k')).not.toThrow();
    await settle(1);
    expect(r.getSnapshot().error?.code).toBe('unexpected');
  });

  it('stop abandons what is in flight', async () => {
    const gate = deferred<string>();
    const r = createResource(() => gate.promise);
    r.start('k');
    r.stop();
    gate.resolve('late');
    await settle(1);
    expect(r.getSnapshot().data).toBeUndefined();
  });

  it('uses the latest loader without starting again', async () => {
    let tag = 'one';
    const r = createResource(() => Promise.resolve(tag));
    r.start('k');
    await settle(1);
    tag = 'two';
    r.setLoader(() => Promise.resolve(tag));
    expect(r.getSnapshot().data).toBe('one');
    r.reload();
    await settle(1);
    expect(r.getSnapshot().data).toBe('two');
  });

  it('the snapshot is the same object until something changes, and a listener hears each change', async () => {
    const r = createResource(() => Promise.resolve(1));
    const listener = vi.fn();
    r.subscribe(listener);
    const first = r.getSnapshot();
    expect(r.getSnapshot()).toBe(first);
    r.start('k');
    await settle(1);
    expect(r.getSnapshot()).not.toBe(first);
    expect(listener).toHaveBeenCalled();
    const done = r.getSnapshot();
    expect(r.getSnapshot()).toBe(done);
  });
});

describe('createAction', () => {
  it('runs with its arguments and answers ok with the value', async () => {
    const fn = vi.fn((a: number, b: number) => Promise.resolve(a + b));
    const a = createAction(fn);
    expect(await a.run(2, 3)).toEqual({ ok: true, value: 5 });
    expect(fn).toHaveBeenCalledWith(2, 3);
    expect(a.getSnapshot()).toEqual({ busy: false, error: null });
  });

  it('is busy while it runs, and a double submit sends once, both callers getting the one answer', async () => {
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const a = createAction(fn);
    const first = a.run();
    const second = a.run();
    expect(a.getSnapshot().busy).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve('x');
    expect(await first).toEqual({ ok: true, value: 'x' });
    expect(await second).toEqual({ ok: true, value: 'x' });
    expect(a.getSnapshot().busy).toBe(false);
  });

  it('answers the error instead of throwing, keeps it, and clears it on the next run or on request', async () => {
    let n = 0;
    const a = createAction(() => (++n === 1 ? Promise.reject(boom('already_decided', 409)) : Promise.resolve('ok')));
    expect(await a.run()).toMatchObject({ ok: false, error: { status: 409, code: 'already_decided' } });
    expect(a.getSnapshot().error?.code).toBe('already_decided');
    a.clearError();
    expect(a.getSnapshot().error).toBeNull();
    await a.run();
    expect(a.getSnapshot().error).toBeNull();
  });

  it('a second run after a failure clears the old error as it starts', async () => {
    const gate = deferred<string>();
    let n = 0;
    const a = createAction(() => (++n === 1 ? Promise.reject(boom()) : gate.promise));
    await a.run();
    expect(a.getSnapshot().error).not.toBeNull();
    const again = a.run();
    expect(a.getSnapshot().error).toBeNull();
    gate.resolve('x');
    await again;
  });

  it('a function that throws before it returns a promise is a failed run, leaves nothing in flight, and the next run works', async () => {
    let n = 0;
    const fn = vi.fn((): Promise<string> => {
      n += 1;
      if (n < 3) throw new URIError('bad');
      return Promise.resolve('fine');
    });
    const a = createAction(fn);
    expect(await a.run()).toMatchObject({ ok: false, error: { code: 'unexpected' } });
    expect(await a.run()).toMatchObject({ ok: false });
    expect(a.getSnapshot().busy).toBe(false);
    expect(await a.run()).toEqual({ ok: true, value: 'fine' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(a.getSnapshot().error).toBeNull();
  });

  it('calls the function inside the call, so a double submit in one tick sends once', () => {
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const a = createAction(fn);
    void a.run();
    void a.run();
    void a.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses the latest function without a new run', async () => {
    let tag = 'one';
    const a = createAction(() => Promise.resolve(tag));
    const run = a.run;
    tag = 'two';
    a.setFn(() => Promise.resolve(tag));
    expect(await run()).toEqual({ ok: true, value: 'two' });
  });

  it('once detached it still answers, but changes nothing a screen would see', async () => {
    const gate = deferred<string>();
    const a = createAction(() => gate.promise);
    const detach = a.attach();
    const listener = vi.fn();
    a.subscribe(listener);
    const p = a.run();
    detach();
    listener.mockClear();
    gate.resolve('late');
    expect(await p).toEqual({ ok: true, value: 'late' });
    expect(listener).not.toHaveBeenCalled();
    a.attach();
    await a.run().catch(() => undefined);
  });
});

describe('createPagedList', () => {
  const pager = (pages: string[][]) => {
    const asked: Array<string | undefined> = [];
    const load = (cursor: string | undefined) => {
      asked.push(cursor);
      const i = cursor === undefined ? 0 : Number(cursor);
      return Promise.resolve({ items: pages[i] ?? [], next: i + 1 < pages.length ? String(i + 1) : null });
    };
    return { load, asked };
  };

  it('loads the first page, then appends on loadMore until next is null, then adds nothing', async () => {
    const { load, asked } = pager([['a', 'b'], ['c'], ['d']]);
    const l = createPagedList(load, 'k');
    expect(l.getSnapshot()).toMatchObject({ items: [], loading: true, loaded: false });
    l.start('k');
    await settle(1);
    expect(l.getSnapshot()).toMatchObject({ items: ['a', 'b'], next: '1', loading: false });
    expect(await l.loadMore()).toBe(1);
    expect(await l.loadMore()).toBe(1);
    expect(l.getSnapshot()).toMatchObject({ items: ['a', 'b', 'c', 'd'], next: null });
    expect(await l.loadMore()).toBe(0);
    expect(asked).toEqual([undefined, '1', '2']);
  });

  it('a double loadMore sends one request, and says loadingMore meanwhile', async () => {
    const gate = deferred<{ items: string[]; next: string | null }>();
    let n = 0;
    const load = vi.fn(() => (++n === 1 ? Promise.resolve({ items: ['a'], next: '1' }) : gate.promise));
    const l = createPagedList(load, 'k');
    l.start('k');
    await settle(1);
    const first = l.loadMore();
    const second = l.loadMore();
    expect(l.getSnapshot().loadingMore).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    gate.resolve({ items: ['b'], next: null });
    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(l.getSnapshot()).toMatchObject({ items: ['a', 'b'], loadingMore: false });
  });

  it('a failed later page keeps the list and sets the error, and loadMore tries that page again', async () => {
    let n = 0;
    const load = vi.fn(() => {
      n += 1;
      if (n === 1) return Promise.resolve({ items: ['a'], next: '1' });
      if (n === 2) return Promise.reject(boom('network', 0));
      return Promise.resolve({ items: ['b'], next: null });
    });
    const l = createPagedList(load, 'k');
    l.start('k');
    await settle(1);
    expect(await l.loadMore()).toBe(0);
    expect(l.getSnapshot()).toMatchObject({ items: ['a'], error: { code: 'network' } });
    expect(await l.loadMore()).toBe(1);
    expect(l.getSnapshot()).toMatchObject({ items: ['a', 'b'], error: null });
  });

  it('a first-page failure has no items and is not loading', async () => {
    const l = createPagedList<string>(() => Promise.reject(boom('forbidden', 403)), 'k');
    l.start('k');
    await settle(1);
    expect(l.getSnapshot()).toMatchObject({ items: [], loading: false, error: { code: 'forbidden' } });
    expect(await l.loadMore()).toBe(0);
  });

  it('a new key starts over, and a late page of the old key is ignored', async () => {
    const late = deferred<{ items: string[]; next: string | null }>();
    let key = 'old';
    const l = createPagedList((cursor) => {
      if (key === 'old') return cursor === undefined ? Promise.resolve({ items: ['o1'], next: '1' }) : late.promise;
      return Promise.resolve({ items: ['n1'], next: null });
    }, 'old');
    l.start('old');
    await settle(1);
    const pending = l.loadMore();
    key = 'new';
    l.start('new');
    await settle(1);
    expect(l.getSnapshot()).toMatchObject({ key: 'new', items: ['n1'], next: null });
    late.resolve({ items: ['o2'], next: null });
    expect(await pending).toBe(0);
    expect(l.getSnapshot().items).toEqual(['n1']);
  });

  it('reload fetches the first page again and replaces the list', async () => {
    let n = 0;
    const l = createPagedList(() => Promise.resolve({ items: [`v${++n}`], next: null }), 'k');
    l.start('k');
    await settle(1);
    l.reload();
    expect(l.getSnapshot().items).toEqual(['v1']);
    await settle(1);
    expect(l.getSnapshot().items).toEqual(['v2']);
  });

  it('stop abandons what is in flight', async () => {
    const gate = deferred<{ items: string[]; next: string | null }>();
    const l = createPagedList(() => gate.promise, 'k');
    l.start('k');
    l.stop();
    gate.resolve({ items: ['late'], next: null });
    await settle(1);
    expect(l.getSnapshot().items).toEqual([]);
  });

  it('the snapshot is the same object until something changes', async () => {
    const { load } = pager([['a']]);
    const l = createPagedList(load, 'k');
    l.start('k');
    await settle(1);
    const s = l.getSnapshot();
    expect(l.getSnapshot()).toBe(s);
    await l.loadMore();
    expect(l.getSnapshot()).toBe(s);
  });
});
