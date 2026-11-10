import { describe, expect, it } from 'vitest';
import { GAP_NOTE_MAX, MAX_SANCTION_DURATION_MS } from '@chatwarden/core';
import { DAY, HOUR, errorOf, world } from './world.js';

const apply = (subject: string, over: Record<string, unknown> = {}) => ({
  subject,
  kind: 'chat',
  durationMs: HOUR,
  rule: 2,
  ...over,
});

describe('POST /sanctions', () => {
  it('applies a timed chat restriction as the moderator, from the authz actor, and answers the group and ref code', async () => {
    const { call, person, store, clock } = await world();
    const subject = person();
    const res = await call('POST', '/sanctions', { actor: 'ann', body: apply(subject, { reason: 'spam in lobby' }) });
    expect(res.status).toBe(200);
    const body = res.body as { groupId: string; refCode: string };
    expect(Object.keys(body).sort()).toEqual(['groupId', 'refCode']);
    expect(body.refCode).toMatch(/^M-[A-Z2-9]{5}$/);
    const rows = store.loadSanctions(clock.t).filter((r) => r.groupId === body.groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'chat',
      value: subject,
      actor: 'ann',
      source: 'moderator',
      automated: false,
      rule: '2',
      endsAt: clock.t + HOUR,
      reason: 'spam in lobby',
    });
  });

  it('takes the actor from the authz hook, never from the body', async () => {
    const { call, person, store, clock } = await world();
    const res = await call('POST', '/sanctions', {
      actor: 'bob',
      body: { ...apply(person()), actor: 'mallory', source: 'api', automated: true },
    });
    expect(res.status).toBe(200);
    const row = store.loadSanctions(clock.t).find((r) => r.groupId === (res.body as { groupId: string }).groupId);
    expect(row).toMatchObject({ actor: 'bob', source: 'moderator', automated: false });
  });

  it.each(['chat', 'area', 'ban'] as const)('applies a timed %s', async (kind) => {
    const { call, person } = await world();
    expect((await call('POST', '/sanctions', { body: apply(person(), { kind, durationMs: DAY }) })).status).toBe(200);
  });

  it.each(['warning', 'note'] as const)('applies a %s (permanent record, null duration)', async (kind) => {
    const { call, person } = await world();
    expect((await call('POST', '/sanctions', { body: apply(person(), { kind, durationMs: null }) })).status).toBe(200);
  });

  it('a warning or a note with a duration, or with includeIp, is refused by the core check (400 invalid_sanction)', async () => {
    const { call, person } = await world();
    const timed = await call('POST', '/sanctions', { body: apply(person(), { kind: 'warning', durationMs: HOUR }) });
    expect([timed.status, errorOf(timed)]).toEqual([400, 'invalid_sanction']);
    const ip = await call('POST', '/sanctions', { body: apply(person(), { kind: 'note', durationMs: null, includeIp: true }) });
    expect([ip.status, errorOf(ip)]).toEqual([400, 'invalid_sanction']);
  });

  it('includeIp defaults to false; includeIp true writes the IP row too (capped at 24 h)', async () => {
    const { call, person, store, clock } = await world();
    const a = await call('POST', '/sanctions', { body: apply(person(), { durationMs: 3 * DAY }) });
    const b = await call('POST', '/sanctions', { body: apply(person(), { durationMs: 3 * DAY, includeIp: true }) });
    const rowsOf = (res: { body: unknown }) =>
      store.loadSanctions(clock.t).filter((r) => r.groupId === (res.body as { groupId: string }).groupId);
    expect(rowsOf(a).map((r) => r.targetType)).toEqual(['subject']);
    const rows = rowsOf(b);
    expect(rows.map((r) => r.targetType).sort()).toEqual(['ip', 'subject']);
    expect(rows.find((r) => r.targetType === 'ip')?.endsAt).toBe(clock.t + DAY);
    // Neither response carries an ip or hash: the body is exactly the two opaque ids. (Not a /ip/i text scan: a random base64url
    // id contains "ip" in about 1 run in 20.)
    expect(Object.keys(b.body as object).sort()).toEqual(['groupId', 'refCode']);
    expect(JSON.stringify(b.body)).not.toMatch(/203\.0\.113/);
  });

  it('a non-boolean includeIp is 400', async () => {
    const { call, person } = await world();
    for (const includeIp of ['true', 1, 0, null, {}, []]) {
      const res = await call('POST', '/sanctions', { body: apply(person(), { includeIp }) });
      expect(res.status, JSON.stringify(includeIp)).toBe(400);
    }
  });

  it('an uncovered rule needs a gap note and opens a gap; a numbered rule must not carry one', async () => {
    const { call, person, cw } = await world();
    const none = await call('POST', '/sanctions', { body: apply(person(), { rule: 'uncovered' }) });
    expect([none.status, errorOf(none)]).toEqual([400, 'invalid_sanction']);
    const blank = await call('POST', '/sanctions', { body: apply(person(), { rule: 'uncovered', gapNote: '   ' }) });
    expect([blank.status, errorOf(blank)]).toEqual([400, 'invalid_sanction']);
    const long = await call('POST', '/sanctions', {
      body: apply(person(), { rule: 'uncovered', gapNote: 'x'.repeat(GAP_NOTE_MAX + 1) }),
    });
    expect([long.status, errorOf(long)]).toEqual([400, 'invalid_sanction']);
    const extra = await call('POST', '/sanctions', { body: apply(person(), { rule: 2, gapNote: 'not needed' }) });
    expect([extra.status, errorOf(extra)]).toEqual([400, 'invalid_sanction']);
    expect(cw.gaps.list()).toEqual([]);

    const ok = await call('POST', '/sanctions', { body: apply(person(), { rule: 'uncovered', gapNote: '  new griefing trick  ' }) });
    expect(ok.status).toBe(200);
    expect(cw.gaps.list()).toMatchObject([{ groupId: (ok.body as { groupId: string }).groupId, note: 'new griefing trick', status: 'open' }]);
  });

  it('a non-string gapNote is 400', async () => {
    const { call, person } = await world();
    for (const gapNote of [1, null, {}, ['a']]) {
      const res = await call('POST', '/sanctions', { body: apply(person(), { rule: 'uncovered', gapNote }) });
      expect(res.status, JSON.stringify(gapNote)).toBe(400);
    }
  });

  it('the rule must be citable: an unknown or retired number is 400, and nothing is written', async () => {
    const { call, person, audit } = await world();
    for (const rule of [0, -1, 1.5, '2', '', null, 9999, true]) {
      const res = await call('POST', '/sanctions', { body: apply(person(), { rule }) });
      expect(res.status, JSON.stringify(rule)).toBe(400);
    }
    expect(audit()).toEqual([]);
  });

  describe('durationMs is required: a positive int up to the cap, or explicit null', () => {
    it('missing, zero, negative, fractional, string, NaN-like and over the cap are all 400', async () => {
      const { call, person } = await world();
      const bad = [0, -1, 1.5, '3600000', true, [], {}, MAX_SANCTION_DURATION_MS + 1, 9e15, 1e300, Number.MAX_SAFE_INTEGER];
      for (const durationMs of bad) {
        const res = await call('POST', '/sanctions', { body: apply(person(), { durationMs }) });
        expect(res.status, JSON.stringify(durationMs)).toBe(400);
      }
      const missing: Record<string, unknown> = apply(person());
      delete missing.durationMs;
      expect((await call('POST', '/sanctions', { body: missing })).status).toBe(400);
      // Raw JSON that parses to a non-finite number is refused too.
      const raw = `{"subject":"${person()}","kind":"chat","rule":2,"durationMs":1e999}`;
      expect((await call('POST', '/sanctions', { raw })).status).toBe(400);
    });

    it('exactly the cap is accepted (control)', async () => {
      const { call, person } = await world();
      expect((await call('POST', '/sanctions', { body: apply(person(), { durationMs: MAX_SANCTION_DURATION_MS }) })).status).toBe(200);
      expect((await call('POST', '/sanctions', { body: apply(person(), { durationMs: 1 }) })).status).toBe(200);
    });
  });

  describe('validation (400)', () => {
    it('refuses a bad subject (router param charset), kind, body shape and unknown JSON', async () => {
      const { call, person, audit } = await world();
      const subjects = ['', 'a b', 'a/b', 'a.b', 'a'.repeat(65), 7, null, {}, ['x']];
      for (const subject of subjects) {
        expect((await call('POST', '/sanctions', { body: apply(person(), { subject }) })).status, JSON.stringify(subject)).toBe(400);
      }
      for (const kind of ['mute', 'BAN', '', 1, null, undefined]) {
        expect((await call('POST', '/sanctions', { body: apply(person(), { kind }) })).status, JSON.stringify(kind)).toBe(400);
      }
      for (const raw of ['', '{nope', '[]', '"s"', 'null', '7']) {
        expect((await call('POST', '/sanctions', { raw })).status, raw).toBe(400);
      }
      expect((await call('POST', '/sanctions', { body: apply(person(), { reason: 'r'.repeat(2001) }) })).status).toBe(400);
      expect((await call('POST', '/sanctions', { body: apply(person(), { reason: 7 }) })).status).toBe(400);
      expect(audit()).toEqual([]);
    });

    it('a body with a prototype-pollution key is 400', async () => {
      const { call, person } = await world();
      const raw = `{"subject":"${person()}","kind":"chat","durationMs":1000,"rule":2,"__proto__":{"x":1}}`;
      expect((await call('POST', '/sanctions', { raw })).status).toBe(400);
    });

    it('an oversized body is 413', async () => {
      const { call, person } = await world();
      const res = await call('POST', '/sanctions', { body: apply(person(), { reason: 'x'.repeat(70_000) }) });
      expect(res.status).toBe(413);
    });

    it('never echoes the subject, the gap note or the reason in an error', async () => {
      const { call } = await world();
      const res = await call('POST', '/sanctions', {
        body: apply('s_leaky_subject_value', { kind: 'nope', rule: 'uncovered', gapNote: 'secret-gap-note', reason: 'secret-reason' }),
      });
      const text = JSON.stringify(res.body);
      for (const s of ['s_leaky_subject_value', 'secret-gap-note', 'secret-reason']) expect(text).not.toContain(s);
      const note = await call('POST', '/sanctions', { body: apply('s_leaky_subject_value', { rule: 2, gapNote: 'secret-gap-note' }) });
      expect(JSON.stringify(note.body)).not.toContain('secret-gap-note');
    });
  });

  describe('permissions', () => {
    it('a moderator may apply a timed ban; a permanent ban needs senior, and a moderator is 403 with nothing written', async () => {
      const { call, person, audit, store, clock } = await world();
      const timed = await call('POST', '/sanctions', { role: 'moderator', body: apply(person(), { kind: 'ban', durationMs: DAY }) });
      expect(timed.status).toBe(200);
      const before = audit().length;
      const denied = await call('POST', '/sanctions', { role: 'moderator', body: apply(person(), { kind: 'ban', durationMs: null }) });
      expect([denied.status, errorOf(denied)]).toEqual([403, 'forbidden']);
      expect(audit()).toHaveLength(before);
      expect(store.loadSanctions(clock.t).filter((r) => r.kind === 'ban')).toHaveLength(1);
      for (const role of ['senior', 'owner'] as const) {
        expect((await call('POST', '/sanctions', { role, body: apply(person(), { kind: 'ban', durationMs: null }) })).status).toBe(200);
      }
    });

    it('a null duration on a chat restriction or area ban needs only sanctions.apply (as in decide)', async () => {
      const { call, person } = await world();
      expect((await call('POST', '/sanctions', { role: 'moderator', body: apply(person(), { kind: 'chat', durationMs: null }) })).status).toBe(200);
    });

    it('overrides apply: sanctions.apply raised to senior, ban_permanent lowered to moderator', async () => {
      const raised = await world({ permissions: { 'sanctions.apply': 'senior' } });
      expect((await raised.call('POST', '/sanctions', { role: 'moderator', body: apply(raised.person()) })).status).toBe(403);
      expect((await raised.call('POST', '/sanctions', { role: 'senior', body: apply(raised.person()) })).status).toBe(200);
      const lowered = await world({ permissions: { 'sanctions.apply.ban_permanent': 'moderator' } });
      expect(
        (await lowered.call('POST', '/sanctions', { role: 'moderator', body: apply(lowered.person(), { kind: 'ban', durationMs: null }) })).status,
      ).toBe(200);
    });

    it('authorization comes before validation: a too-low role with a bad body is 403, no authz is 401', async () => {
      const { call } = await world({ permissions: { 'sanctions.apply': 'senior' } });
      expect((await call('POST', '/sanctions', { role: 'moderator', raw: '{nope' })).status).toBe(403);
      expect((await call('POST', '/sanctions', { role: null, raw: '{nope' })).status).toBe(401);
    });
  });

  describe('audit', () => {
    it('writes sanction.apply with the group id as the target, the actor and the role, and no text', async () => {
      const { call, person, routeAudit, clock } = await world();
      const res = await call('POST', '/sanctions', {
        actor: 'ann',
        role: 'senior',
        body: apply(person(), { reason: 'secret-reason-text', rule: 'uncovered', gapNote: 'secret-gap-text' }),
      });
      const { groupId } = res.body as { groupId: string };
      expect(routeAudit()).toEqual([
        { id: expect.any(String), at: clock.t, actor: 'ann', role: 'senior', action: 'sanction.apply', target: { type: 'sanction', ref: groupId } },
      ]);
      expect(JSON.stringify(routeAudit())).not.toMatch(/secret-/);
    });

    it('a refused request leaves no row', async () => {
      const { call, person, audit } = await world();
      await call('POST', '/sanctions', { body: apply(person(), { kind: 'warning' }) });
      await call('POST', '/sanctions', { body: apply(person(), { rule: 9999 }) });
      expect(audit()).toEqual([]);
    });

    it('the sanction has committed, so a failed audit write is logged and the answer stands (200)', async () => {
      const { call, person, logged, cw } = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
      const res = await call('POST', '/sanctions', { body: apply(person(), { kind: 'warning', durationMs: null }) });
      expect(res.status).toBe(200);
      expect(logged.some(([e]) => e === 'chatwarden.http_audit_failed')).toBe(true);
      expect(cw.audit.list({ limit: 10 }).items).toEqual([]);
    });
  });

  it('a store failure is a plain 500 internal, with no detail', async () => {
    const { call, person, logged } = await world({
      wrap: (cw) => ({ ...cw, sanctions: { ...cw.sanctions, apply: () => Promise.reject(new Error('disk on fire: s_secret')) } }),
    });
    const res = await call('POST', '/sanctions', { body: apply(person()) });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(JSON.stringify(logged)).not.toContain('s_secret');
  });
});

