import { describe, expect, it } from 'vitest';
import type { Chatwarden, ReportInput } from '@chatwarden/core';
import type { KitResponse } from '../src/types.js';
import { BLOCKED, NOW, SEC, routeWorld } from './chat-world.js';
import type { RouteWorld } from './chat-world.js';

const ROOM = 'lobby';
const body = (res: KitResponse): Record<string, unknown> => res.body as Record<string, unknown>;

/** Every response of the chat routes says no-store and nosniff, errors included. */
function expectSafeHeaders(res: KitResponse) {
  expect(res.headers?.['cache-control']).toBe('no-store');
  expect(res.headers?.['x-content-type-options']).toBe('nosniff');
}

/** A first line from `name`, to have something to mute and report. */
async function firstLine(w: RouteWorld, name: string, text = 'a first line') {
  w.advance(2 * SEC);
  const res = await w.post(ROOM, 'lines', w.as(name), { text });
  return (body(res).line as { id: string }).id;
}

describe('every route and status in the table', () => {
  describe('GET /rooms/:room/stream', () => {
    it('200 with the stream headers and an open response', async () => {
      const w = await routeWorld();
      const res = await w.stream(ROOM, w.as('plenk'));
      expect(res.status).toBe(200);
      expect(res.stream).toBeDefined();
      expect(res.headers).toMatchObject({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      });
      expect(res.body).toBeUndefined();
    });

    it('401 for nobody, an address alone, and an empty key', async () => {
      const w = await routeWorld();
      const nobody: Array<Record<string, string>> = [{}, { 'x-ip': '203.0.113.9' }, { 'x-key': '' }, { 'x-key': '', 'x-account': '' }];
      for (const headers of nobody) {
        const res = await w.stream(ROOM, headers);
        expect(res.status).toBe(401);
        expect(body(res)).toEqual({ error: 'unauthorized', message: 'Authentication is required.' });
        expectSafeHeaders(res);
      }
      expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    });

    it('403 when join says no', async () => {
      const w = await routeWorld();
      const res = await w.stream(ROOM, w.as('plenk', { 'x-join': 'null' }));
      expect(res.status).toBe(403);
      expect(body(res).error).toBe('forbidden');
      expectSafeHeaders(res);
      expect(w.chat.stats().members).toBe(0);
    });

    it('429 with retry-after in whole seconds when the open limit is spent', async () => {
      const w = await routeWorld({ routes: { openRateLimit: { max: 2, windowMs: 60_000 } } });
      expect((await w.stream(ROOM, w.as('plenk'))).status).toBe(200);
      expect((await w.stream(ROOM, w.as('plenk'))).status).toBe(200);
      w.advance(1500);
      const res = await w.stream(ROOM, w.as('plenk'));
      expect(res.status).toBe(429);
      expect(res.headers?.['retry-after']).toBe('59'); // 58.5 s rounded up
      expect(body(res).error).toBe('rate_limited');
      expectSafeHeaders(res);
      // another player has their own budget
      expect((await w.stream(ROOM, w.as('wumbo'))).status).toBe(200);
    });

    it('429 when the room is full', async () => {
      const w = await routeWorld({ options: { maxMembers: 1 } });
      w.listen(await w.stream(ROOM, w.as('plenk')));
      const full = await w.stream(ROOM, w.as('wumbo'));
      expect(full.status).toBe(429);
      expect(full.headers?.['retry-after']).toBe('5');
      expect(w.chat.stats().members).toBe(1);
    });

    it('a tab over the per-player limit is 200: the oldest stream of that player is ended', async () => {
      const w = await routeWorld({ options: { maxStreamsPerMember: 1 } });
      const old = w.listen(await w.stream(ROOM, w.as('plenk')));
      const res = await w.stream(ROOM, w.as('plenk'));
      expect(res.status).toBe(200);
      const fresh = w.listen(res);
      expect(old.sink.ended).toBe(true);
      expect(fresh.sink.ended).toBe(false);
      expect(w.chat.stats().streams).toBe(1);
    });

    it('429 when the process is at maxStreams', async () => {
      const w = await routeWorld({ options: { maxStreams: 1 } });
      w.listen(await w.stream(ROOM, w.as('plenk')));
      const res = await w.stream(ROOM, w.as('wumbo'));
      expect(res.status).toBe(429);
      expect(res.headers?.['retry-after']).toBe('5');
    });

    it('HEAD on the stream route does no identity work: no seat, no room, no open-limit hit', async () => {
      const w = await routeWorld({ routes: { openRateLimit: { max: 1, windowMs: 60_000 } } });
      for (let i = 0; i < 5; i += 1) {
        const res = await w.call('HEAD', `/rooms/${ROOM}/stream`, { headers: w.as('plenk') });
        expect(res.status).toBe(200);
        expect(res.headers?.['content-type']).toBe('text/event-stream; charset=utf-8');
        expect(res.headers?.['cache-control']).toBe('no-store, no-transform');
      }
      // even without credentials: a HEAD asks nothing of the player
      expect((await w.call('HEAD', `/rooms/${ROOM}/stream`, { headers: {} })).status).toBe(200);
      expect(w.seatCalls).toHaveLength(0);
      expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
      expect(w.pending()).toBe(0);
      // the one real open the limit allows is still there
      expect((await w.stream(ROOM, w.as('plenk'))).status).toBe(200);
      expect((await w.stream(ROOM, w.as('plenk'))).status).toBe(429);
    });

    it('a session() that fails inside is a 500, not a 429', async () => {
      const w = await routeWorld({
        wrap: (cw) => {
          const f = Object.create(cw) as Chatwarden;
          f.rooms = {
            ...cw.rooms,
            seat: () => {
              throw new TypeError('store is down');
            },
          };
          return f;
        },
      });
      for (const res of [await w.stream(ROOM, w.as('plenk')), await w.post(ROOM, 'lines', w.as('plenk'), { text: 'hi' })]) {
        expect(res.status).toBe(500);
        expect(body(res)).toEqual({ error: 'internal' });
        expectSafeHeaders(res);
      }
      expect(JSON.stringify(w.logs)).not.toContain('store is down');
    });

    it('429 with retry-after when the process holds the most rooms it is allowed; a room that exists still takes players', async () => {
      const w = await routeWorld({ options: { maxRooms: 1 } });
      expect((await w.post('room-a', 'lines', w.as('plenk'), { text: 'hi' })).status).toBe(200);
      const res = await w.post('room-b', 'lines', w.as('wumbo'), { text: 'hi' });
      expect(res.status).toBe(429);
      expect(res.headers?.['retry-after']).toBe('5');
      expect((await w.post('room-a', 'lines', w.as('glarn'), { text: 'hi' })).status).toBe(200);
    });

    it('every stream response, a banned one included, says no-store and no-transform so a body-rewriting middleware leaves it alone', async () => {
      const w = await routeWorld();
      const open = await w.stream(ROOM, w.as('plenk'));
      expect(open.headers?.['cache-control']).toBe('no-store, no-transform');
      w.join('elsewhere', 'wumbo');
      await w.sanction('ban', 'elsewhere', 'wumbo', 3_600_000);
      const banned = await w.stream(ROOM, w.as('wumbo'));
      expect(banned.headers?.['cache-control']).toBe('no-store, no-transform');
      // the JSON answers keep plain no-store
      expect((await w.stream(ROOM, {})).headers?.['cache-control']).toBe('no-store');
    });

    it('a slow consumer that stays backed up is closed after maxBacklog writes and its response ended', async () => {
      const w = await routeWorld({ options: { maxBacklog: 3 } });
      const slow = w.listen(await w.stream(ROOM, w.as('plenk')));
      const talker = w.listen(await w.stream(ROOM, w.as('wumbo')));
      slow.sink.backedUp = true; // the connection stops draining
      for (const text of ['one', 'two', 'three', 'four']) {
        w.advance(2 * SEC);
        await w.post(ROOM, 'lines', w.as('wumbo'), { text });
      }
      expect(slow.sink.ended).toBe(true);
      expect(slow.text()).not.toContain('four'); // nothing written after it was dropped
      expect(w.chat.stats().streams).toBe(1);
      expect(talker.text()).toContain('four');
      slow.cancel(); // the adapter's cancel after the end: harmless
      expect(w.chat.stats().streams).toBe(1);
    });

    it('a sink that throws on the first frame leaves no stream, timer or slot behind', async () => {
      const w = await routeWorld();
      const res = await w.stream(ROOM, w.as('plenk'));
      const stream = res.stream;
      if (stream === undefined) throw new Error('not a stream');
      let ended = false;
      expect(() =>
        stream.start({
          write: () => {
            throw new Error('socket gone');
          },
          end: () => {
            ended = true;
          },
        }),
      ).not.toThrow();
      expect(ended).toBe(true);
      expect(w.chat.stats().streams).toBe(0);
      // only the seat's grace timer is left; the heartbeat was cancelled with the stream
      expect(w.pending()).toBe(1);
    });

    it('a banned player gets 200 and one bye frame, then the response ends', async () => {
      const w = await routeWorld();
      w.join('elsewhere', 'plenk');
      await w.sanction('ban', 'elsewhere', 'plenk', 3_600_000);
      const res = await w.stream(ROOM, w.as('plenk'));
      expect(res.status).toBe(200);
      const heard = w.listen(res);
      expect(heard.text()).toBe(`event: bye\ndata: {"type":"bye","reason":"banned","until":${NOW + 3_600_000}}\n\n`);
      expect(heard.sink.ended).toBe(true);
      expect(w.chat.stats().streams).toBe(0);
    });

    it('a permanent ban says until null', async () => {
      const w = await routeWorld();
      w.join('elsewhere', 'plenk');
      await w.sanction('ban', 'elsewhere', 'plenk', null);
      const heard = w.listen(await w.stream(ROOM, w.as('plenk')));
      expect(heard.text()).toContain('"until":null');
    });
  });

  describe('POST /rooms/:room/lines', () => {
    it('200 delivered', async () => {
      const w = await routeWorld();
      const res = await w.post(ROOM, 'lines', w.as('plenk'), { text: 'hello there' });
      expect(res.status).toBe(200);
      expect(body(res)).toEqual({ ok: true, line: { id: expect.any(String), at: NOW, name: 'plenk', text: 'hello there', mine: true } });
      expectSafeHeaders(res);
    });

    it('200 refused (a refusal is an answer, not an error)', async () => {
      const w = await routeWorld();
      const res = await w.post(ROOM, 'lines', w.as('plenk'), { text: `you ${BLOCKED}` });
      expect(res.status).toBe(200);
      expect(body(res)).toEqual({ ok: false, refused: { reason: 'blocked', rule: 1 } });
      const long = await w.post(ROOM, 'lines', w.as('plenk'), { text: 'x'.repeat(201) });
      expect(body(long)).toEqual({ ok: false, refused: { reason: 'length' } });
    });

    it('200 refused for a banned player, with the ban', async () => {
      const w = await routeWorld();
      w.join('elsewhere', 'plenk');
      await w.sanction('ban', 'elsewhere', 'plenk', 3_600_000);
      const res = await w.post(ROOM, 'lines', w.as('plenk'), { text: 'let me in' });
      expect(res.status).toBe(200);
      expect(body(res)).toEqual({ ok: false, refused: { reason: 'banned', until: NOW + 3_600_000 } });
    });

    it('400 for a body that is not an object, has no text, or has text that is not a string', async () => {
      const w = await routeWorld();
      const bad: Array<[string, string]> = [
        ['an array', '[]'],
        ['a string', '"hello"'],
        ['null', 'null'],
        ['a number', '5'],
        ['no text', '{}'],
        ['text a number', '{"text":5}'],
        ['text null', '{"text":null}'],
        ['text an object', '{"text":{}}'],
        ['text an array', '{"text":["a"]}'],
        ['an empty body', ''],
      ];
      for (const [what, raw] of bad) {
        const res = await w.post(ROOM, 'lines', w.as('plenk'), undefined, { raw });
        expect(res.status, what).toBe(400);
        expect(body(res).error, what).toBe('invalid_request');
        expectSafeHeaders(res);
      }
      const notJson = await w.post(ROOM, 'lines', w.as('plenk'), undefined, { raw: '{"text": ' });
      expect(notJson.status).toBe(400);
      expect(body(notJson).error).toBe('invalid_json');
    });

    it('401, 403', async () => {
      const w = await routeWorld();
      const none = await w.post(ROOM, 'lines', {}, { text: 'hi' });
      expect(none.status).toBe(401);
      const addressOnly = await w.post(ROOM, 'lines', { 'x-ip': '203.0.113.5' }, { text: 'hi' });
      expect(addressOnly.status).toBe(401);
      const forbidden = await w.post(ROOM, 'lines', w.as('plenk', { 'x-join': 'null' }), { text: 'hi' });
      expect(forbidden.status).toBe(403);
    });

    it('413 for a body over 64 KiB', async () => {
      const w = await routeWorld();
      const res = await w.post(ROOM, 'lines', w.as('plenk'), undefined, { raw: JSON.stringify({ text: 'x'.repeat(70_000) }) });
      expect(res.status).toBe(413);
      expect(body(res).error).toBe('payload_too_large');
      expectSafeHeaders(res);
    });

    it('429 with retry-after in whole seconds', async () => {
      const w = await routeWorld({ routes: { actionRateLimit: { max: 2, windowMs: 10_000 } } });
      expect((await w.post(ROOM, 'lines', w.as('plenk'), { text: 'one' })).status).toBe(200);
      expect((await w.post(ROOM, 'lines', w.as('plenk'), { text: 'two' })).status).toBe(200);
      w.advance(2500);
      const res = await w.post(ROOM, 'lines', w.as('plenk'), { text: 'three' });
      expect(res.status).toBe(429);
      expect(res.headers?.['retry-after']).toBe('8'); // 7.5 s, rounded up
      expect(body(res).error).toBe('rate_limited');
      expectSafeHeaders(res);
      w.advance(7500);
      expect((await w.post(ROOM, 'lines', w.as('plenk'), { text: 'four' })).status).toBe(200);
    });

    it('a line over 2 000 characters is answered length without asking the kit or seating anyone', async () => {
      let accepts = 0;
      const w = await routeWorld({
        wrap: (cw) => {
          const f = Object.create(cw) as Chatwarden;
          f.chat = {
            ...cw.chat,
            accept: (...args) => {
              accepts += 1;
              return cw.chat.accept(...args);
            },
          };
          return f;
        },
      });
      for (const length of [2001, 10_000, 30_000]) {
        const res = await w.post(ROOM, 'lines', w.as('plenk'), { text: 'x'.repeat(length) });
        expect(res.status).toBe(200);
        expect(body(res)).toEqual({ ok: false, refused: { reason: 'length' } });
      }
      expect(accepts).toBe(0);
      expect(w.seatCalls).toHaveLength(0);
      // exactly 2 000 goes to the kit, which says length too (the limit is 200)
      const edge = await w.post(ROOM, 'lines', w.as('plenk'), { text: 'x'.repeat(2000) });
      expect(body(edge)).toEqual({ ok: false, refused: { reason: 'length' } });
      expect(accepts).toBe(1);
    });
  });

  describe('POST /rooms/:room/mute', () => {
    it('200 { ok } for a line id and for a token', async () => {
      const w = await routeWorld();
      const lineId = await firstLine(w, 'plenk');
      const heard = w.listen(await w.stream(ROOM, w.as('wumbo')));
      const muted = await w.post(ROOM, 'mute', w.as('wumbo'), { lineId, on: true });
      expect(muted.status).toBe(200);
      expect(body(muted)).toEqual({ ok: true, hiddenIds: [lineId] });
      expectSafeHeaders(muted);
      const state = /event: state\ndata: (.*)\n/.exec(heard.text());
      const ref = (JSON.parse(state?.[1] ?? '{}') as { muted: Array<{ ref: string }> }).muted[0]?.ref as string;
      const unmuted = await w.post(ROOM, 'mute', w.as('wumbo'), { ref, on: false });
      expect(body(unmuted)).toEqual({ ok: true, hiddenIds: [] });
      expect(body(await w.post(ROOM, 'mute', w.as('wumbo'), { ref, on: false }))).toEqual({ ok: false, hiddenIds: [] });
      expect(body(await w.post(ROOM, 'mute', w.as('wumbo'), { lineId: 'nope', on: true }))).toEqual({ ok: false, hiddenIds: [] });
    });

    it('400 for a body that is wrong in shape', async () => {
      const w = await routeWorld();
      const bad: unknown[] = [
        {},
        { on: true },
        { lineId: 'a1' },
        { lineId: 'a1', on: 'yes' },
        { lineId: 'a1', on: 1 },
        { lineId: 5, on: true },
        { ref: 5, on: true },
        { lineId: 'a1', ref: 'b2', on: true },
        { lineId: '', on: true },
        { lineId: 'x'.repeat(65), on: true },
        { lineId: '../etc', on: true },
        { lineId: 'a b', on: true },
        { ref: 'a;b', on: false },
        [],
        'x',
      ];
      for (const b of bad) {
        const res = await w.post(ROOM, 'mute', w.as('wumbo'), b);
        expect(res.status, JSON.stringify(b)).toBe(400);
      }
    });

    it('401, 403, 429', async () => {
      const w = await routeWorld({ routes: { actionRateLimit: { max: 1, windowMs: 10_000 } } });
      expect((await w.post(ROOM, 'mute', {}, { lineId: 'a1', on: true })).status).toBe(401);
      expect((await w.post(ROOM, 'mute', w.as('wumbo', { 'x-join': 'null' }), { lineId: 'a1', on: true })).status).toBe(403);
      expect((await w.post(ROOM, 'mute', w.as('glarn'), { lineId: 'a1', on: true })).status).toBe(200);
      const res = await w.post(ROOM, 'mute', w.as('glarn'), { lineId: 'a1', on: true });
      expect(res.status).toBe(429);
      expect(res.headers?.['retry-after']).toBe('10');
    });
  });

  describe('POST /rooms/:room/report', () => {
    it('200 { ok, remaining } and nothing else', async () => {
      const w = await routeWorld();
      const lineId = await firstLine(w, 'plenk');
      const res = await w.post(ROOM, 'report', w.as('wumbo'), { lineId, reason: 'harassment', note: 'rude' });
      expect(res.status).toBe(200);
      expect(body(res)).toEqual({ ok: true, remaining: 9 });
      expectSafeHeaders(res);
      const again = await w.post(ROOM, 'report', w.as('wumbo'), { lineId });
      expect(body(again)).toEqual({ ok: false, refused: 'duplicate' });
      const missing = await w.post(ROOM, 'report', w.as('wumbo'), { lineId: 'nope' });
      expect(body(missing)).toEqual({ ok: false, refused: 'not_found' });
      const bad = await w.post(ROOM, 'report', w.as('glarn'), { lineId, reason: 'not-a-reason' });
      expect(body(bad)).toEqual({ ok: false, refused: 'reason_unknown' });
    });

    it('400 for a body wrong in shape or size', async () => {
      const w = await routeWorld();
      const bad: unknown[] = [
        {},
        { reason: 'harassment' },
        { lineId: 5 },
        { lineId: '' },
        { lineId: 'a'.repeat(65) },
        { lineId: 'a1', reason: 5 },
        { lineId: 'a1', reason: 'r'.repeat(65) },
        { lineId: 'a1', note: 5 },
        { lineId: 'a1', note: 'n'.repeat(501) },
        { lineId: 'a1', note: {} },
        [],
        'x',
      ];
      for (const b of bad) {
        const res = await w.post(ROOM, 'report', w.as('wumbo'), b);
        expect(res.status, JSON.stringify(b)).toBe(400);
      }
      // the largest allowed reason and note are accepted by the route
      const ok = await w.post(ROOM, 'report', w.as('wumbo'), { lineId: 'a1', reason: 'r'.repeat(64), note: 'n'.repeat(500) });
      expect(ok.status).toBe(200);
      const nulls = await w.post(ROOM, 'report', w.as('wumbo'), { lineId: 'a1', reason: null, note: null });
      expect(nulls.status).toBe(200);
    });

    it('401, 403, 429', async () => {
      const w = await routeWorld({ routes: { actionRateLimit: { max: 1, windowMs: 10_000 } } });
      expect((await w.post(ROOM, 'report', {}, { lineId: 'a1' })).status).toBe(401);
      expect((await w.post(ROOM, 'report', w.as('wumbo', { 'x-join': 'null' }), { lineId: 'a1' })).status).toBe(403);
      expect((await w.post(ROOM, 'report', w.as('glarn'), { lineId: 'a1' })).status).toBe(200);
      expect((await w.post(ROOM, 'report', w.as('glarn'), { lineId: 'a1' })).status).toBe(429);
    });

    it('a kit that rejects is { ok: false, refused: off } with a 200', async () => {
      const w = await routeWorld({
        wrap: (cw) => {
          const f = Object.create(cw) as Chatwarden;
          f.reports = { ...cw.reports, submit: () => Promise.reject(new Error('down')) };
          return f;
        },
      });
      const lineId = await firstLine(w, 'plenk');
      const res = await w.post(ROOM, 'report', w.as('wumbo'), { lineId });
      expect(res.status).toBe(200);
      expect(body(res)).toEqual({ ok: false, refused: 'off' });
    });
  });
});

