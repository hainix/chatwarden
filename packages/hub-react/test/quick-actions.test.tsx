import axe from 'axe-core';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUICK_ACT_COOLDOWN_MS } from '../src/case/useQuickActions.js';
import { UNDO_MS } from '../src/toasts.js';
import type { TransportRequest } from '../src/transport.js';
import { advanceGuardTime } from './guardTime.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine, WorldOptions } from './world.js';

// One-click dismissal and auto-advance: "Nothing wrong here" sends no reason, every quick action moves on to the next case, and Undo
// still works after the move. Real staff routes; the hub's clock is the world's, so the cooldown is the test's to move.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const KEY = 'chatwarden.hub.quickKeys';

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
/** Lets the cooldown of a case that just appeared pass (the hub reads the world's clock). */
const waitCooldown = (w: HubWorld): void => {
  w.clock.t += QUICK_ACT_COOLDOWN_MS + 1;
};

interface Setup {
  options?: WorldOptions;
  cases?: number;
  mode?: 'simple' | 'detailed';
  quickKeys?: 'on' | 'off';
  props?: Parameters<typeof renderHub>[1];
  /** Do not wait for the buttons (a role that has none). */
  bare?: boolean;
}

/** `cases` people each reported once; the hub opens the first (Alpha), with its decision showing. */
async function start({ options = {}, cases = 2, mode = 'simple', quickKeys, props = {}, bare = false }: Setup = {}) {
  cleanup();
  if (quickKeys !== undefined) window.localStorage.setItem(KEY, quickKeys);
  const w = await hubWorld({ actor: 'ann@example.test', ...options });
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].slice(0, cases);
  const filed = [];
  for (const [i, target] of names.entries()) {
    filed.push(await w.fileRich({ lines: TALK, target, reporter: `Rep${i}`, room: `room-${i}` }));
    w.clock.t += 1000;
  }
  const r = renderHub(w, { path: `/reports/${filed[0]!.id}`, mode, ...props });
  await screen.findByRole('heading', { level: 2, name: /Alpha/ });
  if (!bare) await within(decision()).findByRole('button', { name: mode === 'simple' ? /^No action needed/ : /^Nothing wrong here/ });
  waitCooldown(w);
  return { w, filed, names, ...r };
}

const shownReport = (r: { router: { path: string } }): string => r.router.path;

describe('2 dismisses with no reason', () => {
  it.each(['simple', 'detailed'] as const)('the decide body has no reason key (%s)', async (mode) => {
    const s = await start({ mode, quickKeys: 'on', cases: 1 });
    await s.user.keyboard('2');
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    expect(decides(s.w)[0]!.body).toEqual({ verdict: 'no_action', actions: [] });
    expect(Object.keys(decides(s.w)[0]!.body as object)).not.toContain('reason');
    expect(s.w.cw.reports.get(s.filed[0]!.id)?.status).toBe('dismissed');
    expect(s.w.cw.reports.get(s.filed[0]!.id)?.modNote).toBe('No action needed');
  });

  it('the button sends the same, in both modes', async () => {
    for (const mode of ['simple', 'detailed'] as const) {
      const s = await start({ mode, cases: 1 });
      await s.user.click(within(decision()).getByRole('button', { name: mode === 'simple' ? /^No action needed/ : /^Nothing wrong here/ }));
      await pageHides();
      expect(decides(s.w)[0]!.body).toEqual({ verdict: 'no_action', actions: [] });
      s.unmount();
      document.body.replaceChildren();
    }
  });

  it('the toast says it is dismissing, not sending a decision', async () => {
    const s = await start({ cases: 1 });
    await s.user.keyboard('2');
    expect(await screen.findByText('Dismissing Alpha in 5 s.')).toBeInTheDocument();
  });
});

