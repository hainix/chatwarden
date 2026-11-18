import { describe, expect, it } from 'vitest';
import { BLOCKED, SEC, serviceWorld } from './serviceWorld.js';
import type { ServiceWorld } from './serviceWorld.js';
import { bodyOf } from './serviceKit.js';

// S2: what a /v1 answer never holds: a subject id, a person id, a hash, a key, a moderator, a reason a moderator wrote, a rule's private note, the matched term, a seat-to-person mapping.

const ROOM = 'privacy-room';

/** A busy conversation that touches every route, so the scan has something to scan. */
async function conversation(w: ServiceWorld): Promise<void> {
  const ip = '203.0.113.50';
  await w.seat(ROOM, 'a', 'alice-secret-handle', { who: { accountId: 'account-alice-0042', ip } });
  await w.seat(ROOM, 'b', 'bob-secret-handle', { who: { accountId: 'account-bob-0043', ip } });
  await w.seat(ROOM, 'c', 'carol-secret-handle', { who: { accountId: 'account-carol-0044' } });
  await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/c`);
  w.advance(2 * SEC);
  const said = bodyOf(await w.line(ROOM, 'b', 'a plain line from bob'));
  w.advance(2 * SEC);
  await w.line(ROOM, 'c', 'a plain line from carol');
  w.advance(2 * SEC);
  await w.line(ROOM, 'b', `you ${BLOCKED} there`);
  await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`);
  await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body: { target: 'b', lineId: said.line.id, reason: 'harassment', note: 'private reporter note' } });
  await w.warn(ROOM, 'c', 'b');
  await w.sanctionSeat('ban', ROOM, 'c', 3_600_000);
  const pending = bodyOf(await w.call('POST', '/notices/pending', { body: { who: w.who('bob-secret-handle') } }));
  await w.call('POST', `/notices/${pending.notices[0].id}/ack`, { body: { who: w.who('bob-secret-handle') } });
  await w.call('POST', '/record', { body: { who: w.who('bob-secret-handle') } });
  await w.call('POST', '/restriction', { body: { who: w.who('carol-secret-handle'), roomId: ROOM, seatId: 'c' } });
  await w.call('POST', '/doors/check', { body: { kind: 'join', who: w.who('carol-secret-handle') } });
  await w.call('POST', '/names/check', { body: { name: `Mr ${BLOCKED}` } });
  await w.call('GET', '/');
  await w.call('GET', '/', { key: null });
  await w.call('POST', '/rooms/x/seats/y/lines', { body: { nope: 1 } });
}

describe('privacy: no response in the whole suite holds an identifier', () => {
  it('a scan over every recorded response: no subject id, no person id, no hash, no key, no moderator field, no private reason, no matched term, no raw who, no handle', async () => {
    const w = await serviceWorld();
    await conversation(w);
    expect(w.recorded.length).toBeGreaterThanOrEqual(18);

    const text = JSON.stringify(w.recorded.map((r) => [r.status, r.body]));
    const headers = JSON.stringify(w.recorded.map((r) => r.headers ?? {}));
    const subjects = ['a', 'b', 'c'].map((s) => w.real.rooms.subjectAt(ROOM, s) as string);
    for (const subject of subjects) {
      expect(typeof subject).toBe('string');
      expect(text).not.toContain(subject);
      expect(headers).not.toContain(subject);
      // the subject id's body (the part after the prefix) is not there either
      expect(text).not.toContain(subject.slice(2));
    }
    const never = [
      /\bs_[A-Za-z0-9_-]{22}\b/, // a subject id
      /[0-9a-f]{24,}/i, // a hash or a digest
      /"(?:actor|moderator|reason_private|note_private|subject|person|staff|decidedBy|hash|seatId|accountId|clientKey|ip)"\s*:/i,
    ];
    for (const re of never) expect(text, String(re)).not.toMatch(re);
    for (const secret of [
      'mod@example.test',
      'private moderator reason',
      'private reporter note',
      'account-alice-0042',
      'account-bob-0043',
      'raw-client-key-',
      '203.0.113.50',
      'alice-secret-handle',
      'bob-secret-handle',
      'carol-secret-handle',
      BLOCKED,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // no key reaches a response or its headers
    for (const key of ['test-key-a-', 'test-key-b-']) {
      expect(text).not.toContain(key);
      expect(headers).not.toContain(key);
    }
  });

  it('what a seat call and a mutes call say about seats is the game\'s own ids and nothing about who sits there', async () => {
    const w = await serviceWorld();
    await conversation(w);
    const mutes = w.recorded.filter((r) => r.path.endsWith('/mutes') && r.method === 'GET');
    expect(mutes.length).toBeGreaterThan(0);
    for (const r of mutes) expect(Object.keys(r.body as object).sort()).toEqual(['blocked', 'muted']);
    const seats = w.recorded.filter((r) => r.method === 'PUT' && /\/seats\/[^/]+$/.test(r.path));
    for (const r of seats) expect(Object.keys(r.body as object).sort()).toEqual(['ok', 'restriction']);
  });

  it('the log lines of the whole conversation hold no key, who, line text, name, id or body', async () => {
    const w = await serviceWorld();
    await conversation(w);
    const text = JSON.stringify(w.logs);
    for (const secret of ['test-key-a-', 'test-key-b-', 'account-alice-0042', 'raw-client-key-', 'secret-handle', 'a plain line', BLOCKED, ROOM, 'private reporter note', '203.0.113.50']) {
      expect(text, secret).not.toContain(secret);
    }
    const events = new Set(w.logs.map(([e]) => e));
    for (const e of events) expect(e).toMatch(/^chatwarden\.[a-z_]+$/);
  });

  it('an unauthenticated or malformed call leaks nothing beyond the fixed error shape', async () => {
    const w = await serviceWorld();
    const bad = [
      await w.call('POST', `/rooms/${ROOM}/seats/a/lines`, { key: null, body: { text: 'secret-line-text' } }),
      await w.call('POST', `/rooms/${ROOM}/seats/a/lines`, { raw: '{"text": secret-line-text' }),
      await w.call('PUT', `/rooms/${ROOM}/seats/a`, { body: { who: { accountId: 'secret-account' }, handle: 'h', extra: 'secret-extra' } }),
    ];
    for (const res of bad) {
      expect(Object.keys(res.body as object).sort()).toEqual(['error', 'message']);
      expect(JSON.stringify(res.body)).not.toMatch(/secret/);
    }
  });
});
