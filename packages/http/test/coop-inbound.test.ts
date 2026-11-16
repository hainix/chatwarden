import type { Chatwarden } from '@chatwarden/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION, TYPE_REPORT, callbackBody, callbackRequest, coopWorld, fakeCoop, makeCoop, newRsaPair, rsaSign, sharedPair, signedCallback, until } from './coop-world.js';
import type { CoopWorld, SignedOptions } from './coop-world.js';
import { world } from './world.js';

// K5 C3: the verified callback becomes a decision. Signature first, over the exact bytes; then the same decision path as the hub (`decideAs`), as a configured role,
// with the conflict rules of design 8.2.

const EMAIL = 'drakkuun@example.test';
const ACTOR = `coop:${EMAIL}`;
const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized', message: 'Authentication is required.' } };

afterEach(() => {
  vi.restoreAllMocks();
});

const open = async (over: Parameters<typeof coopWorld>[0] = {}) => {
  const c = await coopWorld(over);
  const r = await c.w.file('harassment');
  await until(() => c.cw.links.get('coop-report', r.id) !== null, 'the job is out');
  return { c, r };
};
const post = (c: CoopWorld, id: string, over: Record<string, unknown> = {}, o: SignedOptions = {}) => c.send(callbackRequest(callbackBody(id, over), o));
const ignoredLogs = (c: CoopWorld) => c.logged.filter(([e]) => e === 'chatwarden.coop_callback_ignored').map(([, d]) => d);
const statusOf = (c: CoopWorld, id: string) => c.cw.reports.get(id)?.status;
const auditOf = (c: CoopWorld, id: string) => c.w.routeAudit().filter((a) => a.action === 'report.decide' && a.target?.ref === id);

describe('verification: every failure is the same 401', () => {
  it('a wrong key, a flipped body byte, a missing or malformed header, a signature of another body and a t= shape with a wrong v1', async () => {
    const { c, r } = await open();
    const raw = JSON.stringify(callbackBody(r.id));
    const bad: SignedOptions[] = [
      { pair: newRsaPair() },
      { sendRaw: `${raw} ` },
      { sendRaw: raw.replace('zorbak', 'zorbaK') },
      { headers: { 'coop-signature': undefined } },
      { signature: '!!!not base64!!!' },
      { signature: '' },
      { signature: 'A'.repeat(2000) },
      { signature: rsaSign(sharedPair(), 'another body') },
      { signature: `t=1800000000,v1=${rsaSign(sharedPair(), 'another body')}` },
      { headerName: 'x-coop-signature' },
    ];
    for (const o of bad) {
      const res = await c.send(signedCallback(raw, o));
      expect(res, JSON.stringify(Object.keys(o))).toEqual(UNAUTHORIZED);
    }
    expect(statusOf(c, r.id)).toBe('open');
    expect(c.cw.sanctions.forPerson(r.target)).toEqual([]);
    expect(auditOf(c, r.id)).toEqual([]);
    c.adapter.dispose();
  });

  it('both signature shapes apply, the header name in any case', async () => {
    for (const [shape, name] of [['plain', 'coop-signature'], ['plain', 'Coop-Signature'], ['v1-body', 'coop-signature'], ['v1-tbody', 'coop-signature']] as const) {
      const { c, r } = await open();
      const res = await post(c, r.id, {}, { shape, headerName: name });
      expect(res, `${shape}/${name}`).toEqual({ status: 200, body: { ok: true, outcome: 'applied' } });
      c.adapter.dispose();
    }
  });

  it('rawBody absent is a 500 and a log', async () => {
    const { c, r } = await open();
    const req = signedCallback(JSON.stringify(callbackBody(r.id)));
    delete req.rawBody;
    const res = await c.send(req);
    expect(res).toEqual({ status: 500, body: { error: 'internal' } });
    expect(c.logged).toContainEqual(['chatwarden.coop_failed', { op: 'no_raw_body' }]);
    expect(statusOf(c, r.id)).toBe('open');
    c.adapter.dispose();
  });

  it('the body is not parsed before verification', async () => {
    const { c, r } = await open();
    const parse = vi.spyOn(JSON, 'parse');
    const raws = ['{not json at all', '{"__proto__": {"x": 1}}', '[]', JSON.stringify(callbackBody(r.id, { custom: { zorbak: 'vlemmo' } }))];
    for (const raw of raws) {
      parse.mockClear();
      // Good JSON or bad, a request with the wrong key is a 401 and the body is never given to JSON.parse.
      const res = await c.send(signedCallback(raw, { pair: newRsaPair() }));
      expect(res).toEqual(UNAUTHORIZED);
      expect(parse.mock.calls.some(([arg]) => arg === raw)).toBe(false);
    }
    c.adapter.dispose();
  });

  it('a body over 64 KiB is 413 before any crypto, signed or not', async () => {
    const { c, r } = await open();
    const big = JSON.stringify(callbackBody(r.id, { decisionReason: 'x'.repeat(70_000) }));
    expect((await c.send(signedCallback(big))).status).toBe(413);
    expect((await c.send(signedCallback(big, { pair: newRsaPair() }))).status).toBe(413);
    // Multi-byte text counts in bytes, not characters.
    const wide = JSON.stringify(callbackBody(r.id, { decisionReason: '\u4e2d'.repeat(30_000) }));
    expect((await c.send(signedCallback(wide))).status).toBe(413);
    expect(statusOf(c, r.id)).toBe('open');
    c.adapter.dispose();
  });

  it('a signed body that is not usable is a 400: not JSON, not an object, no item.id, no action.id, ids that are not strings', async () => {
    const { c, r } = await open();
    const raws = [
      '{nope',
      '[]',
      '"text"',
      'null',
      JSON.stringify({}),
      JSON.stringify(callbackBody(r.id, { item: undefined })),
      JSON.stringify(callbackBody(r.id, { item: {} })),
      JSON.stringify(callbackBody(r.id, { item: { id: 5 } })),
      JSON.stringify(callbackBody(r.id, { item: { id: '' } })),
      JSON.stringify(callbackBody(r.id, { item: { id: 'x'.repeat(1000) } })),
      JSON.stringify(callbackBody(r.id, { action: undefined })),
      JSON.stringify(callbackBody(r.id, { action: { id: 5 } })),
      JSON.stringify(callbackBody(r.id, { action: { id: '' } })),
      '{"__proto__": {"x": 1}, "item": {"id": "a"}, "action": {"id": "b"}}',
    ];
    for (const raw of raws) {
      const res = await c.send(signedCallback(raw));
      expect(res.status, raw.slice(0, 40)).toBe(400);
    }
    expect(statusOf(c, r.id)).toBe('open');
    c.adapter.dispose();
  });
});

