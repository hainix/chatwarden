import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import { webhooksOut } from '../src/webhooks/out.js';
import type { WebhookEndpoint } from '../src/webhooks/out.js';
import { world } from './world.js';

// F6: `report.created` of a filter report goes out with its origin and nothing about a line, a pattern or a reporter. An ordinary report's body is as before.

const NOW = 1_800_000_000_000;
const SECRET = 'outgoing-secret-at-least-32-characters-long';

afterEach(() => vi.useRealTimers());

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: string };
}
function fakeFetch() {
  const calls: Call[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init as Call['init'] });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}
const bodyOf = (c: Call) => JSON.parse(c.init.body) as { type: string; data: Record<string, unknown> };
const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ url: 'https://hooks.example.test/in', secret: SECRET, events: ['report.created'], ...over });

describe('report.created webhooks and a filter report', () => {
  it('carries origin filter and no line, no key, no reporter; an ordinary report carries none of it', async () => {
    const w = await world({ overrides: { filters: { links: { action: 'flag' } } } });
    const f = fakeFetch();
    const hook = webhooksOut(w.cw, { endpoints: [endpoint()], fetch: f.fetch, clock: { now: () => NOW } });
    w.cw.rooms.seat('RW', 'p1', { clientKey: 'raw-client-key-w' }, 'Spk');
    w.cw.chat.accept('RW', 'p1', 'see vlemmo.com now');
    await w.cw.filters.stats({ days: 7 });
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    const first = bodyOf(f.calls[0]!);
    expect(first.type).toBe('report.created');
    expect(first.data).toMatchObject({ origin: 'filter', reportedReason: 'spam', category: 'spam' });
    const text = f.calls[0]!.init.body;
    for (const leak of ['vlemmo', 'link.unlisted', 'raw-client-key', 'filter:', 'reporter']) expect(text, leak).not.toContain(leak);

    await w.file();
    await vi.waitFor(() => expect(f.calls.length).toBe(2));
    const second = bodyOf(f.calls[1]!);
    expect(Object.hasOwn(second.data, 'origin')).toBe(false);
    hook.dispose();
  });

  it('with includeExcerpts the filter report carries its excerpt as any report does, and still no reporter', async () => {
    const w = await world({ overrides: { filters: { links: { action: 'flag' } } } });
    const f = fakeFetch();
    const hook = webhooksOut(w.cw, { endpoints: [endpoint({ includeExcerpts: true })], fetch: f.fetch, clock: { now: () => NOW } });
    w.cw.rooms.seat('RX', 'p1', { clientKey: 'raw-client-key-x' }, 'Spk');
    w.cw.chat.accept('RX', 'p1', 'see vlemmo.com now');
    await w.cw.filters.stats({ days: 7 });
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    const data = bodyOf(f.calls[0]!).data as { origin: string; excerpt: Array<{ text: string }> };
    expect(data.origin).toBe('filter');
    expect(data.excerpt.map((l) => l.text)).toEqual(['see vlemmo.com now']);
    expect(f.calls[0]!.init.body).not.toContain('raw-client-key');
    hook.dispose();
  });

  it('a raised event with an origin is passed through whole (fake kit): the body data holds the origin and the other fields only', async () => {
    const listeners = new Set<(e: KitEvent) => unknown>();
    const kit = { on: (_t: string, fn: (e: KitEvent) => unknown) => (listeners.add(fn), () => void listeners.delete(fn)), reports: { get: () => null }, people: { accountIds: () => [] } } as unknown as Pick<Chatwarden, 'on' | 'reports' | 'people'>;
    const f = fakeFetch();
    webhooksOut(kit, { endpoints: [endpoint()], fetch: f.fetch, clock: { now: () => NOW } });
    const e: KitEvent = { type: 'report.created', reportId: 'r1', createdAt: NOW, category: 'spam', reportedReason: 'spam', urgent: false, origin: 'filter', roomTags: { mode: 'ranked' } };
    [...listeners].forEach((l) => void l(e));
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    expect(bodyOf(f.calls[0]!).data).toEqual({ type: 'report.created', reportId: 'r1', createdAt: NOW, category: 'spam', reportedReason: 'spam', urgent: false, origin: 'filter', roomTags: { mode: 'ranked' } });
  });
});
