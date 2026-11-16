import type { Chatwarden, StaffReport } from '@chatwarden/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coop } from '../src/coop/index.js';
import { API_KEY, COOP_URL, ITEM_TYPES, TYPE_USER, coopWorld, makeCoop, reportProblems, sharedPair, until } from './coop-world.js';
import type { CoopWorld } from './coop-world.js';
import { world } from './world.js';

// K5 C2: a kit report becomes a Coop job. Nothing here touches the network: the adapter's `fetch` is the fake Coop, and its clock and jitter are injected.

afterEach(() => {
  vi.useRealTimers();
});

const sent = (c: CoopWorld) => c.fake.reports();
const linkOf = (c: CoopWorld, id: string) => c.cw.links.get('coop-report', id);
const coopLogs = (c: CoopWorld) => c.logged.filter(([e]) => e.startsWith('chatwarden.coop'));

/** A world, then fake timers (the kit's own setup needs real ones). */
const fakeWorld = async (over: Parameters<typeof coopWorld>[0] = {}) => {
  const c = await coopWorld(over);
  vi.useFakeTimers();
  return c;
};

/** With fake timers: let the queue run (microtasks and timers due now), then move `ms`. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('outbound: report.created', () => {
  it('sends one request with the key header, the documented body, in the queue order; the link row carries the coop id', async () => {
    const c = await coopWorld();
    const a = await c.w.file('harassment');
    const b = await c.w.file('harassment');
    await until(() => sent(c).length === 2 && linkOf(c, b.id) !== null, 'two sends');
    const [first, second] = sent(c);
    for (const call of [first!, second!]) {
      expect(call.url).toBe(`${COOP_URL}/api/v1/report`);
      expect(call.headers['x-api-key']).toBe(API_KEY);
      expect(call.headers['content-type']).toBe('application/json');
      expect(call.redirect).toBe('manual');
    }
    expect((first!.body as { reportedItem: { id: string } }).reportedItem.id).toBe(a.id);
    expect((second!.body as { reportedItem: { id: string } }).reportedItem.id).toBe(b.id);
    expect(c.fake.schemaProblems).toEqual([[], []]);
    expect(reportProblems(first!.body)).toEqual([]);
    expect(linkOf(c, a.id)).toEqual({ system: 'coop-report', ref: a.id, external: 'coop-job-1', state: 'sent', at: c.w.clock.now() });
    expect(linkOf(c, b.id)?.external).toBe('coop-job-2');
    // The body carries the staff refs and the line text the adopter opted into, and nothing else that identifies a player.
    const text = JSON.stringify(first!.body);
    expect(text).toContain('a line from the target');
    expect(text).not.toContain('raw-client-key');
    expect(text).not.toContain('198.51.100.23');
    expect((first!.body as { reporter: { typeId: string } }).reporter.typeId).toBe(TYPE_USER);
    expect(ITEM_TYPES.user).toBe(TYPE_USER);
    expect(coopLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('evidence none sends no lines', async () => {
    const c = await coopWorld({ options: { evidence: 'none' } });
    const a = await c.w.file('harassment');
    await until(() => linkOf(c, a.id) !== null, 'send');
    expect(JSON.stringify(sent(c)[0]!.body)).not.toContain('a line from the target');
    expect(c.fake.schemaProblems).toEqual([[]]);
    c.adapter.dispose();
  });

  it('a 201 without a readable id still records the link with external unknown', async () => {
    for (const body of [{}, { reportId: 5 }, { reportId: 'has space' }, { reportId: '' }, 'text', null, { reportId: 'x'.repeat(200) }]) {
      const c = await coopWorld();
      c.fake.script.push({ status: 201, body });
      const a = await c.w.file('harassment');
      await until(() => linkOf(c, a.id) !== null, 'link');
      expect(linkOf(c, a.id)).toMatchObject({ external: 'unknown', state: 'sent' });
      c.adapter.dispose();
    }
  });

  it('a 400 is final and logged by status only; a 401 is final; a redirect is final and never followed', async () => {
    for (const status of [400, 401, 403, 404, 302]) {
      const c = await fakeWorld();
      c.fake.script.push({ status, headers: status === 302 ? { location: 'https://evil.example.test/steal' } : {} });
      await c.w.file('harassment');
      await tick(60_000);
      expect(sent(c), String(status)).toHaveLength(1);
      expect(coopLogs(c)).toEqual([['chatwarden.coop_failed', { status, attempts: 1 }]]);
      c.adapter.dispose();
    }
  });

  it('a 429 honours retry-after, then the report goes through', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ status: 429, headers: { 'retry-after': '3' } });
    const a = await c.w.file('harassment');
    await tick();
    expect(sent(c)).toHaveLength(1);
    await tick(2900);
    expect(sent(c)).toHaveLength(1);
    await tick(200);
    expect(sent(c)).toHaveLength(2);
    expect(linkOf(c, a.id)?.state).toBe('sent');
    expect(coopLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('a 503 retries on the backoff then succeeds', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ status: 503 }, { status: 503 });
    const a = await c.w.file('harassment');
    await tick();
    expect(sent(c)).toHaveLength(1);
    await tick(1000);
    expect(sent(c)).toHaveLength(2);
    await tick(2000);
    expect(sent(c)).toHaveLength(3);
    expect(linkOf(c, a.id)?.state).toBe('sent');
    expect(coopLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('6 failures are logged once and the link is not written', async () => {
    const c = await fakeWorld();
    for (let i = 0; i < 6; i++) c.fake.script.push({ status: 503 });
    const a = await c.w.file('harassment');
    await tick(120_000);
    expect(sent(c)).toHaveLength(6);
    expect(coopLogs(c)).toEqual([['chatwarden.coop_failed', { status: 503, attempts: 6 }]]);
    expect(linkOf(c, a.id)).toBeNull();
    c.adapter.dispose();
  });

  it('a network failure retries and is logged by class only', async () => {
    const c = await fakeWorld();
    for (let i = 0; i < 6; i++) c.fake.script.push({ status: 0, fail: true });
    await c.w.file('harassment');
    await tick(120_000);
    expect(coopLogs(c)).toEqual([['chatwarden.coop_failed', { error: 'TypeError', attempts: 6 }]]);
    c.adapter.dispose();
  });
});

describe('outbound: the link ledger and sweep', () => {
  it('a link that already exists is not sent again', async () => {
    const w = await world();
    const a = await w.file('harassment');
    w.cw.links.put({ system: 'coop-report', ref: a.id, external: 'earlier-job', state: 'sent', at: w.clock.now() });
    const c = makeCoop(w);
    expect(await c.adapter.sweep()).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sent(c)).toHaveLength(0);
    expect(w.cw.links.get('coop-report', a.id)?.external).toBe('earlier-job');
    c.adapter.dispose();
  });

  it('after a simulated crash between the 201 and the put, sweep sends it once more and writes the link', async () => {
    let failPut = true;
    const wrapKit = (cw: Chatwarden): Chatwarden => ({
      ...cw,
      links: {
        ...cw.links,
        put: (row) => {
          if (failPut) {
            failPut = false;
            throw new Error('crash before the link write');
          }
          cw.links.put(row);
        },
      },
    });
    const c = await coopWorld({ wrapKit });
    const a = await c.w.file('harassment');
    await until(() => sent(c).length === 1, 'first send');
    await until(() => c.logged.length > 0, 'the failed put is logged');
    expect(c.logged).toEqual([['chatwarden.coop_failed', { op: 'link', error: 'Error' }]]);
    expect(linkOf(c, a.id)).toBeNull();
    expect(await c.adapter.sweep()).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sent(c)).toHaveLength(2);
    expect(linkOf(c, a.id)?.state).toBe('sent');
    // Nothing is left to send.
    expect(await c.adapter.sweep()).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sent(c)).toHaveLength(2);
    c.adapter.dispose();
  });

  it('sweep ignores closed reports, reports older than catchUpMs and reports with a link, and counts sent, skipped and failed', async () => {
    const w = await world();
    const HOUR = 3_600_000;
    const old = await w.file('harassment');
    w.clock.t += 2 * HOUR;
    const open = await w.file('harassment');
    const closed = await w.file('harassment');
    const linked = await w.file('harassment');
    const failing = await w.file('harassment');
    const res = await w.cw.decide({ reportId: closed.id, verdict: 'no_action', actions: [], actor: 'ann', source: 'moderator' });
    expect(res.ok).toBe(true);
    w.cw.links.put({ system: 'coop-report', ref: linked.id, external: 'x', state: 'sent', at: w.clock.now() });
    const c = makeCoop(w, { options: { catchUpMs: HOUR } });
    // The newest report (`failing`) gets a final 400.
    c.fake.script.push({ status: 400 });
    const result = await c.adapter.sweep();
    // Newest first: failing (400), open (201). linked is skipped; closed and old are not looked at.
    expect(result).toEqual({ sent: 1, skipped: 1, failed: 1 });
    const ids = sent(c).map((x) => (x.body as { reportedItem: { id: string } }).reportedItem.id);
    expect(ids.sort()).toEqual([failing.id, open.id].sort());
    expect(ids).not.toContain(old.id);
    expect(ids).not.toContain(closed.id);
    expect(w.cw.links.get('coop-report', open.id)?.state).toBe('sent');
    expect(w.cw.links.get('coop-report', failing.id)).toBeNull();
    c.adapter.dispose();
  });

  it('sweep reads at most 5 pages of 200 and queues at most what the queue holds', async () => {
    const w = await world();
    const real = await w.file('harassment');
    const template = w.cw.reports.get(real.id) as StaffReport;
    let pages = 0;
    const wrapKit = (cw: Chatwarden): Chatwarden => ({
      ...cw,
      reports: {
        ...cw.reports,
        list: (q) => {
          pages++;
          expect(q?.status).toBe('open');
          expect(q?.limit).toBe(200);
          const items = Array.from({ length: 200 }, (_, i) => ({ ...template, id: `fake-${pages}-${i}` }));
          return { items, next: `cursor-${pages}` };
        },
        get: (id: string) => (id === real.id ? template : null),
      },
    });
    const c = makeCoop(w, { wrapKit });
    const result = await c.adapter.sweep();
    expect(pages).toBe(5);
    // Every fake id is unknown to the kit at send time: skipped, never sent.
    expect(result).toEqual({ sent: 0, skipped: 1000, failed: 0 });
    expect(sent(c)).toHaveLength(0);
    c.adapter.dispose();
  });

  it('a sweep over a failing store is logged by class and returns what it counted', async () => {
    const w = await world();
    await w.file('harassment');
    const wrapKit = (cw: Chatwarden): Chatwarden => ({
      ...cw,
      reports: {
        ...cw.reports,
        list: () => {
          throw new Error('store down snerp');
        },
      },
    });
    const c = makeCoop(w, { wrapKit });
    expect(await c.adapter.sweep()).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(c.logged).toEqual([['chatwarden.coop_failed', { op: 'sweep', error: 'Error' }]]);
    c.adapter.dispose();
  });
});

describe('outbound: the AI severity hook', () => {
  const run = async (hook: (r: StaffReport) => unknown) => {
    const c = await coopWorld({ options: { aiSeverity: hook } });
    const a = await c.w.file('harassment');
    await until(() => linkOf(c, a.id) !== null, 'send');
    const body = sent(c)[0]!.body as { reportedItem: { data: Record<string, unknown> } };
    c.adapter.dispose();
    return { data: body.reportedItem.data, problems: c.fake.schemaProblems };
  };

  it('a number rides in data (the hook may be async and receives the report)', async () => {
    const seen: string[] = [];
    const a = await run((r) => {
      seen.push(r.id);
      return 72;
    });
    expect(a.data['aiSeverity']).toBe(72);
    expect(seen).toHaveLength(1);
    const b = await run(async () => 0);
    expect(b.data['aiSeverity']).toBe(0);
  });

  it('a throw, a rejection, NaN, 101, a string or nothing drops the field and sends the report', async () => {
    const hooks: Array<() => unknown> = [
      () => {
        throw new Error('ai down');
      },
      () => Promise.reject(new Error('ai down')),
      () => Number.NaN,
      () => 101,
      () => -1,
      () => '72',
      () => undefined,
    ];
    for (const hook of hooks) {
      const r = await run(hook);
      expect(r.data['aiSeverity']).toBeUndefined();
      expect(r.problems).toEqual([[]]);
    }
  });
});

describe('outbound: what is logged and what is sent', () => {
  it('no log line contains the api key, a url, a report id, a subject id or any chat text; the request never follows a redirect', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ status: 400 }, { status: 302, headers: { location: 'https://evil.example.test/' } });
    for (let i = 0; i < 6; i++) c.fake.script.push({ status: 500 });
    c.fake.script.push({ status: 0, fail: true });
    const reports = [];
    for (let i = 0; i < 4; i++) reports.push(await c.w.file('harassment'));
    await tick(300_000);
    expect(coopLogs(c).length).toBeGreaterThan(2);
    const text = JSON.stringify(c.logged);
    for (const r of reports) {
      expect(text).not.toContain(r.id);
      expect(text).not.toContain(r.target);
      expect(text).not.toContain(r.reporter);
    }
    for (const needle of [API_KEY, 'coop.example.test', 'https://', 'a line from the target', 'TargetName', 'Rep', 'raw-client-key', 'room', '198.51.100']) {
      expect(text.includes(needle), needle).toBe(false);
    }
    for (const call of sent(c)) expect(call.redirect).toBe('manual');
    c.adapter.dispose();
  });
});

describe('outbound: lifecycle', () => {
  it('dispose unsubscribes, aborts the request in flight, clears timers and later events send nothing', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ status: 0, hang: true });
    const a = await c.w.file('harassment');
    await tick();
    expect(sent(c)).toHaveLength(1);
    c.adapter.dispose();
    await tick(120_000);
    expect(sent(c)).toHaveLength(1);
    expect(linkOf(c, a.id)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await c.w.file('harassment');
    await tick(120_000);
    expect(sent(c)).toHaveLength(1);
    expect(await c.adapter.sweep()).toEqual({ sent: 0, skipped: 0, failed: 0 });
    c.adapter.dispose();
  });

  it('dispose while a retry waits drops it: no further request, no write', async () => {
    const c = await fakeWorld();
    c.fake.script.push({ status: 503 });
    const a = await c.w.file('harassment');
    await tick();
    expect(sent(c)).toHaveLength(1);
    c.adapter.dispose();
    await tick(120_000);
    expect(sent(c)).toHaveLength(1);
    expect(linkOf(c, a.id)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a store without links is a RangeError at construction, and nothing is subscribed', async () => {
    const w = await world();
    let subscribed = 0;
    const kit = { ...w.cw, links: { ...w.cw.links, supported: false }, on: ((...args: Parameters<Chatwarden['on']>) => (subscribed++, w.cw.on(...args))) as Chatwarden['on'] } as Chatwarden;
    expect(() => coop(kit, { baseUrl: COOP_URL, apiKey: API_KEY, webhookPublicKey: sharedPair().publicPem, itemTypes: { ...ITEM_TYPES }, evidence: 'none', actions: {} })).toThrow(RangeError);
    expect(subscribed).toBe(0);
  });

  it('a bad option is a RangeError from coop(), the same as from the options check', async () => {
    const w = await world();
    expect(() => coop(w.cw, { baseUrl: COOP_URL, apiKey: API_KEY, webhookPublicKey: sharedPair().publicPem, itemTypes: { ...ITEM_TYPES }, actions: {} } as never)).toThrow(/evidence/);
  });

  it('a report that closed before its turn is not sent', async () => {
    const c = await fakeWorld();
    // The first report hangs, times out and is retried; the second waits behind it and is decided in the hub meanwhile.
    c.fake.script.push({ status: 0, hang: true });
    const a = await c.w.file('harassment');
    const b = await c.w.file('harassment');
    await tick();
    expect(sent(c)).toHaveLength(1);
    const res = await c.w.cw.decide({ reportId: b.id, verdict: 'no_action', actions: [], actor: 'ann', source: 'moderator' });
    expect(res.ok).toBe(true);
    await tick(30_000);
    expect(sent(c)).toHaveLength(2);
    expect(linkOf(c, a.id)?.state).toBe('sent');
    expect(linkOf(c, b.id)).toBeNull();
    c.adapter.dispose();
  });
});
