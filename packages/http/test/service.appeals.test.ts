import { describe, expect, it } from 'vitest';
import { doorRefusal } from '../src/service/refusal.js';
import { SERVICE_OPENAPI } from '../src/service/openapi.js';
import { ROUTE_SPECS, SERVICE_SCHEMAS } from '../src/service/routes.js';
import { check } from './schemaCheck.js';
import { appealsServiceWorld, ALICE, BOB, CAROL, HOUR, LANDING } from './appealsServiceWorld.js';
import { errorCode, KEY_A } from './serviceKit.js';

// The service API's appeal routes (0.2.1): POST /v1/appeals/link (a signed link for a notice id), POST /v1/appeals (file an appeal for a person, by the notice id the service gave them), POST
// /v1/appeals/mine (their appeals). A refusal is a 200 (the service convention). Nothing staff-side reaches any answer: no reason, no staff ref, no group or person id.

const PRIVATE = ['private moderator reason text', 'mod_ann', 'senior_bea'];
const FIVE = ['createdAt', 'decidedAt', 'id', 'noticeId', 'status'];

describe('POST /v1/appeals/link', () => {
  it('returns a url whose token opens, with the kit, to that notice; the route needs a service key', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE, { kind: 'chat', durationMs: 6 * HOUR });
    const res = await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId } });
    expect(res.status).toBe(200);
    const { url } = res.body as { url: string };
    expect(url.startsWith(`${LANDING}?t=`)).toBe(true);
    expect(w.cw.appeals.openLink(w.tokenOf(url))).toMatchObject({ ok: true, noticeId: s.noticeId });
    expect(Object.keys(res.body as object)).toEqual(['url']);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect((await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId }, key: null })).status).toBe(401);
    expect((await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId }, key: 'x'.repeat(40) })).status).toBe(401);
  });

  it('an unknown id, a notice that is not a sanction and an ended notice give { url: null }', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE, { kind: 'chat', durationMs: 6 * HOUR });
    w.store.insertNotice({ id: 'n-thanks', subject: s.subject, groupId: null, kind: 'report_outcome', rule: null, until: null, refCode: null, excerpt: [], createdAt: w.clock.t, ackedAt: null, withdrawnAt: null });
    for (const noticeId of ['no-such-notice', 'n-thanks']) {
      const res = await w.call('POST', '/appeals/link', { body: { noticeId } });
      expect(res.status, noticeId).toBe(200);
      expect(res.body).toEqual({ url: null });
    }
    // after the appealable window the link is gone
    w.clock.t += 400 * 24 * HOUR;
    expect((await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId } })).body).toEqual({ url: null });
  });

  it('with no landing url set there is no link: { url: null }, not an error', async () => {
    const w = await appealsServiceWorld({ landing: false });
    const s = await w.sanction(ALICE);
    const res = await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: null });
  });

  it('an extra key, a missing key, a non-string, an empty or a 65-character id is 400 invalid_request', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    for (const body of [{ noticeId: s.noticeId, extra: 1 }, {}, { noticeId: 7 }, { noticeId: null }, { noticeId: '' }, { noticeId: 'x'.repeat(65) }, { noticeId: ['a'] }, [], 'text']) {
      const res = await w.call('POST', '/appeals/link', { raw: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
    expect((await w.call('POST', '/appeals/link', {})).status).toBe(400);
    expect((await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId }, contentType: 'text/plain' })).status).toBe(400);
  });

  it('the other methods are 405 and the path under /appeals is not a person route', async () => {
    const w = await appealsServiceWorld();
    expect((await w.call('GET', '/appeals/link')).status).toBe(405);
    expect((await w.call('PUT', '/appeals/link', { body: {} })).status).toBe(405);
  });
});

