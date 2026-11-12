import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUICK_ACT_COOLDOWN_MS } from '../src/case/useQuickActions.js';
import { resetQuickKeysVisit } from '../src/quickKeys.js';
import type { TransportRequest } from '../src/transport.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// "Close more reports at once": dismiss every open report about the person on the case, or from the reporter of this report, behind one
// disclosure in the decision bar. A confirm window shows the live count, the sweep is held for the Undo window, and nothing about it is
// reachable from a key. Real staff routes throughout.

const sweeps = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && r.path === '/reports/dismiss-open');
const previews = (w: HubWorld): TransportRequest[] => sweeps(w).filter((r) => (r.body as { dryRun?: boolean }).dryRun === true);
const real = (w: HubWorld): TransportRequest[] => sweeps(w).filter((r) => (r.body as { dryRun?: boolean }).dryRun !== true);
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const disclosure = (): HTMLDetailsElement => decision().querySelector('details.cw-bulk') as HTMLDetailsElement;
const summary = (): HTMLElement => within(decision()).getByText('Close more reports at once');
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

beforeEach(() => {
  window.localStorage.clear();
  resetQuickKeysVisit();
});
afterEach(() => {
  window.localStorage.clear();
  resetQuickKeysVisit();
});

interface Setup {
  options?: WorldOptions;
  mode?: 'simple' | 'detailed';
  props?: Parameters<typeof renderHub>[1];
  /** Open reports about the case's person (default 3). */
  about?: number;
  /** Something that happens on the server before the hub is shown. */
  before?: (w: HubWorld, mallory: Array<{ id: string; person: string; reporter: string }>) => Promise<unknown>;
}

/** Mallory has `about` open reports from different reporters; the newest is Rita's, and Beta has one, also from Rita. The hub opens Mallory's newest. */
async function start({ options = {}, mode = 'detailed', props = {}, about = 3, before }: Setup = {}) {
  cleanup();
  const w = await hubWorld({ actor: 'ann@example.test', ...options });
  const others = ['Sam', 'Tess', 'Uma', 'Vic'];
  const mallory = [];
  for (let i = 0; i < about; i += 1) {
    mallory.push(await w.file({ target: 'Mallory', reporter: i === about - 1 ? 'Rita' : (others[i] as string), room: `m${i}` }));
    w.clock.t += 1000;
  }
  const beta = await w.file({ target: 'Beta', reporter: 'Rita', room: 'beta' });
  w.clock.t += 1000;
  await before?.(w, mallory);
  const r = renderHub(w, { path: `/reports/${mallory[about - 1]!.id}`, mode, ...props });
  await screen.findByRole('region', { name: 'Decision' });
  if (mode === 'simple') await r.user.click(await within(decision()).findByRole('button', { name: /^Something else/ }));
  await within(decision()).findByText('Close more reports at once').catch(() => undefined);
  w.clock.t += QUICK_ACT_COOLDOWN_MS + 1;
  return { w, mallory, beta, ...r };
}
const open = async (user: Awaited<ReturnType<typeof start>>['user']): Promise<void> => {
  if (!disclosure().open) await user.click(summary());
};

describe('the disclosure', () => {
  it('is closed by default, labelled, and holds two rows once opened', async () => {
    const s = await start();
    expect(disclosure()).not.toBeNull();
    expect(disclosure().open).toBe(false);
    expect(summary().tagName).toBe('SUMMARY');
    await open(s.user);
    expect(disclosure().open).toBe(true);
    expect(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' })).toBeInTheDocument();
    expect(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' })).toBeInTheDocument();
  });

  it('is there in Simple too, inside Something else', async () => {
    const s = await start({ mode: 'simple' });
    expect(disclosure()).not.toBeNull();
    expect(disclosure().open).toBe(false);
    await open(s.user);
    expect(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' })).toBeInTheDocument();
  });

  it('on the Simple card itself (Something else not opened) nothing about it shows', async () => {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reporter: 'Rita' });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('button', { name: /^No action needed/ });
    expect(screen.queryByText('Close more reports at once')).toBeNull();
  });

  it('is absent without reports.decide.bulk', async () => {
    await start({ options: { permissions: { 'reports.decide.bulk': 'senior' } } });
    expect(screen.queryByText('Close more reports at once')).toBeNull();
  });

  it('is absent without reports.decide (the bar says the role cannot decide)', async () => {
    await start({ options: { permissions: { 'reports.decide': 'senior' } } });
    expect(screen.queryByText('Close more reports at once')).toBeNull();
  });

  it('is absent from a server that does not say the role may (an older server has no such key in /me)', async () => {
    cleanup();
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reporter: 'Rita' });
    w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === '/me') {
        const me = await w.direct.me();
        const can = { ...me.can } as Record<string, boolean>;
        delete can['reports.decide.bulk'];
        return { status: 200, headers: {}, body: { ...me, can } };
      }
      return undefined;
    };
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await screen.findByRole('region', { name: 'Decision' });
    await within(decision()).findByRole('button', { name: /^Nothing wrong here/ });
    expect(screen.queryByText('Close more reports at once')).toBeNull();
  });

  it('with one open report about the person only the reporter row is offered', async () => {
    const s = await start({ about: 1 });
    await open(s.user);
    expect(within(disclosure()).queryByRole('button', { name: /^Dismiss all .* open reports about/ })).toBeNull();
    expect(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' })).toBeInTheDocument();
  });

  it('is absent on a case that is already closed', async () => {
    const s = await start();
    await s.w.client.decide(s.mallory[2]!.id, { verdict: 'no_action', actions: [] });
    cleanup();
    renderHub(s.w, { path: `/reports/${s.mallory[2]!.id}`, mode: 'detailed' });
    await screen.findByText(/Decided by/);
    expect(screen.queryByText('Close more reports at once')).toBeNull();
  });
});

