import { act, fireEvent, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import type { TransportRequest } from '../src/transport.js';
import { focusedIn, hubInShadow, removeShadowHosts, shadowRootIn } from './shadow.js';
import { stayingRouter } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// The hub drawn inside a shadow root, the way <chatwarden-hub> draws it and the way an adopter might put <Hub> in a web component of
// their own. In a shadow root `document.activeElement` is the host and `document.getElementById` finds nothing, so every one of
// these used to be wrong. Against the real routes.

afterEach(removeShadowHosts);

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const pageHides = (): void => {
  window.dispatchEvent(new Event('pagehide'));
};

type Shown = ReturnType<typeof hubInShadow>;
const rows = (s: Shown): HTMLElement[] => [...s.container.querySelectorAll<HTMLElement>('.cw-queue .cw-case-link')];
const rowName = (el: Element | null): string => el?.querySelector('.cw-case-name')?.textContent ?? '';
const onRow = (s: Shown): boolean => rows(s).some((r) => r === focusedIn(s.shadow));

async function queueReady(s: Shown, count: number): Promise<void> {
  await waitFor(() => expect(rows(s)).toHaveLength(count));
}

/** Puts focus on a control inside the hub, as a click or Tab into it would. */
const focusIn = (s: Shown): HTMLElement => {
  const skip = s.container.querySelector<HTMLElement>('.cw-skip') as HTMLElement;
  skip.focus();
  return skip;
};

async function threeCases(options: Parameters<typeof hubWorld>[0] = { actor: 'ann@example.test' }) {
  const w = await hubWorld(options);
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    await w.file({ target: name });
    w.clock.t += 1000;
  }
  return w;
}

describe('J and K in a shadow root', () => {
  it('J goes down the queue and K up it, with focus inside the shadow root', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('j');
    expect(rowName(focusedIn(s.shadow))).toBe('Alpha');
    await s.user.keyboard('jj');
    expect(rowName(focusedIn(s.shadow))).toBe('Charlie');
    await s.user.keyboard('j');
    expect(rowName(focusedIn(s.shadow))).toBe('Charlie');
    await s.user.keyboard('k');
    expect(rowName(focusedIn(s.shadow))).toBe('Bravo');
  });

  it("moves from the row that has focus, not from the first one (the shadow root's own focus is read)", async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    rows(s)[1]?.focus();
    await s.user.keyboard('j');
    expect(rowName(focusedIn(s.shadow))).toBe('Charlie');
    await s.user.keyboard('kk');
    expect(rowName(focusedIn(s.shadow))).toBe('Alpha');
  });

  it('Escape with no window open goes back to the queue', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('{Escape}');
    expect(rowName(focusedIn(s.shadow))).toBe('Alpha');
  });

  it('a key typed in a field in the hub is a character, not a shortcut', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('{Control>}k{/Control}');
    const input = await s.q.findByRole('combobox', { name: 'Search people, reports, terms or screens' });
    await s.user.keyboard('jk?');
    expect(input).toHaveValue('jk?');
    expect(s.q.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    expect(onRow(s)).toBe(false);
  });
});

describe('the shortcut sheet and the command bar in a shadow root', () => {
  it('? opens the sheet; Escape closes it and focus goes back to where it was', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    const before = focusIn(s);
    await s.user.keyboard('?');
    const sheet = await s.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(sheet.contains(focusedIn(s.shadow))).toBe(true);
    await s.user.keyboard('{Escape}');
    expect(s.q.queryByRole('dialog')).toBeNull();
    expect(focusedIn(s.shadow)).toBe(before);
  });

  it('Tab inside a window stays inside it, both ways', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('{Control>}k{/Control}');
    const bar = await s.q.findByRole('dialog', { name: 'Command bar' });
    const items = [...bar.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    expect(items.length).toBeGreaterThan(0);
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    last.focus();
    await s.user.keyboard('{Tab}');
    expect(focusedIn(s.shadow)).toBe(first);
    await s.user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(focusedIn(s.shadow)).toBe(last);
    expect(bar.contains(focusedIn(s.shadow))).toBe(true);
  });

  it('Ctrl+K opens the command bar with the search box focused; picking a screen goes there; Escape returns focus', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'ann@example.test' });
    await w.file({ target: 'Alpha' });
    const s = hubInShadow(w);
    await waitFor(() => expect(rows(s)).toHaveLength(1));
    const before = focusIn(s);
    await s.user.keyboard('{Control>}k{/Control}');
    const input = await s.q.findByRole('combobox', { name: 'Search people, reports, terms or screens' });
    expect(focusedIn(s.shadow)).toBe(input);
    await s.user.keyboard('{Escape}');
    expect(s.q.queryByRole('dialog')).toBeNull();
    expect(focusedIn(s.shadow)).toBe(before);
    await s.user.keyboard('{Control>}k{/Control}');
    await s.q.findByRole('combobox', { name: 'Search people, reports, terms or screens' });
    await s.user.click(s.q.getByRole('option', { name: /Rule gaps/ }));
    expect(s.q.queryByRole('dialog')).toBeNull();
    expect(s.router.path).toBe('/gaps');
  });

  it('Meta+K opens it too', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('{Meta>}k{/Meta}');
    await s.q.findByRole('dialog', { name: 'Command bar' });
  });

  it('N takes the next case from inside the shadow root', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('n');
    await waitFor(() => expect(w.sent.filter((r) => r.path === '/cases/next')).toHaveLength(1));
  });

  it('shortcuts={false} turns every one of them off', async () => {
    const w = await threeCases();
    const s = hubInShadow(w, { shortcuts: false });
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('j?n');
    await s.user.keyboard('{Control>}k{/Control}');
    expect(s.q.queryByRole('dialog')).toBeNull();
    expect(onRow(s)).toBe(false);
    expect(w.sent.some((r) => r.path === '/cases/next')).toBe(false);
  });
});