describe('a moderator decision applies', () => {
  it('the verdict, the sanction on the report target, source coop, actor coop:<email>, the reason from decisionReason, one report.closed, one audit row with the role', async () => {
    const { c, r } = await open();
    const closed: unknown[] = [];
    c.cw.on('report.closed', (e) => void closed.push(e));
    const res = await post(c, r.id, { action: { id: ACTION.warn }, decisionReason: 'zorbak vlemmo is not allowed' });
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'applied' } });
    expect(statusOf(c, r.id)).toBe('actioned');
    const groups = c.cw.sanctions.forPerson(r.target);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'warning', source: 'coop', actor: ACTOR, reason: 'zorbak vlemmo is not allowed', rule: c.ruleA, automated: false });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ type: 'report.closed', reportId: r.id, verdict: 'upheld' });
    const rows = auditOf(c, r.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: ACTOR, role: 'moderator', action: 'report.decide', target: { type: 'report', ref: r.id } });
    expect(ignoredLogs(c)).toEqual([]);
    c.adapter.dispose();
  });

  it('every mapped action: a chat restriction with a length, a ban for 7 days, a note, a dismissal, bad faith', async () => {
    const cases: Array<[string, Record<string, unknown>, (c: CoopWorld, id: string, target: string) => void]> = [
      [ACTION.chat, {}, (c, _id, t) => expect(c.cw.sanctions.forPerson(t)[0]).toMatchObject({ kind: 'chat', endsAt: c.w.clock.now() + 86_400_000 })],
      [ACTION.ban7, {}, (c, _id, t) => expect(c.cw.sanctions.forPerson(t)[0]).toMatchObject({ kind: 'ban', endsAt: c.w.clock.now() + 7 * 86_400_000 })],
      [ACTION.note, {}, (c, _id, t) => expect(c.cw.sanctions.forPerson(t)[0]).toMatchObject({ kind: 'note' })],
      [ACTION.dismiss, {}, (c, id, t) => (expect(c.cw.reports.get(id)?.status).toBe('dismissed'), expect(c.cw.sanctions.forPerson(t)).toEqual([]))],
      [ACTION.badFaith, {}, (c, id) => (expect(c.cw.reports.get(id)?.badFaith).toBe(true), expect(c.cw.reports.get(id)?.badFaithEvidence).toBe('zorbak vlemmo is not allowed'))],
    ];
    for (const [action, extra, check] of cases) {
      const { c, r } = await open();
      const res = await post(c, r.id, { action: { id: action }, ...extra });
      expect(res.body, action).toEqual({ ok: true, outcome: 'applied' });
      check(c, r.id, r.target);
      c.adapter.dispose();
    }
  });

  it('the person decided is the report target, whatever the callback names', async () => {
    const { c, r } = await open();
    const other = await c.w.file('harassment');
    const res = await post(c, r.id, { creator: { id: other.target, typeId: 'x' }, custom: { subject: other.target, person: other.reporter } });
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(c.cw.sanctions.forPerson(r.target)).toHaveLength(1);
    expect(c.cw.sanctions.forPerson(other.target)).toEqual([]);
    expect(c.cw.sanctions.forPerson(r.reporter)).toEqual([]);
    expect(statusOf(c, other.id)).toBe('open');
    c.adapter.dispose();
  });

  it('a policy mapped to a rule picks that rule', async () => {
    const { c, r } = await open();
    await post(c, r.id, { policies: [{ id: 'policy-spam', name: 'Spam', penalty: 'LOW' }] });
    expect(c.cw.sanctions.forPerson(r.target)[0]?.rule).toBe(c.ruleB);
    c.adapter.dispose();
  });

  it('the link row ends as decided and keeps the Coop job id', async () => {
    const { c, r } = await open();
    const before = c.cw.links.get('coop-report', r.id);
    await post(c, r.id);
    expect(c.cw.links.get('coop-report', r.id)).toEqual({ ...before, state: 'decided', at: c.w.clock.now() });
    c.adapter.dispose();
  });

  it('a failing link write is logged and the answer is still 200', async () => {
    let failPut = false;
    const wrapKit = (cw: Chatwarden): Chatwarden => ({
      ...cw,
      links: {
        ...cw.links,
        put: (row) => {
          if (failPut) throw new Error('link store down');
          cw.links.put(row);
        },
      },
    });
    const { c, r } = await open({ wrapKit });
    failPut = true;
    const res = await post(c, r.id);
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'applied' } });
    expect(c.logged).toContainEqual(['chatwarden.coop_failed', { op: 'link', error: 'Error' }]);
    expect(statusOf(c, r.id)).toBe('actioned');
    c.adapter.dispose();
  });

  it('a decision releases whoever held the case when it settles the last open report; a held claim never blocks it', async () => {
    const { c, r } = await open();
    c.cw.cases.claim(r.target, 'ann');
    expect(c.cw.cases.holder(r.target)?.by).toBe('ann');
    const res = await post(c, r.id);
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(c.cw.cases.holder(r.target)).toBeNull();
    c.adapter.dispose();
  });

  it('with other reports open about the person, the claim is kept', async () => {
    const { c, r } = await open();
    const second = await c.w.fileAgainst({ key: r.key }, 'x');
    expect(second.target).toBe(r.target);
    c.cw.cases.claim(r.target, 'ann');
    await post(c, r.id);
    expect(c.cw.cases.holder(r.target)?.by).toBe('ann');
    c.adapter.dispose();
  });
});

