import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubController } from '../src/headless/controller.js';
import type { HubController } from '../src/headless/controller.js';
import { CaseCard } from '../src/pieces/CaseCard.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { HubProvider, useHubController } from '../src/provider.js';
import { settle } from './headless/kit.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';
import { renderPieces } from './pieces-kit.js';

// Fix round 2 of 7d: a controller the provider made still answers its toasts ("Open the case", Undo of a case you left) through the
// pieces' callbacks, without a second call for what the pieces already did themselves; and the queue is ref-counted for real, so an
// adopter's own start() is never stopped by the pieces.

afterEach(() => vi.restoreAllMocks());

let grabbed: HubController | null = null;
function Grab() {
  grabbed = useHubController();
  return null;
}

/** A decision on the case that is NOT on the page, which then fails: the moderator has gone on, so the toast offers the way back. */
async function failedAway(w: HubWorld, controllerOf: () => HubController, a: { id: string; person: string }) {
  w.intercept.fn = (req) => (/\/decide$/.test(req.path) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
  const outcome = await controllerOf().decide({ reportId: a.id, person: a.person, input: { verdict: 'no_action', reason: 'fine', actions: [] } }, { hold: false });
  w.intercept.fn = null;
  return outcome;
}

describe('a controller the provider made still answers its toasts through the callbacks', () => {
  it('"Open the case" after a failed decision on a case that is not on the page calls onOpenCase once', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const onOpenCase = vi.fn();
    const { user } = renderPieces(
      w,
      <>
        <Grab />
        <CaseCard reportId={b.id} onOpenCase={onOpenCase} />
      </>,
    );
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    expect((await failedAway(w, () => grabbed as HubController, a)).status).toBe('failed');
    const toasts = await screen.findByRole('region', { name: 'Notifications' });
    await user.click(await within(toasts).findByRole('button', { name: 'Open the case' }));
    expect(onOpenCase).toHaveBeenCalledTimes(1);
    expect(onOpenCase).toHaveBeenCalledWith(a.person, a.id);
  });

  it('falls back to onOpenReport when the piece has no onOpenCase', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const onOpenReport = vi.fn();
    const { user } = renderPieces(
      w,
      <>
        <Grab />
        <CaseCard reportId={b.id} onOpenReport={onOpenReport} />
      </>,
    );
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    await failedAway(w, () => grabbed as HubController, a);
    await user.click(await within(await screen.findByRole('region', { name: 'Notifications' })).findByRole('button', { name: 'Open the case' }));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    expect(onOpenReport).toHaveBeenCalledWith(a.id);
  });

  it('Undo of a decision on a case that is not on the page brings the moderator back to it, once', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const onOpenCase = vi.fn();
    const { user } = renderPieces(
      w,
      <>
        <Grab />
        <CaseCard reportId={b.id} onOpenCase={onOpenCase} />
      </>,
    );
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    void (grabbed as HubController).decide({ reportId: a.id, person: a.person, input: { verdict: 'no_action', reason: 'fine', actions: [] } });
    const toasts = await screen.findByRole('region', { name: 'Notifications' });
    await user.click(await within(toasts).findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith(a.person, a.id));
    expect(onOpenCase).toHaveBeenCalledTimes(1);
  });

  it('but never for a case a piece is already showing: Undo on a card that is on the page calls nothing', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const onOpenCase = vi.fn();
    const { user } = renderPieces(w, <CaseCard reportId={a.id} onOpenCase={onOpenCase} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    const dismiss = await within(card).findByRole('button', { name: /^No action needed/ });
    w.clock.t += 400;
    await user.click(dismiss);
    await user.click(await within(await screen.findByRole('region', { name: 'Notifications' })).findByRole('button', { name: 'Undo' }));
    await act(() => settle());
    expect(onOpenCase).not.toHaveBeenCalled();
  });

  it('but never for a case a piece is already showing: "Open the case" for a card on the page (not the held one) calls nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const onOpenCase = vi.fn();
    const { user } = renderPieces(
      w,
      <>
        <Grab />
        <CaseCard reportId={a.id} onOpenCase={onOpenCase} />
        <CaseCard reportId={b.id} onOpenCase={onOpenCase} />
      </>,
    );
    await screen.findByRole('region', { name: 'Case against Alpha' });
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    // Bravo is held; Alpha is on the page. A decision on Alpha made through the controller fails, and the toast offers the way back.
    await failedAway(w, () => grabbed as HubController, a);
    await user.click(await within(await screen.findByRole('region', { name: 'Notifications' })).findByRole('button', { name: 'Open the case' }));
    await act(() => settle());
    expect(onOpenCase).not.toHaveBeenCalled();
  });

  it('Take next tells onOpenCase exactly once: the outcome and the controller do not both navigate', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const onOpenCase = vi.fn();
    const { user } = renderPieces(w, <CaseList onOpenCase={onOpenCase} />);
    await screen.findByText('Alpha');
    await user.click(screen.getByRole('button', { name: /Take next/ }));
    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith(a.person, a.id));
    await act(() => settle());
    expect(onOpenCase).toHaveBeenCalledTimes(1);
  });

  it('decide-and-next tells the callback exactly once', async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Alpha', room: 'room-a' });
    const second = await w.file({ target: 'Alpha', room: 'room-b' });
    const onOpenReport = vi.fn();
    const { user } = renderPieces(w, <CaseCard reportId={first.id} onOpenReport={onOpenReport} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    (await within(card).findByRole('button', { name: /^No action needed/ })).focus();
    w.clock.t += 1000;
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(onOpenReport).toHaveBeenCalledWith(second.id));
    await act(() => settle());
    expect(onOpenReport).toHaveBeenCalledTimes(1);
  });
});

