import { waitFor } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { goTo, hubShown, mount } from './helpers.js';
import { hubWorld } from './world.js';

// Hubs on the default hash router keep their place in the page's one URL hash, so they all show the same screen; a memory router keeps
// its own place. This is about the router, not the keys: it stays true however each hub hears its keys. (It was in multi-hub.test.ts,
// which recorded the 7e document shim; that file is gone, this part of it is not.)

describe('two hubs on one page: the router', () => {
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
