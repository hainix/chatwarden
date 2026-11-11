import { StrictMode, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createHubController } from '../src/headless/controller.js';
import type { HubController } from '../src/headless/controller.js';
import type { HubClient } from '../src/client.js';
import { createT, en } from '../src/i18n.js';
import { Hub } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import { CaseList } from '../src/pieces/CaseList.js';
import { HubProvider, useHubController } from '../src/provider.js';
import type { HubProviderProps } from '../src/provider.js';
import { useHub } from '../src/context.js';
import { hubWorld } from './world.js';
import { renderPieces } from './pieces-kit.js';

// HubProvider: the one thing a piece needs above it. It owns (or borrows) the controller, asks who is signed in, and draws the
// theme root so a piece is styled where it sits.

function Probe({ onController }: { onController?: (c: HubController) => void }) {
  const controller = useHubController();
  const { me, can } = useHub();
  onController?.(controller);
  return <p data-testid="probe">{`${me.actor}|${can('reports.read')}`}</p>;
}

describe('the theme root', () => {
  it('draws .cw-hub around its children, marked as embedded, so a piece is styled where it sits', async () => {
    const w = await hubWorld();
    const { container } = renderPieces(w, <Probe />);
    await screen.findByTestId('probe');
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass('cw-hub', 'cw-hub--embed');
    expect(root).toContainElement(screen.getByTestId('probe'));
  });

  it('bare draws no wrapper: the adopter places the root', async () => {
    const w = await hubWorld();
    const { container } = renderPieces(w, <Probe />, { bare: true });
    await screen.findByTestId('probe');
    expect(container.querySelector('.cw-hub')).toBeNull();
    expect(container.firstElementChild).toBe(screen.getByTestId('probe'));
  });

  it('a theme forces one scheme on the root, auto and none leave it to the visitor; className lands on the root', async () => {
    const w = await hubWorld();
    const dark = renderPieces(w, <Probe />, { theme: 'dark', className: 'mine' });
    await screen.findByTestId('probe');
    expect(dark.container.firstElementChild).toHaveAttribute('data-cw-theme', 'dark');
    expect(dark.container.firstElementChild).toHaveClass('mine');
    dark.unmount();
    const auto = renderPieces(w, <Probe />, { theme: 'auto' });
    await screen.findByTestId('probe');
    expect(auto.container.firstElementChild).not.toHaveAttribute('data-cw-theme');
  });
});

describe('what it says before it knows who is signed in', () => {
  it('says it is loading, then shows its children', async () => {
    const w = await hubWorld();
    renderPieces(w, <Probe />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the hub');
    expect(await screen.findByTestId('probe')).toHaveTextContent('ann@example.test|true');
  });

  it("a signed-out visitor gets a plain message, not a page: no <main>, no <h1> inside somebody else's dashboard", async () => {
    const w = await hubWorld({ role: null });
    const { container } = renderPieces(w, <Probe />);
    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    expect(screen.queryByTestId('probe')).toBeNull();
  });

  it('the hub itself still shows a page when signed out: a <main> with an <h1> (only the provider alone is a box)', async () => {
    const w = await hubWorld({ role: null });
    const { container } = render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} />);
    expect(await screen.findByRole('heading', { level: 1, name: /sign in/i })).toBeInTheDocument();
    expect(container.querySelector('main')).not.toBeNull();
  });

  it('a failed start says so and offers Retry', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/me' ? { status: 500, body: { error: { code: 'boom', message: 'x' } } } : undefined);
    const { user } = renderPieces(w, <Probe />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    w.intercept.fn = null;
    await user.click(retry);
    expect(await screen.findByTestId('probe')).toBeInTheDocument();
  });
});

describe('with a client, the provider makes, owns and disposes the controller', () => {
  it('asks GET /me once and gives every child the same controller', async () => {
    const w = await hubWorld();
    const seen = new Set<HubController>();
    renderPieces(
      w,
      <>
        <Probe onController={(c) => seen.add(c)} />
        <Probe onController={(c) => seen.add(c)} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByTestId('probe')).toHaveLength(2));
    expect(seen.size).toBe(1);
    expect(w.sent.filter((r) => r.path === '/me')).toHaveLength(1);
  });

  it('disposes it when it unmounts, which sends a decision still held', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    let controller: HubController | undefined;
    const { unmount } = renderPieces(w, <Probe onController={(c) => (controller = c)} />);
    await screen.findByTestId('probe');
    const c = controller as HubController;
    const outcome = c.decide({ reportId: f.id, person: f.person, input: { verdict: 'no_action', reason: 'fine', actions: [] } });
    expect(c.disposed).toBe(false);
    unmount();
    expect(c.disposed).toBe(true);
    expect(await outcome).toMatchObject({ status: 'done' });
    expect((await w.client.getReport(f.id)).report.status).not.toBe('open');
  });

  it('a new client makes a new controller and disposes the old one', async () => {
    const w = await hubWorld();
    const seen: HubController[] = [];
    function Switch() {
      const [client, setClient] = useState(w.client);
      return (
        <>
          <button type="button" onClick={() => setClient(w.direct)}>
            switch
          </button>
          <HubProvider client={client} now={w.now}>
            <Probe onController={(c) => seen.at(-1) !== c && seen.push(c)} />
          </HubProvider>
        </>
      );
    }
    render(<Switch />);
    await screen.findByTestId('probe');
    act(() => screen.getByRole('button', { name: 'switch' }).click());
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]?.disposed).toBe(true);
    expect(seen[1]?.disposed).toBe(false);
    expect(seen[1]?.client).toBe(w.direct);
  });

  it('under StrictMode it still ends with a live controller that works', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const seen: HubController[] = [];
    render(
      <StrictMode>
        <HubProvider client={w.client} now={w.now} mode="detailed">
          <Probe onController={(c) => seen.push(c)} />
          <CaseList />
        </HubProvider>
      </StrictMode>,
    );
    await screen.findByText('Alpha');
    const live = new Set(seen.filter((c) => !c.disposed));
    expect(live.size).toBe(1);
  });
});

