import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import { webhooksOut } from '../src/webhooks/out.js';
import type { WebhookEndpoint } from '../src/webhooks/out.js';
import { DELIVERY_HEADER, ReplayCache, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign, verify } from '../src/webhooks/sign.js';

// `report.escalated` over a webhook (design 6, 8): accepted in `events`, signed like every event, ids and a code only. `includeAccounts` adds the game's account ids to it and
// to `rename.required`, and to no other type. An unknown event type is still refused, and the Discord feed posts nothing for it.

const NOW = 1_800_000_000_000;
const SECRET = 'escalated-secret-at-least-32-characters-long';
const URL_A = 'https://hooks.example.test/chatwarden/ingest?token=URL-TOKEN-XYZ';
const ACCOUNT = 'acct-escalated-12345';
const TARGET = 's_target_000000000000000';

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
const bodyOf = (c: Call) => JSON.parse(c.init.body) as { id: string; type: string; at: number; data: Record<string, unknown> };
const clock = { now: () => NOW };

function fakeKit(accounts: string[] = [ACCOUNT]) {
  const listeners = new Set<(e: KitEvent) => unknown>();
  const kit = {
    on: (_type: string, fn: (e: KitEvent) => unknown) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    reports: { get: () => null },
    people: { accountIds: () => [...accounts] },
  } as unknown as Pick<Chatwarden, 'on' | 'reports' | 'people'>;
  return { kit, emit: (e: KitEvent) => void [...listeners].forEach((l) => void l(e)) };
}

const escalated: KitEvent = { type: 'report.escalated', reportId: 'r1', at: NOW, code: 'law_enforcement_request', target: TARGET };
const renamed: KitEvent = { type: 'rename.required', at: NOW, target: TARGET, rule: 1 };
const closed: KitEvent = { type: 'report.closed', reportId: 'r1', verdict: 'upheld', at: NOW };
const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ url: URL_A, secret: SECRET, events: '*', ...over });
const wait = (f: ReturnType<typeof fakeFetch>, n: number) => vi.waitFor(() => expect(f.calls.length).toBeGreaterThanOrEqual(n));

describe('webhooksOut and report.escalated', () => {
  it('accepts it in events, alone or with others, and by "*"; an unknown type is still refused at creation', () => {
    for (const events of [['report.escalated'], ['report.escalated', 'report.closed'], '*'] as const) {
      const out = webhooksOut(fakeKit().kit, { endpoints: [endpoint({ events })], fetch: fakeFetch().fetch, clock });
      out.dispose();
    }
    expect(() => webhooksOut(fakeKit().kit, { endpoints: [endpoint({ events: ['report.escalate'] as never })], fetch: fakeFetch().fetch, clock })).toThrow(RangeError);
    expect(() => webhooksOut(fakeKit().kit, { endpoints: [endpoint({ events: ['legal.hold'] as never })], fetch: fakeFetch().fetch, clock })).toThrow(RangeError);
  });

  it('delivers { id, type, at, data } signed, with the event as data and no extra field', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint({ events: ['report.escalated'] })], fetch: f.fetch, clock });
    k.emit(escalated);
    k.emit(closed);
    await wait(f, 1);
    expect(f.calls).toHaveLength(1);
    const b = bodyOf(f.calls[0]!);
    expect(Object.keys(b).sort()).toEqual(['at', 'data', 'id', 'type']);
    expect(b.type).toBe('report.escalated');
    expect(b.data).toEqual(escalated);
    expect(Object.keys(b.data).sort()).toEqual(['at', 'code', 'reportId', 'target', 'type']);
    const call = f.calls[0]!;
    expect(call.init.headers[DELIVERY_HEADER]).toBe(b.id);
    expect(call.init.headers[SIGNATURE_HEADER]).toBe(sign(SECRET, NOW / 1000, call.init.body));
    expect(call.init.headers[TIMESTAMP_HEADER]).toBe(String(NOW / 1000));
    expect(verify(SECRET, call.init.headers, call.init.body, NOW, new ReplayCache())).toBe(true);
    expect(call.init.body).not.toContain(ACCOUNT);
  });

  it('includeAccounts adds accounts to it and to rename.required, and to no other type', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint({ includeAccounts: true })], fetch: f.fetch, clock });
    for (const e of [escalated, renamed, closed]) k.emit(e);
    await wait(f, 3);
    const bodies = f.calls.map(bodyOf);
    expect(bodies.map((b) => b.type)).toEqual(['report.escalated', 'rename.required', 'report.closed']);
    expect(bodies[0]?.data).toEqual({ ...escalated, accounts: [ACCOUNT] });
    expect(bodies[1]?.data).toEqual({ ...renamed, accounts: [ACCOUNT] });
    expect(bodies[2]?.data).toEqual(closed);
  });

  it('without includeAccounts no delivery holds an account id', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint()], fetch: f.fetch, clock });
    for (const e of [escalated, renamed]) k.emit(e);
    await wait(f, 2);
    for (const c of f.calls) expect(c.init.body).not.toContain(ACCOUNT);
  });

  it('a real hold end to end: the delivery carries the report id, the code and the target ref, and no line, note or handle', async () => {
    const { world } = await import('./world.js');
    const w = await world();
    const filed = await w.file();
    const f = fakeFetch();
    webhooksOut(w.cw, { endpoints: [endpoint({ events: ['report.escalated'] })], fetch: f.fetch, clock: { now: () => w.clock.t } });
    await w.call('PUT', `/reports/${filed.id}/hold`, { role: 'senior', body: { code: 'safety_review' } });
    await wait(f, 1);
    const b = bodyOf(f.calls[0]!);
    expect(b.data).toEqual({ type: 'report.escalated', reportId: filed.id, at: w.clock.t, code: 'safety_review', target: filed.target });
    for (const bad of ['a line from the target', 'TargetName', 'senior']) expect(f.calls[0]!.init.body).not.toContain(bad);
  });
});