describe('the conflict rules (design 8.2)', () => {
  it('rule 1: a report closed in the hub first answers 200 ignored closed and applies nothing', async () => {
    const { c, r } = await open();
    const hub = await c.cw.decide({ reportId: r.id, verdict: 'no_action', actions: [], actor: 'ann', source: 'moderator' });
    expect(hub.ok).toBe(true);
    const res = await post(c, r.id, { action: { id: ACTION.ban7 } });
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' } });
    expect(ignoredLogs(c)).toEqual([{ reason: 'closed' }]);
    expect(c.cw.sanctions.forPerson(r.target)).toEqual([]);
    expect(statusOf(c, r.id)).toBe('dismissed');
    expect(auditOf(c, r.id)).toEqual([]);
    c.adapter.dispose();
  });

  it('rule 2: the same callback twice is applied once; the second is a replay answered 200', async () => {
    const { c, r } = await open();
    const closed: unknown[] = [];
    c.cw.on('report.closed', (e) => void closed.push(e));
    const raw = JSON.stringify(callbackBody(r.id));
    const first = await c.send(signedCallback(raw));
    const again = await c.send(signedCallback(raw));
    const third = await c.send(signedCallback(raw, { shape: 'v1-body' }));
    expect(first.body).toEqual({ ok: true, outcome: 'applied' });
    expect(again).toEqual({ status: 200, body: { ok: true, outcome: 'replay' } });
    expect(third).toEqual({ status: 200, body: { ok: true, outcome: 'replay' } });
    expect(c.cw.sanctions.forPerson(r.target)).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(auditOf(c, r.id)).toHaveLength(1);
    c.adapter.dispose();
  });

  it('rule 2: a different decision for a decided report is ignored closed', async () => {
    const { c, r } = await open();
    await post(c, r.id, { action: { id: ACTION.warn } });
    const res = await post(c, r.id, { action: { id: ACTION.ban7 } });
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' } });
    expect(ignoredLogs(c)).toEqual([{ reason: 'closed' }]);
    expect(c.cw.sanctions.forPerson(r.target)).toHaveLength(1);
    c.adapter.dispose();
  });

  it('rule 3: an unknown item, an unknown action, no rule, bad_faith with no reason and a permanent ban from a moderator role each answer 200 ignored with a reason code and leave the report open', async () => {
    const { c, r } = await open();
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ['unknown_item', 'nope-no-such-report', {}],
      ['unknown_action', r.id, { action: { id: 'action-zz' } }],
      ['no_reason', r.id, { action: { id: ACTION.badFaith }, decisionReason: undefined, actorNote: undefined }],
      ['forbidden', r.id, { action: { id: ACTION.banPerm } }],
    ];
    for (const [reason, id, over] of attempts) {
      c.logged.length = 0;
      const res = await post(c, id, over);
      expect(res, reason).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' } });
      expect(ignoredLogs(c), reason).toEqual([{ reason }]);
    }
    expect(statusOf(c, r.id)).toBe('open');
    expect(c.cw.sanctions.forPerson(r.target)).toEqual([]);
    c.adapter.dispose();
  });

  it('rule 3: no citable rule for a warning is ignored no_rule and the report stays open', async () => {
    const w = await world();
    const room = 'room-no-reason';
    w.cw.rooms.seat(room, 'p1', { clientKey: 'raw-client-key-r1-aaaaaaaaaaaaaaaa', ip: '198.51.100.7' }, 'Rep');
    w.cw.rooms.seat(room, 'p2', { clientKey: 'raw-client-key-t1-bbbbbbbbbbbbbbbb', ip: '198.51.100.8' }, 'Tgt');
    w.cw.chat.accept(room, 'p2', 'a line');
    const filed = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2' });
    expect(filed.ok).toBe(true);
    const id = (filed as { reportId: string }).reportId;
    expect(w.cw.reports.get(id)?.reportedReason).toBeNull();
    const c = makeCoop(w);
    const res = await post(c, id, { policies: [{ id: 'policy-unmapped', name: 'x', penalty: 'LOW' }] });
    expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' } });
    expect(ignoredLogs(c)).toEqual([{ reason: 'no_rule' }]);
    expect(statusOf(c, id)).toBe('open');
    // A dismissal needs no rule.
    const dismissed = await post(c, id, { action: { id: ACTION.dismiss }, policies: [{ id: 'policy-unmapped', name: 'x', penalty: 'LOW' }] });
    expect(dismissed.body).toEqual({ ok: true, outcome: 'applied' });
    c.adapter.dispose();
  });

  it('rule 3: a permanent ban applies when the adapter is configured as senior', async () => {
    const { c, r } = await open({ options: { role: 'senior' } });
    const res = await post(c, r.id, { action: { id: ACTION.banPerm } });
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(c.cw.sanctions.forPerson(r.target)[0]).toMatchObject({ kind: 'ban', endsAt: null });
    expect(auditOf(c, r.id)[0]).toMatchObject({ role: 'senior' });
    c.adapter.dispose();
  });

  it('rule 3: a lowered permission map is honoured (the shared permission table)', async () => {
    const { c, r } = await open({ options: { permissions: { 'sanctions.apply': 'senior' } } });
    const res = await post(c, r.id, { action: { id: ACTION.warn } });
    expect(res.body).toEqual({ ok: true, outcome: 'ignored' });
    expect(ignoredLogs(c)).toEqual([{ reason: 'forbidden' }]);
    // A dismissal changes no player and is still allowed.
    expect((await post(c, r.id, { action: { id: ACTION.dismiss } })).body).toEqual({ ok: true, outcome: 'applied' });
    c.adapter.dispose();
  });

  it('rule 4: an automated action (no actorEmail) and a strike threshold are ignored', async () => {
    const { c, r } = await open();
    const automated = await post(c, r.id, { actorEmail: undefined });
    const strike = await post(c, r.id, { policies: [], rules: [], actorEmail: undefined, actorNote: undefined });
    const strikeWithEmail = await post(c, r.id, { policies: [], rules: [] });
    for (const res of [automated, strike, strikeWithEmail]) expect(res).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' } });
    expect(ignoredLogs(c)).toEqual([{ reason: 'no_actor' }, { reason: 'no_actor' }, { reason: 'no_policies' }]);
    expect(statusOf(c, r.id)).toBe('open');
    expect(c.cw.sanctions.forPerson(r.target)).toEqual([]);
    c.adapter.dispose();
  });

  it('rule 7: a store failure is 503, nothing is applied, and a retry then applies', async () => {
    let down = true;
    const wrapKit = (cw: Chatwarden): Chatwarden => ({
      ...cw,
      decide: (input) => {
        if (down) return Promise.reject(new Error('db down tarvo'));
        return cw.decide(input);
      },
    });
    const { c, r } = await open({ wrapKit });
    const raw = JSON.stringify(callbackBody(r.id));
    const res = await c.send(signedCallback(raw));
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect(c.logged).toContainEqual(['chatwarden.coop_failed', { op: 'decide', error: 'Error' }]);
    expect(JSON.stringify(c.logged)).not.toContain('tarvo');
    expect(statusOf(c, r.id)).toBe('open');
    down = false;
    expect((await c.send(signedCallback(raw))).body).toEqual({ ok: true, outcome: 'applied' });
    c.adapter.dispose();
  });

  it('rule 7: a failing report read is 503 too', async () => {
    const { c, r } = await open({
      wrapKit: (cw) => ({
        ...cw,
        reports: {
          ...cw.reports,
          get: (id: string) => {
            if (id === 'boom-id') throw new Error('read failed');
            return cw.reports.get(id);
          },
        },
      }),
    });
    const res = await post(c, 'boom-id');
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect(statusOf(c, r.id)).toBe('open');
    c.adapter.dispose();
  });

  it('an audit failure is logged and the decision stands', async () => {
    const wrapKit = (cw: Chatwarden): Chatwarden => ({
      ...cw,
      audit: {
        ...cw.audit,
        record: () => {
          throw new Error('audit down');
        },
      },
    });
    const { c, r } = await open({ wrapKit });
    const res = await post(c, r.id);
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(c.logged).toContainEqual(['chatwarden.coop_failed', { op: 'audit', error: 'Error' }]);
    expect(statusOf(c, r.id)).toBe('actioned');
    c.adapter.dispose();
  });

  it('a 201 that arrives after the decision does not move the link back to sent, and keeps the Coop id', async () => {
    const w = await world();
    const inner = fakeCoop();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const c = makeCoop(w, { options: { fetch: async (url: string, init: RequestInit) => (await gate, inner.fetch(url, init)) } });
    const r = await w.file('harassment');
    // The job is in flight (waiting on the gate); the callback decides the report first.
    const res = await post(c, r.id);
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(w.cw.links.get('coop-report', r.id)).toMatchObject({ state: 'decided', external: 'unknown' });
    release();
    await until(() => w.cw.links.get('coop-report', r.id)?.external === 'coop-job-1', 'the Coop id is kept');
    expect(w.cw.links.get('coop-report', r.id)).toMatchObject({ state: 'decided', external: 'coop-job-1' });
    c.adapter.dispose();
  });
});