describe('every quick action moves on to the next case', () => {
  it('1, 2 and 3 each submit, then open the next case', async () => {
    for (const key of ['1', '2', '3']) {
      const s = await start({ cases: 2 });
      await s.user.keyboard(key);
      await waitFor(() => expect(shownReport(s)).not.toBe(`/reports/${s.filed[0]!.id}`));
      await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Bravo' })).toBeInTheDocument());
      expect(decides(s.w)).toHaveLength(0);
      await pageHides();
      expect(decides(s.w)).toHaveLength(1);
      expect(decides(s.w)[0]!.body).toMatchObject({ verdict: key === '2' ? 'no_action' : key === '1' ? 'upheld' : 'upheld' });
      s.unmount();
      document.body.replaceChildren();
    }
  });

  it('the same person\'s next open report comes first, then the next case', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const a1 = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Rep1', room: 'r1' });
    w.clock.t += 1000;
    const a2 = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Rep2', room: 'r2' });
    w.clock.t += 1000;
    await w.fileRich({ lines: TALK, target: 'Bravo', reporter: 'Rep3', room: 'r3' });
    const r = renderHub(w, { path: `/reports/${a2.id}`, mode: 'simple' });
    await screen.findByRole('heading', { level: 2, name: 'Alpha' });
    await within(decision()).findByRole('button', { name: /^No action needed/ });
    waitCooldown(w);
    await r.user.keyboard('2');
    await waitFor(() => expect(r.router.path).toBe(`/reports/${a1.id}`));
    expect(w.sent.some((q) => q.path === '/cases/next')).toBe(false);
  });

  it('with nobody else waiting it opens the team view', async () => {
    const s = await start({ cases: 1 });
    await s.user.keyboard('2');
    await waitFor(() => expect(s.router.path).toBe('/'));
  });

  it('the buttons advance too, not only the keys', async () => {
    const s = await start({ cases: 2 });
    await s.user.click(within(decision()).getByRole('button', { name: /^No action needed/ }));
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    const t = await start({ cases: 2 });
    await t.user.click(within(decision()).getByRole('button', { name: /^Restrict chat, 24 hours/ }));
    await waitFor(() => expect(t.router.path).not.toBe(`/reports/${t.filed[0]!.id}`));
    const u = await start({ cases: 2 });
    await u.user.click(within(decision()).getByRole('button', { name: /^Send a warning/ }));
    await waitFor(() => expect(u.router.path).not.toBe(`/reports/${u.filed[0]!.id}`));
  });

  it('Ctrl+Enter is the same as 1: the suggested step, then the next case', async () => {
    const s = await start({ cases: 2 });
    await s.user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(s.router.path).not.toBe(`/reports/${s.filed[0]!.id}`));
    await pageHides();
    expect(decides(s.w)[0]!.body).toMatchObject({ verdict: 'upheld', actions: [{ kind: 'chat', durationMs: 86_400_000 }] });
  });
});