describe('identity and access', () => {
  it('identify that throws, rejects or returns a non-object is 401 and logs the error class only', async () => {
    for (const mode of ['throw', 'reject', 'null', 'string']) {
      const w = await routeWorld();
      const headers = { ...w.as('plenk'), 'x-identify': mode };
      for (const res of [await w.stream(ROOM, headers), await w.post(ROOM, 'lines', headers, { text: 'hi' }), await w.post(ROOM, 'mute', headers, { lineId: 'a1', on: true }), await w.post(ROOM, 'report', headers, { lineId: 'a1' })]) {
        expect(res.status, mode).toBe(401);
      }
      const logged = w.logs.filter((l) => l[0].startsWith('chatwarden.http_'));
      if (mode === 'throw' || mode === 'reject') {
        expect(logged).toHaveLength(4);
        for (const [event, detail] of logged) {
          expect(event).toBe('chatwarden.http_identify_failed');
          expect(detail).toEqual({ error: mode === 'throw' ? 'Error' : 'TypeError' });
        }
      }
      expect(JSON.stringify(w.logs)).not.toContain('raw-client-key');
      expect(w.chat.stats().members).toBe(0);
    }
  });

  it('join returning null is 403; join that throws is 500 internal', async () => {
    const w = await routeWorld();
    expect((await w.post(ROOM, 'lines', w.as('plenk', { 'x-join': 'null' }), { text: 'hi' })).status).toBe(403);
    const boom = await w.post(ROOM, 'lines', w.as('plenk', { 'x-join': 'throw' }), { text: 'hi' });
    expect(boom.status).toBe(500);
    expect(body(boom)).toEqual({ error: 'internal' });
    expectSafeHeaders(boom);
    expect(w.logs.filter((l) => l[0] === 'chatwarden.http_error')).toEqual([['chatwarden.http_error', { error: 'TypeError' }]]);
    expect(JSON.stringify(w.logs)).not.toContain('join exploded');
  });

  it('join returning something that is not a member is 403', async () => {
    for (const result of [undefined, 5, 'plenk', false]) {
      const w = await routeWorld({ routes: { join: () => result as never } });
      expect((await w.post(ROOM, 'lines', w.as('plenk'), { text: 'hi' })).status).toBe(403);
    }
  });

  it('a caller with only an address is 401 and is not counted against any limit', async () => {
    const w = await routeWorld({ routes: { actionRateLimit: { max: 1, windowMs: 10_000 } } });
    for (let i = 0; i < 5; i += 1) expect((await w.post(ROOM, 'lines', { 'x-ip': '203.0.113.5' }, { text: 'hi' })).status).toBe(401);
  });

  it('join is given the room, the identity and the request', async () => {
    const seen: Array<[string, unknown, string | undefined]> = [];
    const w = await routeWorld({
      routes: {
        join: (req, room, who) => {
          seen.push([room, who, req.headers['x-name']]);
          return { name: 'plenk' };
        },
      },
    });
    await w.post('room-7', 'lines', w.as('wumbo'), { text: 'hi' });
    expect(seen).toEqual([['room-7', { clientKey: 'raw-client-key-wumbo-0001', ip: '203.0.113.7' }, 'wumbo']]);
  });

  it('the same identity passed to identify twice is the same player (one seat)', async () => {
    const w = await routeWorld();
    await w.post(ROOM, 'lines', w.as('plenk'), { text: 'one' });
    w.advance(SEC);
    await w.post(ROOM, 'lines', w.as('plenk', { 'x-ip': '198.51.100.1' }), { text: 'two' });
    expect(w.chat.stats().members).toBe(1);
  });

  it('a full room is 429 with retry-after on a POST too', async () => {
    const w = await routeWorld({ options: { maxMembers: 1 } });
    expect((await w.post(ROOM, 'lines', w.as('plenk'), { text: 'hi' })).status).toBe(200);
    const res = await w.post(ROOM, 'lines', w.as('wumbo'), { text: 'hi' });
    expect(res.status).toBe(429);
    expect(res.headers?.['retry-after']).toBe('5');
  });
});