describe('the keys belong to the hub that has focus', () => {
  it('a key pressed on the page outside the hub is not taken', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    await s.user.keyboard('j?n');
    expect(s.q.queryByRole('dialog')).toBeNull();
    expect(onRow(s)).toBe(false);
    expect(w.sent.some((r) => r.path === '/cases/next')).toBe(false);
    outside.remove();
  });

  it("a key pressed in the adopter's own control inside the same shadow root, outside the hub, is not taken", async () => {
    const w = await threeCases();
    const shadow = shadowRootIn();
    const mine = document.createElement('button');
    shadow.append(mine);
    const s = hubInShadow(w, { shadow });
    await queueReady(s, 3);
    mine.focus();
    await s.user.keyboard('j?');
    expect(s.q.queryByRole('dialog')).toBeNull();
    expect(onRow(s)).toBe(false);
  });

  it('a key pressed with focus in the hub is not also handled by a listener on the page', async () => {
    const w = await threeCases();
    const s = hubInShadow(w);
    await queueReady(s, 3);
    focusIn(s);
    const seen: string[] = [];
    // Nothing of the hub listens on the document: a bubbling key press that reaches it was not stopped by the hub, and the hub
    // acted from its own root, before it got there.
    const spy = (e: KeyboardEvent): void => void seen.push(`${e.key}:${e.defaultPrevented}`);
    document.addEventListener('keydown', spy);
    await s.user.keyboard('?');
    document.removeEventListener('keydown', spy);
    expect(seen).toEqual(['?:true']);
  });
});

describe('the decision keys in a shadow root', () => {
  it('1 and 2 choose a verdict in the detailed bar', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const s = hubInShadow(w, { path: `/reports/${f.id}` });
    const decision = await s.q.findByRole('region', { name: 'Decision' });
    await within(decision).findByRole('radio', { name: 'Fair' });
    focusIn(s);
    await s.user.keyboard('1');
    expect(within(decision).getByRole('radio', { name: 'Fair' })).toBeChecked();
    await s.user.keyboard('2');
    expect(within(decision).getByRole('radio', { name: 'Fair' })).not.toBeChecked();
  });

  it('with the shortcut sheet open the verdict keys wait', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const s = hubInShadow(w, { path: `/reports/${f.id}` });
    const decision = await s.q.findByRole('region', { name: 'Decision' });
    await within(decision).findByRole('radio', { name: 'Fair' });
    focusIn(s);
    await s.user.keyboard('?');
    await s.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await s.user.keyboard('1');
    expect(within(decision).getByRole('radio', { name: 'Fair' })).not.toBeChecked();
  });

  it('a problem in the list takes you to its field, which is in the shadow root', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const s = hubInShadow(w, { path: `/reports/${f.id}` });
    const decision = await s.q.findByRole('region', { name: 'Decision' });
    await within(decision).findByRole('radio', { name: 'Fair' });
    await s.user.click(within(decision).getByRole('button', { name: 'Decide' }));
    const summary = await within(decision).findByRole('alert');
    const first = within(summary).getAllByRole('button')[0] as HTMLElement;
    await s.user.click(first);
    expect(decision.contains(focusedIn(s.shadow))).toBe(true);
    expect(focusedIn(s.shadow)).not.toBe(first);
  });

  it('in Simple mode 2 sends the no-action decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const s = hubInShadow(w, { mode: 'simple', router: stayingRouter(`/reports/${f.id}`) });
    await s.q.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    w.clock.t += 1000;
    focusIn(s);
    await s.user.keyboard('2');
    expect(await s.q.findByText('Decision queued.')).toBeInTheDocument();
    pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.body).toMatchObject({ verdict: 'no_action' });
  });

  it('in Simple mode a key does nothing while a window is open', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const s = hubInShadow(w, { mode: 'simple', path: `/reports/${f.id}` });
    await s.q.findByRole('button', { name: /^Restrict chat, 24 hours/ });
    focusIn(s);
    await s.user.keyboard('{Control>}k{/Control}');
    await s.q.findByRole('dialog', { name: 'Command bar' });
    await s.user.type(s.q.getByRole('combobox', { name: 'Search people, reports, terms or screens' }), '12');
    await s.user.keyboard('{Control>}{Enter}{/Control}');
    pageHides();
    expect(decides(w)).toHaveLength(0);
  });
});