describe('POST /v1/appeals', () => {
  it('files an appeal: ok with the five documented fields only; a second filing is a 200 refusal already_appealed', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    const res = await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: s.noticeId, statement: 'It was not me.' } });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; appeal: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(['appeal', 'ok']);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.appeal).sort()).toEqual(FIVE);
    expect(body.appeal).toMatchObject({ noticeId: s.noticeId, status: 'open', decidedAt: null });
    const again = await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: s.noticeId, statement: 'Again.' } });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: false, refused: 'already_appealed' });
    expect(w.store.listAppeals({ status: 'all', limit: 50 })).toHaveLength(1);
  });

  it('an empty or whitespace statement is the refusal statement_invalid, never a 400; a statement over the kit limit is too', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    for (const statement of ['', '   ', 'x'.repeat(1001)]) {
      const res = await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: s.noticeId, statement } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, refused: 'statement_invalid' });
    }
    expect(w.store.listAppeals({ status: 'all', limit: 50 })).toEqual([]);
  });

  it('the weekly cap is the refusal rate with retryAfterMs', async () => {
    const w = await appealsServiceWorld({ appeals: { perPlayerPerWeek: 1 } });
    const first = await w.sanction(ALICE);
    const second = await w.sanction(ALICE);
    expect((await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: first.noticeId, statement: 'It was not me.' } })).body).toMatchObject({ ok: true });
    const res = await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: second.noticeId, statement: 'It was not me either.' } });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; refused: string; retryAfterMs: number };
    expect(body).toMatchObject({ ok: false, refused: 'rate' });
    expect(Number.isInteger(body.retryAfterMs)).toBe(true);
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['ok', 'refused', 'retryAfterMs']);
  });

  it("another person's notice, an unknown id and the notice of someone else are all not_found: one answer, so an id cannot be probed", async () => {
    const w = await appealsServiceWorld();
    const mine = await w.sanction(ALICE);
    const bobs = await w.sanction(BOB);
    const answers = [
      await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: bobs.noticeId, statement: 'It was not me.' } }),
      await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: 'no-such-notice', statement: 'It was not me.' } }),
      await w.call('POST', '/appeals', { body: { who: w.idOf(CAROL), noticeId: mine.noticeId, statement: 'It was not me.' } }),
    ];
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(a.body).toEqual({ ok: false, refused: 'not_found' });
    }
  });

  it("the person's own notice that is not a sanction (a thank-you for a report) is the kit's refusal not_appealable", async () => {
    const w = await appealsServiceWorld();
    const mine = await w.sanction(ALICE);
    w.store.insertNotice({ id: 'n-thanks', subject: mine.subject, groupId: null, kind: 'report_outcome', rule: null, until: null, refCode: null, excerpt: [], createdAt: w.clock.t, ackedAt: null, withdrawnAt: null });
    const res = await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: 'n-thanks', statement: 'It was not me.' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, refused: 'not_appealable' });
  });

  it('a statement of 20001 characters, a non-string statement, an extra key, a missing key or an address-only who is 400 invalid_request', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    const ok = { who: w.idOf(ALICE), noticeId: s.noticeId, statement: 'It was not me.' };
    const bad: unknown[] = [
      { ...ok, statement: 'x'.repeat(20_001) },
      { ...ok, statement: 7 },
      { ...ok, statement: null },
      { ...ok, extra: true },
      { who: ok.who, noticeId: ok.noticeId },
      { who: ok.who, statement: ok.statement },
      { noticeId: ok.noticeId, statement: ok.statement },
      { ...ok, who: { ip: '203.0.113.5' } },
      { ...ok, who: {} },
      { ...ok, noticeId: '' },
      { ...ok, noticeId: 'x'.repeat(65) },
      { ...ok, noticeId: 5 },
    ];
    for (const body of bad) {
      const res = await w.call('POST', '/appeals', { raw: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
    // 20000 is the largest the route takes (the kit then refuses it as too long, a 200 refusal)
    const long = await w.call('POST', '/appeals', { body: { ...ok, statement: 'x'.repeat(20_000) } });
    expect(long.status).toBe(200);
    expect(long.body).toEqual({ ok: false, refused: 'statement_invalid' });
  });

  it('needs a service key and is not idempotent: an Idempotency-Key is ignored, a repeat is already_appealed', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    const body = { who: w.idOf(ALICE), noticeId: s.noticeId, statement: 'It was not me.' };
    expect((await w.call('POST', '/appeals', { body, key: null })).status).toBe(401);
    const a = await w.call('POST', '/appeals', { body, idempotencyKey: 'abc' });
    const b = await w.call('POST', '/appeals', { body, idempotencyKey: 'abc' });
    expect(a.body).toMatchObject({ ok: true });
    expect(b.body).toEqual({ ok: false, refused: 'already_appealed' });
    expect(b.headers?.['idempotent-replay']).toBeUndefined();
  });

  it("an account-only identity files for its own notice (the person is the one the notice names)", async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(CAROL);
    const res = await w.call('POST', '/appeals', { body: { who: { accountId: CAROL.accountId }, noticeId: s.noticeId, statement: 'It was not me.' } });
    expect(res.body).toMatchObject({ ok: true });
  });
});