describe('content type', () => {
  it('text/plain, application/x-www-form-urlencoded, multipart/form-data, none and application/jsonp are 400 and send nothing', async () => {
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null, 'application/jsonp', 'application/json5', 'application/jso', 'text/json', 'application/json,text/plain', '']) {
      for (const route of ['lines', 'mute', 'report'] as const) {
        const w = await routeWorld();
        const b = route === 'lines' ? { text: 'hello' } : route === 'mute' ? { lineId: 'a1', on: true } : { lineId: 'a1' };
        const res = await w.post(ROOM, route, w.as('plenk'), undefined, { raw: JSON.stringify(b), type });
        expect(res.status, `${route} ${String(type)}`).toBe(400);
        expect(body(res).error).toBe('invalid_request');
        // nothing happened: no seat, no line
        expect(w.seatCalls).toHaveLength(0);
        expect(w.chat.stats().members).toBe(0);
      }
    }
  });

  it('a form post does not make a player speak', async () => {
    const w = await routeWorld();
    const listener = w.listen(await w.stream(ROOM, w.as('wumbo')));
    const res = await w.post(ROOM, 'lines', w.as('plenk'), undefined, { raw: 'text=hello+there', type: 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(400);
    const plain = await w.post(ROOM, 'lines', w.as('plenk'), undefined, { raw: '{"text":"hello there"}', type: 'text/plain' });
    expect(plain.status).toBe(400);
    expect(listener.text()).not.toContain('hello there');
  });

  it('application/json with a charset, in any case or spacing, is accepted', async () => {
    for (const type of ['application/json; charset=utf-8', 'application/json;charset=UTF-8', 'Application/JSON', ' application/json ', 'application/json']) {
      const w = await routeWorld();
      const res = await w.post(ROOM, 'lines', w.as('plenk'), undefined, { raw: '{"text":"hello"}', type });
      expect(res.status, type).toBe(200);
      expect(body(res).ok).toBe(true);
    }
  });

  it('the content type is not asked of the stream', async () => {
    const w = await routeWorld();
    expect((await w.stream(ROOM, w.as('plenk'))).status).toBe(200);
  });
});

