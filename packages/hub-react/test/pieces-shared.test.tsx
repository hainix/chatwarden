import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createHubController } from '../src/headless/controller.js';
import type { HubController } from '../src/headless/controller.js';
import { CaseCard } from '../src/pieces/CaseCard.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { CaseWorkbench } from '../src/pieces/CaseWorkbench.js';
import { HubProvider, useHubController } from '../src/provider.js';
import { TermsManager } from '../src/pieces/TermsManager.js';
import type { TransportRequest } from '../src/transport.js';
import { manualTimers, settle } from './headless/kit.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';
import { renderPieces } from './pieces-kit.js';

// Pieces under one provider share one controller: one poller on the change token, one read of the queue, one claim and one
// heartbeat per case, however many pieces show it. Counted in requests, against the real routes.

const is = (method: string, path: RegExp | string) => (r: TransportRequest) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path));
const count = (w: HubWorld, method: string, path: RegExp | string): number => w.sent.filter(is(method, path)).length;

/** The adopter's own controller on timers the test moves, so "every 5 seconds" is exact. */
function steered(w: HubWorld) {
  const timers = manualTimers();
  const controller = createHubController({ client: w.client, now: w.now, schedule: timers });
  const advance = (ms: number) => act(async () => void (await timers.advance(ms)));
  return { timers, controller, advance };
}

