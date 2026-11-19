import { describe, expect, it } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import { ROUTE_SPECS, SERVICE_SCHEMAS } from '../src/service/routes.js';
import { check } from './schemaCheck.js';
import { KEY_B, bodyOf, errorCode } from './serviceKit.js';
import { BLOCKED, SEC, serviceWorld } from './serviceWorld.js';
import type { ServiceWorld } from './serviceWorld.js';

// S2: the /v1 routes over the kit. A route is a thin adapter: validate, call the kit, copy the answer by name.

const ROOM = 'lobby';

/** Every recorded 200 answer fits the schema its route documents. */
function schemaProblems(w: ServiceWorld): string[] {
  const problems: string[] = [];
  for (const r of w.recorded) {
    if (r.status !== 200) continue;
    const spec = ROUTE_SPECS.find((s) => s.method === r.method && new RegExp(`^${s.path.replace(/:[A-Za-z]+(~[a-z]+)?/g, '[^/]+')}$`).test(r.path));
    if (spec === undefined) continue;
    for (const p of check(spec.answer as never, r.body, { components: { schemas: SERVICE_SCHEMAS as never } })) problems.push(`${r.method} ${r.path}: ${p}`);
  }
  return problems;
}

describe('seat, check and unseat', () => {
  it("a seated player's clean line is delivered with text and a line id and hiddenFor empty", async () => {
    const w = await serviceWorld();
    const seated = await w.seat(ROOM, 'p1', 'plenk');
    expect(seated.status).toBe(200);
    expect(bodyOf(seated)).toEqual({ ok: true, restriction: null });
    const res = await w.line(ROOM, 'p1', 'hello there');
    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body.ok).toBe(true);
    expect(body.line.text).toBe('hello there');
    expect(typeof body.line.id).toBe('string');
    expect(body.line.id.length).toBeGreaterThan(0);
    expect(body.hiddenFor).toEqual([]);
    expect(Object.keys(body).sort()).toEqual(['hiddenFor', 'line', 'ok']);
    expect(Object.keys(body.line).sort()).toEqual(['id', 'text']);
  });

  it('an unseated seat and an unknown room are refused gate', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    expect(bodyOf(await w.line(ROOM, 'nobody', 'hello'))).toEqual({ ok: false, refused: { reason: 'gate' } });
    expect(bodyOf(await w.line('never-seen', 'p1', 'hello'))).toEqual({ ok: false, refused: { reason: 'gate' } });
    w.advance(2 * SEC);
    expect(bodyOf(await w.call('DELETE', `/rooms/${ROOM}/seats/p1`))).toEqual({ ok: true });
    expect(bodyOf(await w.line(ROOM, 'p1', 'hello'))).toEqual({ ok: false, refused: { reason: 'gate' } });
  });

  it('DELETE seat is a no-op for an unknown seat or room; DELETE room drops seats and evidence', async () => {
    const w = await serviceWorld();
    expect(bodyOf(await w.call('DELETE', '/rooms/none/seats/none'))).toEqual({ ok: true });
    expect(bodyOf(await w.call('DELETE', '/rooms/none'))).toEqual({ ok: true });
    await w.seat(ROOM, 'p1', 'plenk');
    await w.seat(ROOM, 'p2', 'wumbo');
    await w.line(ROOM, 'p1', 'one');
    expect(w.real.rooms.list().some((r) => r.roomId === ROOM)).toBe(true);
    expect(bodyOf(await w.call('DELETE', `/rooms/${ROOM}`))).toEqual({ ok: true });
    expect(w.real.rooms.list().some((r) => r.roomId === ROOM)).toBe(false);
    expect(bodyOf(await w.line(ROOM, 'p1', 'two')).refused).toEqual({ reason: 'gate' });
    // evidence went with the room: a report about the line finds nothing to snapshot, and the room can be seated again fresh
    await w.seat(ROOM, 'p1', 'plenk');
    await w.seat(ROOM, 'p2', 'wumbo');
    const report = await w.call('POST', `/rooms/${ROOM}/seats/p2/reports`, { body: { target: 'p1' } });
    expect(bodyOf(report).ok).toBe(true);
    const stored = w.real.reports.list({}).items[0];
    expect(stored?.excerpt.some((l) => l.raw === 'one')).toBe(false);
  });

  it('a seat is held by the person who seated it last (a repeat PUT replaces)', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    const before = w.real.rooms.subjectAt(ROOM, 'p1');
    await w.seat(ROOM, 'p1', 'wumbo');
    await w.seat(ROOM, 'p2', 'wumbo');
    expect(w.real.rooms.subjectAt(ROOM, 'p1')).toBe(w.real.rooms.subjectAt(ROOM, 'p2'));
    expect(before).not.toBe(w.real.rooms.subjectAt(ROOM, 'p1'));
  });

  it('every answer fits the schema its route documents', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    await w.line(ROOM, 'p1', 'hello');
    await w.call('DELETE', `/rooms/${ROOM}/seats/p1`);
    expect(schemaProblems(w)).toEqual([]);
  });
});

