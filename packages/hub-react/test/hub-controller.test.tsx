import { StrictMode, useState } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/Hub.js';
import type { HubController } from '../src/headless/controller.js';
import { memoryRouter } from '../src/router.js';
import { hubWorld } from './world.js';

// How <Hub> owns its controller: when it is told who is signed in, and what happens when the page mounts it twice.

const seen = vi.hoisted(() => ({ controllers: [] as unknown[], bump: null as null | (() => void), bumps: 0 }));

// Every controller the hub makes is noted, and a listener on `controller.me` pokes a component of another tree. If the hub tells the
// controller who is signed in while it is rendering, React says so: "Cannot update a component while rendering a different one".
vi.mock('../src/headless/controller.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/headless/controller.js')>();
  return {
    ...actual,
    createHubController: (options: Parameters<typeof actual.createHubController>[0]) => {
      const controller = actual.createHubController(options);
      seen.controllers.push(controller);
      controller.me.subscribe(() => {
        seen.bumps += 1;
        seen.bump?.();
      });
      return controller;
    },
  };
});

function Probe() {
  const [n, setN] = useState(0);
  seen.bump = () => setN((x) => x + 1);
  return <i data-testid="probe" data-n={n} />;
}

afterEach(() => {
  seen.controllers.length = 0;
  seen.bump = null;
  seen.bumps = 0;
  vi.restoreAllMocks();
});

describe('<Hub> and its controller', () => {
  it('tells the controller who is signed in outside of rendering: a listener on controller.me causes no "update while rendering" warning', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await hubWorld();
    // One tree: React only warns about an update to a component of the root that is rendering.
    render(
      <>
        <Probe />
        <Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" />
      </>,
    );
    await screen.findByRole('region', { name: 'Open cases' });
    expect(seen.bumps).toBeGreaterThan(0);
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => /Cannot update a component/.test(m))).toEqual([]);
    expect((seen.controllers[0] as HubController).me.getSnapshot()?.actor).toBe('ann@example.test');
  });

  it('the controller knows who is signed in before any child effect runs: the open case claims at once', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    render(<Hub client={w.client} router={memoryRouter(`/reports/${f.id}`)} now={w.now} mode="detailed" />);
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    await vi.waitFor(() => expect(w.sent.some((r) => r.method === 'POST' && /\/claim$/.test(r.path))).toBe(true));
    expect(w.cw.cases.holder(f.person)?.by).toBe('ann@example.test');
  });

  it('under StrictMode the hub still ends up with a live controller: it works, and the disposed one is not the one in use', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    render(
      <StrictMode>
        <Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" />
      </StrictMode>,
    );
    await screen.findByRole('region', { name: 'Open cases' });
    // (StrictMode runs a state initializer twice in development: the spare one is never told anything.)
    const live = (seen.controllers as HubController[]).filter((c) => !c.disposed && c.me.getSnapshot() !== null);
    expect(live).toHaveLength(1);
    expect(live[0]?.me.getSnapshot()?.actor).toBe('ann@example.test');
    await vi.waitFor(() => expect(live[0]?.queue.getSnapshot().status).toBe('ready'));
  });
});