describe('allowedOrigins', () => {
  it('listed passes, unlisted 403, absent passes, and a listed origin with a different port or scheme is 403', async () => {
    const w = await routeWorld({ routes: { allowedOrigins: ['https://game.example.test', 'http://localhost:5173'] } });
    const ask = async (origin: string | undefined) => {
      const headers = w.as('plenk', origin === undefined ? {} : { origin });
      return (await w.post(ROOM, 'lines', headers, { text: 'hello' })).status;
    };
    expect(await ask('https://game.example.test')).toBe(200);
    expect(await ask('http://localhost:5173')).toBe(200);
    expect(await ask(undefined)).toBe(200);
    for (const origin of ['https://evil.example.test', 'http://game.example.test', 'https://game.example.test:8443', 'https://game.example.test/', 'null', '', 'HTTPS://GAME.EXAMPLE.TEST', 'http://localhost:5174', 'http://localhost']) {
      expect(await ask(origin), origin).toBe(403);
    }
  });

  it('the stream, mute and report check it too', async () => {
    const w = await routeWorld({ routes: { allowedOrigins: ['https://game.example.test'] } });
    const bad = w.as('plenk', { origin: 'https://evil.example.test' });
    expect((await w.stream(ROOM, bad)).status).toBe(403);
    expect((await w.post(ROOM, 'mute', bad, { lineId: 'a1', on: true })).status).toBe(403);
    expect((await w.post(ROOM, 'report', bad, { lineId: 'a1' })).status).toBe(403);
    expect(w.chat.stats().members).toBe(0);
  });

  it('with no list, any origin passes (the JSON content type is the guard)', async () => {
    const w = await routeWorld();
    expect((await w.post(ROOM, 'lines', w.as('plenk', { origin: 'https://anywhere.example.test' }), { text: 'hello' })).status).toBe(200);
  });

  it('the list is validated when the routes are built', async () => {
    for (const list of ['https://x.test', [''], [5], [null]]) {
      await expect(routeWorld({ routes: { allowedOrigins: list as never } })).rejects.toBeInstanceOf(TypeError);
    }
    await expect(routeWorld({ routes: { allowedOrigins: [] } })).resolves.toBeDefined();
  });
});