describe('the check refuses as the kit does', () => {
  it('a REFUSED line retried with the same Idempotency-Key replays the stored refusal with the replay header and the kit is asked once (as an accepted line is)', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    const body = { text: `you ${BLOCKED}` };
    const first = await w.call('POST', `/rooms/${ROOM}/seats/p1/lines`, { body, idempotencyKey: 'slur-1' });
    const second = await w.call('POST', `/rooms/${ROOM}/seats/p1/lines`, { body, idempotencyKey: 'slur-1' });
    expect(bodyOf(first)).toMatchObject({ ok: false, refused: { reason: 'blocked' } });
    expect(first.headers?.['idempotent-replay']).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.headers?.['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(w.real.blocked.list({ days: 1 })).toHaveLength(1);
    // another key is a new call: judged again, no replay header
    const third = await w.call('POST', `/rooms/${ROOM}/seats/p1/lines`, { body, idempotencyKey: 'slur-2' });
    expect(third.headers?.['idempotent-replay']).toBeUndefined();
    expect(w.real.blocked.list({ days: 1 })).toHaveLength(2);
  });

  it('a slur is refused blocked with the rule and no term, earns a strike, and an automatic timeout lands after the kit threshold exactly as cw.chat.accept; the refusal body holds only the documented fields', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    const refusals: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      w.advance(2 * SEC);
      const res = await w.line(ROOM, 'p1', `you ${BLOCKED} number ${i}`);
      refusals.push(bodyOf(res));
    }
    for (const r of refusals) expect(r).toEqual({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    expect(w.real.blocked.list({ days: 1 })).toHaveLength(3);
    expect(JSON.stringify(refusals)).not.toContain(BLOCKED);
    // the third strike earned the automatic timeout
    w.advance(2 * SEC);
    const next = bodyOf(await w.line(ROOM, 'p1', 'hello again'));
    expect(next.ok).toBe(false);
    expect(next.refused.reason).toBe('restricted');
    expect(next.refused.byModerator).toBe(false);
    expect(typeof next.refused.until).toBe('number');
    const allowed = ['reason', 'until', 'byModerator', 'rule', 'noticeId', 'retryAfterMs'];
    for (const key of Object.keys(next.refused)) expect(allowed).toContain(key);
    expect(Object.keys(next).sort()).toEqual(['ok', 'refused']);
  });

  it('length: a line over 200 is refused length by the kit, one over 2000 characters without asking the kit (a spy)', async () => {
    let asked = 0;
    const w = await serviceWorld({
      world: {
        wrap: (cw: Chatwarden) => {
          const facade = Object.create(cw) as Chatwarden;
          facade.chat = {
            ...cw.chat,
            accept: (...args) => {
              asked += 1;
              return cw.chat.accept(...args);
            },
          };
          return facade;
        },
      },
    });
    await w.seat(ROOM, 'p1', 'plenk');
    expect(bodyOf(await w.line(ROOM, 'p1', 'x'.repeat(201))).refused).toEqual({ reason: 'length' });
    expect(asked).toBe(1);
    w.advance(2 * SEC);
    expect(bodyOf(await w.line(ROOM, 'p1', 'x'.repeat(2000))).refused).toEqual({ reason: 'length' });
    expect(asked).toBe(2);
    expect(bodyOf(await w.line(ROOM, 'p1', 'x'.repeat(2001))).refused).toEqual({ reason: 'length' });
    expect(asked).toBe(2);
    w.advance(2 * SEC);
    expect(bodyOf(await w.line(ROOM, 'p1', 'x'.repeat(200))).ok).toBe(true);
  });

  it('rate: a fourth line in 5 seconds is refused rate; empty text is refused empty', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    for (const t of ['one', 'two', 'three']) expect(bodyOf(await w.line(ROOM, 'p1', t)).ok).toBe(true);
    expect(bodyOf(await w.line(ROOM, 'p1', 'four')).refused).toEqual({ reason: 'rate' });
    w.advance(5 * SEC);
    expect(bodyOf(await w.line(ROOM, 'p1', '   ')).refused).toEqual({ reason: 'empty' });
  });

  it('slow mode answers retryAfterMs as the kit does', async () => {
    const w = await serviceWorld({ world: { pace: { slowModeMs: 5000 } } });
    await w.seat(ROOM, 'p1', 'plenk');
    expect(bodyOf(await w.line(ROOM, 'p1', 'one')).ok).toBe(true);
    w.advance(SEC);
    const second = bodyOf(await w.line(ROOM, 'p1', 'two'));
    expect(second.refused.reason).toBe('slow_mode');
    expect(second.refused.retryAfterMs).toBeGreaterThanOrEqual(1);
    expect(second.refused.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it('a refusing profanity filter answers profanity; a ban at the door is a restriction on the line', async () => {
    const w = await serviceWorld({ world: { profanity: 'refuse' } });
    await w.seat(ROOM, 'p1', 'plenk');
    expect(bodyOf(await w.line(ROOM, 'p1', 'oh glarn it')).refused).toEqual({ reason: 'profanity' });
    await w.sanctionSeat('ban', ROOM, 'p1', 3_600_000);
    w.advance(2 * SEC);
    const res = bodyOf(await w.line(ROOM, 'p1', 'hello'));
    expect(res.refused.reason).toBe('restricted');
    expect(res.refused.until).toBe(w.now() + 3_600_000 - 2 * SEC);
  });
});

describe('PUT seat: the body', () => {
  it('a malformed context is 400 invalid_request (from the kit RangeError); an unknown but well-formed context is accepted and every line is then refused gate', async () => {
    const w = await serviceWorld();
    for (const context of ['Bad Name', 'UPPER', '1abc', 'a'.repeat(33), 'has space', '']) {
      const res = await w.seat(`r-${context.length}`, 'p1', 'plenk', { tags: { context } });
      expect(res.status, JSON.stringify(context)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
    const ok = await w.seat('r-unknown', 'p1', 'plenk', { tags: { context: 'nowhere' } });
    expect(ok.status).toBe(200);
    expect(bodyOf(await w.line('r-unknown', 'p1', 'hello')).refused).toEqual({ reason: 'gate' });
  });

  it('a declared context is accepted and applies; a second seat that names another context for the room is 400', async () => {
    const w = await serviceWorld({ world: { contexts: { kids: { profanity: { mode: 'refuse' } } } } });
    expect((await w.seat('kids-room', 'p1', 'plenk', { tags: { context: 'kids' } })).status).toBe(200);
    expect(bodyOf(await w.line('kids-room', 'p1', 'oh glarn it')).refused).toEqual({ reason: 'profanity' });
    const other = await w.seat('kids-room', 'p2', 'wumbo', { tags: { context: 'nowhere' } });
    expect(other.status).toBe(400);
  });

  it('a malformed scope tag is 400; a well-formed one is accepted', async () => {
    const w = await serviceWorld();
    for (const scope of ['Creator Alice', 'UPPER', '', 'a'.repeat(65), ':x']) expect((await w.seat('scoped', 'p1', 'plenk', { tags: { scope } })).status, JSON.stringify(scope)).toBe(400);
    expect((await w.seat('scoped-ok', 'p1', 'plenk', { tags: { scope: 'creator:alice' } })).status).toBe(200);
  });

  it('tags: at most 8 keys, key [a-z][a-z0-9_]{0,23}, value 1..64 characters, strings only', async () => {
    const w = await serviceWorld();
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 'v']));
    expect((await w.seat('tags-ok', 'p1', 'plenk', { tags: eight })).status).toBe(200);
    expect((await w.seat('tags-nine', 'p1', 'plenk', { tags: { ...eight, k8: 'v' } })).status).toBe(400);
    expect((await w.seat('tags-ok-2', 'p1', 'plenk', { tags: { a: 'x'.repeat(64) } })).status).toBe(200);
    for (const tags of [{ A: 'v' }, { '1a': 'v' }, { a: '' }, { a: 'x'.repeat(65) }, { ['a'.repeat(25)]: 'v' }, { a: 5 }, { a: null }, [], 'tags', 5]) {
      const res = await w.call('PUT', '/rooms/tags-bad/seats/p1', { body: { who: w.who('plenk'), handle: 'plenk', tags } });
      expect(res.status, JSON.stringify(tags)).toBe(400);
    }
  });

  it('who with only ip is 400; handle must be 1..64 characters; unknown body keys, a missing who or handle and a non-object are 400; nothing is seated by a refused call', async () => {
    const w = await serviceWorld();
    const base = { who: w.who('plenk'), handle: 'plenk' };
    const bad: unknown[] = [
      { who: { ip: '203.0.113.7' }, handle: 'plenk' },
      { who: {}, handle: 'plenk' },
      { handle: 'plenk' },
      { who: base.who },
      { ...base, handle: '' },
      { ...base, handle: 'h'.repeat(65) },
      { ...base, handle: 5 },
      { ...base, extra: 1 },
      { ...base, who: { ...base.who, extra: 'x' } },
      { ...base, who: { clientKey: 'k'.repeat(257) } },
      [],
      'seat',
      null,
    ];
    for (const body of bad) {
      const res = await w.call('PUT', '/rooms/bad-bodies/seats/p1', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
    expect(w.real.rooms.list().some((r) => r.roomId === 'bad-bodies')).toBe(false);
    // 1 and 64 characters are fine
    expect((await w.call('PUT', '/rooms/ok-bodies/seats/p1', { body: { ...base, handle: 'h' } })).status).toBe(200);
    expect((await w.call('PUT', '/rooms/ok-bodies/seats/p2', { body: { who: w.who('wumbo'), handle: 'h'.repeat(64) } })).status).toBe(200);
  });

  it('an account id, a client key and an address all work as who; the address is the game\'s word (the kit sees it as given)', async () => {
    const w = await serviceWorld();
    expect((await w.call('PUT', '/rooms/ids/seats/a', { body: { who: { accountId: 'acct-1' }, handle: 'a' } })).status).toBe(200);
    expect((await w.call('PUT', '/rooms/ids/seats/b', { body: { who: { clientKey: 'ck-1', ip: '203.0.113.9' }, handle: 'b' } })).status).toBe(200);
    expect((await w.call('PUT', '/rooms/ids/seats/c', { body: { who: { accountId: 'acct-2', clientKey: 'ck-2', ip: '198.51.100.4' }, handle: 'c' } })).status).toBe(200);
  });
});

describe('restriction in the PUT answer', () => {
  it('a person with a chat sanction gets kind chat and until; a ban kind ban; a clean person gets null', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    await w.sanctionSeat('chat', ROOM, 'p1', 3_600_000);
    const again = bodyOf(await w.seat(ROOM, 'p1', 'plenk'));
    expect(again).toEqual({ ok: true, restriction: { until: w.now() + 3_600_000, kind: 'chat' } });
    const clean = bodyOf(await w.seat(ROOM, 'p2', 'wumbo'));
    expect(clean).toEqual({ ok: true, restriction: null });
    await w.seat('elsewhere', 'q1', 'grimble');
    await w.sanctionSeat('ban', 'elsewhere', 'q1', null);
    expect(bodyOf(await w.seat(ROOM, 'p3', 'grimble')).restriction).toEqual({ until: null, kind: 'ban' });
  });

  it('a stored chat sanction restricts the line itself, with the sanction\'s rule and the moderator flag', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'p1', 'plenk');
    await w.sanctionSeat('chat', ROOM, 'p1', 3_600_000);
    const res = bodyOf(await w.line(ROOM, 'p1', 'hello'));
    expect(res.refused).toMatchObject({ reason: 'restricted', byModerator: true, rule: 2 });
  });
});