describe('POST /v1/appeals/mine', () => {
  it('lists the appeal the person filed with the five fields; an unknown person has none', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: s.noticeId, statement: 'It was not me.' } });
    const res = await w.call('POST', '/appeals/mine', { body: { who: w.idOf(ALICE) } });
    expect(res.status).toBe(200);
    const list = (res.body as { appeals: Array<Record<string, unknown>> }).appeals;
    expect(Object.keys(res.body as object)).toEqual(['appeals']);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0] as object).sort()).toEqual(FIVE);
    expect(list[0]).toMatchObject({ noticeId: s.noticeId, status: 'open' });
    expect((await w.call('POST', '/appeals/mine', { body: { who: { clientKey: 'a-person-nobody-has-seen-0001' } } })).body).toEqual({ appeals: [] });
    expect((await w.call('POST', '/appeals/mine', { body: { who: w.idOf(BOB) } })).body).toEqual({ appeals: [] });
  });

  it('a decided appeal shows its status and time and nothing of the decision: no reason, no staff ref, no code', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    const filed = w.cw.appeals.file(w.idOf(ALICE), { noticeId: s.noticeId, statement: 'It was not me.' });
    if (!filed.ok) throw new Error('filing refused');
    await w.cw.appeals.decide({ appealId: filed.appeal.id, outcome: 'revoke', actor: 'senior_bea', reason: 'private moderator reason text', reasonCode: 'mistake' });
    const res = await w.call('POST', '/appeals/mine', { body: { who: w.idOf(ALICE) } });
    const list = (res.body as { appeals: Array<Record<string, unknown>> }).appeals;
    expect(list[0]).toMatchObject({ status: 'revoked', decidedAt: expect.any(Number) });
    expect(Object.keys(list[0] as object).sort()).toEqual(FIVE);
  });

  it('a bad who, an extra key or no body is 400 invalid_request; it needs a key', async () => {
    const w = await appealsServiceWorld();
    for (const body of [{}, { who: {} }, { who: { ip: '203.0.113.5' } }, { who: { clientKey: 'k' }, extra: 1 }]) {
      const res = await w.call('POST', '/appeals/mine', { raw: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await w.call('POST', '/appeals/mine', { body: { who: { clientKey: 'k' } }, key: null })).status).toBe(401);
  });

  it('no staff field, reason, group id, person id or raw credential appears in any answer of the three routes', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE);
    await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId } });
    await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: s.noticeId, statement: 'It was not me.' } });
    const filed = w.cw.appeals.file(w.idOf(BOB), { noticeId: 'nope', statement: 'x' });
    expect(filed.ok).toBe(false);
    await w.call('POST', '/appeals/mine', { body: { who: w.idOf(ALICE) } });
    const text = JSON.stringify(w.recorded);
    for (const secret of [...PRIVATE, s.groupId, s.subject, s.reportId, ALICE.clientKey as string, 'It was not me.']) expect(text, secret).not.toContain(secret);
    expect(text).not.toMatch(/s_[A-Za-z0-9_-]{22}/);
  });
});