describe('the confirm window', () => {
  it('choosing the person row opens it with the live count from a dry run and focus on Cancel', async () => {
    const s = await start();
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 3 reports about Mallory?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(previews(s.w)).toHaveLength(1);
    expect(previews(s.w)[0]!.body).toEqual({ scope: 'person', ref: s.mallory[0]!.person, dryRun: true });
    expect(real(s.w)).toHaveLength(0);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByText('Nothing happens to anyone. Reporters are not told and are not marked as acting in bad faith. You can undo for 5 seconds.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Dismiss 3 reports' })).toBeInTheDocument();
  });

  it('says it is counting first', async () => {
    const s = await start();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    s.w.intercept.fn = async (req) => {
      if (req.path === '/reports/dismiss-open') await gate;
      return undefined;
    };
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Counting the open reports...')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Dismiss \d/ })).toBeNull();
    release();
    await within(dialog).findByRole('button', { name: 'Dismiss 2 reports' });
  });

  it('names the reporter and counts their reports, whichever cases they are about', async () => {
    const s = await start();
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 2 reports from Rita?' });
    expect(previews(s.w)[0]!.body).toEqual({ scope: 'reporter', ref: s.mallory[s.mallory.length - 1]!.reporter, dryRun: true });
    expect(within(dialog).getByRole('button', { name: 'Dismiss 2 reports' })).toBeInTheDocument();
  });

  it('Cancel and Escape send nothing and give focus back inside the disclosure', async () => {
    const s = await start();
    await open(s.user);
    const row = within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' });
    await s.user.click(row);
    const dialog = await screen.findByRole('dialog');
    await s.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(disclosure().contains(document.activeElement)).toBe(true);
    await s.user.click(row);
    await screen.findByRole('dialog');
    await s.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(disclosure().contains(document.activeElement)).toBe(true);
    await pageHides();
    expect(real(s.w)).toHaveLength(0);
  });

  it('with nothing open it says so and offers only Close', async () => {
    const s = await start({ about: 2 });
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' }));
    const first = await screen.findByRole('dialog');
    await within(first).findByRole('button', { name: 'Dismiss 2 reports' });
    await s.user.click(within(first).getByRole('button', { name: 'Cancel' }));
    // Everything of Rita's is closed behind the hub's back.
    for (const r of [s.mallory[1]!, s.beta]) await s.w.client.decide(r.id, { verdict: 'no_action', actions: [] });
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('There are no open reports to dismiss.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Dismiss \d/ })).toBeNull();
    await s.user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(real(s.w)).toHaveLength(0);
  });

  it('a failed count says so and sends nothing', async () => {
    const s = await start();
    s.w.intercept.fn = (req) => (req.path === '/reports/dismiss-open' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Dismiss \d/ })).toBeNull();
  });
});

