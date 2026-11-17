import { describe, expect, it } from 'vitest';
import { errorOf, keysDeep, world } from './world.js';

// R4: the staff routes for rooms under attack. rooms.read lists, rooms.manage sets a mode and takes a line back. Both writes are audited FIRST and `required` (a failing audit write fails the call and
// changes nothing); the target is the room, by roomAuditRef. No seat id, handle or text anywhere.

type W = Awaited<ReturnType<typeof world>>;

function seat(w: W, room: string, name: string, line?: string): string | null {
  w.cw.rooms.seat(room, name, { clientKey: `rooms-key-${room}-${name}-aaaaaaaa` }, `Handle-${name}`);
  if (line === undefined) return null;
  w.clock.t += 6000;
  const res = w.cw.chat.accept(room, name, line);
  return 'deliver' in res ? res.deliver.lineId : null;
}

const failAudit = <T>(w: W, run: () => Promise<T>): Promise<T> => {
  const orig = w.cw.audit.record.bind(w.cw.audit);
  w.cw.audit.record = () => {
    throw new Error('audit down');
  };
  return run().finally(() => {
    w.cw.audit.record = orig;
  });
};

describe('permission boundaries', () => {
  it('rooms.read and rooms.manage are a moderator\'s by default and follow the permissions option; 401 without authz', async () => {
    const w = await world({ permissions: { 'rooms.read': 'senior', 'rooms.manage': 'owner' } });
    seat(w, 'R1', 'a', 'hello');
    expect((await w.call('GET', '/rooms', { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', '/rooms', { role: 'senior' })).status).toBe(200);
    expect((await w.call('GET', '/rooms', { role: null })).status).toBe(401);
    for (const role of ['moderator', 'senior'] as const) {
      expect((await w.call('POST', '/rooms/R1/mode', { role, body: { mode: 'locked' } })).status, role).toBe(403);
      expect((await w.call('POST', '/rooms/R1/lines/1/retract', { role, body: {} })).status, role).toBe(403);
    }
    expect((await w.call('POST', '/rooms/R1/mode', { role: 'owner', body: { mode: 'locked' } })).status).toBe(200);
    const d = await world();
    expect((await d.call('GET', '/rooms', { role: 'moderator' })).status).toBe(200);
    expect((await d.call('POST', '/rooms/R1/mode', { role: 'moderator', body: { mode: 'locked' } })).status).toBe(200);
  });
});

describe('GET /rooms', () => {
  it('is no-store JSON with { rooms } and no seat id or handle; most seated first; the mode and its end', async () => {
    const w = await world();
    seat(w, 'small', 'a');
    seat(w, 'big', 'a');
    seat(w, 'big', 'b');
    w.cw.rooms.setMode('small', 'locked', { forMs: 600_000 });
    const res = await w.call('GET', '/rooms');
    expect(res.status).toBe(200);
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      rooms: [
        { roomId: 'big', tags: {}, seated: 2, mode: 'normal', until: null },
        { roomId: 'small', tags: {}, seated: 1, mode: 'locked', until: w.clock.t + 600_000 },
      ],
    });
    const text = JSON.stringify(res.body);
    for (const needle of ['Handle-', 'rooms-key']) expect(text).not.toContain(needle);
    expect(w.routeAudit().filter((r) => /room/.test(r.action))).toEqual([]);
  });

  it('an empty kit is an empty list', async () => {
    const w = await world();
    expect((await w.call('GET', '/rooms')).body).toEqual({ rooms: [] });
  });
});

describe('POST /rooms/:room/mode', () => {
  it('200 with the new state; the room reads that mode; normal clears and needs no forMs', async () => {
    const w = await world();
    seat(w, 'R1', 'a');
    const res = await w.call('POST', '/rooms/R1/mode', { body: { mode: 'emergency', forMs: 120_000 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'emergency', since: w.clock.t, until: w.clock.t + 120_000 });
    expect(w.cw.rooms.mode('R1')).toMatchObject({ mode: 'emergency' });
    const def = await w.call('POST', '/rooms/R1/mode', { body: { mode: 'locked' } });
    expect(def.body).toMatchObject({ mode: 'locked', until: w.clock.t + 1_800_000 });
    const clear = await w.call('POST', '/rooms/R1/mode', { body: { mode: 'normal' } });
    expect(clear.body).toEqual({ mode: 'normal', since: null, until: null });
    expect(w.cw.rooms.mode('R1').mode).toBe('normal');
  });

  it('400 invalid_mode for an unknown mode, a bad forMs and a bad body; nothing changes and nothing is audited', async () => {
    const w = await world();
    w.cw.rooms.setMode('R1', 'locked', { forMs: 600_000 });
    const before = w.cw.rooms.mode('R1');
    for (const mode of ['lock', 'LOCKED', '', 5, null, undefined, {}, ['locked']]) {
      const res = await w.call('POST', '/rooms/R1/mode', { body: { mode } });
      expect([res.status, errorOf(res)], JSON.stringify(mode)).toEqual([400, 'invalid_mode']);
    }
    for (const forMs of [59_999, 86_400_001, 2.5, NaN, -1, 0, '60000', null, true]) {
      const res = await w.call('POST', '/rooms/R1/mode', { body: { mode: 'locked', forMs } });
      expect([res.status, errorOf(res)], JSON.stringify(forMs)).toEqual([400, 'invalid_value']);
    }
    for (const body of [[], 'locked', 5, null]) {
      const res = await w.call('POST', '/rooms/R1/mode', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const extra = await w.call('POST', '/rooms/R1/mode', { body: { mode: 'locked', actor: 'someone', reason: 'x' } });
    expect([extra.status, errorOf(extra)]).toEqual([400, 'invalid_request']);
    expect((await w.call('POST', '/rooms/R1/mode', { raw: '{not json' })).status).toBe(400);
    expect(w.cw.rooms.mode('R1')).toEqual(before);
    expect(w.routeAudit().filter((r) => r.action === 'room.mode')).toEqual([]);
  });

  it('a bad room id is 400 invalid_request: empty after decoding is no route, a control character or a very long id is refused', async () => {
    const w = await world();
    for (const room of ['bad%00id', 'x'.repeat(129), 'tab%09id']) {
      const res = await w.call('POST', `/rooms/${room}/mode`, { body: { mode: 'locked' } });
      expect([res.status, errorOf(res)], room).toEqual([400, 'invalid_request']);
    }
    expect(w.cw.rooms.list()).toEqual([]);
  });

  it('the audit write comes first and is required: a failing audit leaves the room unchanged and the call a 500', async () => {
    const w = await world();
    seat(w, 'R1', 'a');
    const res = await failAudit(w, () => w.call('POST', '/rooms/R1/mode', { body: { mode: 'locked' } }));
    expect(res.status).toBe(500);
    expect(w.cw.rooms.mode('R1').mode).toBe('normal');
    // the same for clearing a mode
    w.cw.rooms.setMode('R1', 'locked', { forMs: 600_000 });
    const clear = await failAudit(w, () => w.call('POST', '/rooms/R1/mode', { body: { mode: 'normal' } }));
    expect(clear.status).toBe(500);
    expect(w.cw.rooms.mode('R1').mode).toBe('locked');
  });

  it('audits room.mode with the room as target, actor and role, and no detail; normal is audited too', async () => {
    const w = await world();
    await w.call('POST', '/rooms/lobby-1/mode', { actor: 'mod_ann', body: { mode: 'emergency' } });
    await w.call('POST', '/rooms/lobby-1/mode', { actor: 'mod_ann', body: { mode: 'normal' } });
    const rows = w.routeAudit().filter((r) => r.action === 'room.mode');
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ actor: 'mod_ann', role: 'moderator', target: { type: 'room', ref: 'lobby-1' } });
    expect(JSON.stringify(rows)).not.toMatch(/"detail"|emergency|forMs/);
  });

  it('a room with an awkward id is audited by hash and the id never reaches the trail', async () => {
    const w = await world();
    const awkward = 'Ranked lobby / EU éè #7';
    const res = await w.call('POST', `/rooms/${encodeURIComponent(awkward)}/mode`, { body: { mode: 'locked' } });
    expect(res.status).toBe(200);
    expect(w.cw.rooms.mode(awkward).mode).toBe('locked');
    const row = w.routeAudit().find((r) => r.action === 'room.mode');
    expect(row?.target?.type).toBe('room');
    expect(row?.target?.ref).toMatch(/^h-[0-9a-f]{16}$/);
    expect(JSON.stringify(w.audit())).not.toContain('Ranked');
    // the same id always gives the same ref
    await w.call('POST', `/rooms/${encodeURIComponent(awkward)}/mode`, { body: { mode: 'normal' } });
    const refs = w.routeAudit().filter((r) => r.action === 'room.mode').map((r) => r.target?.ref);
    expect(new Set(refs).size).toBe(1);
  });

  it('a mode set here is what the chat sees: a non-staff line is refused locked', async () => {
    const w = await world();
    seat(w, 'R1', 'a');
    await w.call('POST', '/rooms/R1/mode', { body: { mode: 'locked' } });
    expect(w.cw.chat.accept('R1', 'a', 'hello')).toMatchObject({ refuse: { reason: 'locked' } });
    expect(w.cw.chat.accept('R1', 'a', 'hello', { staff: true })).toMatchObject({ deliver: { text: 'hello' } });
  });

  it('a mode never writes a sanction, notice or strike', async () => {
    const w = await world();
    seat(w, 'R1', 'a');
    await w.call('POST', '/rooms/R1/mode', { body: { mode: 'emergency' } });
    expect(w.store.loadStrikes(0)).toEqual([]);
    expect(w.store.loadSanctions(w.clock.t)).toEqual([]);
  });
});

describe('POST /rooms/:room/lines/:line/retract', () => {
  it('200 with the count; the line is retracted in the evidence and the body holds no text', async () => {
    const w = await world();
    const id = seat(w, 'R1', 'a', 'SENTINEL-line-text');
    const res = await w.call('POST', `/rooms/R1/lines/${id}/retract`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1 });
    expect(JSON.stringify(res.body)).not.toContain('SENTINEL');
    expect(w.cw.rooms.retract('R1', id!).ok).toBe(false);
  });

  it('the body may be absent; allFromAuthor is honoured and must be a boolean', async () => {
    const w = await world();
    const first = seat(w, 'R1', 'a', 'one');
    seat(w, 'R1', 'b', 'fine');
    w.clock.t += 6000;
    w.cw.chat.accept('R1', 'a', 'two');
    const bad = await w.call('POST', `/rooms/R1/lines/${first}/retract`, { body: { allFromAuthor: 'yes' } });
    expect([bad.status, errorOf(bad)]).toEqual([400, 'invalid_request']);
    const extra = await w.call('POST', `/rooms/R1/lines/${first}/retract`, { body: { allFromAuthor: true, text: 'x' } });
    expect([extra.status, errorOf(extra)]).toEqual([400, 'invalid_request']);
    const res = await w.call('POST', `/rooms/R1/lines/${first}/retract`, { body: { allFromAuthor: true } });
    expect(res.body).toEqual({ count: 2 });
    const none = await w.call('POST', '/rooms/R1/lines/1/retract', {});
    expect(none.status).toBe(404);
  });

  it('404 not_found for an old line, an unknown line and an unknown room, with the same body', async () => {
    const w = await world();
    const id = seat(w, 'R1', 'a', 'one');
    w.clock.t += 16 * 60_000;
    const old = await w.call('POST', `/rooms/R1/lines/${id}/retract`, { body: {} });
    const unknown = await w.call('POST', '/rooms/R1/lines/9999/retract', { body: {} });
    const room = await w.call('POST', '/rooms/nope/lines/1/retract', { body: {} });
    for (const res of [old, unknown, room]) expect([res.status, errorOf(res)]).toEqual([404, 'not_found']);
    expect(old.body).toEqual(unknown.body);
    expect(unknown.body).toEqual(room.body);
  });

  it('audits room.retract first and required: a failing audit leaves the line as it was', async () => {
    const w = await world();
    const id = seat(w, 'R1', 'a', 'one');
    const res = await failAudit(w, () => w.call('POST', `/rooms/R1/lines/${id}/retract`, { body: {} }));
    expect(res.status).toBe(500);
    expect(w.cw.rooms.retract('R1', id!, undefined)).toMatchObject({ ok: true });
  });

  it('audits room.retract with the room as target and no line, text or detail', async () => {
    const w = await world();
    const id = seat(w, 'R1', 'a', 'one');
    await w.call('POST', `/rooms/R1/lines/${id}/retract`, { actor: 'mod_ann', body: {} });
    const rows = w.routeAudit().filter((r) => r.action === 'room.retract');
    expect(rows).toEqual([expect.objectContaining({ actor: 'mod_ann', role: 'moderator', target: { type: 'room', ref: 'R1' } })]);
    expect(JSON.stringify(rows)).not.toMatch(/"detail"|"one"/);
  });

  it('writes no notice, strike or sanction and the author is told nothing', async () => {
    const w = await world();
    const id = seat(w, 'R1', 'a', 'one');
    await w.call('POST', `/rooms/R1/lines/${id}/retract`, { body: {} });
    expect(w.store.loadStrikes(0)).toEqual([]);
    expect(w.store.loadSanctions(w.clock.t)).toEqual([]);
  });

  it('a line param that is not a line id is no route', async () => {
    const w = await world();
    const res = await w.call('POST', '/rooms/R1/lines/a%20b/retract', { body: {} });
    expect(res.status).toBe(404);
  });
});

describe('the whole surface', () => {
  it('no body carries a seat, a handle, a subject or a key', async () => {
    const w = await world();
    const id = seat(w, 'R1', 'a', 'hello');
    const bodies = [
      (await w.call('GET', '/rooms')).body,
      (await w.call('POST', '/rooms/R1/mode', { body: { mode: 'locked' } })).body,
      (await w.call('POST', `/rooms/R1/lines/${id}/retract`, { body: {} })).body,
    ];
    for (const key of keysDeep(bodies)) expect(key, key).not.toMatch(/seatId|handle|subject|person|actor|text/i);
  });
});