describe('callbackAuth', () => {
  const options = { callbackAuth: { header: 'x-callback-key', value: 'snerp-callback-value-1' } };

  it('a missing or wrong header is the same 401; a right one passes (any case of the name)', async () => {
    const { c, r } = await open({ options });
    expect(await post(c, r.id)).toEqual(UNAUTHORIZED);
    expect(await post(c, r.id, {}, { headers: { 'x-callback-key': 'wrong-value' } })).toEqual(UNAUTHORIZED);
    expect(await post(c, r.id, {}, { headers: { 'x-callback-key': 'snerp-callback-value-1 ' } })).toEqual(UNAUTHORIZED);
    expect(await post(c, r.id, {}, { headers: { 'x-callback-key': 'snerp-callback-value-10' } })).toEqual(UNAUTHORIZED);
    expect(await post(c, r.id, {}, { headers: { 'x-callback-key': '' } })).toEqual(UNAUTHORIZED);
    // A good signature does not stand in for the header, and a good header does not stand in for the signature.
    const raw = JSON.stringify(callbackBody(r.id));
    expect(await c.send(signedCallback(raw, { pair: newRsaPair(), headers: { 'x-callback-key': 'snerp-callback-value-1' } }))).toEqual(UNAUTHORIZED);
    expect(statusOf(c, r.id)).toBe('open');
    const ok = await post(c, r.id, {}, { headers: { 'x-callback-key': 'snerp-callback-value-1' } });
    expect(ok.body).toEqual({ ok: true, outcome: 'applied' });
    c.adapter.dispose();
  });
});

