import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubController } from '../src/headless/controller.js';
import type { HubController } from '../src/headless/controller.js';
import { CaseCard } from '../src/pieces/CaseCard.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { CaseWorkbench } from '../src/pieces/CaseWorkbench.js';
import { HubProvider } from '../src/provider.js';
import { TermsManager } from '../src/pieces/TermsManager.js';
import { AuditLog } from '../src/pieces/AuditLog.js';
import type { TransportRequest } from '../src/transport.js';
import { settle } from './headless/kit.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';
import { renderPieces } from './pieces-kit.js';

// Fix round 1 of 7d: callbacks fire the same way for a client and for a borrowed controller; "and next" never takes a case nobody
// will see; one held case is said plainly and warned about; the queue is started and stopped only by whoever started it.

const posts = (w: HubWorld, re: RegExp): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && re.test(r.path));
const ctrlEnter = async (user: ReturnType<typeof userEvent.setup>, within_: HTMLElement) => {
  const button = await within(within_).findByRole('button', { name: /^No action needed/ });
  button.focus();
  await user.keyboard('{Control>}{Enter}{/Control}');
};

type Mount = (w: HubWorld, ui: React.ReactNode) => { unmount: () => void; controller: HubController | null; user: ReturnType<typeof userEvent.setup> };
const asClient: Mount = (w, ui) => {
  const r = renderPieces(w, ui);
  return { unmount: r.unmount, controller: null, user: r.user };
};
const asBorrowed: Mount = (w, ui) => {
  const controller = createHubController({ client: w.client, now: w.now });
  const user = userEvent.setup();
  const r = render(
    <HubProvider controller={controller} now={w.now} mode="detailed">
      {ui}
    </HubProvider>,
  );
  return { unmount: r.unmount, controller, user };
};

describe.each([
  ['a client', asClient],
  ['a borrowed controller', asBorrowed],
] as const)('callbacks fire the same way for %s', (_name, mount) => {
  afterEach(() => vi.restoreAllMocks());

  it('Take next in CaseList takes the case and tells onOpenCase once', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const onOpenCase = vi.fn();
    const m = mount(w, <CaseList onOpenCase={onOpenCase} />);
    await screen.findByText('Alpha');
    await m.user.click(screen.getByRole('button', { name: /Take next/ }));
    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith(a.person, a.id));
    await act(() => settle());
    expect(onOpenCase).toHaveBeenCalledTimes(1);
    m.controller?.dispose();
  });

  it("Ctrl+Enter on a card goes on to the same person's next report: onOpenReport, once", async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Alpha', room: 'room-a' });
    const second = await w.file({ target: 'Alpha', room: 'room-b' });
    const onOpenReport = vi.fn();
    const m = mount(w, <CaseCard reportId={first.id} onOpenReport={onOpenReport} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    await ctrlEnter(m.user, card);
    await waitFor(() => expect(onOpenReport).toHaveBeenCalledWith(second.id));
    await act(() => settle());
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    m.controller?.dispose();
  });

  it("Ctrl+Enter on a card with no more of the person's reports takes the next case and tells onOpenCase", async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const onOpenCase = vi.fn();
    const m = mount(w, <CaseCard reportId={a.id} onOpenCase={onOpenCase} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    await ctrlEnter(m.user, card);
    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith(b.person, b.id));
    await act(() => settle());
    expect(onOpenCase).toHaveBeenCalledTimes(1);
    expect(w.cw.cases.holder(b.person)?.by).toBe('ann@example.test');
    m.controller?.dispose();
  });

  it('Ctrl+Enter in a workbench does the same', async () => {
    const w = await hubWorld();
    const first = await w.file({ target: 'Alpha', room: 'room-a' });
    const second = await w.file({ target: 'Alpha', room: 'room-b' });
    const onOpenReport = vi.fn();
    const m = mount(w, <CaseWorkbench reportId={first.id} onOpenReport={onOpenReport} />);
    await screen.findByRole('complementary', { name: 'About this case' });
    const bar = await screen.findByRole('region', { name: 'Decision' });
    await m.user.click(await within(bar).findByRole('radio', { name: /Not a problem/ }));
    await m.user.type(within(bar).getByRole('textbox', { name: 'Reason' }), 'Fine.{Control>}{Enter}{/Control}');
    await waitFor(() => expect(onOpenReport).toHaveBeenCalledWith(second.id));
    expect(onOpenReport).toHaveBeenCalledTimes(1);
    m.controller?.dispose();
  });

  it('with nowhere to show a next case, Ctrl+Enter decides only: no case is taken for nobody to see', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const m = mount(w, <CaseCard reportId={a.id} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    await ctrlEnter(m.user, card);
    expect(await screen.findAllByRole('button', { name: 'Undo' })).not.toHaveLength(0);
    await act(() => settle());
    expect(posts(w, /^\/cases\/next$/)).toHaveLength(0);
    expect(w.cw.cases.holder(b.person)).toBeNull();
    m.controller?.dispose();
  });

  it('onOpenReport alone is enough to show the case that was taken', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 60_000;
    const b = await w.file({ target: 'Bravo' });
    const onOpenReport = vi.fn();
    const m = mount(w, <CaseCard reportId={a.id} onOpenReport={onOpenReport} />);
    const card = await screen.findByRole('region', { name: 'Case against Alpha' });
    await ctrlEnter(m.user, card);
    await waitFor(() => expect(onOpenReport).toHaveBeenCalledWith(b.id));
    m.controller?.dispose();
  });
});