describe('one poller, one queue read', () => {
  it('a list, a card and a workbench read the queue once and poll the change token once', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { controller, advance } = steered(w);
    render(
      <HubProvider controller={controller} now={w.now} mode="detailed">
        <CaseList />
        <CaseCard reportId={f.id} />
        <CaseWorkbench reportId={f.id} />
      </HubProvider>,
    );
    await screen.findByRole('complementary', { name: 'About this case' });
    await act(() => settle());
    // Starting the queue is one read of the change token (to adopt it) and one of the list; each poll after is one read of the token.
    expect(count(w, 'GET', '/reports')).toBe(1);
    expect(count(w, 'GET', '/changes')).toBe(1);
    await advance(5_000);
    await act(() => settle());
    expect(count(w, 'GET', '/changes')).toBe(2);
    await advance(5_000);
    await act(() => settle());
    expect(count(w, 'GET', '/changes')).toBe(3);
    controller.dispose();
  });

  it('under StrictMode too: still one read of the queue', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { controller } = steered(w);
    render(
      <StrictMode>
        <HubProvider controller={controller} now={w.now} mode="detailed">
          <CaseList />
          <CaseCard reportId={f.id} />
        </HubProvider>
      </StrictMode>,
    );
    await screen.findByRole('region', { name: 'Case against Alpha' });
    await act(() => settle());
    // StrictMode mounts the effects twice in development; the queue is started once and a stop/start pair reads it again at most once.
    expect(count(w, 'GET', '/reports')).toBeLessThanOrEqual(2);
    controller.dispose();
  });

  it('a piece that has nothing to do with the queue does not start it', async () => {
    const w = await hubWorld({ role: 'senior' });
    await w.file({ target: 'Alpha' });
    const { controller, advance } = steered(w);
    render(
      <HubProvider controller={controller} now={w.now}>
        <TermsManager />
      </HubProvider>,
    );
    await screen.findByRole('heading', { level: 2, name: 'Terms' });
    await advance(30_000);
    await act(() => settle());
    expect(count(w, 'GET', '/reports')).toBe(0);
    expect(count(w, 'GET', '/changes')).toBe(0);
    controller.dispose();
  });

  it('with a client the provider starts the queue for its pieces and stops it when the last one leaves', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    let controller: HubController | undefined;
    function Grab() {
      controller = useHubController();
      return null;
    }
    const view = render(
      <HubProvider client={w.client} now={w.now}>
        <Grab />
        <CaseList />
      </HubProvider>,
    );
    await screen.findByText('Alpha');
    const c = controller as HubController;
    const stop = vi.spyOn(c.queue, 'stop');
    expect(count(w, 'GET', '/reports')).toBe(1);
    view.rerender(
      <HubProvider client={w.client} now={w.now}>
        <Grab />
      </HubProvider>,
    );
    await act(() => settle());
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('one claim and one heartbeat per case', () => {
  it('a card and a workbench on the same case claim it once', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    renderPieces(
      w,
      <>
        <CaseCard reportId={f.id} />
        <CaseWorkbench reportId={f.id} />
      </>,
    );
    await screen.findByRole('complementary', { name: 'About this case' });
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await act(() => settle());
    expect(count(w, 'POST', `/cases/${f.person}/claim`)).toBe(1);
    expect(count(w, 'POST', `/cases/${f.person}/viewing`)).toBe(1);
  });

  it('two cards on the same case claim it once, and one leaving does not let it go', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    function Page({ both }: { both: boolean }) {
      return (
        <>
          <CaseCard reportId={f.id} />
          {both && <CaseCard reportId={f.id} />}
        </>
      );
    }
    const view = render(
      <HubProvider client={w.client} now={w.now}>
        <Page both />
      </HubProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Case against Alpha' })).toHaveLength(2));
    await act(() => settle());
    expect(count(w, 'POST', `/cases/${f.person}/claim`)).toBe(1);
    view.rerender(
      <HubProvider client={w.client} now={w.now}>
        <Page both={false} />
      </HubProvider>,
    );
    await act(() => settle());
    expect(count(w, 'POST', `/cases/${f.person}/release`)).toBe(0);
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
    view.unmount();
    await waitFor(() => expect(w.cw.cases.holder(f.person)).toBeNull());
    expect(count(w, 'POST', `/cases/${f.person}/release`)).toBe(1);
  });

  it('the heartbeat is one timer per case, not one per piece', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const { controller, advance } = steered(w);
    render(
      <HubProvider controller={controller} now={w.now} mode="detailed">
        <CaseCard reportId={f.id} />
        <CaseWorkbench reportId={f.id} />
      </HubProvider>,
    );
    await screen.findByRole('complementary', { name: 'About this case' });
    await act(() => settle());
    const before = count(w, 'POST', `/cases/${f.person}/claim`);
    await advance(60_000);
    await act(() => settle());
    expect(count(w, 'POST', `/cases/${f.person}/claim`)).toBe(before + 1);
    controller.dispose();
  });

  it('under StrictMode a card claims once, not once per mount', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    render(
      <StrictMode>
        <HubProvider client={w.client} now={w.now}>
          <CaseCard reportId={f.id} />
        </HubProvider>
      </StrictMode>,
    );
    await screen.findByRole('region', { name: 'Case against Alpha' });
    await act(() => settle());
    expect(count(w, 'POST', `/cases/${f.person}/claim`)).toBe(1);
    expect(count(w, 'POST', `/cases/${f.person}/release`)).toBe(0);
  });

  it('a card that is replaced in one commit (a new key) neither lets the case go nor claims it again', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    const view = render(
      <HubProvider client={w.client} now={w.now}>
        <CaseCard key="one" reportId={f.id} />
      </HubProvider>,
    );
    await waitFor(() => expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test'));
    await act(() => settle());
    view.rerender(
      <HubProvider client={w.client} now={w.now}>
        <CaseCard key="two" reportId={f.id} />
      </HubProvider>,
    );
    await screen.findByRole('region', { name: 'Case against Alpha' });
    await act(() => settle());
    expect(count(w, 'POST', `/cases/${f.person}/release`)).toBe(0);
    expect(count(w, 'POST', `/cases/${f.person}/claim`)).toBe(1);
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
  });

  it('two cards on different cases hold one claim at a time: the claim follows the card the moderator is in', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const b = await w.file({ target: 'Bravo' });
    renderPieces(
      w,
      <>
        <CaseCard reportId={a.id} />
        <CaseCard reportId={b.id} />
      </>,
    );
    const alpha = await screen.findByRole('region', { name: 'Case against Alpha' });
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    // One of them holds it, never both.
    const holders = [w.cw.cases.holder(a.person), w.cw.cases.holder(b.person)].filter((h) => h !== null && h !== undefined);
    expect(holders).toHaveLength(1);
    // Moving into Alpha's card makes Alpha the one that is held.
    await act(async () => {
      within(alpha).getByRole('button', { name: /^No action needed/ }).focus();
    });
    await waitFor(() => expect(w.cw.cases.holder(a.person)?.by).toBe('ann@example.test'));
    await waitFor(() => expect(w.cw.cases.holder(b.person)).toBeNull());
  });
});

