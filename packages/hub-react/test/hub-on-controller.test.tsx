import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/Hub.js';
import type { HubController } from '../src/headless/controller.js';
import { memoryRouter } from '../src/router.js';
import { hubWorld } from './world.js';

// `<Hub onController>`: the page is handed the hub's controller once it exists (and again if it is replaced), so it can call
// `controller.refresh()` without any event hack. `@experimental`.

afterEach(() => {
  vi.restoreAllMocks();
});

const pane = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Open cases' });

describe('<Hub onController>', () => {
  it('is called once with the hub controller once it exists', async () => {
    const w = await hubWorld();
    const onController = vi.fn();
    render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" onController={onController} />);
    await pane();
    expect(onController).toHaveBeenCalledTimes(1);
    const controller = onController.mock.calls[0]?.[0] as HubController;
    expect(controller.client).toBe(w.client);
    expect(typeof controller.refresh).toBe('function');
    expect(controller.disposed).toBe(false);
  });

  it('is not called again on a re-render, nor when only the callback changes (the latest one is used later, never re-announced)', async () => {
    const w = await hubWorld();
    const first = vi.fn();
    const second = vi.fn();
    const router = memoryRouter('/');
    const { rerender } = render(<Hub client={w.client} router={router} now={w.now} mode="detailed" onController={first} />);
    await pane();
    rerender(<Hub client={w.client} router={router} now={w.now} mode="detailed" onController={second} />);
    await pane();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('is called again, with the new controller, when the client is replaced', async () => {
    const w = await hubWorld();
    const other = await hubWorld();
    const onController = vi.fn();
    const router = memoryRouter('/');
    const { rerender } = render(<Hub client={w.client} router={router} now={w.now} mode="detailed" onController={onController} />);
    await pane();
    rerender(<Hub client={other.client} router={router} now={other.now} mode="detailed" onController={onController} />);
    await pane();
    expect(onController).toHaveBeenCalledTimes(2);
    const [a, b] = onController.mock.calls.map((c) => c[0] as HubController);
    expect(a).not.toBe(b);
    expect(b?.client).toBe(other.client);
    expect(b?.disposed).toBe(false);
  });

  it('under StrictMode the last controller it was given is a live one, and it is never given a disposed one after that', async () => {
    const w = await hubWorld();
    const given: HubController[] = [];
    render(
      <StrictMode>
        <Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" onController={(c) => given.push(c)} />
      </StrictMode>,
    );
    await pane();
    expect(given.length).toBeGreaterThan(0);
    expect(given[given.length - 1]?.disposed).toBe(false);
  });

  it('works without the prop (nothing is required of a page that does not need a handle)', async () => {
    const w = await hubWorld();
    render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" />);
    expect(await pane()).toBeTruthy();
  });

  it('is not called while the hub is still asking who is signed in, only once the controller exists', async () => {
    const w = await hubWorld();
    const onController = vi.fn();
    render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" onController={onController} />);
    // The controller is made with the provider, before GET /me answers: the page may use it from then on.
    expect(onController.mock.calls.length).toBeLessThanOrEqual(1);
    await pane();
    expect(onController).toHaveBeenCalledTimes(1);
  });

  it('the controller it gives: refresh() reads the change token once and shows a new report without waiting for the poll', async () => {
    const w = await hubWorld();
    let controller: HubController | undefined;
    render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" onController={(c) => (controller = c)} />);
    await pane();
    await w.file({ target: 'Alpha' });
    const before = w.sent.filter((r) => r.path === '/changes').length;
    await act(async () => {
      controller?.refresh();
    });
    await screen.findByRole('button', { name: /new case/i });
    expect(w.sent.filter((r) => r.path === '/changes').length).toBe(before + 1);
  });

  it('refresh() leaves no write behind: no request but the two reads', async () => {
    const w = await hubWorld();
    let controller: HubController | undefined;
    render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" onController={(c) => (controller = c)} />);
    await pane();
    const mark = w.sent.length;
    await act(async () => {
      controller?.refresh();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(w.sent.slice(mark).filter((r) => r.method !== 'GET')).toEqual([]);
  });
});
