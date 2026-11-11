import { waitFor } from '@testing-library/dom';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { defineChatwardenHub } from '../src/index.js';
import type { ChatwardenHubElement } from '../src/index.js';
import { hubShown, inside, mount } from './helpers.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Each hub hears only its own keys. This replaces what Task 7e recorded when hub-react looked at the page's `document` (a key in one
// hub reached the first hub with shortcuts on): hub-react now listens on the hub's own root, so two elements on a page, an element
// with shortcuts off beside one with them on, and an element inside another component's shadow root all behave as one hub does alone.

afterEach(() => {
  document.body.replaceChildren();
});

const skip = (el: Element): HTMLElement => el.shadowRoot?.querySelector<HTMLElement>('.cw-skip') as HTMLElement;
const rows = (el: Element): HTMLElement[] => [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.cw-queue .cw-case-link') ?? [])];
const name = (el: Element | null | undefined): string => el?.querySelector('.cw-case-name')?.textContent ?? '';
const dialogs = (el: Element): number => el.shadowRoot?.querySelectorAll('[role="dialog"]').length ?? 0;

async function filed(): Promise<HubWorld> {
  const w = await hubWorld({ actor: 'ann@example.test' });
  for (const target of ['Alpha', 'Bravo', 'Charlie']) {
    await w.fileRich({ target, reporter: `R-${target}`, room: target });
    w.clock.t += 1000;
  }
  return w;
}

async function ready(el: ChatwardenHubElement): Promise<void> {
  await hubShown(el);
  await waitFor(() => expect(rows(el)).toHaveLength(3), { timeout: 5000 });
}

const detailed = { mode: 'detailed', router: 'memory' };

describe('two hubs on one page', () => {
  it('? pressed in one opens the shortcut sheet in that hub only, whichever is first', async () => {
    const w = await filed();
    const a = mount(detailed, { client: w.client });
    const b = mount(detailed, { client: w.client });
    await ready(a);
    await ready(b);
    const user = userEvent.setup();
    skip(b).focus();
    await user.keyboard('?');
    await inside(b).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(a)).toBe(0);
    expect(dialogs(b)).toBe(1);
    await user.keyboard('{Escape}');
    skip(a).focus();
    await user.keyboard('?');
    await inside(a).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(b)).toBe(0);
  });

  it('J moves the queue of the hub that has focus and not the other', async () => {
    const w = await filed();
    const a = mount(detailed, { client: w.client });
    const b = mount(detailed, { client: w.client });
    await ready(a);
    await ready(b);
    const user = userEvent.setup();
    skip(a).focus();
    await user.keyboard('jj');
    expect(name(a.shadowRoot?.activeElement)).toBe('Bravo');
    expect(b.shadowRoot?.activeElement).toBeNull();
    skip(b).focus();
    await user.keyboard('j');
    expect(name(b.shadowRoot?.activeElement)).toBe('Alpha');
    // A kept its own place: the page has one focus, and it left A when B took it.
    expect(a.shadowRoot?.activeElement).toBeNull();
  });

  it('shortcuts="false" turns one hub\'s keys off and does not hand them to the other', async () => {
    const w = await filed();
    const quiet = mount({ ...detailed, shortcuts: 'false' }, { client: w.client });
    const loud = mount(detailed, { client: w.client });
    await ready(quiet);
    await ready(loud);
    const user = userEvent.setup();
    skip(quiet).focus();
    await user.keyboard('?j');
    await user.keyboard('{Control>}k{/Control}');
    expect(dialogs(quiet)).toBe(0);
    expect(dialogs(loud)).toBe(0);
    expect(rows(loud).some((r) => r === loud.shadowRoot?.activeElement)).toBe(false);
    // The loud one still answers its own.
    skip(loud).focus();
    await user.keyboard('?');
    await inside(loud).findByRole('dialog', { name: 'Keyboard shortcuts' });
  });

  it('Ctrl+K opens the command bar of one hub; the other stays as it was', async () => {
    const w = await filed();
    const a = mount(detailed, { client: w.client });
    const b = mount(detailed, { client: w.client });
    await ready(a);
    await ready(b);
    const user = userEvent.setup();
    skip(a).focus();
    await user.keyboard('{Control>}k{/Control}');
    await inside(a).findByRole('dialog', { name: 'Command bar' });
    expect(dialogs(b)).toBe(0);
    await user.keyboard('{Escape}');
    expect(dialogs(a)).toBe(0);
    expect(a.shadowRoot?.activeElement).toBe(skip(a));
  });

  it('a key on the page outside both hubs is taken by neither', async () => {
    const w = await filed();
    const a = mount(detailed, { client: w.client });
    const b = mount(detailed, { client: w.client });
    await ready(a);
    await ready(b);
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    await userEvent.setup().keyboard('?jn');
    await new Promise((r) => setTimeout(r, 30));
    expect(dialogs(a) + dialogs(b)).toBe(0);
    expect(a.shadowRoot?.activeElement ?? b.shadowRoot?.activeElement).toBeNull();
  });
});