describe('the Simple menu in a shadow root', () => {
  async function menu() {
    const w = await hubWorld({ role: 'owner', actor: 'ann@example.test' });
    await w.file({ target: 'Alpha' });
    const s = hubInShadow(w, { mode: 'simple' });
    const nav = await s.q.findByRole('navigation', { name: 'Moderator hub sections' });
    const more = within(nav).getByRole('button', { name: /More/ });
    await s.user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    return { s, more };
  }

  it('survives a press inside itself (the page sees the host, the menu must not count that as away)', async () => {
    const { more } = await menu();
    await act(async () => {
      more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(more).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on a press outside the hub', async () => {
    const { more } = await menu();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'false'));
  });

  it('closes on a press elsewhere inside the hub', async () => {
    const { s, more } = await menu();
    (s.container.querySelector('.cw-body') as HTMLElement).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'false'));
  });
});

describe('focus put on a field by id, in a shadow root', () => {
  it('an empty sanction form puts focus on its first field with a problem', async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory' });
    const s = hubInShadow(w, { path: `/people/${f.person}` });
    await s.q.findByRole('region', { name: 'Timeline' });
    await s.user.click(await s.q.findByRole('button', { name: 'Sanction' }));
    await s.user.click(s.q.getByRole('button', { name: 'Apply' }));
    const what = s.q.getByLabelText('What happens');
    expect(what).toHaveAttribute('aria-invalid', 'true');
    expect(focusedIn(s.shadow)).toBe(what);
  });

  it('Reset reporting, once done, puts focus back on its button', async () => {
    const w = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    expect(w.cw.policy.save({ reporting: { flow: 'reason_required', thanks: 'Thanks!' } }, { version: 0, actor: 'owen@example.test', reason: 'set up' }).ok).toBe(true);
    const s = hubInShadow(w, { path: '/settings/reporting' });
    await s.q.findByRole('list', { name: 'Reasons' });
    await s.user.click(s.q.getByRole('button', { name: 'Reset reporting' }));
    const confirm = s.q.getByRole('group', { name: 'Reset reporting?' });
    // (Seen with this controlled textarea only: user-event's typed text reached the DOM but React's onChange did not run, and the field
    // cleared on the next render. The tests above that type into the command bar read the DOM value, which would not show it.)
    fireEvent.change(within(confirm).getByRole('textbox', { name: /Why are you resetting this/ }), { target: { value: 'Back to the default' } });
    await s.user.click(within(confirm).getByRole('button', { name: 'Reset' }));
    await s.q.findByText('Reset the reporting settings.');
    await waitFor(() => expect(focusedIn(s.shadow)).toBe(s.q.getByRole('button', { name: 'Reset reporting' })));
  });
});

describe('a shadow root inside another shadow root', () => {
  it('the nearest root answers: keys, focus and windows', async () => {
    const w = await threeCases();
    const outer = shadowRootIn();
    const host = document.createElement('div');
    outer.append(host);
    const inner = host.attachShadow({ mode: 'open' });
    const s = hubInShadow(w, { shadow: inner });
    await queueReady(s, 3);
    focusIn(s);
    await s.user.keyboard('j');
    expect(rowName(inner.activeElement)).toBe('Alpha');
    // The outer root and the page see only the host that holds the focus.
    expect(outer.activeElement).toBe(host);
    await s.user.keyboard('?');
    await s.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await s.user.keyboard('{Escape}');
    expect(s.q.queryByRole('dialog')).toBeNull();
    expect(rowName(inner.activeElement)).toBe('Alpha');
  });
});

describe.each(['light', 'dark'] as const)('axe in a shadow root, %s theme', (theme) => {
  const RULES = { 'color-contrast': { enabled: false } } as const;
  async function violations(el: HTMLElement): Promise<string[]> {
    const result = await axe.run(el, { rules: RULES, resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
  }

  it('the workbench, with the command bar open, has no violations', async () => {
    const w = await threeCases({ role: 'senior', actor: 'ann@example.test' });
    const s = hubInShadow(w, { theme });
    await queueReady(s, 3);
    expect(await violations(s.container)).toEqual([]);
    focusIn(s);
    await s.user.keyboard('{Control>}k{/Control}');
    await s.q.findByRole('dialog', { name: 'Command bar' });
    expect(await violations(s.container)).toEqual([]);
  });

  it('an open case has no violations', async () => {
    const w = await hubWorld({ role: 'senior', actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: TALK });
    const s = hubInShadow(w, { theme, path: `/reports/${f.id}` });
    await within(await s.q.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
    expect(await violations(s.container)).toEqual([]);
  });
});