describe('private text and hostile bodies', () => {
  it('an actorNote and a decisionReason are stored only as the private reason (cut to 500) and appear in no log, event or response', async () => {
    const { c, r } = await open();
    const events: unknown[] = [];
    c.cw.on('*', (e) => void events.push(e));
    const seed = 'tarvo-private-reason-xyz';
    const res = await post(c, r.id, { decisionReason: seed + 'x'.repeat(900), actorNote: 'glarn-private-note-xyz' });
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    const stored = c.cw.sanctions.forPerson(r.target)[0]?.reason ?? '';
    expect(stored).toHaveLength(500);
    expect(stored.startsWith(seed)).toBe(true);
    for (const seen of [JSON.stringify(res), JSON.stringify(c.logged), JSON.stringify(events)]) {
      expect(seen).not.toMatch(/tarvo-private|glarn-private/);
    }
    c.adapter.dispose();
  });

  it('a note alone is the reason when there is no decisionReason', async () => {
    const { c, r } = await open();
    await post(c, r.id, { decisionReason: undefined, actorNote: 'the actor note' });
    expect(c.cw.sanctions.forPerson(r.target)[0]?.reason).toBe('the actor note');
    c.adapter.dispose();
  });

  it('__proto__ keys, a 10 000 element policies array, a long decisionReason and nested custom objects are handled without throwing', async () => {
    const { c, r } = await open();
    const proto = '{"__proto__": {"polluted": true}, "item": {"id": "' + r.id + '"}, "action": {"id": "' + ACTION.warn + '"}}';
    expect((await c.send(signedCallback(proto))).status).toBe(400);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) nested = { deeper: nested, list: [1, 2, 3] };
    const raw = JSON.stringify(callbackBody(r.id, { policies: Array.from({ length: 10_000 }, () => 1), decisionReason: 'y'.repeat(60_000 - 40_000), custom: nested }));
    expect(raw.length).toBeLessThan(65_536);
    const res = await c.send(signedCallback(raw));
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(c.cw.sanctions.forPerson(r.target)[0]?.reason).toHaveLength(500);
    c.adapter.dispose();
  });

  it('control characters and bidi marks in an email become underscores in the actor', async () => {
    const { c, r } = await open();
    await post(c, r.id, { actorEmail: 'zorbak\u0000\u202e <z@x.test>' });
    expect(c.cw.sanctions.forPerson(r.target)[0]?.actor).toBe('coop:zorbak____z@x.test_');
    c.adapter.dispose();
  });

  it('the callback type id and the item type name are not used for anything', async () => {
    const { c, r } = await open();
    const res = await post(c, r.id, { item: { id: r.id, typeId: 'any-other-type', typeName: 'zorbak' } });
    expect(res.body).toEqual({ ok: true, outcome: 'applied' });
    expect(TYPE_REPORT).not.toBe('any-other-type');
    c.adapter.dispose();
  });
});

describe('lifecycle', () => {
  it('after dispose the route answers the same 401 and applies nothing', async () => {
    const { c, r } = await open();
    c.adapter.dispose();
    expect(await post(c, r.id)).toEqual(UNAUTHORIZED);
    expect(statusOf(c, r.id)).toBe('open');
  });

  it('the route table has exactly the callback route when no signal is set', async () => {
    const c = await coopWorld();
    expect(Object.keys(c.adapter.routes)).toEqual(['POST /coop/actions']);
    c.adapter.dispose();
  });
});
