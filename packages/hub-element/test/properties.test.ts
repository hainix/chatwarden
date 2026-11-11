import { createT, en } from '@chatwarden/hub-react';
import { waitFor } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { ChatwardenHubElement, defineChatwardenHub } from '../src/index.js';
import { fetchFor, hubShown, inside, mount } from './helpers.js';
import { hubWorld } from './world.js';

// The two things that cannot be attributes: a ready client, and a translation function.

describe('client', () => {
  it('is used instead of base-url: the hub asks the client, and never touches fetch', async () => {
    const w = await hubWorld();
    const { fn, calls } = fetchFor(w);
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const el = mount({ 'base-url': '/somewhere-else' }, { client: w.client });
      await hubShown(el);
      expect(calls).toEqual([]);
      expect(w.sent.some((r) => r.path === '/me')).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('can be set after the element is on the page: the hub switches to it', async () => {
    const a = await hubWorld({ gameName: 'Alpha' });
    const b = await hubWorld({ gameName: 'Beta' });
    const el = mount({}, { client: a.client });
    await hubShown(el);
    expect(a.sent.some((r) => r.path === '/me')).toBe(true);
    el.client = b.client;
    await waitFor(() => expect(b.sent.some((r) => r.path === '/me')).toBe(true));
    expect(el.client).toBe(b.client);
  });

  it('set back to null, the element goes back to base-url', async () => {
    const w = await hubWorld();
    const { fn, calls } = fetchFor(w, '/ops');
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const el = mount({ 'base-url': '/ops' }, { client: w.client });
      await hubShown(el);
      expect(calls).toEqual([]);
      el.client = null;
      await waitFor(() => expect(calls.some((c) => c.url === '/ops/me')).toBe(true));
    } finally {
      globalThis.fetch = original;
    }
  });

  it('a change of base-url builds a new client for the new place', async () => {
    const w = await hubWorld();
    const { fn, calls } = fetchFor(w, '/one');
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const el = mount({ 'base-url': '/one' });
      await hubShown(el);
      expect(calls.some((c) => c.url === '/one/me')).toBe(true);
      const two = fetchFor(w, '/two');
      globalThis.fetch = two.fn;
      el.setAttribute('base-url', '/two');
      await waitFor(() => expect(two.calls.some((c) => c.url === '/two/me')).toBe(true));
    } finally {
      globalThis.fetch = original;
    }
  });

  it('a base-url of a trailing slash or a full address is passed through to fetch', async () => {
    const w = await hubWorld();
    const { fn, calls } = fetchFor(w, '/mod');
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const el = mount({ 'base-url': '/mod/' });
      await hubShown(el);
      expect(calls.some((c) => c.url === '/mod/me')).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('t', () => {
  const french = createT({ ...en, 'hub.skip': 'Aller au contenu' }, 'en');

  it('translates the hub, and setting it later re-renders', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    await hubShown(el);
    expect(inside(el).getByRole('button', { name: en['hub.skip'] })).toBeTruthy();
    el.t = french;
    await waitFor(() => expect(inside(el).getByRole('button', { name: 'Aller au contenu' })).toBeTruthy());
    expect(el.t).toBe(french);
    el.t = null;
    await waitFor(() => expect(inside(el).getByRole('button', { name: en['hub.skip'] })).toBeTruthy());
  });

  it('works when set before the element connects', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client, t: french });
    await hubShown(el);
    expect(inside(el).getByRole('button', { name: 'Aller au contenu' })).toBeTruthy();
  });
});

describe('properties set before the script defined the element', () => {
  it('a client and a t set on the plain element are picked up when it is upgraded', async () => {
    const w = await hubWorld();
    const words = createT({ ...en, 'hub.skip': 'Aller au contenu' }, 'en');
    const early = document.createElement('cw-late-hub') as HTMLElement & { client?: unknown; t?: unknown };
    early.client = w.client;
    early.t = words;
    document.body.append(early);
    defineChatwardenHub('cw-late-hub');
    // The element upgrades in place, keeps the values, and draws with them.
    expect(early).toBeInstanceOf(ChatwardenHubElement);
    expect((early as ChatwardenHubElement).client).toBe(w.client);
    expect((early as ChatwardenHubElement).t).toBe(words);
    await hubShown(early);
    expect(inside(early).getByRole('button', { name: 'Aller au contenu' })).toBeTruthy();
  });
});
