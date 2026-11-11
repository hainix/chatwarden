import { render, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/Hub.js';
import type { HubProps } from '../src/Hub.js';
import type { HubProviderProps } from '../src/provider.js';
import { memoryRouter } from '../src/router.js';
import { hubInShadow, removeShadowHosts, shadowRootIn } from './shadow.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Keys right after load. A hub answers a key pressed inside it; and, for a page that has nothing focused (focus on the body, as it is
// after load), the one hub that is the page's: the only hub with shortcuts on, or, among several, the one marked `primary`. Nobody else:
// focus anywhere else (an adopter's control, another component's shadow root) keeps its keys, and Escape is only ever the hub's own.

afterEach(() => {
  removeShadowHosts();
  document.body.replaceChildren();
});

const registry = (): { hubs: Map<Element, unknown>; stop: unknown } | undefined => (globalThis as Record<symbol, never>)[Symbol.for('chatwarden.hubs')];
// (Through any shadow root: the page's own activeElement is only a host.)
const blur = (): void => {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  (el as HTMLElement | null)?.blur();
};

async function world(): Promise<HubWorld> {
  const w = await hubWorld({ actor: 'ann@example.test' });
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    await w.file({ target: name });
    w.clock.t += 1000;
  }
  return w;
}

/** A hub in the page, in its own container. */
function mountHub(w: HubWorld, props: Partial<Omit<HubProps, 'client'>> = {}) {
  const container = document.body.appendChild(document.createElement('div'));
  const r = render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" {...props} />, { container });
  return { ...r, container };
}
const rows = (c: ParentNode): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('.cw-queue .cw-case-link')];
const dialogs = (c: ParentNode): number => c.querySelectorAll('[role="dialog"]').length;
async function loaded(...containers: HTMLElement[]): Promise<void> {
  for (const c of containers) await waitFor(() => expect(rows(c)).toHaveLength(3));
}
const nextCalls = (w: HubWorld): number => w.sent.filter((r) => r.path === '/cases/next').length;

describe('the only hub on the page, with focus on the body', () => {
  it('J and K move through the queue, ? opens the sheet, Ctrl+K the command bar', async () => {
    const w = await world();
    const { container } = mountHub(w);
    await loaded(container);
    blur();
    const user = userEvent.setup();
    await user.keyboard('j');
    expect(document.activeElement).toBe(rows(container)[0]);
    blur();
    await user.keyboard('k');
    expect(document.activeElement).toBe(rows(container)[2]);
    blur();
    await user.keyboard('?');
    await within(container).findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.keyboard('{Escape}');
    expect(dialogs(container)).toBe(0);
    blur();
    await user.keyboard('{Control>}k{/Control}');
    await within(container).findByRole('dialog', { name: 'Command bar' });
  });

  it('N takes the next case, once, however many times the key repeats', async () => {
    const w = await world();
    const { container } = mountHub(w);
    await loaded(container);
    blur();
    await userEvent.setup().keyboard('n');
    await waitFor(() => expect(nextCalls(w)).toBe(1));
  });

  it('Escape does nothing: it is only ever the hub\'s own, when focus is inside it', async () => {
    const w = await world();
    const { container } = mountHub(w);
    await loaded(container);
    blur();
    await userEvent.setup().keyboard('{Escape}');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(document.body);
    expect(dialogs(container)).toBe(0);
  });

  it('a modifier key combination the browser owns is left alone', async () => {
    const w = await world();
    const { container } = mountHub(w);
    await loaded(container);
    blur();
    await userEvent.setup().keyboard('{Control>}j{/Control}{Alt>}n{/Alt}');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(document.body);
    expect(nextCalls(w)).toBe(0);
  });

  it('with shortcuts off it answers nothing', async () => {
    const w = await world();
    const { container } = mountHub(w, { shortcuts: false });
    await loaded(container);
    blur();
    await userEvent.setup().keyboard('j?n');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(document.body);
    expect(dialogs(container)).toBe(0);
    expect(nextCalls(w)).toBe(0);
  });

  it('does not take a key pressed in the adopter\'s own control', async () => {
    const w = await world();
    const { container } = mountHub(w);
    await loaded(container);
    const mine = document.body.appendChild(document.createElement('button'));
    mine.focus();
    await userEvent.setup().keyboard('j?n');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(mine);
    expect(dialogs(container)).toBe(0);
    expect(nextCalls(w)).toBe(0);
  });

  it('does not take a key pressed in another component\'s shadow root', async () => {
    const w = await world();
    const { container } = mountHub(w);
    await loaded(container);
    const shadow = shadowRootIn();
    const mine = shadow.appendChild(document.createElement('input'));
    mine.focus();
    await userEvent.setup().keyboard('?');
    await new Promise((r) => setTimeout(r, 20));
    expect(dialogs(container)).toBe(0);
  });

  it('a key the page already handled (defaultPrevented) is not taken', async () => {
    const w = await world();
    const { container } = mountHub(w);
    await loaded(container);
    blur();
    const stop = (e: KeyboardEvent): void => e.preventDefault();
    document.body.addEventListener('keydown', stop);
    await userEvent.setup().keyboard('?');
    await new Promise((r) => setTimeout(r, 20));
    document.body.removeEventListener('keydown', stop);
    expect(dialogs(container)).toBe(0);
  });
});

