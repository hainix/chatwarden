import { act, render, screen } from '@testing-library/react';
import { StrictMode, useLayoutEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { useStore } from '../src/controllerContext.js';
import { createStore } from '../src/headless/store.js';
import type { Store } from '../src/headless/store.js';

// `useStore` is how every provider and hook reads a headless store: `useSyncExternalStore` over `subscribe` and `getSnapshot`.

/** A store that counts who is listening. */
function counted<T>(initial: T) {
  const inner = createStore(initial);
  let listening = 0;
  const store: Store<T> & { set: (v: T) => void; listening: () => number } = {
    subscribe: (l) => {
      listening += 1;
      const off = inner.subscribe(l);
      return () => {
        listening -= 1;
        off();
      };
    },
    getSnapshot: inner.getSnapshot,
    set: inner.set,
    listening: () => listening,
  };
  return store;
}

describe('useStore', () => {
  it('shows the store and follows each change', () => {
    const store = createStore('a');
    function Show() {
      return <p>{useStore(store)}</p>;
    }
    render(<Show />);
    expect(screen.getByText('a')).toBeInTheDocument();
    act(() => store.set('b'));
    expect(screen.getByText('b')).toBeInTheDocument();
  });

  it('renders a change in the synchronous lane: a store change outside a batch is on screen within microtasks, not a task later', async () => {
    const store = createStore('before');
    function Show() {
      return <p>{useStore(store)}</p>;
    }
    render(<Show />);
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      store.set('after');
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      expect(screen.getByText('after')).toBeInTheDocument();
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it('misses no update made between the render and the subscription (a layout effect of a sibling changes the store)', () => {
    const store = createStore(0);
    function Reader() {
      return <p data-testid="read">{useStore(store)}</p>;
    }
    function Writer() {
      useLayoutEffect(() => {
        store.set(7);
      }, []);
      return null;
    }
    render(
      <>
        <Reader />
        <Writer />
      </>,
    );
    expect(screen.getByTestId('read')).toHaveTextContent('7');
  });

  it('does not render again when a change leaves the snapshot the same', () => {
    const store = createStore({ n: 1 });
    let renders = 0;
    function Show() {
      renders += 1;
      return <p>{useStore(store).n}</p>;
    }
    render(<Show />);
    const before = renders;
    act(() => store.update((s) => s));
    act(() => store.set(store.getSnapshot()));
    expect(renders).toBe(before);
    act(() => store.set({ n: 2 }));
    expect(renders).toBe(before + 1);
  });

  it('listens once while mounted and stops on unmount', () => {
    const store = counted(0);
    function Show() {
      return <p>{useStore(store)}</p>;
    }
    const { unmount } = render(<Show />);
    expect(store.listening()).toBe(1);
    unmount();
    expect(store.listening()).toBe(0);
    store.set(5);
  });

  it('two readers of one store always agree', () => {
    const store = createStore(0);
    const seen: Array<[number, number]> = [];
    function A() {
      return <p data-testid="a">{useStore(store)}</p>;
    }
    function B() {
      const v = useStore(store);
      seen.push([v, store.getSnapshot()]);
      return <p data-testid="b">{v}</p>;
    }
    render(
      <>
        <A />
        <B />
      </>,
    );
    for (const n of [1, 2, 3]) {
      act(() => store.set(n));
      expect(screen.getByTestId('a').textContent).toBe(screen.getByTestId('b').textContent);
      expect(screen.getByTestId('a')).toHaveTextContent(String(n));
    }
    expect(seen.every(([v, now]) => v === now)).toBe(true);
  });

  it('a different store is read at once, not after a render of the old one', () => {
    const one = createStore('one');
    const two = createStore('two');
    function Show({ s }: { s: Store<string> }) {
      return <p>{useStore(s)}</p>;
    }
    const { rerender } = render(<Show s={one} />);
    rerender(<Show s={two} />);
    expect(screen.getByText('two')).toBeInTheDocument();
    act(() => one.set('ignored'));
    expect(screen.getByText('two')).toBeInTheDocument();
  });

  it('works under StrictMode: still subscribed after the simulated unmount, and unsubscribed on the real one', () => {
    const store = counted('x');
    function Show() {
      return <p>{useStore(store)}</p>;
    }
    const { unmount } = render(
      <StrictMode>
        <Show />
      </StrictMode>,
    );
    expect(store.listening()).toBe(1);
    act(() => store.set('y'));
    expect(screen.getByText('y')).toBeInTheDocument();
    unmount();
    expect(store.listening()).toBe(0);
  });
});
