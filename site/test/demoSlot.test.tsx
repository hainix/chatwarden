// The demo is code-split: DemoSlot shows the placeholder, and loads the demo chunk when the section nears the viewport.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoSlot } from '../src/sections/DemoSlot';

type Cb = (entries: Array<{ isIntersecting: boolean }>) => void;
let observers: Array<{ cb: Cb; opts?: IntersectionObserverInit; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }>;

function stubIO() {
  observers = [];
  class FakeIO {
    constructor(cb: Cb, opts?: IntersectionObserverInit) {
      const rec = { cb, opts, disconnect: vi.fn(), observe: vi.fn() };
      observers.push(rec);
      this.observe = rec.observe;
      this.disconnect = rec.disconnect;
    }
    observe: (el: Element) => void;
    disconnect: () => void;
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);
}

beforeEach(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DemoSlot lazy loading', () => {
  it('shows the placeholder first, and watches the section with a generous margin', () => {
    stubIO();
    const { container } = render(<DemoSlot />);
    expect(screen.getByText(/loading the demo/i)).toBeTruthy();
    expect(container.querySelector('[data-demo-slot]')).toBeTruthy();
    expect(screen.queryByRole('group', { name: /interactive demo/i })).toBeNull();
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observe).toHaveBeenCalledTimes(1);
    expect(parseInt(String(observers[0]?.opts?.rootMargin ?? '0'), 10)).toBeGreaterThanOrEqual(200);
  });
  it('does not load the demo while the section is still far away', () => {
    stubIO();
    render(<DemoSlot />);
    act(() => observers[0]?.cb([{ isIntersecting: false }]));
    expect(screen.queryByRole('group', { name: /interactive demo/i })).toBeNull();
    expect(observers[0]?.disconnect).not.toHaveBeenCalled();
  });
  it('loads the demo chunk when the section nears the viewport, then stops watching', async () => {
    stubIO();
    render(<DemoSlot />);
    act(() => observers[0]?.cb([{ isIntersecting: true }]));
    expect(await screen.findByRole('group', { name: /chatwarden interactive demo/i })).toBeTruthy();
    expect(screen.queryByText(/loading the demo/i)).toBeNull();
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });
  it('loads at once when IntersectionObserver is missing', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<DemoSlot />);
    expect(await screen.findByRole('group', { name: /chatwarden interactive demo/i })).toBeTruthy();
  });
  it('loads when a visitor focuses or points into the placeholder (interaction), even before it scrolls near', async () => {
    stubIO();
    const { container } = render(<DemoSlot />);
    fireEvent.pointerEnter(container.querySelector('[data-demo-slot]') as Element);
    expect(await screen.findByRole('group', { name: /chatwarden interactive demo/i })).toBeTruthy();
  });
  it('keeps the section heading and the lead while it loads, and announces the loading politely', () => {
    stubIO();
    render(<DemoSlot />);
    expect(screen.getByRole('heading', { level: 2, name: /play both sides/i })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/loading the demo/i);
  });
});