describe('keys belong to the piece they are pressed in', () => {
  async function twoCards() {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const b = await w.file({ target: 'Bravo' });
    const controller = createHubController({ client: w.client, now: w.now });
    const view = render(
      <HubProvider controller={controller} now={w.now}>
        <CaseCard reportId={a.id} />
        <CaseCard reportId={b.id} />
      </HubProvider>,
    );
    const alpha = await screen.findByRole('region', { name: 'Case against Alpha' });
    const bravo = await screen.findByRole('region', { name: 'Case against Bravo' });
    await within(alpha).findByRole('button', { name: /^No action needed/ });
    await within(bravo).findByRole('button', { name: /^No action needed/ });
    return { w, a, b, controller, alpha, bravo, ...view };
  }
  const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    });

  it('2 with focus in the first card decides only the first', async () => {
    const { a, b, controller, alpha } = await twoCards();
    const button = within(alpha).getByRole('button', { name: /^No action needed/ });
    button.focus();
    await press(button, '2');
    await waitFor(() => expect(controller.decisions.entry(a.id)?.state.status).toBe('held'));
    expect(controller.decisions.entry(b.id)).toBeUndefined();
    controller.dispose();
  });

  it('2 with focus in the second card decides only the second', async () => {
    const { a, b, controller, bravo } = await twoCards();
    const button = within(bravo).getByRole('button', { name: /^No action needed/ });
    button.focus();
    await press(button, '2');
    await waitFor(() => expect(controller.decisions.entry(b.id)?.state.status).toBe('held'));
    expect(controller.decisions.entry(a.id)).toBeUndefined();
    controller.dispose();
  });

  it('2 with no focus in either card does nothing, anywhere on the page', async () => {
    const { a, b, controller } = await twoCards();
    await press(document.body, '2');
    await press(document.documentElement, '2');
    await act(() => settle());
    expect(controller.decisions.entry(a.id)).toBeUndefined();
    expect(controller.decisions.entry(b.id)).toBeUndefined();
    controller.dispose();
  });

  it('1 sends the suggested step in the card that has focus only', async () => {
    const { a, b, controller, bravo } = await twoCards();
    const button = within(bravo).getAllByRole('button')[0] as HTMLElement;
    button.focus();
    await press(button, '1');
    await waitFor(() => expect(controller.decisions.entry(b.id)?.state.status).toBe('held'));
    expect(controller.decisions.entry(a.id)).toBeUndefined();
    controller.dispose();
  });

  it('a key pressed while typing in a card is text, not a command', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const controller = createHubController({ client: w.client, now: w.now });
    render(
      <HubProvider controller={controller} now={w.now}>
        <CaseCard reportId={a.id} />
      </HubProvider>,
    );
    const alpha = await screen.findByRole('region', { name: 'Case against Alpha' });
    const field = document.createElement('textarea');
    alpha.appendChild(field);
    field.focus();
    await press(field, '2');
    await act(() => settle());
    expect(controller.decisions.entry(a.id)).toBeUndefined();
    field.remove();
    controller.dispose();
  });

  it('shortcuts={false} on the provider turns the card keys off', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const controller = createHubController({ client: w.client, now: w.now });
    render(
      <HubProvider controller={controller} now={w.now} shortcuts={false}>
        <CaseCard reportId={a.id} />
      </HubProvider>,
    );
    const alpha = await screen.findByRole('region', { name: 'Case against Alpha' });
    const button = await within(alpha).findByRole('button', { name: /^No action needed/ });
    button.focus();
    await press(button, '2');
    await act(() => settle());
    expect(controller.decisions.entry(a.id)).toBeUndefined();
    controller.dispose();
  });

  it('a key in a workbench changes the verdict of that workbench only', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const b = await w.file({ target: 'Bravo' });
    render(
      <HubProvider client={w.client} now={w.now} mode="detailed">
        <section aria-label="first">
          <CaseWorkbench reportId={a.id} />
        </section>
        <section aria-label="second">
          <CaseWorkbench reportId={b.id} />
        </section>
      </HubProvider>,
    );
    const first = await screen.findByRole('region', { name: 'first' });
    const second = screen.getByRole('region', { name: 'second' });
    await within(first).findByRole('radio', { name: /Not a problem/ });
    await within(second).findByRole('radio', { name: /Not a problem/ });
    const target = within(second).getAllByRole('tab')[0] as HTMLElement;
    target.focus();
    await press(target, '2');
    await waitFor(() => expect(within(second).getByRole('radio', { name: /Not a problem/ })).toBeChecked());
    expect(within(first).getByRole('radio', { name: /Not a problem/ })).not.toBeChecked();
  });
});