describe('a borrowed controller answers its toasts through the adopter\'s own host', () => {
  it('"Open the case" calls host.show, not the pieces\' callbacks (the adopter owns the controller, so the adopter owns its navigation)', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const show = vi.fn();
    const controller = createHubController({ client: w.client, now: w.now, host: { show } });
    const onOpenCase = vi.fn();
    const user = userEvent.setup();
    render(
      <HubProvider controller={controller} now={w.now}>
        <CaseCard reportId={b.id} onOpenCase={onOpenCase} />
      </HubProvider>,
    );
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    await failedAway(w, () => controller, a);
    await user.click(await within(await screen.findByRole('region', { name: 'Notifications' })).findByRole('button', { name: 'Open the case' }));
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(a.id);
    expect(onOpenCase).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe('the queue is ref-counted for real', () => {
  it("an adopter's own start() keeps it running after the pieces mount and unmount; its release, the last one, stops it", async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const controller = createHubController({ client: w.client, now: w.now });
    const started = await controller.start();
    expect(started.ok).toBe(true);
    expect(controller.queue.running).toBe(true);
    const view = render(
      <HubProvider controller={controller} now={w.now}>
        <CaseList />
      </HubProvider>,
    );
    await screen.findByText('Alpha');
    view.unmount();
    await act(() => settle());
    expect(controller.queue.running).toBe(true);
    started.release();
    expect(controller.queue.running).toBe(false);
    controller.dispose();
  });

  it('the pieces\' release does not stop it while the adopter still holds a start, and the adopter\'s release does not stop it while pieces are mounted', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const controller = createHubController({ client: w.client, now: w.now });
    const started = await controller.start();
    const view = render(
      <HubProvider controller={controller} now={w.now}>
        <CaseList />
      </HubProvider>,
    );
    await screen.findByText('Alpha');
    started.release();
    expect(controller.queue.running).toBe(true);
    view.unmount();
    await act(() => settle());
    expect(controller.queue.running).toBe(false);
    controller.dispose();
  });

  it('a start that failed (signed out) hands back a release that does nothing', async () => {
    const w = await hubWorld({ role: null });
    const controller = createHubController({ client: w.client, now: w.now });
    const started = await controller.start();
    expect(started.ok).toBe(false);
    expect(() => started.release()).not.toThrow();
    controller.dispose();
  });
});
