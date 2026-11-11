import { render, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '../src/Hub.js';
import { memoryRouter } from '../src/router.js';
import { focusedIn, hubInShadow, removeShadowHosts } from './shadow.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Two hubs on one page. Each answers only the keys pressed while focus is inside it: a key never reaches the other hub, and one
// that has shortcuts off stays quiet whoever else is listening.

afterEach(removeShadowHosts);

async function world(): Promise<HubWorld> {
  const w = await hubWorld({ actor: 'ann@example.test' });
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    await w.file({ target: name });
    w.clock.t += 1000;
  }
  return w;
}

const sheetsIn = (el: ParentNode): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Keyboard shortcuts"]')];

describe('two hubs in the page (no shadow root)', () => {
  async function pair(props: { a?: Partial<Parameters<typeof Hub>[0]>; b?: Partial<Parameters<typeof Hub>[0]> } = {}) {
    const w = await world();
    const user = userEvent.setup();
    const a = render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" {...props.a} />, { container: document.body.appendChild(document.createElement('div')) });
    const b = render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" {...props.b} />, { container: document.body.appendChild(document.createElement('div')) });
    await waitFor(() => expect(a.container.querySelectorAll('.cw-queue .cw-case-link')).toHaveLength(3));
    await waitFor(() => expect(b.container.querySelectorAll('.cw-queue .cw-case-link')).toHaveLength(3));
    const skip = (r: { container: HTMLElement }): HTMLElement => r.container.querySelector<HTMLElement>('.cw-skip') as HTMLElement;
    return { w, user, a, b, skip };
  }

  it('? pressed in one hub opens the sheet in that hub only', async () => {
    const { user, a, b, skip } = await pair();
    skip(b).focus();
    await user.keyboard('?');
    await within(b.container).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(sheetsIn(a.container)).toHaveLength(0);
    expect(sheetsIn(b.container)).toHaveLength(1);
  });

  it('J moves the queue of the hub with focus and leaves the other where it was', async () => {
    const { user, a, b, skip } = await pair();
    skip(a).focus();
    await user.keyboard('j');
    const first = a.container.querySelector('.cw-queue .cw-case-link') as HTMLElement;
    expect(document.activeElement).toBe(first);
    // Focus now in A: B's queue was not touched, its rows are not focused and none is marked.
    expect([...b.container.querySelectorAll('.cw-queue .cw-case-link')].some((r) => r === document.activeElement)).toBe(false);
    skip(b).focus();
    await user.keyboard('jj');
    const rowsB = [...b.container.querySelectorAll('.cw-queue .cw-case-link')];
    expect(document.activeElement).toBe(rowsB[1]);
    // A's own place is still its first row.
    expect(first.closest('.cw-hub')).toBe(a.container.querySelector('.cw-hub'));
  });

  it('with both on, one key opens one sheet, not two', async () => {
    const { user, a, b, skip } = await pair();
    skip(a).focus();
    await user.keyboard('?');
    await within(a.container).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(sheetsIn(a.container).length + sheetsIn(b.container).length).toBe(1);
  });

  it('a hub with shortcuts off stays quiet, and does not hand its keys to the other', async () => {
    const { user, a, b, skip } = await pair({ a: { shortcuts: false } });
    skip(a).focus();
    await user.keyboard('?');
    await user.keyboard('{Control>}k{/Control}');
    expect(sheetsIn(a.container)).toHaveLength(0);
    expect(sheetsIn(b.container)).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The other still answers its own.
    skip(b).focus();
    await user.keyboard('?');
    expect(sheetsIn(b.container)).toHaveLength(1);
  });

  it('Ctrl+K in one opens that hub\'s command bar only', async () => {
    const { user, a, b, skip } = await pair();
    skip(a).focus();
    await user.keyboard('{Control>}k{/Control}');
    await within(a.container).findByRole('dialog', { name: 'Command bar' });
    expect(within(b.container).queryByRole('dialog')).toBeNull();
  });

  it('a key pressed on the page outside both is taken by neither', async () => {
    const { user, a, b } = await pair();
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    await user.keyboard('?j{Control>}k{/Control}');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...a.container.querySelectorAll('.cw-case-link'), ...b.container.querySelectorAll('.cw-case-link')].some((r) => r === document.activeElement)).toBe(false);
    outside.remove();
  });
});

