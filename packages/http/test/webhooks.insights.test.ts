import { afterEach, describe, expect, it, vi } from 'vitest';
import { webhooksOut } from '../src/webhooks/out.js';
import type { WebhookEndpoint } from '../src/webhooks/out.js';
import { world } from './world.js';

// U7: a webhook endpoint may subscribe to insights.digest, raised by cw.insights.emitDigest(): counts and times, no names.

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
const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ url: 'https://hooks.example.test/in', secret: SECRET, events: ['insights.digest'], ...over });

describe('webhooksOut and the Insights digest', () => {
  it('accepts insights.digest in an endpoint list and signs one body with the digest numbers only', async () => {
    const w = await world({ overrides: { desk: { insights: true } } });
    await w.file('harassment');
    const f = fakeFetch();
    const hook = webhooksOut(w.cw, { endpoints: [endpoint()], fetch: f.fetch, clock: { now: () => NOW } });
    w.cw.insights.emitDigest(7);
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    const body = JSON.parse(f.calls[0]!.init.body) as { type: string; data: { digest: Record<string, unknown> } };
    expect(body.type).toBe('insights.digest');
    expect(Object.keys(body.data.digest).sort()).toEqual(['days', 'decided', 'filed', 'from', 'longestOpenMs', 'medianMs', 'open', 'p90Ms', 'to', 'urgentFiled', 'urgentOpen']);
    expect(body.data.digest).toMatchObject({ days: 7, filed: 1, open: 1 });
    expect(f.calls[0]!.init.headers).toHaveProperty('x-chatwarden-signature');
    for (const leak of ['TargetName', 'a line from the target', 'subject', 'handle']) expect(f.calls[0]!.init.body, leak).not.toContain(leak);
    hook.dispose();
  });

  it('an endpoint that did not list insights.digest does not get it', async () => {
    const w = await world({ overrides: { desk: { insights: true } } });
    const f = fakeFetch();
    const hook = webhooksOut(w.cw, { endpoints: [endpoint({ events: ['report.created'] })], fetch: f.fetch, clock: { now: () => NOW } });
    w.cw.insights.emitDigest(7);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toEqual([]);
    hook.dispose();
  });

  it('with Insights off, emitDigest raises nothing, so nothing goes out even to a "*" endpoint', async () => {
    const w = await world();
    const f = fakeFetch();
    const hook = webhooksOut(w.cw, { endpoints: [endpoint({ events: '*' })], fetch: f.fetch, clock: { now: () => NOW } });
    w.cw.insights.emitDigest(7);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls).toEqual([]);
    hook.dispose();
  });
});