describe('what a body can and cannot name', () => {
  it('a body that names reporter, seat, targetSeat or __proto__ keys is rejected (forbidden_key) or ignored; the kit is never called with them', async () => {
    const submitted: ReportInput[] = [];
    const w = await routeWorld({
      wrap: (cw) => {
        const f = Object.create(cw) as Chatwarden;
        f.reports = {
          ...cw.reports,
          submit: (input) => {
            submitted.push(structuredClone(input));
            return cw.reports.submit(input);
          },
        };
        return f;
      },
    });
    const lineId = await firstLine(w, 'plenk');
    // ignored: extra keys the API has no use for
    const res = await w.post(ROOM, 'report', w.as('wumbo'), { lineId, reporter: 'plenk', reporterSeat: 'x', seat: 'y', targetSeat: 'z', subject: 's_1', roomId: 'elsewhere' });
    expect(res.status).toBe(200);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.reporterSeat).toBe(w.seatOf(ROOM, 'wumbo'));
    expect(submitted[0]?.targetSeat).toBe(w.seatOf(ROOM, 'plenk'));
    expect(submitted[0]?.roomId).toBe(ROOM);
    expect(Object.keys(submitted[0] ?? {}).sort()).toEqual(['lineId', 'reporterSeat', 'roomId', 'targetSeat']);
    // rejected: prototype keys at any depth
    for (const raw of ['{"lineId":"a1","__proto__":{"x":1}}', '{"lineId":"a1","a":{"constructor":{}}}', '{"text":"hi","prototype":1}']) {
      for (const route of ['lines', 'mute', 'report'] as const) {
        const r = await w.post(ROOM, route, w.as('wumbo'), undefined, { raw });
        expect(r.status, raw).toBe(400);
        expect(body(r).error).toBe('forbidden_key');
      }
    }
    expect(submitted).toHaveLength(1);
  });
});

