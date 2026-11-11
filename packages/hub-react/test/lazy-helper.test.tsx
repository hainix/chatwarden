import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Component } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubProvider } from '../src/provider.js';
import { ScreenShown, lazyScreen } from '../src/screens/lazy.js';
import { hubWorld } from './world.js';

// `lazyScreen(what, load)`: a screen that loads on first use. A skeleton while it loads, the hub's error block with Try again when
// the load fails (and Try again really loads it again), and nothing swallowed: a screen that breaks while rendering is not "failed to load".

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const Hello = ({ name }: { name: string }) => <h2 className="cw-screen-title">Hello {name}</h2>;

async function inHub(node: ReactNode) {
  const w = await hubWorld();
  return render(<HubProvider client={w.client}>{node}</HubProvider>);
}

describe('lazyScreen', () => {
  it('shows the quiet skeleton (a polite "Loading" and grey bars) while it loads, then the screen with its props', async () => {
    const gate = deferred<typeof Hello>();
    const Screen = lazyScreen<{ name: string }>('hub.state.what.terms', () => gate.promise);
    const { container } = await inHub(<Screen name="Ada" />);
    expect((await screen.findByText(/^Loading$/)).getAttribute('role')).toBe('status');
    expect(container.querySelector('.cw-skel')).not.toBeNull();
    expect(screen.queryByText('Hello Ada')).toBeNull();
    gate.resolve(Hello);
    expect(await screen.findByText('Hello Ada')).toBeTruthy();
    expect(container.querySelector('.cw-skel')).toBeNull();
  });

  it('loads once: the second time it is shown there is no skeleton and no second load', async () => {
    const load = vi.fn(() => Promise.resolve(Hello));
    const Screen = lazyScreen<{ name: string }>('hub.state.what.terms', load);
    const first = await inHub(<Screen name="Ada" />);
    await screen.findByText('Hello Ada');
    first.unmount();
    const { container } = await inHub(<Screen name="Bo" />);
    expect(await screen.findByText('Hello Bo')).toBeTruthy();
    expect(container.querySelector('.cw-skel')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed load shows the hub error block, naming what could not be loaded, with Try again', async () => {
    const Screen = lazyScreen<{ name: string }>('hub.state.what.terms', () => Promise.reject(new Error('chunk 404')));
    await inHub(<Screen name="Ada" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the terms.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The reason is the hub's plain sentence, never the raw text of a bundler's error.
    expect(alert.textContent).not.toContain('chunk 404');
  });

  it('Try again loads it again (not the failed result again): the skeleton, then the screen', async () => {
    const second = deferred<typeof Hello>();
    const load = vi.fn<() => Promise<typeof Hello>>().mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(second.promise);
    const Screen = lazyScreen<{ name: string }>('hub.state.what.guide', load);
    await inHub(<Screen name="Ada" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(load).toHaveBeenCalledTimes(2);
    expect((await screen.findByText(/^Loading$/)).getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    second.resolve(Hello);
    expect(await screen.findByText('Hello Ada')).toBeTruthy();
  });

  it('Try again that fails again shows the error block again, and a third try can succeed', async () => {
    const load = vi.fn<() => Promise<typeof Hello>>().mockRejectedValueOnce(new Error('one')).mockRejectedValueOnce(new Error('two')).mockResolvedValueOnce(Hello);
    const Screen = lazyScreen<{ name: string }>('hub.state.what.audit', load);
    await inHub(<Screen name="Ada" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Hello Ada')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('a screen that throws while it renders is not a failed load: the error goes on up, to the page boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = (): ReactNode => {
      throw new Error('render bug');
    };
    const Screen = lazyScreen<object>('hub.state.what.terms', () => Promise.resolve(Broken));
    class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
      override state = { error: null as Error | null };
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      override render() {
        return this.state.error === null ? this.props.children : <p data-testid="page-boundary">{this.state.error.message}</p>;
      }
    }
    await inHub(
      <Boundary>
        <Screen />
      </Boundary>,
    );
    expect((await screen.findByTestId('page-boundary')).textContent).toBe('render bug');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells the shell when the screen has come in (once), so focus can follow a screen that arrives late', async () => {
    const shown = vi.fn();
    const gate = deferred<typeof Hello>();
    const Screen = lazyScreen<{ name: string }>('hub.state.what.terms', () => gate.promise);
    await inHub(
      <ScreenShown.Provider value={shown}>
        <Screen name="Ada" />
      </ScreenShown.Provider>,
    );
    await screen.findByText(/^Loading$/);
    expect(shown).not.toHaveBeenCalled();
    gate.resolve(Hello);
    await screen.findByText('Hello Ada');
    expect(shown).toHaveBeenCalledTimes(1);
  });

  it('tells the shell about a failed load too, with the error block, so focus can go to it', async () => {
    const shown = vi.fn();
    const Screen = lazyScreen<{ name: string }>('hub.state.what.terms', () => Promise.reject(new Error('x')));
    await inHub(
      <ScreenShown.Provider value={shown}>
        <Screen name="Ada" />
      </ScreenShown.Provider>,
    );
    const alert = await screen.findByRole('alert');
    expect(shown).toHaveBeenCalledTimes(1);
    expect((shown.mock.calls[0]?.[0] as HTMLElement).contains(alert)).toBe(true);
  });

  it('a failed load takes no focus outside the hub shell (a piece sits in another page)', async () => {
    const Screen = lazyScreen<{ name: string }>('hub.state.what.terms', () => Promise.reject(new Error('x')));
    await inHub(<Screen name="Ada" />);
    await screen.findByRole('alert');
    expect(document.body).toHaveFocus();
  });

  it('after Try again has failed twice it suggests reloading the page; before that it does not', async () => {
    const Screen = lazyScreen<{ name: string }>('hub.state.what.guide', () => Promise.reject(new Error('stale')));
    await inHub(<Screen name="Ada" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/reload/i);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText(/reload the page/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