describe('one held case is said plainly', () => {
  afterEach(() => vi.restoreAllMocks());

  const warned = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => /one case at a time/i.test(String(c[0])));

  it('warns once, in development, when two different people are shown at once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    expect(warned(warn)).toHaveLength(1);
    // Moving between them is not a new mistake.
    const alpha = screen.getByRole('region', { name: 'Case against Alpha' });
    await act(async () => within(alpha).getByRole('button', { name: /^No action needed/ }).focus());
    await act(() => settle());
    expect(warned(warn)).toHaveLength(1);
  });

  it('is quiet for one person with two reports, the same case twice, and a single card', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha', room: 'room-a' });
    const a2 = await w.file({ target: 'Alpha', room: 'room-b' });
    renderPieces(
      w,
      <>
        <CaseCard reportId={a.id} />
        <CaseWorkbench reportId={a2.id} />
        <CaseCard reportId={a.id} />
      </>,
    );
    await screen.findByRole('complementary', { name: 'About this case' });
    await act(() => settle());
    expect(warned(warn)).toHaveLength(0);
  });

  it('is silent in production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    try {
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
      await screen.findByRole('region', { name: 'Case against Bravo' });
      await act(() => settle());
      expect(warned(warn)).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('deciding on the card that is not held decides that case only, and Undo undoes that case only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const b = await w.file({ target: 'Bravo' });
    const controller = createHubController({ client: w.client, now: w.now });
    const user = userEvent.setup();
    render(
      <HubProvider controller={controller} now={w.now}>
        <CaseCard reportId={a.id} />
        <CaseCard reportId={b.id} />
      </HubProvider>,
    );
    const alpha = await screen.findByRole('region', { name: 'Case against Alpha' });
    await screen.findByRole('region', { name: 'Case against Bravo' });
    await act(() => settle());
    // Bravo was shown last, so it is the held one: Alpha is the card that is not.
    await waitFor(() => expect(w.cw.cases.holder(b.person)?.by).toBe('ann@example.test'));
    await user.click(await within(alpha).findByRole('button', { name: /^No action needed/ }));
    await waitFor(() => expect(controller.decisions.entry(a.id)?.state.status).toBe('held'));
    expect(controller.decisions.entry(b.id)).toBeUndefined();
    await user.click(await within(await screen.findByRole('region', { name: 'Notifications' })).findByRole('button', { name: 'Undo' }));
    // Undone: the card is back (the entry is taken back by the card or still says undone), and Bravo was never touched.
    await waitFor(() => expect([undefined, 'undone']).toContain(controller.decisions.entry(a.id)?.state.status));
    await within(alpha).findByRole('button', { name: /^No action needed/ });
    expect(controller.decisions.entry(b.id)).toBeUndefined();
    expect(posts(w, /\/decide$/)).toHaveLength(0);
    expect((await w.client.getReport(a.id)).report.status).toBe('open');
    expect((await w.client.getReport(b.id)).report.status).toBe('open');
    controller.dispose();
  });
});

describe('the queue is started and stopped by whoever started it', () => {
  it('a borrowed controller that was not running is started by the pieces and stopped when the last leaves', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const controller = createHubController({ client: w.client, now: w.now });
    expect(controller.queue.running).toBe(false);
    const view = render(
      <HubProvider controller={controller} now={w.now}>
        <CaseList />
      </HubProvider>,
    );
    await screen.findByText('Alpha');
    expect(controller.queue.running).toBe(true);
    view.unmount();
    await act(() => settle());
    expect(controller.queue.running).toBe(false);
    controller.dispose();
  });

  it('a borrowed controller the adopter already started is left running', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const controller = createHubController({ client: w.client, now: w.now });
    await controller.start();
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
    controller.dispose();
  });

  it('it stays running while any piece still needs it, and a remount in one commit does not stop it', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const controller = createHubController({ client: w.client, now: w.now });
    const stop = vi.spyOn(controller.queue, 'stop');
    const view = render(
      <StrictMode>
        <HubProvider controller={controller} now={w.now}>
          <CaseList />
          <CaseList />
        </HubProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getAllByText('Alpha')).toHaveLength(2));
    await act(() => settle());
    expect(stop).not.toHaveBeenCalled();
    view.rerender(
      <StrictMode>
        <HubProvider controller={controller} now={w.now}>
          <CaseList />
        </HubProvider>
      </StrictMode>,
    );
    await act(() => settle());
    expect(controller.queue.running).toBe(true);
    view.unmount();
    await act(() => settle());
    expect(controller.queue.running).toBe(false);
    controller.dispose();
  });

  it('pieces that never need the queue neither start nor stop a borrowed one', async () => {
    const w = await hubWorld({ role: 'senior' });
    const controller = createHubController({ client: w.client, now: w.now });
    const start = vi.spyOn(controller.queue, 'start');
    const stop = vi.spyOn(controller.queue, 'stop');
    const view = render(
      <HubProvider controller={controller} now={w.now}>
        <TermsManager />
      </HubProvider>,
    );
    await screen.findByRole('heading', { level: 2, name: 'Terms' });
    view.unmount();
    await act(() => settle());
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe('the no-access message names the permission for whoever is debugging a grant', () => {
  it('data-cw-need carries the permission key, and the text stays plain', async () => {
    const w = await hubWorld({ role: 'moderator' });
    renderPieces(w, <AuditLog />);
    const message = await screen.findByText(/can.t open this/);
    expect(message).toHaveAttribute('data-cw-need', 'audit.read');
    expect(message.textContent).not.toMatch(/audit\.read/);
  });
});
