import { describe, expect, it } from 'vitest';
import { errorOf, keysDeep, world } from './world.js';

// U6: the staff workflow over HTTP (desk.workflow): comments, a second look, escalation. Off: every workflow route is 404 and the bodies carry no trace of them.

type W = Awaited<ReturnType<typeof world>>;
let n = 0;
const SENTINEL = 'SENTINEL-quissel-text';

const on = () => world({ overrides: { desk: { workflow: true } } });

async function fileOne(w: W, reason = 'harassment') {
  n += 1;
  const room = `wf-room-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `wf-reporter-${n}-eeeeeeeeeeee` }, 'Rep');
  w.cw.rooms.seat(room, 'p2', { clientKey: `wf-target-${n}-ffffffffffff` }, 'TargetName');
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  w.clock.t += 1000;
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', reason });
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  return { id: res.reportId, target: w.cw.reports.get(res.reportId)!.targetPerson };
}

const detail = async (w: W, id: string, role: 'moderator' | 'senior' | 'owner' = 'moderator') => (await w.call('GET', `/reports/${id}`, { role })).body as { report: Record<string, unknown> };
const post = (w: W, id: string, text: unknown, o: { role?: 'moderator' | 'senior' | 'owner' | null; actor?: string } = {}) =>
  w.call('POST', `/reports/${id}/comments`, { ...o, body: { text } });

describe('with desk.workflow off', () => {
  it('every workflow route is 404, GET /reports/:id has no comments or escalation keys, /changes no asked, summaries no escalatedTo', async () => {
    const w = await world();
    const f = await fileOne(w);
    for (const [method, path, body] of [
      ['POST', `/reports/${f.id}/comments`, { text: 'x' }],
      ['DELETE', `/reports/${f.id}/comments/abc`, undefined],
      ['POST', `/reports/${f.id}/escalate`, { to: 'senior' }],
      ['DELETE', `/reports/${f.id}/escalate`, undefined],
    ] as const) {
      const res = await w.call(method, path, body === undefined ? {} : { body });
      expect([res.status, errorOf(res)], `${method} ${path}`).toEqual([404, 'not_found']);
    }
    const body = await detail(w, f.id);
    expect(Object.keys(body.report)).not.toContain('comments');
    expect(Object.keys(body.report)).not.toContain('escalation');
    expect(Object.keys((await w.call('GET', '/changes')).body as object)).not.toContain('asked');
    expect(keysDeep((await w.call('GET', '/reports', { query: { status: 'open' } })).body).has('escalatedTo')).toBe(false);
    expect(w.routeAudit().filter((r) => /comment|escalate/.test(r.action))).toEqual([]);
  });

  it('a 404 is the same body whatever the cause (no hint that the feature exists)', async () => {
    const w = await world();
    const f = await fileOne(w);
    const off = await w.call('POST', `/reports/${f.id}/comments`, { body: { text: 'x' } });
    const unknown = await w.call('GET', '/reports/nope/does-not-exist');
    expect(off.body).toEqual(unknown.body);
  });
});

describe('with desk.workflow on: permission boundaries', () => {
  it('comments and escalation are a moderator\'s by default and follow the permissions option; 401 without authz', async () => {
    const w = await world({ overrides: { desk: { workflow: true } }, permissions: { 'reports.comment': 'senior', 'reports.escalate': 'owner' } });
    const f = await fileOne(w);
    expect((await post(w, f.id, 'x', { role: 'moderator' })).status).toBe(403);
    expect((await post(w, f.id, 'x', { role: 'senior' })).status).toBe(200);
    expect((await w.call('POST', `/reports/${f.id}/escalate`, { role: 'senior', body: { to: 'senior' } })).status).toBe(403);
    expect((await w.call('POST', `/reports/${f.id}/escalate`, { role: 'owner', body: { to: 'senior' } })).status).toBe(403);
    expect((await post(w, f.id, 'x', { role: null })).status).toBe(401);
  });

  it('a moderator comments and asks for a look in a default world; the owner can comment but not escalate (the role order)', async () => {
    const w = await on();
    const f = await fileOne(w);
    expect((await post(w, f.id, 'hello')).status).toBe(200);
    expect((await w.call('POST', `/reports/${f.id}/escalate`, { body: { to: 'senior' } })).status).toBe(200);
    const owner = await w.call('POST', `/reports/${f.id}/escalate`, { role: 'owner', actor: 'owner_ed', body: { to: 'owner' } });
    expect([owner.status, errorOf(owner)]).toEqual([403, 'forbidden']);
  });
});

describe('comments over HTTP', () => {
  it('POST adds and returns the comment; GET /reports/:id carries the thread oldest first and the escalation', async () => {
    const w = await on();
    const f = await fileOne(w);
    const res = await post(w, f.id, 'first', { actor: 'mod_ann' });
    expect(res.status).toBe(200);
    const made = (res.body as { comment: Record<string, unknown> }).comment;
    expect(Object.keys(made).sort()).toEqual(['at', 'author', 'id', 'kind', 'role', 'text']);
    expect(made).toMatchObject({ author: 'mod_ann', role: 'moderator', kind: 'comment', text: 'first' });
    w.clock.t += 1000;
    await post(w, f.id, 'second', { role: 'senior', actor: 'sen_cy' });
    const body = await detail(w, f.id);
    expect((body.report.comments as Array<{ text: string }>).map((c) => c.text)).toEqual(['first', 'second']);
    expect(body.report.escalation).toBeNull();
  });

  it('400 for empty, too long and non-text; 404 for an unknown report; 409 comment_limit for the 51st', async () => {
    const w = await on();
    const f = await fileOne(w);
    for (const text of ['', '   ', 'x'.repeat(501), 5, null]) {
      const res = await post(w, f.id, text);
      expect([res.status, errorOf(res)], JSON.stringify(text)).toEqual([400, 'invalid_request']);
    }
    const bad = await w.call('POST', `/reports/${f.id}/comments`, { body: { text: 'x', extra: 1 } });
    expect([bad.status, errorOf(bad)]).toEqual([400, 'invalid_request']);
    const unknown = await post(w, 'nope', 'x');
    expect([unknown.status, errorOf(unknown)]).toEqual([404, 'not_found']);
    for (let i = 0; i < 50; i++) expect((await post(w, f.id, `c${i}`)).status).toBe(200);
    const over = await post(w, f.id, 'one too many');
    expect([over.status, errorOf(over)]).toEqual([409, 'comment_limit']);
  });

  it('DELETE: the author, a senior; another moderator and an unknown id get the same 404 body', async () => {
    const w = await on();
    const f = await fileOne(w);
    const mine = ((await post(w, f.id, 'mine', { actor: 'mod_ann' })).body as { comment: { id: string } }).comment.id;
    const theirs = ((await post(w, f.id, 'theirs', { actor: 'mod_bea' })).body as { comment: { id: string } }).comment.id;
    const refused = await w.call('DELETE', `/reports/${f.id}/comments/${theirs}`, { actor: 'mod_ann' });
    const unknown = await w.call('DELETE', `/reports/${f.id}/comments/nothing`, { actor: 'mod_ann' });
    expect([refused.status, errorOf(refused)]).toEqual([404, 'not_found']);
    expect(refused.body).toEqual(unknown.body);
    expect((await w.call('DELETE', `/reports/${f.id}/comments/${mine}`, { actor: 'mod_ann' })).status).toBe(200);
    expect((await w.call('DELETE', `/reports/${f.id}/comments/${theirs}`, { role: 'senior', actor: 'sen_cy' })).status).toBe(200);
    expect(w.cw.comments.list(f.id)).toEqual([]);
  });

  it('audits report.comment and report.comment_remove best-effort on the report with no text; a failing audit does not undo the write', async () => {
    const w = await on();
    const f = await fileOne(w);
    const made = (await post(w, f.id, SENTINEL, { actor: 'mod_ann' })).body as { comment: { id: string } };
    await w.call('DELETE', `/reports/${f.id}/comments/${made.comment.id}`, { actor: 'mod_ann' });
    const rows = w.routeAudit().filter((r) => r.action.startsWith('report.comment'));
    expect(rows.map((r) => r.action).sort()).toEqual(['report.comment', 'report.comment_remove']);
    for (const r of rows) expect(r).toMatchObject({ actor: 'mod_ann', role: 'moderator', target: { type: 'report', ref: f.id } });
    expect(JSON.stringify(w.routeAudit())).not.toContain(SENTINEL);
    expect(JSON.stringify(w.routeAudit())).not.toContain('"detail"');
    const orig = w.cw.audit.record.bind(w.cw.audit);
    w.cw.audit.record = () => {
      throw new Error('audit down');
    };
    const res = await post(w, f.id, 'still written', { actor: 'mod_ann' });
    w.cw.audit.record = orig;
    expect(res.status).toBe(200);
    expect(w.cw.comments.list(f.id)).toHaveLength(1);
  });

  it('the text never appears in the queue summaries, /changes or the audit list', async () => {
    const w = await on();
    const f = await fileOne(w);
    await post(w, f.id, SENTINEL);
    const bodies = [
      (await w.call('GET', '/reports', { query: { status: 'open' } })).body,
      (await w.call('GET', '/changes')).body,
      (await w.call('GET', '/audit', { role: 'senior' })).body,
    ];
    for (const b of bodies) expect(JSON.stringify(b)).not.toContain(SENTINEL);
    // it is in the one place it belongs
    expect(JSON.stringify((await detail(w, f.id)).report.comments)).toContain(SENTINEL);
  });

  it('is never claim-gated', async () => {
    const w = await on();
    const f = await fileOne(w);
    w.cw.cases.claim(f.target, 'mod_bea');
    expect((await post(w, f.id, 'x', { actor: 'mod_ann' })).status).toBe(200);
  });
});

describe('escalation over HTTP', () => {
  it('POST sets it, GET /reports/:id shows { to, by, at } and the thread entry, the summary carries escalatedTo only while open', async () => {
    const w = await on();
    const f = await fileOne(w);
    const res = await w.call('POST', `/reports/${f.id}/escalate`, { actor: 'mod_ann', body: { to: 'senior', note: 'please look' } });
    expect([res.status, res.body]).toEqual([200, { ok: true }]);
    const body = await detail(w, f.id);
    expect(body.report.escalation).toEqual({ to: 'senior', by: 'mod_ann', at: w.clock.t });
    expect((body.report.comments as Array<{ kind: string; text: string | null }>).map((c) => [c.kind, c.text])).toEqual([['ask', 'please look']]);
    const rows = (await w.call('GET', '/reports', { query: { status: 'open' } })).body as { items: Array<Record<string, unknown>> };
    expect(rows.items.find((r) => r.id === f.id)).toMatchObject({ escalatedTo: 'senior' });
    expect(JSON.stringify(rows)).not.toContain('mod_ann');
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: 'mod_ann' });
    const after = (await w.call('GET', '/reports', { query: { status: 'dismissed' } })).body as { items: Array<Record<string, unknown>> };
    expect(after.items.find((r) => r.id === f.id)).not.toHaveProperty('escalatedTo');
  });

  it('400 for a bad target or an extra key or a bad note; 404 unknown; 409 already_decided; the owner asking is 403', async () => {
    const w = await on();
    const f = await fileOne(w);
    for (const body of [{ to: 'moderator' }, { to: 3 }, {}, { to: 'senior', note: 5 }, { to: 'senior', note: 'n'.repeat(501) }, { to: 'senior', extra: true }]) {
      const res = await w.call('POST', `/reports/${f.id}/escalate`, { body });
      expect([res.status, errorOf(res)], JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }
    expect((await w.call('POST', '/reports/nope/escalate', { body: { to: 'senior' } })).status).toBe(404);
    await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: 'ann' });
    const closed = await w.call('POST', `/reports/${f.id}/escalate`, { body: { to: 'senior' } });
    expect([closed.status, errorOf(closed)]).toEqual([409, 'already_decided']);
  });

  it('DELETE "looked at": the asker, anyone at or above the target; an unrelated moderator is 403; a second is 200', async () => {
    const w = await on();
    const f = await fileOne(w);
    await w.call('POST', `/reports/${f.id}/escalate`, { actor: 'mod_ann', body: { to: 'senior' } });
    const no = await w.call('DELETE', `/reports/${f.id}/escalate`, { actor: 'mod_bea' });
    expect([no.status, errorOf(no)]).toEqual([403, 'forbidden']);
    expect((await w.call('DELETE', `/reports/${f.id}/escalate`, { role: 'senior', actor: 'sen_cy' })).status).toBe(200);
    expect((await detail(w, f.id)).report.escalation).toBeNull();
    expect((await w.call('DELETE', `/reports/${f.id}/escalate`, { actor: 'mod_bea' })).status).toBe(200);
  });

  it('audits report.escalate for both directions, best-effort, with the report target and no detail', async () => {
    const w = await on();
    const f = await fileOne(w);
    await w.call('POST', `/reports/${f.id}/escalate`, { actor: 'mod_ann', body: { to: 'senior', note: SENTINEL } });
    await w.call('DELETE', `/reports/${f.id}/escalate`, { actor: 'mod_ann' });
    const rows = w.routeAudit().filter((r) => r.action === 'report.escalate');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ target: { type: 'report', ref: f.id } });
    expect(JSON.stringify(w.routeAudit())).not.toContain(SENTINEL);
  });

  it('GET /changes asked counts per target role only, and moves with the ask and the decision', async () => {
    const w = await on();
    const asked = async () => ((await w.call('GET', '/changes')).body as { asked: { senior: number; owner: number } }).asked;
    expect(await asked()).toEqual({ senior: 0, owner: 0 });
    const a = await fileOne(w);
    const b = await fileOne(w);
    const c = await fileOne(w);
    await w.call('POST', `/reports/${a.id}/escalate`, { actor: 'mod_ann', body: { to: 'senior' } });
    await w.call('POST', `/reports/${b.id}/escalate`, { actor: 'mod_ann', body: { to: 'senior' } });
    await w.call('POST', `/reports/${c.id}/escalate`, { actor: 'mod_ann', body: { to: 'owner' } });
    expect(await asked()).toEqual({ senior: 2, owner: 1 });
    await w.cw.decide({ reportId: a.id, verdict: 'no_action', actions: [], actor: 'ann' });
    expect(await asked()).toEqual({ senior: 1, owner: 1 });
    expect(JSON.stringify((await w.call('GET', '/changes')).body)).not.toContain('mod_ann');
  });

  it('is never claim-gated, and does not move the claim', async () => {
    const w = await on();
    const f = await fileOne(w);
    w.cw.cases.claim(f.target, 'mod_bea');
    expect((await w.call('POST', `/reports/${f.id}/escalate`, { actor: 'mod_ann', body: { to: 'senior' } })).status).toBe(200);
    expect(w.cw.cases.holder(f.target)?.by).toBe('mod_bea');
  });
});