describe('guards: a key is one action on one case that has been read', () => {
  it('a held key is one action: repeat events are ignored', async () => {
    const s = await start({ cases: 2 });
    const target = document.body;
    fireEvent.keyDown(target, { key: '2', repeat: true });
    fireEvent.keyDown(target, { key: '1', repeat: true });
    fireEvent.keyDown(target, { key: 'Enter', ctrlKey: true, repeat: true });
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
    fireEvent.keyDown(target, { key: '2' });
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });

  it('a second tap within the cooldown of the next case appearing does nothing; after it, it acts', async () => {
    const s = await start({ cases: 3 });
    await s.user.keyboard('2');
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    await within(decision()).findByRole('button', { name: /^No action needed/ });
    // The case appeared a moment ago on the hub's clock: the second tap of a double tap is meant for Alpha.
    s.w.clock.t += QUICK_ACT_COOLDOWN_MS - 1;
    await s.user.keyboard('2');
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    expect(s.w.cw.reports.get(s.filed[1]!.id)?.status).toBe('open');
    s.w.clock.t += 1;
    await s.user.keyboard('2');
    await pageHides();
    expect(decides(s.w)).toHaveLength(2);
    expect(s.w.cw.reports.get(s.filed[1]!.id)?.status).toBe('dismissed');
  });

  it('the cooldown applies to Ctrl+Enter too', async () => {
    const s = await start({ cases: 2 });
    // Back to the moment the case appeared.
    advanceGuardTime(-(QUICK_ACT_COOLDOWN_MS + 1));
    await s.user.keyboard('{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
  });

  it('a key pressed while the next case is still loading does nothing', async () => {
    const s = await start({ cases: 2 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    s.w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === `/reports/${s.filed[1]!.id}`) await gate;
      return undefined;
    };
    await s.user.keyboard('2');
    await waitFor(() => expect(s.router.path).toBe(`/reports/${s.filed[1]!.id}`));
    waitCooldown(s.w);
    await s.user.keyboard('2');
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    expect(s.w.cw.reports.get(s.filed[1]!.id)?.status).toBe('open');
    release();
  });

  it('a decision already waiting for this report is ignored (no double submit)', async () => {
    const s = await start({ cases: 1 });
    const alpha = within(decision()).getByRole('button', { name: /^No action needed/ });
    fireEvent.click(alpha);
    fireEvent.click(alpha);
    fireEvent.keyDown(document.body, { key: '2' });
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });

  it('a case held by another moderator: the keys do nothing', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    await w.clientFor('maya@example.test').claimCase(f.person);
    const r = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByText('maya is on it.');
    w.clock.t += 1000;
    await r.user.keyboard('1');
    await r.user.keyboard('2');
    await r.user.keyboard('3');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('a closed case: the keys do nothing', async () => {
    const s = await start({ cases: 1 });
    await s.w.client.decide(s.filed[0]!.id, { verdict: 'no_action', actions: [] });
    s.unmount();
    document.body.replaceChildren();
    const r = renderHub(s.w, { path: `/reports/${s.filed[0]!.id}`, mode: 'simple' });
    await screen.findByText(/Decided by/);
    s.w.clock.t += 1000;
    await r.user.keyboard('2');
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
  });

  it('a role without reports.decide: the keys do nothing', async () => {
    const s = await start({ options: { permissions: { 'reports.decide': 'senior' } }, cases: 1, mode: 'simple', bare: true });
    await s.user.keyboard('2');
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
  });

  it('typing in the reason box, a note field or a select: digits do nothing (except the rule select, digits only)', async () => {
    const s = await start({ mode: 'detailed', quickKeys: 'on', cases: 2 });
    const reason = within(decision()).getByRole('textbox', { name: /Reason/ });
    reason.focus();
    await s.user.keyboard('12');
    expect(reason).toHaveValue('12');
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
    const select = within(decision()).getAllByRole('combobox')[0] as HTMLElement;
    select.focus();
    fireEvent.keyDown(select, { key: '2' });
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
  });

  it('with Something else open (Simple) the digits select verdicts in the bar, as before', async () => {
    const s = await start({ cases: 2 });
    await s.user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
    waitCooldown(s.w);
    (document.activeElement as HTMLElement | null)?.blur();
    await s.user.keyboard('2');
    expect(within(decision()).getByRole('radio', { name: /Not a problem/ })).toBeChecked();
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
  });
});

describe('Detailed: Quick keys decide whether 1, 2 and 3 act', () => {
  it('Quick keys off: 2 selects Not a problem; Ctrl+Enter then dismisses with no reason typed', async () => {
    const s = await start({ mode: 'detailed', quickKeys: 'off', cases: 2 });
    await s.user.keyboard('2');
    expect(within(decision()).getByRole('radio', { name: /Not a problem/ })).toBeChecked();
    expect(decides(s.w)).toHaveLength(0);
    await s.user.keyboard('{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    expect(decides(s.w)[0]!.body).toEqual({ verdict: 'no_action', actions: [] });
  });

  it('Quick keys off: the Nothing wrong here button dismisses at once', async () => {
    const s = await start({ mode: 'detailed', quickKeys: 'off', cases: 2 });
    await s.user.click(within(decision()).getByRole('button', { name: /^Nothing wrong here/ }));
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    expect(decides(s.w)[0]!.body).toEqual({ verdict: 'no_action', actions: [] });
    await waitFor(() => expect(s.router.path).not.toBe(`/reports/${s.filed[0]!.id}`));
  });

  it('Quick keys on: 1, 2, 3 act and the bar\'s handler is silent (exactly one submit each)', async () => {
    for (const key of ['1', '2', '3']) {
      const s = await start({ mode: 'detailed', quickKeys: 'on', cases: 2 });
      await s.user.keyboard(key);
      await pageHides();
      expect(decides(s.w), key).toHaveLength(1);
      expect(within(decision()).queryByRole('radio', { checked: true }), key).toBeNull();
      s.unmount();
      document.body.replaceChildren();
    }
  });

  it('Ctrl+Enter in Detailed keeps deciding the form the moderator filled in, with Quick keys on too', async () => {
    const s = await start({ mode: 'detailed', quickKeys: 'on', cases: 1 });
    await s.user.click(within(decision()).getByRole('radio', { name: /Fair/ }));
    await s.user.type(within(decision()).getByRole('textbox', { name: /Reason/ }), 'My own words.');
    await s.user.keyboard('{Control>}{Enter}{/Control}');
    await pageHides();
    expect(decides(s.w)).toHaveLength(1);
    expect(decides(s.w)[0]!.body).toMatchObject({ reason: 'My own words.' });
  });

  it('the dismissal verdict hint says the reason is optional', async () => {
    const s = await start({ mode: 'detailed', quickKeys: 'off', cases: 1 });
    expect(within(decision()).queryByText(/Optional for/)).toBeNull();
    await s.user.click(within(decision()).getByRole('radio', { name: /Not a problem/ }));
    expect(within(decision()).getByText(/Optional for "Not a problem"/)).toBeInTheDocument();
  });
});

describe('Undo after the move', () => {
  it('press 2 on A, advance to B, Undo on A\'s toast: A is shown again with its claim, nothing was sent for A', async () => {
    const s = await start({ cases: 2 });
    await s.user.keyboard('2');
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    const toast = within(screen.getByRole('region', { name: 'Notifications' }));
    await s.user.click(toast.getByRole('button', { name: 'Undo' }));
    await screen.findByRole('heading', { level: 2, name: 'Alpha' });
    expect(s.router.path).toBe(`/reports/${s.filed[0]!.id}`);
    expect(decides(s.w)).toHaveLength(0);
    await act(async () => {
      await Promise.resolve();
    });
    expect(s.w.cw.reports.get(s.filed[0]!.id)?.status).toBe('open');
  });

  it('after Undo the button that sent it has focus', async () => {
    const s = await start({ cases: 2 });
    await s.user.keyboard('2');
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    await s.user.click(within(screen.getByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Undo' }));
    const back = await within(decision()).findByRole('button', { name: /^No action needed/ });
    await waitFor(() => expect(back).toHaveFocus());
  });

  it('six quick dismissals in five seconds are all undoable, newest first', async () => {
    const s = await start({ cases: 6 });
    for (let i = 0; i < 5; i += 1) {
      await s.user.keyboard('2');
      await screen.findByRole('heading', { level: 2, name: ['Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'][i] as string });
      s.w.clock.t += QUICK_ACT_COOLDOWN_MS + 1;
    }
    await s.user.keyboard('2');
    expect(decides(s.w)).toHaveLength(0);
    for (let i = 5; i >= 0; i -= 1) {
      const undo = within(screen.getByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Undo' });
      await s.user.click(undo);
      await screen.findByRole('heading', { level: 2, name: s.names[i] as string });
    }
    await pageHides();
    expect(decides(s.w)).toHaveLength(0);
    expect(s.w.cw.reports.get(s.filed[0]!.id)?.status).toBe('open');
  });

  it('a send that fails after the move shows the "not sent" toast with a way back', async () => {
    const s = await start({ cases: 2 });
    s.w.intercept.fn = (req) => (isDecide(req) ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await s.user.keyboard('2');
    await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    const alert = await screen.findByText(/was not sent\. The case is back/);
    expect(alert).toBeInTheDocument();
    await s.user.click(screen.getByRole('button', { name: 'Open the case' }));
    await screen.findByRole('heading', { level: 2, name: 'Alpha' });
  });

  it('the hold lasts the Undo window', async () => {
    expect(UNDO_MS).toBe(5_000);
  });
});

describe('focus', () => {
  it('after the move the new case\'s title has focus', async () => {
    const s = await start({ cases: 2 });
    await s.user.keyboard('2');
    const title = await screen.findByRole('heading', { level: 2, name: 'Bravo' });
    await waitFor(() => expect(title).toHaveFocus());
  });
});

describe('a11y of the new controls', () => {
  it('the Nothing wrong here button has a name and a description, and aria-keyshortcuts only with Quick keys on and shortcuts on', async () => {
    const on = await start({ mode: 'detailed', quickKeys: 'on', cases: 1 });
    const button = within(decision()).getByRole('button', { name: 'Nothing wrong here' });
    expect(button).toHaveAccessibleDescription('Closes the report with no action. Nobody is told and nobody is marked.');
    expect(button).toHaveAttribute('aria-keyshortcuts', '2');
    on.unmount();
    document.body.replaceChildren();
    const off = await start({ mode: 'detailed', quickKeys: 'off', cases: 1 });
    expect(within(decision()).getByRole('button', { name: 'Nothing wrong here' })).not.toHaveAttribute('aria-keyshortcuts');
    off.unmount();
    document.body.replaceChildren();
    const none = await start({ mode: 'detailed', quickKeys: 'on', cases: 1, props: { shortcuts: false } });
    expect(within(decision()).getByRole('button', { name: 'Nothing wrong here' })).not.toHaveAttribute('aria-keyshortcuts');
    await none.user.keyboard('2');
    await pageHides();
    expect(decides(none.w)).toHaveLength(0);
  });
});

describe.each(['light', 'dark'] as const)('axe on the new controls, %s theme', (theme) => {
  const RULES = { 'color-contrast': { enabled: false } } as const;
  const found = async (container: HTMLElement): Promise<string[]> => {
    const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
    return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.impact}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
  };

  it('the Detailed bar with Nothing wrong here, Quick keys on and off', async () => {
    for (const quickKeys of ['off', 'on'] as const) {
      const s = await start({ mode: 'detailed', quickKeys, cases: 1, props: { theme } });
      expect(await found(s.container)).toEqual([]);
    }
  });

  it('the toast stack with several held decisions and the "earlier decisions waiting" line', async () => {
    const s = await start({ cases: 4, props: { theme } });
    for (const name of ['Bravo', 'Charlie', 'Delta']) {
      await s.user.keyboard('2');
      await screen.findByRole('heading', { level: 2, name });
      s.w.clock.t += QUICK_ACT_COOLDOWN_MS + 1;
    }
    expect(await screen.findByText('2 earlier decisions waiting.')).toBeInTheDocument();
    expect(await found(s.container)).toEqual([]);
  });
});