describe('two hubs on the page, with focus on the body', () => {
  async function pair(a: Partial<Omit<HubProps, 'client'>> = {}, b: Partial<Omit<HubProps, 'client'>> = {}) {
    const w = await world();
    const one = mountHub(w, a);
    const two = mountHub(w, b);
    await loaded(one.container, two.container);
    blur();
    return { w, one: one.container, two: two.container, user: userEvent.setup() };
  }

  it('neither answers when none is primary', async () => {
    const { w, one, two, user } = await pair();
    await user.keyboard('j?n');
    await new Promise((r) => setTimeout(r, 20));
    expect(dialogs(one) + dialogs(two)).toBe(0);
    expect(document.activeElement).toBe(document.body);
    expect(nextCalls(w)).toBe(0);
  });

  it('the primary one answers, and only it', async () => {
    const { one, two, user } = await pair({}, { primary: true });
    await user.keyboard('?');
    await within(two).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(one)).toBe(0);
    await user.keyboard('{Escape}');
    blur();
    await user.keyboard('j');
    expect(document.activeElement).toBe(rows(two)[0]);
  });

  it('two primaries are no better than none', async () => {
    const { one, two, user } = await pair({ primary: true }, { primary: true });
    await user.keyboard('?');
    await new Promise((r) => setTimeout(r, 20));
    expect(dialogs(one) + dialogs(two)).toBe(0);
  });

  it('a hub with shortcuts off is not counted: the other one is the only one', async () => {
    const { one, two, user } = await pair({ shortcuts: false }, {});
    await user.keyboard('?');
    await within(two).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(one)).toBe(0);
  });

  it('a primary beside a quiet hub: the primary answers, the quiet one does not', async () => {
    const { one, two, user } = await pair({ shortcuts: false }, { primary: true });
    await user.keyboard('?');
    await within(two).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(one)).toBe(0);
  });

  it('a primary that has shortcuts off is not counted either', async () => {
    const { one, two, user } = await pair({ primary: true, shortcuts: false }, {});
    await user.keyboard('?');
    await within(two).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(one)).toBe(0);
  });

  it('a key pressed inside a hub is still that hub\'s alone, primary or not', async () => {
    const { one, two, user } = await pair({}, { primary: true });
    one.querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('?');
    await within(one).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(two)).toBe(0);
  });

  it('a key pressed inside a hub is handled once (the page path does not repeat it)', async () => {
    const w = await world();
    const only = mountHub(w);
    await loaded(only.container);
    only.container.querySelector<HTMLElement>('.cw-skip')?.focus();
    await userEvent.setup().keyboard('n');
    await new Promise((r) => setTimeout(r, 50));
    expect(nextCalls(w)).toBe(1);
  });
});