describe("an element inside another component's shadow root", () => {
  async function nested(extra: Record<string, string> = {}): Promise<{ host: HTMLElement; el: ChatwardenHubElement; w: HubWorld }> {
    const w = await filed();
    defineChatwardenHub();
    const host = document.createElement('div');
    document.body.append(host);
    const adopter = host.attachShadow({ mode: 'open' });
    const mine = adopter.appendChild(document.createElement('button'));
    mine.textContent = 'my own control';
    const el = document.createElement('chatwarden-hub') as ChatwardenHubElement;
    for (const [k, v] of Object.entries({ ...detailed, ...extra })) el.setAttribute(k, v);
    el.client = w.client;
    adopter.append(el);
    await ready(el);
    return { host, el, w };
  }

  it("J and K read the hub's own focus, not the outer component's host", async () => {
    const { el } = await nested();
    const user = userEvent.setup();
    skip(el).focus();
    await user.keyboard('j');
    expect(name(el.shadowRoot?.activeElement)).toBe('Alpha');
    await user.keyboard('jj');
    expect(name(el.shadowRoot?.activeElement)).toBe('Charlie');
    await user.keyboard('k');
    expect(name(el.shadowRoot?.activeElement)).toBe('Bravo');
  });

  it('the shortcut sheet and the command bar open, and focus goes back to what had it when they close', async () => {
    const { el } = await nested();
    const user = userEvent.setup();
    rows(el)[1]?.focus();
    await user.keyboard('?');
    await inside(el).findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('{Escape}');
    expect(dialogs(el)).toBe(0);
    expect(el.shadowRoot?.activeElement).toBe(rows(el)[1]);
    await user.keyboard('{Control>}k{/Control}');
    await inside(el).findByRole('dialog', { name: 'Command bar' });
    await user.keyboard('{Escape}');
    expect(el.shadowRoot?.activeElement).toBe(rows(el)[1]);
  });

  it('Tab stays inside an open window', async () => {
    const { el } = await nested();
    const user = userEvent.setup();
    skip(el).focus();
    await user.keyboard('{Control>}k{/Control}');
    const bar = await inside(el).findByRole('dialog', { name: 'Command bar' });
    for (let i = 0; i < 4; i += 1) {
      await user.keyboard('{Tab}');
      expect(bar.contains(el.shadowRoot?.activeElement ?? null)).toBe(true);
    }
  });

  it("a key pressed in the outer component's own control is not taken", async () => {
    const { host, el } = await nested();
    (host.shadowRoot?.querySelector('button') as HTMLElement).focus();
    await userEvent.setup().keyboard('?j');
    await new Promise((r) => setTimeout(r, 30));
    expect(dialogs(el)).toBe(0);
    expect(el.shadowRoot?.activeElement).toBeNull();
  });

  it('two such elements in two components each answer their own keys', async () => {
    const one = await nested();
    const two = await nested();
    const user = userEvent.setup();
    skip(two.el).focus();
    await user.keyboard('?');
    await inside(two.el).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(one.el)).toBe(0);
  });

  it('shortcuts="false" still turns the keys off there', async () => {
    const { el } = await nested({ shortcuts: 'false' });
    skip(el).focus();
    await userEvent.setup().keyboard('?j');
    await new Promise((r) => setTimeout(r, 30));
    expect(dialogs(el)).toBe(0);
    expect(el.shadowRoot?.activeElement).toBe(skip(el));
  });
});