describe('mutes', () => {
  it('PUT mutes/{target} mutes, GET lists the seat ids, hiddenFor on a later line lists the muting seat, DELETE removes it', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    await w.seat(ROOM, 'c', 'grimble');
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`))).toEqual({ muted: [], blocked: [] });
    expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`))).toEqual({ ok: true });
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`))).toEqual({ muted: ['b'], blocked: [] });
    w.advance(2 * SEC);
    expect(bodyOf(await w.line(ROOM, 'b', 'hello from b')).hiddenFor).toEqual(['a']);
    w.advance(2 * SEC);
    expect(bodyOf(await w.line(ROOM, 'c', 'hello from c')).hiddenFor).toEqual([]);
    expect(bodyOf(await w.call('DELETE', `/rooms/${ROOM}/seats/a/mutes/b`))).toEqual({ ok: true });
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`))).toEqual({ muted: [], blocked: [] });
    w.advance(2 * SEC);
    expect(bodyOf(await w.line(ROOM, 'b', 'hello again')).hiddenFor).toEqual([]);
  });

  it('muting oneself, an empty seat or an unknown seat is ok and a no-op; deleting a mute that is not there is ok', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    for (const target of ['a', 'empty', 'nobody-at-all']) {
      expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/${target}`))).toEqual({ ok: true });
    }
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`))).toEqual({ muted: [], blocked: [] });
    expect(bodyOf(await w.call('DELETE', `/rooms/${ROOM}/seats/a/mutes/empty`))).toEqual({ ok: true });
    expect(bodyOf(await w.call('GET', '/rooms/never/seats/a/mutes'))).toEqual({ muted: [], blocked: [] });
  });

  it('hiddenFor lists every muting seat, in a room of many, and only seats still seated', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'b', 'wumbo');
    for (const [i, name] of ['n1', 'n2', 'n3'].entries()) {
      await w.seat(ROOM, `m${i}`, name);
      await w.call('PUT', `/rooms/${ROOM}/seats/m${i}/mutes/b`);
    }
    await w.seat(ROOM, 'quiet', 'quiet');
    w.advance(2 * SEC);
    expect([...bodyOf(await w.line(ROOM, 'b', 'hi all')).hiddenFor].sort()).toEqual(['m0', 'm1', 'm2']);
    await w.call('DELETE', `/rooms/${ROOM}/seats/m1`);
    w.advance(2 * SEC);
    expect([...bodyOf(await w.line(ROOM, 'b', 'hi again')).hiddenFor].sort()).toEqual(['m0', 'm2']);
  });

  it('the mute body is none: a body with a key is 400 (the kind arrives with blocks), the ids are checked', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    expect((await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`, { body: { surprise: 1 } })).status).toBe(400);
    expect((await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/bad%20id`)).status).toBe(400);
    expect((await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/..`)).status).toBe(400);
  });
});

describe('reports', () => {
  it('a report with a line id and reason is ok with remaining; no report id is in the body; the report is stored with the evidence', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    const said = bodyOf(await w.line(ROOM, 'b', 'rude to plenk'));
    const res = await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body: { target: 'b', lineId: said.line.id, reason: 'harassment', note: 'it was rude' } });
    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body.ok).toBe(true);
    expect(body.remaining).toBe(9);
    expect(typeof body.detailUntil).toBe('number');
    expect(Object.keys(body).sort()).toEqual(['detailUntil', 'ok', 'remaining']);
    const stored = w.real.reports.list({}).items;
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(stored[0]!.id);
    expect(stored[0]!.excerpt.some((l) => l.raw === 'rude to plenk')).toBe(true);
  });

  it('refused reason_unknown, rate, duplicate, self and not_player come back as ok false with the refusal (and remaining on rate)', async () => {
    const w = await serviceWorld({ world: { limits: { reports: { perDay: 1 } } } });
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    await w.seat(ROOM, 'c', 'grimble');
    const report = (seat: string, body: unknown) => w.call('POST', `/rooms/${ROOM}/seats/${seat}/reports`, { body });
    expect(bodyOf(await report('a', { target: 'b', reason: 'not_a_reason' }))).toEqual({ ok: false, refused: 'reason_unknown' });
    expect(bodyOf(await report('a', { target: 'a' }))).toMatchObject({ ok: false, refused: 'self' });
    expect(bodyOf(await report('a', { target: 'ghost' }))).toMatchObject({ ok: false, refused: 'not_player' });
    expect(bodyOf(await report('a', { target: 'b' })).ok).toBe(true);
    expect(bodyOf(await report('a', { target: 'b' }))).toMatchObject({ ok: false });
    expect(bodyOf(await report('a', { target: 'c' }))).toEqual({ ok: false, refused: 'rate', remaining: 0 });
  });

  it('bad bodies are 400: no target, a bad id, a bad line id, a reason over 64, a note over 500, a non-string, an unknown key', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    const bad: unknown[] = [{}, { target: 5 }, { target: 'bad id' }, { target: 'b', lineId: 'bad id' }, { target: 'b', lineId: 5 }, { target: 'b', reason: 'r'.repeat(65) }, { target: 'b', note: 'n'.repeat(501) }, { target: 'b', note: 5 }, { target: 'b', extra: 1 }, [], 'x'];
    for (const body of bad) {
      const res = await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(w.real.reports.list({}).items).toHaveLength(0);
    expect((await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body: { target: 'b', note: 'n'.repeat(500), reason: 'r'.repeat(64) } })).status).toBe(200);
  });

  it('an Idempotency-Key replay files one report', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    const body = { target: 'b' };
    const first = await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body, idempotencyKey: 'rep-1' });
    const second = await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body, idempotencyKey: 'rep-1' });
    expect(second.headers?.['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(w.real.reports.list({}).items).toHaveLength(1);
    // without the key the second is the kit's duplicate refusal
    expect(bodyOf(await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body }))).toMatchObject({ ok: false });
  });
});

describe('notices', () => {
  async function warned() {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    await w.line(ROOM, 'b', 'rude to plenk');
    await w.warn(ROOM, 'a', 'b');
    return w;
  }

  it('a pending notice carries what the sanction was about (0.2.2) and still fits the documented schema', async () => {
    const w = await warned();
    const pending = bodyOf(await w.call('POST', '/notices/pending', { body: { who: w.who('wumbo') } }));
    expect(pending.notices[0].evidence).toBe('chat');
    expect(schemaProblems(w)).toEqual([]);
  });

  it('pending lists an unacknowledged notice for the named who; ack marks it; a second ack and another person\'s id both answer ok false in the same shape', async () => {
    const w = await warned();
    const pending = bodyOf(await w.call('POST', '/notices/pending', { body: { who: w.who('wumbo') } }));
    expect(pending.notices).toHaveLength(1);
    const notice = pending.notices[0];
    expect(notice).toMatchObject({ kind: 'warning', mustAcknowledge: true });
    expect(JSON.stringify(pending)).not.toContain('private moderator reason');
    expect(JSON.stringify(pending)).not.toContain('mod@example.test');
    // another person cannot ack it
    expect(bodyOf(await w.call('POST', `/notices/${notice.id}/ack`, { body: { who: w.who('plenk') } }))).toEqual({ ok: false });
    expect(bodyOf(await w.call('POST', `/notices/${notice.id}/ack`, { body: { who: w.who('wumbo') } }))).toEqual({ ok: true });
    // a retried ack is fine (the kit's own rule: marking a seen notice again is ok), so a lost answer can be asked again
    expect(bodyOf(await w.call('POST', `/notices/${notice.id}/ack`, { body: { who: w.who('wumbo') } }))).toEqual({ ok: true });
    expect(bodyOf(await w.call('POST', '/notices/some-unknown-id/ack', { body: { who: w.who('wumbo') } }))).toEqual({ ok: false });
    expect(bodyOf(await w.call('POST', '/notices/pending', { body: { who: w.who('wumbo') } })).notices).toEqual([]);
  });

  it('record lists sanction notices (seen or not); an unknown person gets empty lists, not 404', async () => {
    const w = await warned();
    const record = bodyOf(await w.call('POST', '/record', { body: { who: w.who('wumbo') } }));
    expect(record.record.map((n: { kind: string }) => n.kind)).toEqual(['warning']);
    const stranger = { who: { clientKey: 'a-player-nobody-has-met-0001' } };
    expect(bodyOf(await w.call('POST', '/notices/pending', { body: stranger }))).toEqual({ notices: [] });
    expect(bodyOf(await w.call('POST', '/record', { body: stranger }))).toEqual({ record: [] });
    // asking never creates a person
    expect(w.real.rooms.subjectAt(ROOM, 'a-player-nobody-has-met-0001')).toBeNull();
  });

  it('bad bodies are 400: no who, an ip-only who, unknown keys, a bad notice id in the path is 404', async () => {
    const w = await serviceWorld();
    for (const path of ['/notices/pending', '/record', '/notices/abc/ack']) {
      for (const body of [{}, { who: { ip: '203.0.113.7' } }, { who: w.who('x'), extra: 1 }, { who: 'x' }, [], 'x']) {
        expect((await w.call('POST', path, { body })).status, `${path} ${JSON.stringify(body)}`).toBe(400);
      }
    }
    expect((await w.call('POST', '/notices/has%20space/ack', { body: { who: w.who('x') } })).status).toBe(404);
  });

  it('a read that names a person is a POST: GET on these paths is 405', async () => {
    const w = await serviceWorld();
    for (const path of ['/notices/pending', '/record', '/restriction', '/doors/check', '/names/check']) {
      const res = await w.call('GET', path);
      expect(res.status, path).toBe(405);
      expect(res.headers?.allow).toContain('POST');
    }
  });
});

describe('restriction route', () => {
  it('answers restricted, until and kind for a named person; a clean or unknown person is not restricted', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.sanctionSeat('chat', ROOM, 'a', 3_600_000);
    expect(bodyOf(await w.call('POST', '/restriction', { body: { who: w.who('plenk') } }))).toEqual({ restricted: true, until: w.now() + 3_600_000, kind: 'chat' });
    expect(bodyOf(await w.call('POST', '/restriction', { body: { who: w.who('plenk'), roomId: ROOM, seatId: 'a' } }))).toMatchObject({ restricted: true, kind: 'chat' });
    expect(bodyOf(await w.call('POST', '/restriction', { body: { who: w.who('wumbo') } }))).toEqual({ restricted: false, until: null, kind: null });
  });

  it('roomId and seatId are optional ids, checked; unknown keys are 400', async () => {
    const w = await serviceWorld();
    for (const body of [{ who: w.who('x'), roomId: 'bad id' }, { who: w.who('x'), seatId: 5 }, { who: w.who('x'), extra: 1 }, { who: { ip: '203.0.113.7' } }, {}]) {
      expect((await w.call('POST', '/restriction', { body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('an automatic timeout in memory is found with the room and seat', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    for (let i = 0; i < 3; i++) {
      w.advance(2 * SEC);
      await w.line(ROOM, 'a', `${BLOCKED} ${i}`);
    }
    const res = bodyOf(await w.call('POST', '/restriction', { body: { who: w.who('plenk'), roomId: ROOM, seatId: 'a' } }));
    expect(res.restricted).toBe(true);
    expect(res.kind === 'auto' || res.kind === 'chat').toBe(true);
  });
});

describe('doors', () => {
  it('a banned who is refused with the kind, until and refCode and no staff field; a clean one is ok', async () => {
    const w = await serviceWorld();
    await w.seat('elsewhere', 'q', 'plenk');
    await w.sanctionSeat('ban', 'elsewhere', 'q', 3_600_000);
    for (const kind of ['join', 'create', 'public', 'matchmaking']) {
      const res = bodyOf(await w.call('POST', '/doors/check', { body: { kind, who: w.who('plenk') } }));
      expect(res.ok).toBe(false);
      expect(Object.keys(res).sort()).toEqual(['ok', 'refusal']);
      expect(res.refusal.kind).toBe('ban');
      expect(res.refusal.until).toBe(w.now() + 3_600_000);
      expect(typeof res.refusal.refCode).toBe('string');
      for (const key of Object.keys(res.refusal)) expect(['kind', 'until', 'refCode', 'noticeId']).toContain(key);
      expect(JSON.stringify(res)).not.toMatch(/mod@|private|actor|reason/);
    }
    expect(bodyOf(await w.call('POST', '/doors/check', { body: { kind: 'join', who: w.who('wumbo') } }))).toEqual({ ok: true });
  });

  it('bad kinds and bodies are 400', async () => {
    const w = await serviceWorld();
    for (const body of [{ kind: 'enter', who: w.who('x') }, { who: w.who('x') }, { kind: 'join' }, { kind: 'join', who: { ip: '203.0.113.7' } }, { kind: 5, who: w.who('x') }, { kind: 'join', who: w.who('x'), extra: 1 }]) {
      expect((await w.call('POST', '/doors/check', { body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('an address that is banned refuses a who that only brings that address along with a key', async () => {
    const w = await serviceWorld();
    await w.seat('elsewhere', 'q', 'plenk');
    await w.sanctionSeat('ban', 'elsewhere', 'q', 3_600_000);
    expect(bodyOf(await w.call('POST', '/doors/check', { body: { kind: 'join', who: { clientKey: 'a-fresh-client-key-0001', accountId: 'acct-fresh' } } }))).toEqual({ ok: true });
  });
});

describe('names', () => {
  it('ok and name_not_allowed with the rule; the name is never in any log line', async () => {
    const w = await serviceWorld();
    expect(bodyOf(await w.call('POST', '/names/check', { body: { name: 'Plenk the Brave' } }))).toEqual({ ok: true });
    const bad = bodyOf(await w.call('POST', '/names/check', { body: { name: `Mr ${BLOCKED}` } }));
    expect(bad).toMatchObject({ ok: false, reason: 'name_not_allowed' });
    expect(typeof bad.rule).toBe('number');
    expect(JSON.stringify(w.logs)).not.toContain(BLOCKED);
    expect(JSON.stringify(w.logs)).not.toContain('Plenk');
  });

  it('a who may ride along (it keys the kit\'s own check limit); the name is 1..64 characters; bad bodies are 400', async () => {
    const w = await serviceWorld();
    expect((await w.call('POST', '/names/check', { body: { name: 'a', who: w.who('x') } })).status).toBe(200);
    expect((await w.call('POST', '/names/check', { body: { name: 'a'.repeat(64) } })).status).toBe(200);
    for (const body of [{ name: '' }, { name: 'a'.repeat(65) }, { name: 5 }, {}, { name: 'x', who: 'x' }, { name: 'x', extra: 1 }, []]) {
      expect((await w.call('POST', '/names/check', { body })).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('every route', () => {
  it('needs a service key: no key is 401 on each, and a wrong key too', async () => {
    const w = await serviceWorld();
    const probes: Array<[string, string, unknown?]> = [
      ['PUT', '/rooms/r/seats/s', { who: w.who('x'), handle: 'x' }],
      ['DELETE', '/rooms/r/seats/s'],
      ['DELETE', '/rooms/r'],
      ['POST', '/rooms/r/seats/s/lines', { text: 'x' }],
      ['GET', '/rooms/r/seats/s/mutes'],
      ['PUT', '/rooms/r/seats/s/mutes/t'],
      ['DELETE', '/rooms/r/seats/s/mutes/t'],
      ['POST', '/rooms/r/seats/s/reports', { target: 't' }],
      ['POST', '/notices/pending', { who: w.who('x') }],
      ['POST', '/notices/n1/ack', { who: w.who('x') }],
      ['POST', '/record', { who: w.who('x') }],
      ['POST', '/restriction', { who: w.who('x') }],
      ['POST', '/names/check', { name: 'x' }],
      ['POST', '/doors/check', { kind: 'join', who: w.who('x') }],
    ];
    for (const [i, [method, path, body]] of probes.entries()) {
      // each probe from its own address, so the failure throttle (20 a minute per address) is not what answers
      const remoteAddress = `198.51.100.${i + 1}`;
      expect((await w.call(method, path, { key: null, remoteAddress, ...(body === undefined ? {} : { body }) })).status, `${method} ${path}`).toBe(401);
      expect((await w.call(method, path, { key: 'z'.repeat(40), remoteAddress, ...(body === undefined ? {} : { body }) })).status, `${method} ${path}`).toBe(401);
      // either of the two configured keys works
      const ok = await w.call(method, path, { key: KEY_B, remoteAddress, ...(body === undefined ? {} : { body }) });
      expect(ok.status, `${method} ${path}`).toBe(200);
    }
  });

  it('a non-JSON content type on each POST and on a PUT with a body is 400 invalid_request', async () => {
    const w = await serviceWorld();
    for (const [method, path] of [['PUT', '/rooms/r/seats/s'], ['POST', '/rooms/r/seats/s/lines'], ['POST', '/rooms/r/seats/s/reports'], ['POST', '/notices/pending'], ['POST', '/record'], ['POST', '/restriction'], ['POST', '/names/check'], ['POST', '/doors/check']] as const) {
      const res = await w.call(method, path, { body: { a: 1 }, contentType: 'text/plain' });
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
  });

  it('answers over toFetch at /v1 with the service headers, and over a malformed JSON body with invalid_json', async () => {
    const w = await serviceWorld();
    const seated = await w.fetchJson('PUT', '/rooms/fetch-room/seats/s1', { who: w.who('plenk'), handle: 'plenk' });
    expect(seated.status).toBe(200);
    expect(seated.headers.get('chatwarden-api')).toBe('1');
    expect(seated.body).toEqual({ ok: true, restriction: null });
    const line = await w.fetchJson('POST', '/rooms/fetch-room/seats/s1/lines', { text: 'hello' });
    expect((line.body as { ok: boolean }).ok).toBe(true);
    const res = await w.fetchJson('POST', '/names/check', undefined, { 'content-type': 'application/json' });
    expect(res.status).toBe(400);
  });
});

describe('idempotency on lines', () => {
  it('a retried slur is struck once; the replay does not spend a rate slot (a spy) and answers identically', async () => {
    let asked = 0;
    const w = await serviceWorld({
      world: {
        wrap: (cw: Chatwarden) => {
          const facade = Object.create(cw) as Chatwarden;
          facade.chat = {
            ...cw.chat,
            accept: (...args) => {
              asked += 1;
              return cw.chat.accept(...args);
            },
          };
          return facade;
        },
      },
    });
    await w.seat(ROOM, 'a', 'plenk');
    const first = await w.line(ROOM, 'a', `you ${BLOCKED}`, 'line-1');
    const again = await w.line(ROOM, 'a', `you ${BLOCKED}`, 'line-1');
    const third = await w.line(ROOM, 'a', `you ${BLOCKED}`, 'line-1');
    expect(bodyOf(first)).toEqual({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    expect(again.body).toEqual(first.body);
    expect(third.headers?.['idempotent-replay']).toBe('true');
    expect(asked).toBe(1);
    expect(w.real.blocked.list({ days: 1 })).toHaveLength(1);
    // without the key the same retry is judged and struck again
    w.advance(2 * SEC);
    await w.line(ROOM, 'a', `you ${BLOCKED}`);
    await w.line(ROOM, 'a', `you ${BLOCKED}`);
    expect(w.real.blocked.list({ days: 1 })).toHaveLength(3);
  });

  it('a delivered line replays as the same line id and is delivered once', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    const first = await w.line(ROOM, 'a', 'hello', 'line-2');
    const second = await w.line(ROOM, 'a', 'hello', 'line-2');
    expect(second.body).toEqual(first.body);
    const report = bodyOf(first).line.id as string;
    expect(w.real.rooms.lineStates(ROOM).filter((l) => l.lineId === report)).toHaveLength(1);
    expect(w.real.rooms.lineStates(ROOM)).toHaveLength(1);
  });

  it('the same key with another text is 409 idempotency_mismatch and the kit is not asked', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.line(ROOM, 'a', 'hello', 'line-3');
    const res = await w.line(ROOM, 'a', 'something else', 'line-3');
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('idempotency_mismatch');
    expect(w.real.rooms.lineStates(ROOM)).toHaveLength(1);
  });
});

describe('the table', () => {
  it('unknown paths under /v1 are 404 not_found; wrong methods are 405 with allow; HEAD is not supported', async () => {
    const w = await serviceWorld();
    expect((await w.call('GET', '/nothing/here')).status).toBe(404);
    expect(errorCode(await w.call('GET', '/rooms'))).toBe('not_found');
    const wrong = await w.call('POST', `/rooms/${ROOM}/seats/a/mutes`, { body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers?.allow).toContain('GET');
    const del = await w.call('DELETE', `/rooms/${ROOM}/seats/a/lines`);
    expect(del.status).toBe(405);
    expect(del.headers?.allow).toContain('POST');
    const head = await w.call('HEAD', `/rooms/${ROOM}/seats/a/mutes`);
    expect(head.status).toBe(405);
    expect((await w.call('HEAD', '/')).status).toBe(405);
  });

  it('a path with an empty segment, or one ending in a slash, is 404', async () => {
    const w = await serviceWorld();
    expect((await w.call('PUT', '/rooms//seats/a', { body: {} })).status).toBe(404);
    expect((await w.call('DELETE', `/rooms/${ROOM}/`)).status).toBe(404);
  });

  it('a seat id and a room id may hold : @ ~ . - _ and are opaque', async () => {
    const w = await serviceWorld();
    const room = 'match:2024.05@eu~1';
    const seat = 'user_1:a@b';
    expect((await w.seat(room, encodeURIComponent(seat), 'plenk')).status).toBe(200);
    expect(bodyOf(await w.line(room, encodeURIComponent(seat), 'hi')).ok).toBe(true);
  });
});