describe('appeals off: the routes answer like the kit does, not as a missing route', () => {
  it('link is { url: null }, file is refused off, mine is empty (all 200)', async () => {
    const w = await appealsServiceWorld({ appeals: false });
    const s = await w.sanction(ALICE);
    expect(w.cw.appeals.enabled()).toBe(false);
    const link = await w.call('POST', '/appeals/link', { body: { noticeId: s.noticeId } });
    expect(link.status).toBe(200);
    expect(link.body).toEqual({ url: null });
    const file = await w.call('POST', '/appeals', { body: { who: w.idOf(ALICE), noticeId: s.noticeId, statement: 'It was not me.' } });
    expect(file.status).toBe(200);
    expect(file.body).toEqual({ ok: false, refused: 'off' });
    const mine = await w.call('POST', '/appeals/mine', { body: { who: w.idOf(ALICE) } });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ appeals: [] });
  });
});

describe('appealUrl on a door refusal and on the notices', () => {
  it('a banned person is refused at the door with an appealUrl whose token opens to the refusal\'s own notice', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE, { kind: 'ban', durationMs: null });
    const res = await w.call('POST', '/doors/check', { body: { kind: 'join', who: w.idOf(ALICE) } });
    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; refusal: { kind: string; noticeId: string; appealUrl: string; refCode: string } };
    expect(body.ok).toBe(false);
    expect(body.refusal.noticeId).toBe(s.noticeId);
    expect(body.refusal.appealUrl.startsWith(`${LANDING}?t=`)).toBe(true);
    expect(w.cw.appeals.openLink(w.tokenOf(body.refusal.appealUrl))).toMatchObject({ ok: true, noticeId: body.refusal.noticeId });
    expect(Object.keys(body.refusal).sort()).toEqual(['appealUrl', 'kind', 'noticeId', 'refCode', 'until']);
  });

  it('pending notices and the record carry appealUrl for a sanction notice', async () => {
    const w = await appealsServiceWorld();
    const s = await w.sanction(ALICE, { kind: 'chat', durationMs: 6 * HOUR });
    for (const [path, key] of [['/notices/pending', 'notices'], ['/record', 'record']] as const) {
      const res = await w.call('POST', path, { body: { who: w.idOf(ALICE) } });
      const notices = (res.body as Record<string, Array<{ id: string; appealUrl?: string }>>)[key] as Array<{ id: string; appealUrl?: string }>;
      const mine = notices.find((n) => n.id === s.noticeId);
      expect(mine?.appealUrl, path).toBeDefined();
      expect(w.cw.appeals.openLink(w.tokenOf(mine?.appealUrl as string))).toMatchObject({ ok: true, noticeId: s.noticeId });
    }
  });

  it('with no landing url there is no appealUrl on a refusal or a notice', async () => {
    const w = await appealsServiceWorld({ landing: false });
    await w.sanction(ALICE, { kind: 'ban', durationMs: null });
    const door = (await w.call('POST', '/doors/check', { body: { kind: 'join', who: w.idOf(ALICE) } })).body as { refusal: Record<string, unknown> };
    expect(door.refusal).not.toHaveProperty('appealUrl');
    const notices = ((await w.call('POST', '/notices/pending', { body: { who: w.idOf(ALICE) } })).body as { notices: Array<Record<string, unknown>> }).notices;
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) expect(n).not.toHaveProperty('appealUrl');
  });

  it('with appeals off there is no appealUrl either', async () => {
    const w = await appealsServiceWorld({ appeals: false });
    await w.sanction(ALICE, { kind: 'ban', durationMs: null });
    const door = (await w.call('POST', '/doors/check', { body: { kind: 'join', who: w.idOf(ALICE) } })).body as { refusal: Record<string, unknown> };
    expect(door.refusal).not.toHaveProperty('appealUrl');
  });
});

