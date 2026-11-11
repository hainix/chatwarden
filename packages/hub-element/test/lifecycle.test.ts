import { waitFor } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { decides, fetchFor, goTo, hubShown, inside, mount, pageHides } from './helpers.js';
import { hubWorld } from './world.js';

// Mount, unmount, move: one React root in an open shadow root, kept across a move, torn down (and its controller disposed) on
// a real removal.

const RESTRICT = { name: /^Restrict chat, 24 hours/ };

describe('mount', () => {
  it('attaches an open shadow root and draws the hub in it, not in the page', async () => {
    const w = await hubWorld();
    const el = mount({ mode: 'detailed' }, { client: w.client });
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
    await hubShown(el);
    expect(el.shadowRoot?.querySelector('.cw-hub')).not.toBeNull();
    // Nothing of the hub is in the light DOM or elsewhere in the page.
    expect(el.children.length).toBe(0);
    expect(document.querySelector('.cw-hub')).toBeNull();
    expect(document.body.querySelector('.cw-body')).toBeNull();
  });

  it('asks the staff routes at base-url (default /admin)', async () => {
    const w = await hubWorld();
    const { fn, calls } = fetchFor(w, '/admin');
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const el = mount();
      await hubShown(el);
      expect(calls.some((c) => c.url === '/admin/me')).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('two elements are two separate hubs', async () => {
    const w = await hubWorld();
    const a = mount({}, { client: w.client });
    const b = mount({}, { client: w.client });
    await hubShown(a);
    await hubShown(b);
    expect(a.shadowRoot).not.toBe(b.shadowRoot);
    expect(a.shadowRoot?.querySelectorAll('.cw-hub').length).toBe(1);
    expect(b.shadowRoot?.querySelectorAll('.cw-hub').length).toBe(1);
  });
});

describe('unmount', () => {
  it('removing the element takes the hub out of its shadow root and stops its polling', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    el.remove();
    await waitFor(() => expect(el.shadowRoot?.querySelector('.cw-hub')).toBeNull());
    const before = w.sent.length;
    await new Promise((r) => setTimeout(r, 60));
    // A disposed controller asks nothing more.
    expect(w.sent.length).toBe(before);
  });

  it('sends a decision held for Undo, at once and with keepalive, when the element is removed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    goTo(`/reports/${f.id}`);
    const el = mount({ mode: 'simple' }, { client: w.client });
    const q = inside(el);
    (await q.findByRole('button', RESTRICT, { timeout: 5000 })).click();
    // Held for its Undo window: nothing sent yet.
    await waitFor(() => expect(q.queryAllByRole('button', { name: /^Undo/ })).not.toHaveLength(0));
    expect(decides(w)).toHaveLength(0);
    el.remove();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.keepalive).toBe(true);
    expect(decides(w)[0]?.method).toBe('POST');
  });

  it('a page hide also sends the held decision (it is the same controller)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    goTo(`/reports/${f.id}`);
    const el = mount({ mode: 'simple' }, { client: w.client });
    const q = inside(el);
    (await q.findByRole('button', RESTRICT, { timeout: 5000 })).click();
    await waitFor(() => expect(q.queryAllByRole('button', { name: /^Undo/ })).not.toHaveLength(0));
    pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.keepalive).toBe(true);
  });
});

describe('a move in the DOM', () => {
  it('keeps the same root and the same DOM: nothing is torn down and nothing is asked again', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    const hubNode = el.shadowRoot?.querySelector('.cw-hub');
    const meBefore = w.sent.filter((r) => r.path === '/me').length;
    const holder = document.createElement('div');
    document.body.append(holder);
    holder.append(el); // disconnect, then connect again, in the same task
    await new Promise((r) => setTimeout(r, 30));
    expect(el.shadowRoot?.querySelector('.cw-hub')).toBe(hubNode);
    expect(w.sent.filter((r) => r.path === '/me').length).toBe(meBefore);
  });

  it('does not lose or send an Undo hold: a moved element keeps the held decision held', async () => {
    const w = await hubWorld();
    const f = await w.fileRich();
    goTo(`/reports/${f.id}`);
    const el = mount({ mode: 'simple' }, { client: w.client });
    const q = inside(el);
    (await q.findByRole('button', RESTRICT, { timeout: 5000 })).click();
    await waitFor(() => expect(q.queryAllByRole('button', { name: /^Undo/ })).not.toHaveLength(0));
    const holder = document.createElement('div');
    document.body.append(holder);
    holder.append(el);
    await new Promise((r) => setTimeout(r, 30));
    expect(decides(w)).toHaveLength(0);
    // ...and Undo is still on screen.
    expect(q.queryAllByRole('button', { name: /^Undo/ })).not.toHaveLength(0);
  });

  it('an element removed and added back later mounts a fresh hub', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    el.remove();
    await waitFor(() => expect(el.shadowRoot?.querySelector('.cw-hub')).toBeNull());
    document.body.append(el);
    await hubShown(el);
    expect(el.shadowRoot?.querySelectorAll('.cw-hub').length).toBe(1);
  });

  it('removing and re-adding in one task is a move, even into a different parent', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    const first = el.shadowRoot?.querySelector('.cw-hub');
    const a = document.createElement('section');
    const b = document.createElement('section');
    document.body.append(a, b);
    a.append(el);
    b.append(el);
    await new Promise((r) => setTimeout(r, 20));
    expect(el.shadowRoot?.querySelector('.cw-hub')).toBe(first);
  });
});