describe('with a controller, the provider borrows it and never disposes it', () => {
  it("uses the adopter's controller, is told who is signed in, and leaves it running on unmount", async () => {
    const w = await hubWorld();
    const controller = createHubController({ client: w.client, now: w.now });
    let used: HubController | undefined;
    const { unmount } = render(
      <HubProvider controller={controller} now={w.now}>
        <Probe onController={(c) => (used = c)} />
      </HubProvider>,
    );
    await screen.findByTestId('probe');
    expect(used).toBe(controller);
    expect(controller.me.getSnapshot()?.actor).toBe('ann@example.test');
    unmount();
    expect(controller.disposed).toBe(false);
    controller.dispose();
  });

  it('does not ask GET /me again when the controller already knows who is signed in', async () => {
    const w = await hubWorld();
    const controller = createHubController({ client: w.client, now: w.now });
    await controller.start();
    const before = w.sent.filter((r) => r.path === '/me').length;
    render(
      <HubProvider controller={controller} now={w.now}>
        <Probe />
      </HubProvider>,
    );
    await screen.findByTestId('probe');
    expect(w.sent.filter((r) => r.path === '/me')).toHaveLength(before);
    controller.dispose();
  });

  it('survives StrictMode without being disposed', async () => {
    const w = await hubWorld();
    const controller = createHubController({ client: w.client, now: w.now });
    render(
      <StrictMode>
        <HubProvider controller={controller} now={w.now}>
          <Probe />
        </HubProvider>
      </StrictMode>,
    );
    await screen.findByTestId('probe');
    expect(controller.disposed).toBe(false);
    controller.dispose();
  });

  it("a controller keeps its own words when the provider is given none: configure is not called", async () => {
    const w = await hubWorld();
    const controller = createHubController({ client: w.client, now: w.now, t: createT({ ...en, 'hub.queue.title': 'Mine' }, 'en') });
    const configure = vi.spyOn(controller, 'configure');
    render(
      <HubProvider controller={controller} now={w.now}>
        <Probe />
      </HubProvider>,
    );
    await screen.findByTestId('probe');
    expect(configure).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("the words reach its toasts: configure({ t }) is called with the provider's words", async () => {
    const w = await hubWorld();
    const controller = createHubController({ client: w.client, now: w.now });
    const configure = vi.spyOn(controller, 'configure');
    const t = createT({ ...en, 'hub.queue.title': 'Cases to do' }, 'en');
    render(
      <HubProvider controller={controller} t={t} now={w.now}>
        <Probe />
      </HubProvider>,
    );
    await screen.findByTestId('probe');
    expect(configure).toHaveBeenCalledWith({ t });
    controller.dispose();
  });
});

describe('what it passes down', () => {
  it('the words, the locale, the clock and the shortcuts switch reach the pieces', async () => {
    const w = await hubWorld();
    const t = createT({ ...en, 'hub.queue.title': 'Cases to do' }, 'en');
    function Read() {
      const h = useHub();
      return <p data-testid="read">{`${h.t('hub.queue.title')}|${h.locale}|${h.now()}|${h.shortcuts}`}</p>;
    }
    renderPieces(w, <Read />, { t, locale: 'fr', now: () => 42, shortcuts: false });
    expect(await screen.findByTestId('read')).toHaveTextContent('Cases to do|fr|42|false');
  });

  it("the clock and the locale are the page's by default", async () => {
    const w = await hubWorld();
    function Read() {
      const h = useHub();
      return <p data-testid="read">{`${h.locale}|${h.shortcuts}|${h.now() > 1_000_000}`}</p>;
    }
    render(
      <HubProvider client={w.client}>
        <Read />
      </HubProvider>,
    );
    expect(await screen.findByTestId('read')).toHaveTextContent('en|true|true');
  });

  it('mode picks the rows of a CaseList: Simple hides the person tag a Detailed row shows', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    const simple = renderPieces(w, <CaseList />, { mode: 'simple' });
    await screen.findByText('Alpha');
    expect(simple.container.querySelector('.cw-case .cw-pid')).toBeNull();
    simple.unmount();
    const detailed = renderPieces(w, <CaseList />, { mode: 'detailed' });
    await screen.findByText('Alpha');
    expect(detailed.container.querySelector('.cw-case .cw-pid')).not.toBeNull();
  });
});

describe('the one-of rule', () => {
  it('takes a client or a controller, never both and never neither (a type-level check)', () => {
    const client = {} as HubClient;
    const controller = {} as HubController;
    const ok: HubProviderProps[] = [{ client }, { controller }];
    // @ts-expect-error both
    const both: HubProviderProps = { client, controller };
    // @ts-expect-error neither
    const neither: HubProviderProps = {};
    expect([ok.length, both, neither]).toHaveLength(3);
  });

  it('useHubController throws a plain message outside a provider', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/inside <HubProvider>/);
    errors.mockRestore();
  });
});
