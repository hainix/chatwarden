import { waitFor } from '@testing-library/dom';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { goTo, hubShown, inside, mount } from './helpers.js';
import { hubWorld } from './world.js';

// REMOVE WITH THE SHIM (Task 7j). These record what the build's `document` stand-in does today when two hubs share a page, so the
// README can say so honestly. Once hub-react scopes its keys to its own root, a key pressed in one hub reaches only that hub and the
// first test below inverts (and the hash note, which is about the router, stays).

describe('two hubs on one page (current behaviour of the shim)', () => {
  it('a key pressed in a hub with shortcuts="false" still drives a hub that has them on', async () => {
    const w = await hubWorld();
    const quiet = mount({ shortcuts: 'false', router: 'memory' }, { client: w.client });
    const loud = mount({ router: 'memory' }, { client: w.client });
    await hubShown(quiet);
    await hubShown(loud);
    const user = userEvent.setup();
    quiet.shadowRoot?.querySelector<HTMLElement>('.cw-skip')?.focus();
    await user.keyboard('?');
    // The shortcut sheet opens in the OTHER hub, the one with shortcuts on.
    await inside(loud).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(inside(quiet).queryByRole('dialog')).toBeNull();
  });

  it('with two hubs that both have shortcuts on, the first one to start answers a key pressed in either (it takes the key first)', async () => {
    const w = await hubWorld();
    const a = mount({ router: 'memory' }, { client: w.client });
    const b = mount({ router: 'memory' }, { client: w.client });
    await hubShown(a);
    await hubShown(b);
    b.shadowRoot?.querySelector<HTMLElement>('.cw-skip')?.focus();
    await userEvent.setup().keyboard('?');
    await inside(a).findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(inside(b).queryByRole('dialog')).toBeNull();
  });

  it('hubs on the default hash router share the page URL hash; a memory router keeps its own place', async () => {
    const w = await hubWorld({ role: 'owner' });
    goTo('/blocked');
    const a = mount({ mode: 'detailed' }, { client: w.client });
    const b = mount({ mode: 'detailed' }, { client: w.client });
    const c = mount({ mode: 'detailed', router: 'memory' }, { client: w.client });
    await hubShown(a);
    await hubShown(b);
    await hubShown(c);
    const title = (el: Element) => el.shadowRoot?.querySelector('.cw-screen-title')?.textContent ?? '';
    await waitFor(() => expect(title(a)).toMatch(/Blocked/));
    expect(title(b)).toMatch(/Blocked/);
    expect(title(c)).not.toMatch(/Blocked/);
    goTo('/audit');
    await waitFor(() => expect(title(a)).toMatch(/Audit/));
    await waitFor(() => expect(title(b)).toMatch(/Audit/));
    expect(title(c)).not.toMatch(/Audit/);
  });
});