describe('confirming', () => {
  async function confirmPerson(s: Awaited<ReturnType<typeof start>>) {
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 3 reports about Mallory?' });
    await s.user.click(within(dialog).getByRole('button', { name: 'Dismiss 3 reports' }));
  }

  it('holds for 5 seconds with Undo; Undo sends nothing and the case returns with its claim', async () => {
    const s = await start();
    await waitFor(() => expect(s.w.cw.cases.holder(s.mallory[0]!.person)?.by).toBe('ann@example.test'));
    await confirmPerson(s);
    expect(await screen.findByText('Dismissing 3 reports in 5 s.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    await s.user.click(within(screen.getByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Undo' }));
    await pageHides();
    expect(real(s.w)).toHaveLength(0);
    await waitFor(() => expect(s.router.path).toBe(`/reports/${s.mallory[2]!.id}`));
    await waitFor(() => expect(s.w.cw.cases.holder(s.mallory[0]!.person)?.by).toBe('ann@example.test'));
    for (const r of s.mallory) expect(s.w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('after the hold exactly one POST /reports/dismiss-open is sent with scope and ref, and no reason', async () => {
    const s = await start();
    await confirmPerson(s);
    await pageHides();
    await waitFor(() => expect(real(s.w)).toHaveLength(1));
    expect(real(s.w)[0]!.body).toEqual({ scope: 'person', ref: s.mallory[0]!.person });
    expect(JSON.stringify(real(s.w)[0]!.body)).not.toContain('reason');
    await pageHides();
    expect(real(s.w)).toHaveLength(1);
    for (const r of s.mallory) expect(s.w.cw.reports.get(r.id)?.status).toBe('dismissed');
    expect(s.w.cw.reports.get(s.beta.id)?.status).toBe('open');
    expect(await screen.findByText('Dismissed 3 reports.')).toBeInTheDocument();
  });

  it('person scope: the case leaves the queue at once and the next case opens', async () => {
    const s = await start();
    expect(within(screen.getByRole('region', { name: 'Open cases' })).getByText('Mallory')).toBeInTheDocument();
    await confirmPerson(s);
    await waitFor(() => expect(s.router.path).toBe(`/reports/${s.beta.id}`));
    expect(within(screen.getByRole('region', { name: 'Open cases' })).queryByText('Mallory')).toBeNull();
    expect(real(s.w)).toHaveLength(0);
  });

  it('reporter scope: nothing leaves the queue until the sweep is sent', async () => {
    const s = await start();
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 2 reports from Rita?' });
    await s.user.click(within(dialog).getByRole('button', { name: 'Dismiss 2 reports' }));
    expect(await screen.findByText('Dismissing 2 reports in 5 s.')).toBeInTheDocument();
    const queue = within(screen.getByRole('region', { name: 'Open cases' }));
    expect(queue.getByText('Mallory')).toBeInTheDocument();
    expect(queue.getByText('Beta')).toBeInTheDocument();
    await pageHides();
    await waitFor(() => expect(real(s.w)).toHaveLength(1));
    expect(real(s.w)[0]!.body).toEqual({ scope: 'reporter', ref: s.mallory[s.mallory.length - 1]!.reporter });
    await waitFor(() => expect(queue.queryByText('Beta')).toBeNull());
    expect(s.w.cw.reports.get(s.mallory[2]!.id)?.status).toBe('dismissed');
    expect(s.w.cw.reports.get(s.mallory[1]!.id)?.status).toBe('open');
    expect(s.w.cw.reports.get(s.mallory[0]!.id)?.status).toBe('open');
  });

  it('the page hiding during the hold sends it at once', async () => {
    const s = await start();
    await confirmPerson(s);
    expect(real(s.w)).toHaveLength(0);
    await pageHides();
    await waitFor(() => expect(real(s.w)).toHaveLength(1));
    expect(real(s.w)[0]).toMatchObject({ keepalive: true });
  });

  it('works from Simple, inside Something else, the same way', async () => {
    const s = await start({ mode: 'simple' });
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 3 reports about Mallory?' });
    await s.user.click(within(dialog).getByRole('button', { name: 'Dismiss 3 reports' }));
    await pageHides();
    await waitFor(() => expect(real(s.w)).toHaveLength(1));
  });
});

describe('cases held by another moderator', () => {
  it('reporter scope: the window says how many stay open, and the result repeats it', async () => {
    const s = await start();
    await s.w.clientFor('maya@example.test', 'moderator').claimCase(s.beta.person);
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 1 report from Rita?' });
    expect(within(dialog).getByText('1 is held by another moderator and stays open.')).toBeInTheDocument();
    await s.user.click(within(dialog).getByRole('button', { name: 'Dismiss 1 report' }));
    await pageHides();
    expect(await screen.findByText('Dismissed 1 report.')).toBeInTheDocument();
    expect(await screen.findByText('1 stays open: another moderator is handling it.')).toBeInTheDocument();
    expect(s.w.cw.reports.get(s.beta.id)?.status).toBe('open');
  });

  it('person scope held by someone else is never read as "nothing to do": the window says who holds it', async () => {
    const s = await start({ options: { role: 'moderator' } });
    // Maya takes the case over from Ann (a senior may), so Ann's own case is now someone else's.
    await s.w.clientFor('maya@example.test', 'senior').claimCase(s.mallory[0]!.person, { takeOver: true });
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: /^Dismiss all 3 open reports about Mallory/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/maya is handling this case/)).toBeInTheDocument();
    expect(within(dialog).queryByText('There are no open reports to dismiss.')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Dismiss \d+ reports?$/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Take over/ })).toBeNull();
    await pageHides();
    expect(real(s.w)).toHaveLength(0);
  });

  it('a senior sees Take over and dismiss, and the call is made with takeOver true', async () => {
    const s = await start({ options: { role: 'senior', actor: 'sen@example.test' }, before: (w, m) => w.clientFor('maya@example.test', 'moderator').claimCase(m[0]!.person) });
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: /^Dismiss all 3 open reports about Mallory/ }));
    const dialog = await screen.findByRole('dialog');
    await s.user.click(await within(dialog).findByRole('button', { name: 'Take over and dismiss 3 reports' }));
    await pageHides();
    await waitFor(() => expect(real(s.w)).toHaveLength(1));
    expect(real(s.w)[0]!.body).toEqual({ scope: 'person', ref: s.mallory[0]!.person, takeOver: true });
    for (const r of s.mallory) expect(s.w.cw.reports.get(r.id)?.status).toBe('dismissed');
    expect(s.w.cw.audit.list({ limit: 50 }).items.some((x) => x.action === 'case.takeover')).toBe(true);
  });
});

