import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { HubContext } from '../src/context.js';
import type { HubContextValue } from '../src/context.js';
import { createT, en } from '../src/i18n.js';
import { ToastProvider, useToasts } from '../src/toasts.js';
import type { Toasts } from '../src/toasts.js';

// A toast host with no hub controller above it keeps a toast store of its own. It must keep working when React mounts it twice
// (StrictMode runs the effect cleanup once in development, which disposes a store made for the first mount).

const context = { t: createT(en, 'en') } as unknown as HubContextValue;

function mount(strict: boolean) {
  const ref: { api: Toasts | null } = { api: null };
  function Grab() {
    ref.api = useToasts();
    return null;
  }
  const tree = (
    <HubContext.Provider value={context}>
      <ToastProvider>
        <Grab />
      </ToastProvider>
    </HubContext.Provider>
  );
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { ...view, api: (): Toasts => ref.api as Toasts };
}

describe('a toast host with no controller', () => {
  it('shows a toast', () => {
    const { api } = mount(false);
    act(() => void api().push({ text: 'Plain.' }));
    expect(screen.getByText('Plain.')).toBeInTheDocument();
  });

  it('shows a toast under StrictMode too, and a held action still runs once', async () => {
    const { api } = mount(true);
    let ran = 0;
    act(() => {
      api().push({ text: 'Under StrictMode.' });
      api().hold({ text: 'Held.', run: () => void (ran += 1) });
    });
    expect(screen.getByText('Under StrictMode.')).toBeInTheDocument();
    expect(screen.getByText('Held.')).toBeInTheDocument();
    await act(async () => {
      api().hold({ text: 'Now.', run: () => void (ran += 1) }).commit();
      await Promise.resolve();
    });
    expect(ran).toBe(1);
  });

  it('disposes its own store on unmount: a held action runs then', async () => {
    const { api, unmount } = mount(false);
    let ran = 0;
    act(() => void api().hold({ text: 'Held.', run: () => void (ran += 1) }));
    unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(1);
  });
});
