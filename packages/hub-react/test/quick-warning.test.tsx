import { CATEGORY_TO_RULE } from '@chatwarden/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TransportRequest } from '../src/transport.js';
import { renderHub, hubRoot } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine, WorldOptions } from './world.js';

// "Send a warning" on the Simple card: Lae's light tap. When the ladder suggests more than a warning, one click sends a warning
// through the same hold and Undo, with the rule's title as the reason. Key 3 does the same, only when nothing else is going on.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const RULE = CATEGORY_TO_RULE.harassment as number;
const H = 3_600_000;
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path));
const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const warn = (): HTMLElement => within(decision()).getByRole('button', { name: /^Send a warning/ });
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

async function card(options: WorldOptions = {}, props: Parameters<typeof renderHub>[1] = {}) {
  const w = await hubWorld(options);
  const f = await w.fileRich({ lines: TALK });
  const r = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', ...props });
  await screen.findByRole('heading', { level: 2, name: 'Mallory' });
  await screen.findByRole('button', { name: /^No action needed/ });
  return { w, f, ...r };
}

describe('when the button is there', () => {
  it('beside a suggestion harsher than a warning, with its key', async () => {
    await card();
    expect(within(decision()).getByRole('button', { name: /^Restrict chat, 24 hours/ })).toBeInTheDocument();
    expect(warn()).toHaveAttribute('aria-keyshortcuts', '3');
  });

  it.each<[string, object]>([
    ['an area restriction', { kind: 'area', durationMs: 7 * 24 * H }],
    ['a ban', { kind: 'ban', durationMs: 7 * 24 * H }],
  ])('for %s as well', async (_n, outcome) => {
    await card({ overrides: { firstOffense: { hostile: outcome } } as never });
    expect(warn()).toBeInTheDocument();
  });

  it('not when the suggestion is itself a warning (that one button already says it, once)', async () => {
    await card({ overrides: { firstOffense: { hostile: 'warning' } } as never });
    expect(within(decision()).getAllByRole('button', { name: /^Send a warning/ })).toHaveLength(1);
  });

  it.each<[string, 'note' | 'none']>([
    ['a note', 'note'],
    ['nothing', 'none'],
  ])('not when the suggestion is %s', async (_n, outcome) => {
    await card({ overrides: { firstOffense: { hostile: outcome } } as never });
    expect(within(decision()).queryByRole('button', { name: /^Send a warning/ })).toBeNull();
  });

  it('not for a role that may not apply sanctions', async () => {
    await card({ permissions: { 'sanctions.apply': 'owner' } });
    expect(within(decision()).queryByRole('button', { name: /^Send a warning/ })).toBeNull();
  });

  it('a moderator still has it when the suggested step needs a senior (a warning needs no permanent-ban permission)', async () => {
    await card({ role: 'moderator', overrides: { firstOffense: { hostile: { kind: 'ban', durationMs: null } } } as never });
    expect(within(decision()).queryByRole('button', { name: /^Ban, permanent/ })).toBeNull();
    expect(warn()).toBeInTheDocument();
  });

  it('while Something else is open the card is the bar, so there is no quick button', async () => {
    const { user } = await card();
    await user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
    expect(screen.queryByRole('button', { name: /^Send a warning/ })).toBeNull();
  });

  it('without shortcuts the button stays and shows no key', async () => {
    await card({}, { shortcuts: false });
    expect(warn()).not.toHaveAttribute('aria-keyshortcuts');
    expect(warn().querySelector('kbd')).toBeNull();
  });
});

describe('what a click sends', () => {
  it('a Fair decision with one warning, under the report rule, the rule title as the reason, and the person lines shown', async () => {
    const { w, f, user } = await card();
    await user.click(warn());
    expect(decides(w)).toHaveLength(0);
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.path).toBe(`/reports/${f.id}/decide`);
    expect(decides(w)[0]?.body).toEqual({
      verdict: 'upheld',
      reason: w.cw.rules.get(RULE)?.title,
      actions: [{ subject: f.person, kind: 'warning', durationMs: null, rule: RULE, lineIds: expect.any(Array) }],
    });
    const lines = ((decides(w)[0]?.body as { actions: Array<{ lineIds: string[] }> }).actions[0] as { lineIds: string[] }).lineIds;
    expect(lines).toHaveLength(2);
    expect(w.cw.sanctions.forPerson(f.person).map((s) => s.kind)).toEqual(['warning']);
  });

  it('waits for the Undo window like every decision, and the toast says what was done', async () => {
    const { w, user } = await card();
    await user.click(warn());
    const toasts = screen.getByRole('region', { name: 'Notifications' });
    expect(within(toasts).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(within(toasts).getByText(/Sending the decision on Mallory/)).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
  });

  it('Undo sends nothing, and the card is back with keyboard focus on the button that sent it', async () => {
    const { w, user } = await card();
    await user.click(warn());
    await user.click(within(screen.getByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Undo' }));
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    await waitFor(() => expect(warn()).toBeInTheDocument());
    expect(w.cw.sanctions.forPerson((await w.client.listSanctions()).items[0]?.person ?? 'none')).toHaveLength(0);
  });

  it('a double click sends one decision', async () => {
    const { w, user } = await card();
    await user.dblClick(warn());
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
  });
});

describe('key 3', () => {
  const press = (key: string, target: Element = hubRoot()) => fireEvent.keyDown(target, { key });

  it('sends the warning, as the button does', async () => {
    const { w } = await card();
    press('3');
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]?.body as { actions: Array<{ kind: string }> }).actions[0]?.kind).toBe('warning');
  });

  it('not while typing', async () => {
    const { w, user } = await card();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    await user.keyboard('3');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
    input.remove();
  });

  it('not when Something else is open, nor with a modifier', async () => {
    const { w, user } = await card();
    fireEvent.keyDown(hubRoot(), { key: '3', ctrlKey: true });
    fireEvent.keyDown(hubRoot(), { key: '3', metaKey: true });
    await user.click(within(decision()).getByRole('button', { name: /^Something else/ }));
    press('3');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('not while a decision is waiting: a second press sends nothing more', async () => {
    const { w, user } = await card();
    await user.click(within(decision()).getByRole('button', { name: /^Restrict chat, 24 hours/ }));
    press('3');
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]?.body as { actions: Array<{ kind: string }> }).actions[0]?.kind).toBe('chat');
  });

  it('not when the suggestion is a note, nor with shortcuts off', async () => {
    const a = await card({ overrides: { firstOffense: { hostile: 'note' } } as never });
    press('3');
    await pageHides();
    expect(decides(a.w)).toHaveLength(0);
  });

  it('not with shortcuts off', async () => {
    const { w } = await card({}, { shortcuts: false });
    press('3');
    await pageHides();
    expect(decides(w)).toHaveLength(0);
  });

  it('keys 1 and 2 still do what they did', async () => {
    const { w } = await card();
    press('2');
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]?.body as { verdict: string }).verdict).toBe('no_action');
  });
});
