import { afterEach, describe, expect, it, vi } from 'vitest';
import { webhooksOut } from '../src/webhooks/out.js';
import type { WebhookEndpoint } from '../src/webhooks/out.js';
import { world } from './world.js';

// U5: report.created carries urgent, report.handoff goes out with ids and a time only, and an endpoint that did not list report.handoff does not get it.

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
const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ url: 'https://hooks.example.test/in', secret: SECRET, events: ['report.created', 'report.handoff'], ...over });

let n = 0;
async function fileUnder(w: Awaited<ReturnType<typeof world>>, reason: string) {
  n += 1;
  const room = `wh-room-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `wh-reporter-${n}-cccccccccccccc` }, 'ReporterName');
  w.cw.rooms.seat(room, 'p2', { clientKey: `wh-target-${n}-dddddddddddddd` }, 'TargetName');
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', reason, note: 'NOTE-TEXT-quissel' });
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  return res.reportId;
}

describe('webhooksOut and the urgent lane', () => {
  it('signs report.created with urgent true and report.handoff with ids and a time, and never a note, text or handle', async () => {
    const w = await world();
    const f = fakeFetch();
    const hook = webhooksOut(w.cw, { endpoints: [endpoint()], fetch: f.fetch, clock: { now: () => NOW } });
    const id = await fileUnder(w, 'threat');
    await fileUnder(w, 'harassment');
    await vi.waitFor(() => expect(f.calls.length).toBe(2));
    expect(bodyOf(f.calls[0]!)).toMatchObject({ type: 'report.created', data: { reportId: id, urgent: true, reportedReason: 'threat' } });
    expect(bodyOf(f.calls[1]!).data).toMatchObject({ urgent: false });
    w.cw.cases.handoff(id, 'mod_ann');
    await vi.waitFor(() => expect(f.calls.length).toBe(3));
    const handoff = bodyOf(f.calls[2]!);
    expect(handoff.type).toBe('report.handoff');
    expect(Object.keys(handoff.data).sort()).toEqual(['at', 'reportId', 'type']);
    expect(handoff.data).toMatchObject({ reportId: id, at: w.clock.t });
    for (const c of f.calls) {
      expect(c.init.headers).toHaveProperty('x-chatwarden-signature');
      for (const leak of ['NOTE-TEXT', 'quissel', 'a line from the target', 'TargetName', 'ReporterName', 'mod_ann']) expect(c.init.body, leak).not.toContain(leak);
    }
    hook.dispose();
  });

  it('an endpoint that did not list report.handoff does not get it, one that did not list report.created does not get that', async () => {
    const w = await world();
    const created = fakeFetch();
    const onlyHandoff = fakeFetch();
    const a = webhooksOut(w.cw, { endpoints: [endpoint({ events: ['report.created'] })], fetch: created.fetch, clock: { now: () => NOW } });
    const b = webhooksOut(w.cw, { endpoints: [endpoint({ events: ['report.handoff'] })], fetch: onlyHandoff.fetch, clock: { now: () => NOW } });
    const id = await fileUnder(w, 'threat');
    w.cw.cases.handoff(id, 'mod_ann');
    await vi.waitFor(() => expect(created.calls.length).toBe(1));
    await vi.waitFor(() => expect(onlyHandoff.calls.length).toBe(1));
    expect(bodyOf(created.calls[0]!).type).toBe('report.created');
    expect(bodyOf(onlyHandoff.calls[0]!).type).toBe('report.handoff');
    a.dispose();
    b.dispose();
  });

  it('events accepts report.handoff, and an unknown name is still a RangeError', async () => {
    const w = await world();
    const f = fakeFetch();
    expect(() => webhooksOut(w.cw, { endpoints: [endpoint({ events: ['report.handoff'] })], fetch: f.fetch }).dispose()).not.toThrow();
    expect(() => webhooksOut(w.cw, { endpoints: [endpoint({ events: ['report.handoffs' as never] })], fetch: f.fetch })).toThrow(RangeError);
  });

  it('a second hand-off call raises no second delivery', async () => {
    const w = await world();
    const f = fakeFetch();
    const hook = webhooksOut(w.cw, { endpoints: [endpoint({ events: ['report.handoff'] })], fetch: f.fetch, clock: { now: () => NOW } });
    const id = await fileUnder(w, 'threat');
    w.cw.cases.handoff(id, 'mod_ann');
    w.cw.cases.handoff(id, 'mod_bea');
    await vi.waitFor(() => expect(f.calls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.length).toBe(1);
    hook.dispose();
  });
});