describe('no key starts or confirms a bulk', () => {
  it('Enter and the digits on the page, in the closed disclosure and in the window, send nothing', async () => {
    const s = await start({ options: { permissions: {} } });
    (document.activeElement as HTMLElement | null)?.blur();
    await s.user.keyboard('{Enter}123');
    expect(previews(s.w)).toHaveLength(0);
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Dismiss 3 reports' });
    await s.user.keyboard('123u');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    // Enter on the focused Cancel is Cancel, never the confirm.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await s.user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await pageHides();
    expect(real(s.w)).toHaveLength(0);
    expect(s.w.sent.filter((r) => isDecide(r))).toHaveLength(0);
  });
});

const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);

describe('the audit trail', () => {
  it('the two sweep actions are labelled in words on the audit screen, not shown as raw names', async () => {
    cleanup();
    const w = await hubWorld({ role: 'owner', actor: 'own@example.test' });
    const a = await w.file({ target: 'Mallory', reporter: 'Rita', room: 'a' });
    await w.file({ target: 'Mallory', reporter: 'Sam', room: 'b' });
    await w.client.dismissOpen({ scope: 'person', ref: a.person });
    const c = await w.file({ target: 'Beta', reporter: 'Rita', room: 'c' });
    await w.client.dismissOpen({ scope: 'reporter', ref: c.reporter });
    renderHub(w, { path: '/audit' });
    expect(await screen.findAllByText('Dismissed all open reports about a person')).not.toHaveLength(0);
    expect(screen.getAllByText('Dismissed all open reports from a reporter').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('report.dismiss_case');
    expect(document.body.textContent).not.toContain('report.dismiss_reporter');
  });
});

describe.each(['light', 'dark'] as const)('axe on the bulk dismissal, %s theme', (theme) => {
  const found = async (container: HTMLElement): Promise<string[]> => {
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
  };

  it.each(['simple', 'detailed'] as const)('the disclosure open and the confirm window, in %s', async (mode) => {
    const s = await start({ mode, props: { theme } });
    await open(s.user);
    expect(await found(s.container)).toEqual([]);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all 3 open reports about Mallory' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 3 reports about Mallory?' });
    expect(await found(s.container)).toEqual([]);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('the window while counting, and with nothing to dismiss', async () => {
    const s = await start({ about: 1, props: { theme } });
    await open(s.user);
    await s.user.click(within(disclosure()).getByRole('button', { name: 'Dismiss all open reports from Rita' }));
    const dialog = await screen.findByRole('dialog');
    expect(await found(s.container)).toEqual([]);
    await within(dialog).findByRole('button', { name: 'Cancel' });
  });
});