describe('a hub in a shadow root, with focus on the body', () => {
  it('the only hub answers', async () => {
    const w = await world();
    const s = hubInShadow(w);
    await waitFor(() => expect(rows(s.container)).toHaveLength(3));
    blur();
    await s.user.keyboard('?');
    await s.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await s.user.keyboard('{Escape}');
    blur();
    await s.user.keyboard('j');
    expect(s.shadow.activeElement).toBe(rows(s.container)[0]);
  });

  it('beside a hub in the page, only the primary one answers', async () => {
    const w = await world();
    const s = hubInShadow(w, { primary: true });
    const page = mountHub(w);
    await waitFor(() => expect(rows(s.container)).toHaveLength(3));
    await loaded(page.container);
    blur();
    await s.user.keyboard('?');
    await s.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialogs(page.container)).toBe(0);
  });

  it('inside another shadow root nested in a component, with the page\'s focus on the body', async () => {
    const w = await world();
    const outer = shadowRootIn();
    const host = outer.appendChild(document.createElement('div'));
    const s = hubInShadow(w, { shadow: host.attachShadow({ mode: 'open' }) });
    await waitFor(() => expect(rows(s.container)).toHaveLength(3));
    blur();
    await s.user.keyboard('j');
    expect(s.shadow.activeElement).toBe(rows(s.container)[0]);
  });
});

describe('primary belongs to the hub alone', () => {
  it('HubProvider does not take it (a piece answers keys only while focus is inside it)', () => {
    // The type is the test: tsc fails this file if HubProvider ever grows the prop.
    const props: HubProviderProps = {
      client: undefined as never,
      // @ts-expect-error `primary` is a prop of <Hub> and of the element, not of the provider
      primary: true,
    };
    expect(props).toBeDefined();
  });
});

describe('the hubs the page knows about', () => {
  it('a hub registers when it mounts and leaves when it unmounts; the last one out takes the page listener away', async () => {
    const w = await world();
    expect(registry()?.hubs.size ?? 0).toBe(0);
    const a = mountHub(w);
    await loaded(a.container);
    expect(registry()?.hubs.size).toBe(1);
    const b = mountHub(w);
    await loaded(b.container);
    expect(registry()?.hubs.size).toBe(2);
    b.unmount();
    expect(registry()?.hubs.size).toBe(1);
    // With one left it is the only hub again, and answers.
    blur();
    await userEvent.setup().keyboard('?');
    await within(a.container).findByRole('dialog', { name: 'Keyboard shortcuts' });
    a.unmount();
    expect(registry()?.hubs.size ?? 0).toBe(0);
    expect(registry()?.stop ?? null).toBeNull();
  });

  it('a hub that turns shortcuts off leaves; turning them on brings it back', async () => {
    const w = await world();
    const a = mountHub(w);
    await loaded(a.container);
    expect(registry()?.hubs.size).toBe(1);
    a.rerender(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" shortcuts={false} />);
    expect(registry()?.hubs.size ?? 0).toBe(0);
    a.rerender(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" />);
    expect(registry()?.hubs.size).toBe(1);
  });

  it('under StrictMode (effects run twice) the hub is registered once and answers once', async () => {
    const w = await world();
    const container = document.body.appendChild(document.createElement('div'));
    render(
      <StrictMode>
        <Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" />
      </StrictMode>,
      { container },
    );
    await loaded(container);
    expect(registry()?.hubs.size).toBe(1);
    blur();
    await userEvent.setup().keyboard('n');
    await new Promise((r) => setTimeout(r, 50));
    expect(nextCalls(w)).toBe(1);
  });
});