describe('construction', () => {
  it('is validated: identify and join are required functions, the limits are positive whole numbers', async () => {
    const w = await routeWorld({ noBroadcaster: false });
    const { chatRoutes } = await import('../src/chat/routes.js');
    const ok = { identify: () => ({}), join: () => ({ name: 'x' }) };
    expect(() => chatRoutes(w.cw, w.chat, { ...ok, identify: undefined as never })).toThrow(TypeError);
    expect(() => chatRoutes(w.cw, w.chat, { ...ok, join: undefined as never })).toThrow(TypeError);
    expect(() => chatRoutes(w.cw, w.chat, undefined as never)).toThrow(TypeError);
    expect(() => chatRoutes(w.cw, {} as never, ok)).toThrow(TypeError);
    expect(() => chatRoutes(undefined as never, w.chat, ok)).toThrow(TypeError);
    for (const key of ['actionRateLimit', 'openRateLimit'] as const) {
      for (const bad of [{ max: 0, windowMs: 1000 }, { max: 1, windowMs: 0 }, { max: 1.5, windowMs: 1000 }, { max: '3', windowMs: 1000 }, null, 5, {}]) {
        let message = '';
        try {
          chatRoutes(w.cw, w.chat, { ...ok, [key]: bad });
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
          message = (err as Error).message;
        }
        expect(message).toBe(`chatRoutes: ${key} needs a positive whole max and windowMs`);
      }
    }
    expect(() => chatRoutes(w.cw, w.chat, { ...ok, logger: {} as never })).toThrow(TypeError);
    expect(() => chatRoutes(w.cw, w.chat, { ...ok, now: 5 as never })).toThrow(TypeError);
  });

  it('has exactly the four routes', async () => {
    const w = await routeWorld();
    expect(Object.keys(w.routes).sort()).toEqual(['GET /rooms/:room/stream', 'POST /rooms/:room/lines', 'POST /rooms/:room/mute', 'POST /rooms/:room/report']);
  });

  it('an unknown path, a wrong method and a bad room id are the router\'s 404 and 405', async () => {
    const w = await routeWorld();
    expect((await w.call('GET', '/rooms/lobby/lines', { headers: w.as('plenk') })).status).toBe(405);
    expect((await w.call('POST', '/rooms/lobby/stream', { headers: w.as('plenk') })).status).toBe(405);
    expect((await w.call('GET', '/rooms/lobby/other', { headers: w.as('plenk') })).status).toBe(404);
    expect((await w.call('GET', '/rooms/lo%20bby/stream', { headers: w.as('plenk') })).status).toBe(404);
    expect((await w.call('GET', `/rooms/${'r'.repeat(65)}/stream`, { headers: w.as('plenk') })).status).toBe(404);
  });
});