describe('two hubs in two shadow roots on one page', () => {
  async function pair() {
    const w = await world();
    const a = hubInShadow(w);
    const b = hubInShadow(w);
    await waitFor(() => expect(a.container.querySelectorAll('.cw-queue .cw-case-link')).toHaveLength(3));
    await waitFor(() => expect(b.container.querySelectorAll('.cw-queue .cw-case-link')).toHaveLength(3));
    return { w, a, b };
  }
  const skip = (r: { container: HTMLElement }): HTMLElement => r.container.querySelector<HTMLElement>('.cw-skip') as HTMLElement;

  it('each answers its own keys: ? opens the sheet in the one with focus and no other', async () => {
    const { a, b } = await pair();
    skip(b).focus();
    await b.user.keyboard('?');
    await b.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(a.q.queryByRole('dialog')).toBeNull();
    await b.user.keyboard('{Escape}');
    skip(a).focus();
    await a.user.keyboard('?');
    await a.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(b.q.queryByRole('dialog')).toBeNull();
  });

  it('J in one moves that one; its focus is read from its own root', async () => {
    const { a, b } = await pair();
    skip(a).focus();
    await a.user.keyboard('jj');
    expect(focusedIn(a.shadow)?.querySelector('.cw-case-name')?.textContent).toBe('Bravo');
    expect(focusedIn(b.shadow)).toBeNull();
  });

  it('a hub with shortcuts off beside a hub with them on: the quiet one is quiet', async () => {
    const w = await world();
    const quiet = hubInShadow(w, { shortcuts: false });
    const loud = hubInShadow(w);
    await waitFor(() => expect(loud.container.querySelectorAll('.cw-queue .cw-case-link')).toHaveLength(3));
    skip(quiet).focus();
    await quiet.user.keyboard('?');
    expect(quiet.q.queryByRole('dialog')).toBeNull();
    expect(loud.q.queryByRole('dialog')).toBeNull();
  });
});

describe('a hub in a shadow root beside a hub in the page', () => {
  it('keys do not cross between them', async () => {
    const w = await world();
    const inShadow = hubInShadow(w);
    const user = userEvent.setup();
    const onPage = render(<Hub client={w.client} router={memoryRouter('/')} now={w.now} mode="detailed" />, { container: document.body.appendChild(document.createElement('div')) });
    await waitFor(() => expect(onPage.container.querySelectorAll('.cw-queue .cw-case-link')).toHaveLength(3));
    await waitFor(() => expect(inShadow.container.querySelectorAll('.cw-queue .cw-case-link')).toHaveLength(3));
    (inShadow.container.querySelector('.cw-skip') as HTMLElement).focus();
    await user.keyboard('?');
    await inShadow.q.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(onPage.container.querySelector('[role="dialog"]')).toBeNull();
    await user.keyboard('{Escape}');
    (onPage.container.querySelector('.cw-skip') as HTMLElement).focus();
    await user.keyboard('?');
    await within(onPage.container).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(inShadow.q.queryByRole('dialog')).toBeNull();
  });
});

describe('an open window holds the keys of its own hub only', () => {
  it("a command bar open in one hub does not stop the other hub's 2 key from deciding", async () => {
    const w = await hubWorld({ actor: 'ann@example.test' });
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hello' }, { who: 'target', text: 'a line from the target' }], target: 'Alpha' });
    const user = userEvent.setup();
    const make = () =>
      render(<Hub client={w.client} router={memoryRouter(`/reports/${f.id}`)} now={w.now} mode="simple" />, { container: document.body.appendChild(document.createElement('div')) });
    const a = make();
    const b = make();
    for (const v of [a, b]) await within(v.container).findByRole('button', { name: /^No action needed/ });
    a.container.querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('{Control>}k{/Control}');
    await within(a.container).findByRole('dialog', { name: 'Command bar' });
    b.container.querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('2');
    await within(b.container).findByText('Decision queued.');
    expect(within(a.container).queryByText('Decision queued.')).toBeNull();
  });
});
