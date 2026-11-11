// @vitest-environment node
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/Hub.js';
import { HubContext } from '../src/context.js';
import type { HubContextValue } from '../src/context.js';
import { createT, en } from '../src/i18n.js';
import { memoryRouter } from '../src/router.js';
import { LazyTerms, lazyScreen } from '../src/screens/lazy.js';
import type { HubClient } from '../src/client.js';

// Server rendering: `renderToString(<Hub/>)` still works, and a lazy screen that is reached on the server renders its skeleton
// (the code is not waited for) without a warning, the first time and after it has loaded.

afterEach(() => {
  vi.restoreAllMocks();
});

const hub = { t: createT(en, 'en') } as unknown as HubContextValue;
const inHub = (node: React.ReactNode) => <HubContext.Provider value={hub}>{node}</HubContext.Provider>;

describe('server rendering', () => {
  it('renders <Hub> on a node server (no window): the hub is waiting for who is signed in, nothing throws', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = { me: () => new Promise(() => undefined) } as unknown as HubClient;
    const html = renderToString(<Hub client={client} router={memoryRouter('/')} />);
    expect(html).toContain('cw-hub');
    expect(errors).not.toHaveBeenCalled();
  });

  it('renders <Hub> on a lazy route too: the shell does not wait for a screen', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = { me: () => new Promise(() => undefined) } as unknown as HubClient;
    for (const path of ['/terms', '/blocked', '/gaps', '/audit', '/guide', '/actions', '/settings/ladder', '/settings/reporting']) {
      expect(() => renderToString(<Hub client={client} router={memoryRouter(path)} />), path).not.toThrow();
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it('a lazy screen reached on the server renders the skeleton, not an error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const html = renderToString(inHub(<LazyTerms />));
    expect(html).toContain('cw-skel');
    expect(html).toContain('Loading');
    expect(html).not.toContain('cw-error');
    expect(errors).not.toHaveBeenCalled();
  });

  it('a screen whose code has already loaded renders itself on the server, with no layout-effect warning', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Screen = lazyScreen<object>('hub.state.what.terms', () => Promise.resolve(() => <h2>Loaded</h2>));
    // First render starts the load (the skeleton); once it has settled the same screen renders at once.
    renderToString(inHub(<Screen />));
    await new Promise((r) => setTimeout(r, 0));
    const html = renderToString(inHub(<Screen />));
    expect(html).toContain('Loaded');
    expect(errors).not.toHaveBeenCalled();
  });
});