describe('POST /sanctions/:groupId/revoke', () => {
  it('revokes the whole group, audits sanction.revoke, and a second revoke is 404', async () => {
    const { call, person, routeAudit, store, clock } = await world();
    const made = await call('POST', '/sanctions', { body: apply(person(), { durationMs: DAY, includeIp: true }) });
    const { groupId } = made.body as { groupId: string };
    expect(store.loadSanctions(clock.t).filter((r) => r.groupId === groupId)).toHaveLength(2);
    clock.t += 1000;
    const res = await call('POST', `/sanctions/${groupId}/revoke`, { actor: 'bob', role: 'senior', body: { reason: 'appeal upheld' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(store.loadSanctions(clock.t).filter((r) => r.groupId === groupId)).toEqual([]);
    expect(routeAudit().find((r) => r.action === 'sanction.revoke')).toEqual({
      id: expect.any(String),
      at: clock.t,
      actor: 'bob',
      role: 'senior',
      action: 'sanction.revoke',
      target: { type: 'sanction', ref: groupId },
    });
    const again = await call('POST', `/sanctions/${groupId}/revoke`, { body: { reason: 'again' } });
    expect([again.status, errorOf(again)]).toEqual([404, 'not_found']);
    expect(routeAudit().filter((r) => r.action === 'sanction.revoke')).toHaveLength(1);
  });

  it('an unknown group is 404 with no audit row; a group id outside the router charset is 404', async () => {
    const { call, routeAudit } = await world();
    expect((await call('POST', '/sanctions/nope/revoke', { body: { reason: 'x' } })).status).toBe(404);
    expect((await call('POST', `/sanctions/${'a'.repeat(65)}/revoke`, { body: { reason: 'x' } })).status).toBe(404);
    expect(routeAudit()).toEqual([]);
  });

  it('needs a reason string: missing, empty, blank, non-string and over-long are 400, and nothing is revoked', async () => {
    const { call, person, store, clock } = await world();
    const { groupId } = (await call('POST', '/sanctions', { body: apply(person(), { durationMs: DAY }) })).body as { groupId: string };
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 5 }, { reason: null }, { reason: 'r'.repeat(2001) }, []]) {
      const res = await call('POST', `/sanctions/${groupId}/revoke`, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('POST', `/sanctions/${groupId}/revoke`, { raw: '{nope' })).status).toBe(400);
    expect(store.loadSanctions(clock.t).filter((r) => r.groupId === groupId)).toHaveLength(1);
  });

  it('is moderator by default; sanctions.revoke can be raised', async () => {
    const { call, person } = await world({ permissions: { 'sanctions.revoke': 'owner' } });
    const { groupId } = (await call('POST', '/sanctions', { body: apply(person(), { durationMs: DAY }) })).body as { groupId: string };
    for (const role of ['moderator', 'senior'] as const) {
      expect((await call('POST', `/sanctions/${groupId}/revoke`, { role, body: { reason: 'x' } })).status).toBe(403);
    }
    expect((await call('POST', `/sanctions/${groupId}/revoke`, { role: 'owner', body: { reason: 'x' } })).status).toBe(200);
    const def = await world();
    const made = (await def.call('POST', '/sanctions', { body: apply(def.person(), { durationMs: DAY }) })).body as { groupId: string };
    expect((await def.call('POST', `/sanctions/${made.groupId}/revoke`, { role: 'moderator', body: { reason: 'x' } })).status).toBe(200);
  });

  it('never echoes the reason, and keeps it out of the audit row', async () => {
    const { call, person, audit } = await world();
    const { groupId } = (await call('POST', '/sanctions', { body: apply(person(), { durationMs: DAY }) })).body as { groupId: string };
    const res = await call('POST', `/sanctions/${groupId}/revoke`, { body: { reason: 'secret-revoke-reason' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(JSON.stringify(audit())).not.toContain('secret');
    const bad = await call('POST', `/sanctions/${groupId}/revoke`, { body: { reason: 'secret-revoke-reason'.repeat(200) } });
    expect(JSON.stringify(bad.body)).not.toContain('secret');
  });

  it('a failed audit write after the revoke is logged and the answer stands', async () => {
    const { call, person, logged } = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const { groupId } = (await call('POST', '/sanctions', { body: apply(person(), { durationMs: DAY }) })).body as { groupId: string };
    const res = await call('POST', `/sanctions/${groupId}/revoke`, { body: { reason: 'x' } });
    expect(res.status).toBe(200);
    expect(logged.filter(([e]) => e === 'chatwarden.http_audit_failed').length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /gaps', () => {
  it('lists the open gaps newest first with no person, and writes no audit row', async () => {
    const { call, gap, routeAudit, audit } = await world();
    const a = await gap('first note');
    const b = await gap('second note');
    const res = await call('GET', '/gaps', { role: 'moderator' });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>> };
    expect(body.items.map((g) => g.groupId)).toEqual([b.groupId, a.groupId]);
    expect(body.items[0]).toMatchObject({ refCode: b.refCode, actor: 'ann', note: 'second note', rule: 'uncovered', status: 'open' });
    expect(JSON.stringify(res.body)).not.toContain(a.subject);
    expect(routeAudit()).toEqual([]);
    expect(audit()).toEqual([]);
  });

  it('is an empty list when there are no gaps', async () => {
    const { call } = await world();
    expect((await call('GET', '/gaps')).body).toEqual({ items: [] });
  });

  it('gaps.read can be raised', async () => {
    const { call } = await world({ permissions: { 'gaps.read': 'senior' } });
    expect((await call('GET', '/gaps', { role: 'moderator' })).status).toBe(403);
    expect((await call('GET', '/gaps', { role: 'senior' })).status).toBe(200);
  });
});

describe('POST /gaps/:groupId/close', () => {
  it('closes a gap as not_a_rule (ref null or absent); only core writes the gap.close row, once', async () => {
    const { call, gap, cw, audit, routeAudit } = await world();
    const a = await gap();
    const b = await gap();
    expect((await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', actor: 'olga', body: { status: 'not_a_rule', ref: null } })).status).toBe(200);
    expect((await call('POST', `/gaps/${b.groupId}/close`, { role: 'owner', body: { status: 'not_a_rule' } })).status).toBe(200);
    expect(cw.gaps.list().map((g) => g.status)).toEqual(['not_a_rule', 'not_a_rule']);
    const closes = audit().filter((r) => r.action === 'gap.close');
    expect(closes).toHaveLength(2);
    expect(closes.find((r) => r.target?.ref === a.groupId)).toMatchObject({ actor: 'olga', target: { type: 'sanction', ref: a.groupId } });
    // The route wrote no second row (core's row has no role).
    expect(routeAudit()).toEqual([]);
  });

  it('closes a gap as ruled with the number of an active rule', async () => {
    const { call, gap, cw, db } = await world();
    const a = await gap();
    const res = await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', body: { status: 'ruled', ref: 3 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(cw.gaps.list()[0]?.status).toBe('ruled');
    expect(db.prepare('SELECT gap_ref, gap_status FROM kit_sanctions WHERE group_id = ? AND target_type = ?').get(a.groupId, 'subject')).toMatchObject({
      gap_ref: '3',
      gap_status: 'ruled',
    });
  });

  it('ruled needs an active CR number: missing, unknown, retired, non-integer, string and uncovered are 400 invalid_gap_ref', async () => {
    const { call, gap, cw } = await world();
    const a = await gap();
    const retired = cw.rules.all().find((r) => r.retired === true);
    const refs: unknown[] = [undefined, null, 9999, 0, -1, 1.5, '3', 'uncovered', true, [], {}];
    if (retired !== undefined) refs.push(retired.number);
    for (const ref of refs) {
      const body = ref === undefined ? { status: 'ruled' } : { status: 'ruled', ref };
      const res = await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', body });
      expect([res.status, errorOf(res)], JSON.stringify(ref)).toEqual([400, 'invalid_gap_ref']);
    }
    expect(cw.gaps.list()[0]?.status).toBe('open');
  });

  it('not_a_rule takes no ref: a number is 400 invalid_gap_ref', async () => {
    const { call, gap, cw } = await world();
    const a = await gap();
    const res = await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', body: { status: 'not_a_rule', ref: 3 } });
    expect([res.status, errorOf(res)]).toEqual([400, 'invalid_gap_ref']);
    expect(cw.gaps.list()[0]?.status).toBe('open');
  });

  it('the status must be ruled or not_a_rule: open, other strings and non-strings are 400', async () => {
    const { call, gap } = await world();
    const a = await gap();
    for (const status of ['open', 'closed', 'RULED', '', 1, null, undefined, {}]) {
      const res = await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', body: { status, ref: null } });
      expect(res.status, JSON.stringify(status)).toBe(400);
    }
    for (const raw of ['', '{nope', '[]']) {
      expect((await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', raw })).status).toBe(400);
    }
  });

  it('an unknown group, a sanction with no gap, and an already closed gap are 404', async () => {
    const { call, gap, person } = await world();
    const a = await gap();
    expect((await call('POST', '/gaps/nope/close', { role: 'owner', body: { status: 'not_a_rule' } })).status).toBe(404);
    const plain = await call('POST', '/sanctions', { body: apply(person(), { durationMs: DAY }) });
    const plainId = (plain.body as { groupId: string }).groupId;
    expect((await call('POST', `/gaps/${plainId}/close`, { role: 'owner', body: { status: 'not_a_rule' } })).status).toBe(404);
    expect((await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', body: { status: 'not_a_rule' } })).status).toBe(200);
    expect((await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', body: { status: 'ruled', ref: 2 } })).status).toBe(404);
  });

  it('is owner only by default; a senior and a moderator are 403 and nothing changes; an override applies', async () => {
    const { call, gap, cw } = await world();
    const a = await gap();
    for (const role of ['moderator', 'senior'] as const) {
      const res = await call('POST', `/gaps/${a.groupId}/close`, { role, body: { status: 'not_a_rule' } });
      expect([res.status, errorOf(res)]).toEqual([403, 'forbidden']);
    }
    expect(cw.gaps.list()[0]?.status).toBe('open');
    const lowered = await world({ permissions: { 'gaps.close': 'moderator' } });
    const g = await lowered.gap();
    expect((await lowered.call('POST', `/gaps/${g.groupId}/close`, { role: 'moderator', body: { status: 'not_a_rule' } })).status).toBe(200);
  });

  it('never echoes the ref or the note in an error', async () => {
    const { call, gap } = await world();
    const a = await gap('secret-gap-note');
    const res = await call('POST', `/gaps/${a.groupId}/close`, { role: 'owner', body: { status: 'ruled', ref: 'secret-ref' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
