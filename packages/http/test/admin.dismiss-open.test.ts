import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { BULK_DISMISS_MAX, NO_ACTION_DEFAULT_REASON, createChatwarden } from '@chatwarden/core';
import type { Chatwarden, KitEvent, Logger, RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, createRouter, playerRoutes, webhooksOut } from '@chatwarden/http';
import type { Authz, KitRequest, Role } from '@chatwarden/http';
import { errorOf, keysDeep, world } from './world.js';

// POST /reports/dismiss-open: a confirmed sweep of one person's open reports (their case) or one reporter's, built on
// cw.reports.dismissMany. Audit: a required summary row first, then one report.decide row per report closed (best effort).

const ROUTE = '/reports/dismiss-open';
const person = (ref: string, over: Record<string, unknown> = {}) => ({ scope: 'person', ref, ...over });
const reporter = (ref: string, over: Record<string, unknown> = {}) => ({ scope: 'reporter', ref, ...over });

type W = Awaited<ReturnType<typeof world>>;

/** `count` reports from ONE reporter (a key), each against a person of its own. Time moves on between them. */
async function fromReporter(w: W, key: string, count: number) {
  const ids: string[] = [];
  const targets: string[] = [];
  let reporterRef = '';
  for (let i = 0; i < count; i++) {
    const room = `rep-room-${key}-${i}-${ids.length}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: key }, 'Rep');
    w.cw.rooms.seat(room, 'p2', { clientKey: `${key}-target-${i}-${Math.random()}` }, 'Tgt');
    w.cw.chat.accept(room, 'p2', 'a line');
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    const rec = w.cw.reports.get(res.reportId)!;
    ids.push(res.reportId);
    targets.push(rec.targetPerson);
    reporterRef = rec.reporterPerson;
  }
  return { ids, targets, reporter: reporterRef };
}

/** `count` reports against ONE person, each from its own reporter. */
async function against(w: W, count: number) {
  const first = await w.file('harassment');
  const ids = [first.id];
  for (let i = 1; i < count; i++) ids.push((await w.fileAgainst(first, 'x')).id);
  return { ids, target: first.target, key: first.key };
}

const statusOf = (w: W, id: string) => w.cw.reports.get(id)?.status;

/** A world whose audit writes are also recorded in call order (the test clock is frozen, so stored rows share a time). */
async function recorded(over: Parameters<typeof world>[0] = {}) {
  const seq: Array<{ action: string; actor: string; target: unknown }> = [];
  const w = await world({
    ...over,
    wrap: (cw) => ({
      ...cw,
      audit: {
        ...cw.audit,
        record: (input) => {
          const ok = cw.audit.record(input);
          if (ok) seq.push({ action: input.action, actor: input.actor, target: input.target });
          return ok;
        },
      },
    }),
  });
  return { ...w, seq };
}

describe('POST /reports/dismiss-open: person scope', () => {
  it('a moderator dismisses all open reports about a person: each is no_action with the standard reason', async () => {
    const w = await world();
    const a = await against(w, 3);
    const other = await w.file();
    const res = await w.call('POST', ROUTE, { body: person(a.target) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, dryRun: false, open: 3, dismissed: 3, replayed: 0, skipped: { claimed: 0, decided: 0 }, more: false });
    for (const id of a.ids) {
      expect(w.store.loadReport(id)).toMatchObject({ status: 'dismissed', badFaith: false, actionedBy: 'ann', modNote: NO_ACTION_DEFAULT_REASON });
    }
    expect(statusOf(w, other.id)).toBe('open');
  });

  it('audit: one report.dismiss_case row first, then one report.decide row per dismissed report, in that order', async () => {
    const w = await recorded();
    const a = await against(w, 3);
    w.seq.length = 0;
    await w.call('POST', ROUTE, { body: person(a.target), actor: 'ann' });
    expect(w.seq.map((r) => r.action)).toEqual(['report.dismiss_case', 'report.decide', 'report.decide', 'report.decide']);
    expect(w.seq[0]).toMatchObject({ actor: 'ann', target: { type: 'person', ref: a.target } });
    expect(w.seq.slice(1).map((r) => r.target)).toEqual(expect.arrayContaining(a.ids.map((id) => ({ type: 'report', ref: id }))));
    expect(w.seq.slice(1).every((r) => r.actor === 'ann')).toBe(true);
    // The stored rows: the summary row has the role and no detail and no text.
    const stored = w.audit().filter((r) => r.action === 'report.dismiss_case');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ actor: 'ann', role: 'moderator', target: { type: 'person', ref: a.target } });
    expect('detail' in (stored[0] as object)).toBe(false);
    expect(w.audit().filter((r) => r.action === 'report.decide')).toHaveLength(3);
  });

  it('the summary row is required: when it cannot be written the answer is 500 and nothing is dismissed', async () => {
    const real = await world();
    const a = await against(real, 2);
    const failing = await world({
      wrap: (cw) => ({
        ...cw,
        audit: { ...cw.audit, record: (input) => (input.action === 'report.dismiss_case' ? false : cw.audit.record(input)) },
      }),
    });
    const b = await against(failing, 2);
    const res = await failing.call('POST', ROUTE, { body: person(b.target) });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    for (const id of b.ids) expect(statusOf(failing, id)).toBe('open');
    expect(a.ids).toHaveLength(2);
  });

  it('a failing per-report audit row is logged and the answer stays 200', async () => {
    const w = await world({
      wrap: (cw) => ({
        ...cw,
        audit: { ...cw.audit, record: (input) => (input.action === 'report.decide' ? false : cw.audit.record(input)) },
      }),
    });
    const a = await against(w, 2);
    const res = await w.call('POST', ROUTE, { body: person(a.target) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dismissed: 2 });
    for (const id of a.ids) expect(statusOf(w, id)).toBe('dismissed');
    expect(w.logged.filter(([e]) => e === 'chatwarden.http_audit_failed')).toHaveLength(2);
  });

  it('an unknown or never-reported person is 200 with zeros, and the same answer as a known one with nothing open', async () => {
    const w = await world();
    const quiet = w.person();
    const unknown = await w.call('POST', ROUTE, { body: person('s_nobody_here') });
    const known = await w.call('POST', ROUTE, { body: person(quiet) });
    const zeros = { ok: true, dryRun: false, open: 0, dismissed: 0, replayed: 0, skipped: { claimed: 0, decided: 0 }, more: false };
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(zeros);
    expect(known.body).toEqual(zeros);
  });

  it("the caller's own claim is released when no open report is left", async () => {
    const w = await world();
    const a = await against(w, 2);
    expect(w.cw.cases.claim(a.target, 'ann').ok).toBe(true);
    await w.call('POST', ROUTE, { body: person(a.target), actor: 'ann' });
    expect(w.cw.cases.holder(a.target)).toBeNull();
    // Someone else's claim on another case is never touched by this caller's sweep.
    const b = await against(w, 1);
    w.cw.cases.claim(b.target, 'bea');
    await w.call('POST', ROUTE, { body: person(b.target, { takeOver: true }), actor: 'sam', role: 'senior' });
    // Sam took the case over and swept it, so Sam's own claim ended with its last open report; Bea's is gone with the takeover.
    expect(w.cw.cases.holder(b.target)).toBeNull();
  });

  it('person scope: another moderator\'s claim is 409 claimed; a moderator\'s takeOver is 409; a senior\'s takeOver audits case.takeover first and dismisses', async () => {
    const w = await recorded();
    const a = await against(w, 2);
    w.cw.cases.claim(a.target, 'bea');
    const plain = await w.call('POST', ROUTE, { body: person(a.target), actor: 'ann' });
    expect(plain.status).toBe(409);
    expect(errorOf(plain)).toBe('claimed');
    const taken = await w.call('POST', ROUTE, { body: person(a.target, { takeOver: true }), actor: 'ann', role: 'moderator' });
    expect(taken.status).toBe(409);
    for (const id of a.ids) expect(statusOf(w, id)).toBe('open');
    expect(w.audit()).toEqual([]);

    const ok = await w.call('POST', ROUTE, { body: person(a.target, { takeOver: true }), actor: 'sam', role: 'senior' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ dismissed: 2 });
    const actions = w.seq.map((r) => r.action);
    expect(actions.slice(0, 2)).toEqual(['case.takeover', 'report.dismiss_case']);
    expect(actions.slice(2)).toEqual(['report.decide', 'report.decide']);
    expect(w.audit().find((r) => r.action === 'case.takeover')).toMatchObject({ actor: 'sam', target: { type: 'person', ref: a.target } });
    for (const id of a.ids) expect(statusOf(w, id)).toBe('dismissed');
  });

  it('the 409 body names the holder and carries no report id', async () => {
    const w = await world();
    const a = await against(w, 1);
    w.cw.cases.claim(a.target, 'bea');
    const res = await w.call('POST', ROUTE, { body: person(a.target), actor: 'ann' });
    expect(res.body).toMatchObject({ error: 'claimed', by: 'bea' });
    expect(JSON.stringify(res.body)).not.toContain(a.ids[0]);
  });

  it('dryRun counts, writes no audit row, closes nothing and takes no case over', async () => {
    const w = await world();
    const a = await against(w, 3);
    w.cw.cases.claim(a.target, 'bea');
    const token = w.cw.changes.token();
    // Even a senior's takeOver on a dry run moves nothing.
    const dry = await w.call('POST', ROUTE, { body: person(a.target, { dryRun: true, takeOver: true }), actor: 'sam', role: 'senior' });
    expect(dry.status).toBe(200);
    expect(dry.body).toEqual({ ok: true, dryRun: true, open: 0, dismissed: 0, replayed: 0, skipped: { claimed: 3, decided: 0 }, more: false });
    expect(w.audit()).toEqual([]);
    expect(w.cw.cases.holder(a.target)).toMatchObject({ by: 'bea' });
    expect(w.cw.changes.token()).toBe(token);
    for (const id of a.ids) expect(statusOf(w, id)).toBe('open');
    // An unclaimed case previews its whole count.
    const free = await against(w, 2);
    const preview = await w.call('POST', ROUTE, { body: person(free.target, { dryRun: true }) });
    expect(preview.body).toMatchObject({ dryRun: true, open: 2, dismissed: 0 });
    expect(w.audit()).toEqual([]);
  });

  it('more is true past 200 and a second call finishes; a retried identical request dismisses 0', async () => {
    const w = await recorded();
    const a = await against(w, BULK_DISMISS_MAX + 2);
    w.cw.cases.claim(a.target, 'ann');
    const first = await w.call('POST', ROUTE, { body: person(a.target), actor: 'ann' });
    expect(first.body).toMatchObject({ open: BULK_DISMISS_MAX, dismissed: BULK_DISMISS_MAX, more: true });
    // Two reports are still open, so the caller's claim on the case is kept.
    expect(w.cw.cases.holder(a.target)).toMatchObject({ by: 'ann' });
    const second = await w.call('POST', ROUTE, { body: person(a.target), actor: 'ann' });
    expect(second.body).toMatchObject({ dismissed: 2, more: false });
    expect(w.cw.cases.holder(a.target)).toBeNull();
    const third = await w.call('POST', ROUTE, { body: person(a.target) });
    expect(third.body).toMatchObject({ open: 0, dismissed: 0, replayed: 0, more: false });
    expect(w.seq.filter((r) => r.action === 'report.decide')).toHaveLength(BULK_DISMISS_MAX + 2);
  }, 60_000);
});

describe('POST /reports/dismiss-open: reporter scope', () => {
  it("report.dismiss_reporter, reports against different people closed, other reporters' reports untouched", async () => {
    const w = await recorded();
    const a = await fromReporter(w, 'rk-a', 4);
    const b = await fromReporter(w, 'rk-b', 2);
    const res = await w.call('POST', ROUTE, { body: reporter(a.reporter) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ open: 4, dismissed: 4, more: false });
    for (const id of a.ids) expect(statusOf(w, id)).toBe('dismissed');
    for (const id of b.ids) expect(statusOf(w, id)).toBe('open');
    const rows = w.seq.map((r) => r.action);
    expect(rows[0]).toBe('report.dismiss_reporter');
    expect(rows.slice(1)).toEqual(['report.decide', 'report.decide', 'report.decide', 'report.decide']);
    expect(w.audit().find((r) => r.action === 'report.dismiss_reporter')).toMatchObject({ target: { type: 'person', ref: a.reporter } });
    expect(w.audit().some((r) => r.action === 'report.dismiss_case')).toBe(false);
  });

  it('skips cases held by others and says how many; takeOver is refused as an unknown key', async () => {
    const w = await world();
    const a = await fromReporter(w, 'rk-a', 3);
    w.cw.cases.claim(a.targets[1] as string, 'bea');
    const refused = await w.call('POST', ROUTE, { body: reporter(a.reporter, { takeOver: true }), role: 'senior' });
    expect(refused.status).toBe(400);
    expect(errorOf(refused)).toBe('forbidden_key');
    expect(w.audit()).toEqual([]);
    const res = await w.call('POST', ROUTE, { body: reporter(a.reporter), actor: 'ann' });
    expect(res.body).toMatchObject({ open: 2, dismissed: 2, skipped: { claimed: 1, decided: 0 } });
    expect(a.ids.map((id) => statusOf(w, id))).toEqual(['dismissed', 'open', 'dismissed']);
    expect(w.cw.cases.holder(a.targets[1] as string)).toMatchObject({ by: 'bea' });
  });

  it("releases the caller's own claims on the cases it closed", async () => {
    const w = await world();
    const a = await fromReporter(w, 'rk-a', 2);
    w.cw.cases.claim(a.targets[0] as string, 'ann');
    await w.call('POST', ROUTE, { body: reporter(a.reporter), actor: 'ann' });
    expect(w.cw.cases.holder(a.targets[0] as string)).toBeNull();
  });

  it('dryRun on a reporter writes nothing and counts the claimed cases', async () => {
    const w = await world();
    const a = await fromReporter(w, 'rk-a', 3);
    w.cw.cases.claim(a.targets[0] as string, 'bea');
    const res = await w.call('POST', ROUTE, { body: reporter(a.reporter, { dryRun: true }) });
    expect(res.body).toEqual({ ok: true, dryRun: true, open: 2, dismissed: 0, replayed: 0, skipped: { claimed: 1, decided: 0 }, more: false });
    expect(w.audit()).toEqual([]);
    for (const id of a.ids) expect(statusOf(w, id)).toBe('open');
  });
});

describe('POST /reports/dismiss-open: permissions and bodies', () => {
  it('reports.decide.bulk raised to senior gives a moderator 403 and changes nothing; a senior may', async () => {
    const w = await world({ permissions: { 'reports.decide.bulk': 'senior' } });
    const a = await against(w, 2);
    const no = await w.call('POST', ROUTE, { body: person(a.target), role: 'moderator' });
    expect(no.status).toBe(403);
    expect(errorOf(no)).toBe('forbidden');
    expect(w.audit()).toEqual([]);
    for (const id of a.ids) expect(statusOf(w, id)).toBe('open');
    // A single dismissal is still the moderator's own.
    expect((await w.call('POST', `/reports/${a.ids[0]}/decide`, { body: { verdict: 'no_action', actions: [] }, role: 'moderator' })).status).toBe(200);
    expect((await w.call('POST', ROUTE, { body: person(a.target), role: 'senior' })).status).toBe(200);
  });

  it('a bulk also needs reports.decide: lowering one does not bypass the other', async () => {
    const w = await world({ permissions: { 'reports.decide': 'senior', 'reports.decide.bulk': 'moderator' } });
    const a = await against(w, 1);
    expect((await w.call('POST', ROUTE, { body: person(a.target), role: 'moderator' })).status).toBe(403);
    expect(statusOf(w, a.ids[0] as string)).toBe('open');
  });

  it('a reports.read-only caller is 403 and an unauthenticated one 401', async () => {
    const w = await world({ permissions: { 'reports.decide': 'owner', 'reports.decide.bulk': 'owner' } });
    const a = await against(w, 1);
    expect((await w.call('POST', ROUTE, { body: person(a.target), role: 'senior' })).status).toBe(403);
    expect((await w.call('POST', ROUTE, { body: person(a.target), role: null })).status).toBe(401);
    expect(statusOf(w, a.ids[0] as string)).toBe('open');
  });

  it('authorization comes before body validation', async () => {
    const w = await world({ permissions: { 'reports.decide.bulk': 'owner' } });
    expect((await w.call('POST', ROUTE, { role: 'moderator', raw: '{nope' })).status).toBe(403);
    expect((await w.call('POST', ROUTE, { role: null, raw: '{nope' })).status).toBe(401);
  });

  const bad: Array<[string, unknown]> = [
    ['an unknown scope', { scope: 'everyone', ref: 's_x' }],
    ['no scope', { ref: 's_x' }],
    ['a missing ref', { scope: 'person' }],
    ['a ref that is not a string', { scope: 'person', ref: 5 }],
    ['a ref that is null', { scope: 'person', ref: null }],
    ['an empty ref', { scope: 'person', ref: '' }],
    ['a ref over 128 characters', { scope: 'person', ref: 'a'.repeat(129) }],
    ['a ref with a bad character', { scope: 'person', ref: 's x/../y' }],
    ['takeOver that is not a boolean', { scope: 'person', ref: 's_x', takeOver: 'yes' }],
    ['dryRun that is not a boolean', { scope: 'person', ref: 's_x', dryRun: 1 }],
    ['a scope that is an object', { scope: { person: 's_x' }, ref: 's_x' }],
    ['an array body', [{ scope: 'person', ref: 's_x' }]],
    ['a string body', 'person'],
    ['a null body', null],
  ];
  it.each(bad)('is 400 for %s', async (_name, body) => {
    const w = await world();
    await against(w, 1);
    const res = await w.call('POST', ROUTE, { body });
    expect(res.status).toBe(400);
    expect(w.audit()).toEqual([]);
  });

  it('is 400 for no body at all and for unparseable JSON', async () => {
    const w = await world();
    expect((await w.call('POST', ROUTE, {})).status).toBe(400);
    expect((await w.call('POST', ROUTE, { raw: '{nope' })).status).toBe(400);
  });

  it.each([['reason', 'because'], ['limit', 5], ['ids', ['r1']], ['ignoreClaims', true], ['extra', 1]])(
    'extra key %s is 400 forbidden_key and writes nothing (a sweep always carries the standard reason)',
    async (key, value) => {
      const w = await world();
      const a = await against(w, 1);
      const res = await w.call('POST', ROUTE, { body: person(a.target, { [key]: value }) });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('forbidden_key');
      expect(w.audit()).toEqual([]);
      expect(statusOf(w, a.ids[0] as string)).toBe('open');
    },
  );

  it('the response and the error bodies contain no report id, subject id or reporter ref', async () => {
    const w = await world();
    const a = await against(w, 2);
    const b = await fromReporter(w, 'rk-leak', 2);
    const bodies = [
      (await w.call('POST', ROUTE, { body: person(a.target) })).body,
      (await w.call('POST', ROUTE, { body: reporter(b.reporter) })).body,
      (await w.call('POST', ROUTE, { body: person(a.target, { dryRun: true }) })).body,
      (await w.call('POST', ROUTE, { body: { scope: 'person' } })).body,
    ];
    const text = JSON.stringify(bodies);
    for (const secret of [...a.ids, ...b.ids, a.target, b.reporter, ...b.targets]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/s_[A-Za-z0-9_-]{22}/);
    for (const body of bodies) {
      const keys = [...keysDeep(body)];
      expect(keys.every((k) => ['ok', 'dryRun', 'open', 'dismissed', 'replayed', 'skipped', 'claimed', 'decided', 'more', 'error', 'message'].includes(k))).toBe(true);
    }
  });

  it('the response is not cached', async () => {
    const w = await world();
    const res = await w.call('POST', ROUTE, { body: person('s_nobody') });
    expect(res.headers?.['cache-control']).toBe('no-store');
  });
});

describe('GET /me and the table', () => {
  it('has reports.decide.bulk in .can, for a moderator by default', async () => {
    const w = await world();
    const me = await w.call('GET', '/me', { role: 'moderator' });
    expect((me.body as { can: Record<string, boolean> }).can['reports.decide.bulk']).toBe(true);
    const raised = await world({ permissions: { 'reports.decide.bulk': 'senior' } });
    expect(((await raised.call('GET', '/me', { role: 'moderator' })).body as { can: Record<string, boolean> }).can['reports.decide.bulk']).toBe(false);
    expect(((await raised.call('GET', '/me', { role: 'senior' })).body as { can: Record<string, boolean> }).can['reports.decide.bulk']).toBe(true);
  });
});

describe('the figure and the sweep stay on staff channels', () => {
  const FIGURE_KEYS = ['reporterAccuracy', 'unfounded', 'falseRate', 'habitual', 'accuracy', 'noticeable'];

  it('no player route, webhook payload (out) or event carries reporterAccuracy, unfounded, falseRate or habitual', async () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    const clock = { t: 1_800_000_000_000, now: () => clock.t };
    const logger: Logger = { warn() {} };
    const cw: Chatwarden = await createChatwarden({ store, secret: 'leak-secret', platform: { identify: (c) => c as RawWho }, clock, logger, retention: false });
    const events: KitEvent[] = [];
    cw.on('*', (e) => void events.push(e));
    const bodies: string[] = [];
    const out = webhooksOut(cw, {
      endpoints: [{ url: 'https://hooks.example.test/in', secret: 'x'.repeat(40), events: '*' }],
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body));
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
      clock,
      logger,
    });
    // A habitual reporter: six unfounded reports, then a fresh report, then a sweep of the fresh one.
    const room = (n: number) => `leak-room-${n}`;
    let reporterRef = '';
    for (let i = 0; i < 7; i++) {
      cw.rooms.seat(room(i), 'p1', { clientKey: 'habitual-reporter' }, 'Rep');
      cw.rooms.seat(room(i), 'p2', { clientKey: `leak-target-${i}` }, 'Tgt');
      cw.chat.accept(room(i), 'p2', 'a line');
      clock.t += 1000;
      const res = await cw.reports.submit({ roomId: room(i), reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
      if (!res.ok) throw new Error('refused');
      reporterRef = cw.reports.get(res.reportId)!.reporterPerson;
      if (i < 6) await cw.decide({ reportId: res.reportId, verdict: 'no_action', actions: [], actor: 'ann' });
    }
    const authorize = (req: KitRequest): Authz | null => ({ actor: 'ann', role: (req.headers['x-role'] ?? 'moderator') as Role });
    const staff = createRouter(adminRoutes(cw, { authorize }));
    const queue = await staff({ method: 'GET', path: '/reports', query: { status: 'open' }, headers: {}, body: undefined });
    expect(JSON.stringify(queue.body)).toContain('reporterAccuracy'); // staff do get it
    const swept = await staff({ method: 'POST', path: ROUTE, query: {}, headers: {}, body: undefined, rawBody: JSON.stringify(reporter(reporterRef)) });
    expect(swept.status).toBe(200);

    const players = createRouter(playerRoutes(cw, { identify: (req) => ({ clientKey: req.headers['x-key'] ?? 'habitual-reporter' }) }));
    const playerBodies: unknown[] = [];
    for (const path of ['/notices', '/record', '/rules']) {
      const r = await players({ method: 'GET', path, query: {}, headers: {}, body: undefined });
      playerBodies.push(r.body);
    }
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    out.dispose();

    const haystacks = [JSON.stringify(playerBodies), JSON.stringify(events), bodies.join('\n')];
    for (const text of haystacks) for (const key of FIGURE_KEYS) expect(text).not.toContain(key);
    expect(events.some((e) => e.type === 'report.closed')).toBe(true);
  });
});