describe('the limits', () => {
  it('the action limit covers lines, mutes and reports together; the open limit covers stream opens only', async () => {
    const w = await routeWorld({ routes: { actionRateLimit: { max: 3, windowMs: 10_000 }, openRateLimit: { max: 2, windowMs: 10_000 } } });
    const lineId = await firstLine(w, 'glarn');
    w.advance(10_000);
    const h = w.as('plenk');
    expect((await w.post(ROOM, 'lines', h, { text: 'one' })).status).toBe(200);
    expect((await w.post(ROOM, 'mute', h, { lineId, on: true })).status).toBe(200);
    expect((await w.post(ROOM, 'report', h, { lineId })).status).toBe(200);
    // the budget is spent whichever route comes next
    for (const route of ['lines', 'mute', 'report'] as const) {
      const b = route === 'lines' ? { text: 'x' } : route === 'mute' ? { lineId, on: false } : { lineId };
      expect((await w.post(ROOM, route, h, b)).status, route).toBe(429);
    }
    // opening streams is a different budget: two opens pass, the third does not
    expect((await w.stream(ROOM, h)).status).toBe(200);
    expect((await w.stream(ROOM, h)).status).toBe(200);
    expect((await w.stream(ROOM, h)).status).toBe(429);
    // and spent stream opens do not stop an action of another player, or of this one after the window
    expect((await w.post(ROOM, 'lines', w.as('wumbo'), { text: 'fine' })).status).toBe(200);
    w.advance(10_000);
    expect((await w.post(ROOM, 'lines', h, { text: 'later' })).status).toBe(200);
  });

  it('limiter keys follow the seat rules: an account is one budget across devices, and never a credential in a log', async () => {
    const w = await routeWorld({ routes: { actionRateLimit: { max: 1, windowMs: 10_000 } } });
    const account = { 'x-account': 'acct-limit-1', 'x-name': 'plenk' };
    expect((await w.post(ROOM, 'lines', { ...account, 'x-key': 'device-one-aaaaaaaa' }, { text: 'one' })).status).toBe(200);
    expect((await w.post(ROOM, 'lines', { ...account, 'x-key': 'device-two-bbbbbbbb' }, { text: 'two' })).status).toBe(429);
    // another account, even on a shared device key, has its own budget
    expect((await w.post(ROOM, 'lines', { 'x-account': 'acct-limit-2', 'x-key': 'device-one-aaaaaaaa', 'x-name': 'wumbo' }, { text: 'three' })).status).toBe(200);
    expect(JSON.stringify(w.logs)).not.toMatch(/acct-limit|device-/);
  });

  it('a player at the limit of one room is at the limit in another (the budget is per player)', async () => {
    const w = await routeWorld({ routes: { actionRateLimit: { max: 1, windowMs: 10_000 } } });
    expect((await w.post('room-a', 'lines', w.as('plenk'), { text: 'one' })).status).toBe(200);
    expect((await w.post('room-b', 'lines', w.as('plenk'), { text: 'two' })).status).toBe(429);
  });

  it('defaults: 30 actions per 10 s and 10 opens per minute', async () => {
    const w = await routeWorld();
    const h = w.as('plenk');
    let ok = 0;
    for (let i = 0; i < 40; i += 1) if ((await w.post(ROOM, 'mute', h, { lineId: 'a1', on: true })).status === 200) ok += 1;
    expect(ok).toBe(30);
    w.advance(10_000);
    expect((await w.post(ROOM, 'mute', h, { lineId: 'a1', on: true })).status).toBe(200);
    let opened = 0;
    const g = w.as('glarn', { 'x-name': 'glarn' });
    const w2 = await routeWorld({ options: { maxStreamsPerMember: 100 } });
    for (let i = 0; i < 15; i += 1) if ((await w2.stream(ROOM, g)).status === 200) opened += 1;
    expect(opened).toBe(10);
  });
});