describe('doorRefusal copies appealUrl by name', () => {
  const base = { kind: 'ban', until: null, refCode: 'M-ABCDE', noticeId: 'n1' };
  it('a string of 1 to 2100 characters is copied; anything else is left out', () => {
    expect(doorRefusal({ ...base, appealUrl: 'https://game.example/appeal?t=abc' })).toMatchObject({ appealUrl: 'https://game.example/appeal?t=abc' });
    const longest = `https://g.example/${'a'.repeat(2100 - 'https://g.example/'.length)}`;
    expect(longest).toHaveLength(2100);
    expect(doorRefusal({ ...base, appealUrl: longest })).toMatchObject({ appealUrl: longest });
    for (const bad of ['', `${longest}a`, 5, null, undefined, {}, ['x'], true]) expect(doorRefusal({ ...base, appealUrl: bad }), String(bad)).not.toHaveProperty('appealUrl');
    expect(doorRefusal(base)).not.toHaveProperty('appealUrl');
  });

  it('nothing else rides along', () => {
    const out = doorRefusal({ ...base, appealUrl: 'https://game.example/appeal?t=abc', subject: 's_x', groupId: 'g1', reason: 'private' } as never);
    expect(Object.keys(out).sort()).toEqual(['appealUrl', 'kind', 'noticeId', 'refCode', 'until']);
  });
});

describe('the API description', () => {
  const doc = SERVICE_OPENAPI as unknown as { paths: Record<string, Record<string, { operationId: string; requestBody?: unknown; responses: Record<string, unknown> }>>; components: { schemas: Record<string, { properties?: Record<string, unknown> }> } };
  const byName = (name: string) => ROUTE_SPECS.find((s) => s.name === name);

  it('describes the three routes, the Appeal schema and the appealUrl fields', () => {
    for (const [path, name] of [['/v1/appeals/link', 'appeals_link'], ['/v1/appeals', 'appeals_file'], ['/v1/appeals/mine', 'appeals_mine']] as const) {
      expect(doc.paths[path]?.post?.operationId, path).toBe(name);
      expect(byName(name), name).toBeDefined();
      expect(doc.paths[path]?.post?.requestBody, path).toBeDefined();
    }
    expect(SERVICE_SCHEMAS.Appeal).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys((SERVICE_SCHEMAS.Appeal as { properties: object }).properties).sort()).toEqual(FIVE);
    expect(((SERVICE_SCHEMAS.Appeal as { properties: Record<string, { enum?: string[] }> }).properties.status as { enum: string[] }).enum).toEqual(['open', 'upheld', 'reduced', 'revoked']);
    expect((SERVICE_SCHEMAS.Notice as { properties: Record<string, unknown> }).properties.appealUrl).toEqual({ type: 'string', minLength: 1, maxLength: 2100 });
    expect(JSON.stringify(byName('doors_check')?.answer)).toContain('appealUrl');
    expect(doc.components.schemas.Appeal).toBeDefined();
  });

  it('every example of the three routes fits its answer schema and every request example fits its request schema', () => {
    const DOC = { components: { schemas: SERVICE_SCHEMAS as never } };
    for (const name of ['appeals_link', 'appeals_file', 'appeals_mine', 'notices_pending', 'record', 'doors_check']) {
      const spec = byName(name);
      expect(spec, name).toBeDefined();
      for (const example of spec?.examples ?? []) expect(check(spec?.answer as never, example, DOC), `${name} ${JSON.stringify(example).slice(0, 60)}`).toEqual([]);
      if (spec?.request !== undefined) expect(check(spec.request as never, spec.requestExample, DOC), `${name} request`).toEqual([]);
    }
    // the notice example shows an appealUrl
    expect(JSON.stringify(byName('notices_pending')?.examples)).toContain('appealUrl');
    expect(JSON.stringify(byName('doors_check')?.examples)).toContain('appealUrl');
  });

  it('the file route documents each refusal and the retryAfterMs of a rate', () => {
    const text = JSON.stringify(byName('appeals_file')?.answer);
    for (const refused of ['off', 'not_found', 'not_appealable', 'statement_invalid', 'already_appealed', 'rate']) expect(text, refused).toContain(refused);
    expect(text).toContain('retryAfterMs');
    expect(JSON.stringify(byName('appeals_file')?.request)).toContain('20000');
  });

  it('the table has the three routes with the keys the description gives', async () => {
    const w = await appealsServiceWorld();
    expect(Object.keys(w.svcRoutes)).toEqual(expect.arrayContaining(['POST /appeals/link', 'POST /appeals', 'POST /appeals/mine']));
    expect(Object.keys(w.svcRoutes).sort()).toEqual(ROUTE_SPECS.map((s) => `${s.method} ${s.path}`).sort());
    void KEY_A;
  });
});
