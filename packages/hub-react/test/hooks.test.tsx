import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../src/client.js';
import { useHubAction, useHubData, usePagedList } from '../src/hooks.js';

/** A promise the test settles by hand. */
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

describe('useHubData', () => {
  it('loads once for a key and reports loading, then the data', async () => {
    const load = vi.fn(() => Promise.resolve('hello'));
    const { result } = renderHook(() => useHubData('k', load));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBe('hello'));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not load again on a re-render with the same key, even with a new load function', async () => {
    const load = vi.fn(() => Promise.resolve(1));
    const { result, rerender } = renderHook(() => useHubData('k', () => load()));
    await waitFor(() => expect(result.current.data).toBe(1));
    rerender();
    rerender();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads again when the key changes and never shows the old key data under the new key', async () => {
    const gate = deferred<string>();
    const { result, rerender } = renderHook(({ k }) => useHubData(k, () => (k === 'a' ? Promise.resolve('A') : gate.promise)), { initialProps: { k: 'a' } });
    await waitFor(() => expect(result.current.data).toBe('A'));
    rerender({ k: 'b' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await act(async () => gate.resolve('B'));
    expect(result.current.data).toBe('B');
  });

  it('ignores a slow answer for an old key that arrives after the new one', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const { result, rerender } = renderHook(({ k }) => useHubData(k, () => (k === 'slow' ? slow.promise : fast.promise)), { initialProps: { k: 'slow' } });
    rerender({ k: 'fast' });
    await act(async () => fast.resolve('FAST'));
    expect(result.current.data).toBe('FAST');
    await act(async () => slow.resolve('SLOW'));
    expect(result.current.data).toBe('FAST');
  });

  it('ignores an old error that arrives after a newer answer', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let n = 0;
    const { result } = renderHook(() => useHubData('k', () => (++n === 1 ? first.promise : second.promise)));
    act(() => result.current.reload());
    await act(async () => second.resolve('NEW'));
    await act(async () => first.reject(boom()));
    expect(result.current.data).toBe('NEW');
    expect(result.current.error).toBeNull();
  });

  it('reports a failure as a HubError and has no data', async () => {
    const { result } = renderHook(() => useHubData('k', () => Promise.reject(boom('forbidden', 403))));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatchObject({ status: 403, code: 'forbidden' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it('wraps a non-HubError rejection as a HubError', async () => {
    const { result } = renderHook(() => useHubData('k', () => Promise.reject(new TypeError('x'))));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBeInstanceOf(HubError);
    expect(result.current.error?.code).toBe('unexpected');
  });

  it('keeps the last good data when a reload fails, with the error beside it', async () => {
    let n = 0;
    const { result } = renderHook(() => useHubData('k', () => (++n === 1 ? Promise.resolve('good') : Promise.reject(boom('network', 0)))));
    await waitFor(() => expect(result.current.data).toBe('good'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBe('good');
    expect(result.current.error?.code).toBe('network');
  });

  it('clears the error when a reload works', async () => {
    let n = 0;
    const { result } = renderHook(() => useHubData('k', () => (++n === 1 ? Promise.reject(boom()) : Promise.resolve('fine'))));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toBe('fine'));
    expect(result.current.error).toBeNull();
  });

  it('shows loading during a reload while keeping the data', async () => {
    const gate = deferred<string>();
    let n = 0;
    const { result } = renderHook(() => useHubData('k', () => (++n === 1 ? Promise.resolve('one') : gate.promise)));
    await waitFor(() => expect(result.current.data).toBe('one'));
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe('one');
    await act(async () => gate.resolve('two'));
    expect(result.current.data).toBe('two');
    expect(result.current.loading).toBe(false);
  });

  it('does nothing after unmount', async () => {
    const gate = deferred<string>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useHubData('k', () => gate.promise));
    unmount();
    await act(async () => gate.resolve('late'));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('useHubAction', () => {
  it('runs the function with its arguments and returns ok with the value', async () => {
    const fn = vi.fn((a: number, b: number) => Promise.resolve(a + b));
    const { result } = renderHook(() => useHubAction(fn));
    let out: unknown;
    await act(async () => {
      out = await result.current.run(2, 3);
    });
    expect(out).toEqual({ ok: true, value: 5 });
    expect(fn).toHaveBeenCalledWith(2, 3);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('is busy while it runs', async () => {
    const gate = deferred<string>();
    const { result } = renderHook(() => useHubAction(() => gate.promise));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.run();
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      gate.resolve('done');
      await p;
    });
    expect(result.current.busy).toBe(false);
  });

  it('sends once on a double submit and gives both callers the same answer', async () => {
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useHubAction(fn));
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    act(() => {
      a = result.current.run();
      b = result.current.run();
    });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve('x'));
    expect(await a).toEqual({ ok: true, value: 'x' });
    expect(await b).toEqual({ ok: true, value: 'x' });
  });

  it('can run again after the first finished', async () => {
    const fn = vi.fn(() => Promise.resolve('x'));
    const { result } = renderHook(() => useHubAction(fn));
    await act(async () => void (await result.current.run()));
    await act(async () => void (await result.current.run()));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('returns the error instead of throwing, keeps it in state, and clears it on the next run or on request', async () => {
    let n = 0;
    const { result } = renderHook(() => useHubAction(() => (++n === 1 ? Promise.reject(boom('already_decided', 409)) : Promise.resolve('ok'))));
    let out: unknown;
    await act(async () => {
      out = await result.current.run();
    });
    expect(out).toMatchObject({ ok: false, error: { status: 409, code: 'already_decided' } });
    expect(result.current.error).toMatchObject({ code: 'already_decided' });
    expect(result.current.busy).toBe(false);
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    await act(async () => void (await result.current.run()));
    expect(result.current.error).toBeNull();
  });

  it('a second run after a failure clears the old error as it starts', async () => {
    const gate = deferred<string>();
    let n = 0;
    const { result } = renderHook(() => useHubAction(() => (++n === 1 ? Promise.reject(boom()) : gate.promise)));
    await act(async () => void (await result.current.run()));
    expect(result.current.error).not.toBeNull();
    act(() => void result.current.run());
    expect(result.current.error).toBeNull();
    await act(async () => gate.resolve('x'));
  });

  it('wraps a non-HubError throw as unexpected', async () => {
    const { result } = renderHook(() => useHubAction(() => Promise.reject(new RangeError('x'))));
    let out: { ok: boolean; error?: HubError } = { ok: true };
    await act(async () => {
      out = (await result.current.run()) as typeof out;
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('unexpected');
  });

  it('does nothing visible after unmount', async () => {
    const gate = deferred<string>();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, unmount } = renderHook(() => useHubAction(() => gate.promise));
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.run();
    });
    unmount();
    await act(async () => {
      gate.resolve('late');
      await p;
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('uses the latest function without needing a new run function', async () => {
    let tag = 'one';
    const { result, rerender } = renderHook(() => {
      const t = tag;
      return useHubAction(() => Promise.resolve(t));
    });
    const run = result.current.run;
    tag = 'two';
    rerender();
    let out: unknown;
    await act(async () => {
      out = await run();
    });
    expect(out).toEqual({ ok: true, value: 'two' });
  });
});

describe('usePagedList', () => {
  const pager = (pages: string[][]) => {
    const asked: Array<string | undefined> = [];
    const load = (cursor: string | undefined) => {
      asked.push(cursor);
      const i = cursor === undefined ? 0 : Number(cursor);
      return Promise.resolve({ items: pages[i] ?? [], next: i + 1 < pages.length ? String(i + 1) : null });
    };
    return { load, asked };
  };

  it('loads the first page, then appends the next page on loadMore, until next is null', async () => {
    const { load, asked } = pager([['a', 'b'], ['c'], ['d']]);
    const { result } = renderHook(() => usePagedList('k', load));
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));
    expect(result.current.next).toBe('1');
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual(['a', 'b', 'c']);
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual(['a', 'b', 'c', 'd']);
    expect(result.current.next).toBeNull();
    await act(async () => result.current.loadMore());
    expect(asked).toEqual([undefined, '1', '2']);
  });

  it('loadMore says how many items it added: the page size, then 0 at the end, a failure or a double call', async () => {
    let n = 0;
    const load = (cursor: string | undefined) => {
      n += 1;
      if (n === 3) return Promise.reject(boom('network', 0));
      return Promise.resolve(cursor === undefined ? { items: ['a', 'b'], next: '1' } : { items: ['c'], next: cursor === '1' ? '2' : null });
    };
    const { result } = renderHook(() => usePagedList('k', load));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    let added = -1;
    await act(async () => {
      added = await result.current.loadMore();
    });
    expect(added).toBe(1);
    await act(async () => {
      added = await result.current.loadMore();
    });
    expect(added).toBe(0);
    expect(result.current.error).not.toBeNull();
    await act(async () => {
      added = await result.current.loadMore();
    });
    expect(added).toBe(1);
    expect(result.current.next).toBeNull();
    await act(async () => {
      added = await result.current.loadMore();
    });
    expect(added).toBe(0);
  });

  it('sends one request for a double loadMore', async () => {
    const gate = deferred<{ items: string[]; next: string | null }>();
    let n = 0;
    const load = vi.fn(() => (++n === 1 ? Promise.resolve({ items: ['a'], next: '1' }) : gate.promise));
    const { result } = renderHook(() => usePagedList('k', load));
    await waitFor(() => expect(result.current.items).toEqual(['a']));
    act(() => {
      void result.current.loadMore();
      void result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => gate.resolve({ items: ['b'], next: null }));
    expect(result.current.items).toEqual(['a', 'b']);
    expect(result.current.loadingMore).toBe(false);
  });

  it('keeps the list and sets the error when a later page fails, and loadMore can retry', async () => {
    let n = 0;
    const load = vi.fn(() => {
      n += 1;
      if (n === 1) return Promise.resolve({ items: ['a'], next: '1' });
      if (n === 2) return Promise.reject(boom('network', 0));
      return Promise.resolve({ items: ['b'], next: null });
    });
    const { result } = renderHook(() => usePagedList('k', load));
    await waitFor(() => expect(result.current.items).toEqual(['a']));
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual(['a']);
    expect(result.current.error?.code).toBe('network');
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual(['a', 'b']);
    expect(result.current.error).toBeNull();
  });

  it('reports a first-page failure with no items', async () => {
    const { result } = renderHook(() => usePagedList<string>('k', () => Promise.reject(boom('forbidden', 403))));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('starts over when the key changes, and ignores a late page of the old key', async () => {
    const lateOld = deferred<{ items: string[]; next: string | null }>();
    const { result, rerender } = renderHook(
      ({ k }) =>
        usePagedList(k, (cursor) => {
          if (k === 'old') return cursor === undefined ? Promise.resolve({ items: ['o1'], next: '1' }) : lateOld.promise;
          return Promise.resolve({ items: ['n1'], next: null });
        }),
      { initialProps: { k: 'old' } },
    );
    await waitFor(() => expect(result.current.items).toEqual(['o1']));
    act(() => void result.current.loadMore());
    rerender({ k: 'new' });
    await waitFor(() => expect(result.current.items).toEqual(['n1']));
    await act(async () => lateOld.resolve({ items: ['o2'], next: null }));
    expect(result.current.items).toEqual(['n1']);
    expect(result.current.next).toBeNull();
  });

  it('reload fetches the first page again and replaces the list', async () => {
    let n = 0;
    const load = () => Promise.resolve({ items: [`v${++n}`], next: null });
    const { result } = renderHook(() => usePagedList('k', load));
    await waitFor(() => expect(result.current.items).toEqual(['v1']));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.items).toEqual(['v2']));
  });
});
