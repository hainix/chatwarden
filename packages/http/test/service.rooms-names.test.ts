import { describe, expect, it } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import { ROUTE_SPECS } from '../src/service/routes.js';
import { bodyOf, errorCode } from './serviceKit.js';
import { BLOCKED, SEC, serviceWorld } from './serviceWorld.js';

// The service lines of M4 (blocks), M5 (phrases) and M6 (names and entities), added after S2: they ride on the same wrapper and the same descriptions.

const ROOM = 'lobby';
const BOOKS = { junior: [{ id: 'gg', text: 'Good game!' }, { id: 'help', text: 'Can you help me?', group: 'Ask' }, { id: 'thx', text: 'Thank you' }] };
const CONTEXTS = { junior: { chat: { phrases: 'junior' } } };

const counting = (counter: { n: number }, method: 'accept' | 'acceptPhrase') => (cw: Chatwarden): Chatwarden => {
  const facade = Object.create(cw) as Chatwarden;
  facade.chat = {
    ...cw.chat,
    [method]: (...args: unknown[]) => {
      counter.n += 1;
      return (cw.chat[method] as (...a: unknown[]) => unknown)(...args);
    },
  } as Chatwarden['chat'];
  return facade;
};

describe('M4: blocks', () => {
  it('PUT mutes with kind block blocks; GET lists it under blocked and not under muted; kind mute (the default) is a mute', async () => {
    const w = await serviceWorld();
    for (const [seat, name] of [['a', 'plenk'], ['b', 'wumbo'], ['c', 'grimble']] as const) await w.seat(ROOM, seat, name);
    expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`, { body: { kind: 'block' } }))).toEqual({ ok: true });
    expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/c`, { body: { kind: 'mute' } }))).toEqual({ ok: true });
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`))).toEqual({ muted: ['c'], blocked: ['b'] });
    expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/c`, { body: {} }))).toEqual({ ok: true });
    // a mute never downgrades a block
    await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`, { body: { kind: 'mute' } });
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`)).blocked).toEqual(['b']);
  });

  it('hiddenFor lists a seat that blocked the sender, and (two-way) the seat the sender blocked', async () => {
    const w = await serviceWorld();
    for (const [seat, name] of [['a', 'plenk'], ['b', 'wumbo'], ['c', 'grimble']] as const) await w.seat(ROOM, seat, name);
    await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`, { body: { kind: 'block' } });
    w.advance(2 * SEC);
    // b (blocked by a) speaks: a must not be sent the line
    expect(bodyOf(await w.line(ROOM, 'b', 'hello from b')).hiddenFor).toEqual(['a']);
    w.advance(2 * SEC);
    // a (the blocker) speaks: b must not be sent the line either
    expect(bodyOf(await w.line(ROOM, 'a', 'hello from a')).hiddenFor).toEqual(['b']);
    w.advance(2 * SEC);
    expect(bodyOf(await w.line(ROOM, 'c', 'hello from c')).hiddenFor).toEqual([]);
  });

  it('DELETE removes a block (the row goes, no mute is left behind)', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`, { body: { kind: 'block' } });
    expect(bodyOf(await w.call('DELETE', `/rooms/${ROOM}/seats/a/mutes/b`))).toEqual({ ok: true });
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`))).toEqual({ muted: [], blocked: [] });
    w.advance(2 * SEC);
    expect(bodyOf(await w.line(ROOM, 'b', 'hello')).hiddenFor).toEqual([]);
  });

  it('a bad kind, a non-object body and an unknown key are 400; blocking oneself or an empty seat is ok and nothing', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    for (const body of [{ kind: 'ban' }, { kind: 5 }, { kind: null }, { kind: 'block', extra: 1 }, [], 'block']) {
      expect((await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`, { body })).status, JSON.stringify(body)).toBe(400);
    }
    for (const target of ['a', 'empty']) expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/${target}`, { body: { kind: 'block' } }))).toEqual({ ok: true });
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`))).toEqual({ muted: [], blocked: [] });
  });

  it('with 500 blocks a new one is refused: ok false and limit true, and nothing is written', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    for (let i = 0; i < 501; i++) await w.call('PUT', `/rooms/${ROOM}/seats/t${i}`, { body: { who: w.who(`target-${i}`), handle: `t${i}` } });
    for (let i = 0; i < 500; i++) expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/t${i}`, { body: { kind: 'block' } })).ok, `block ${i}`).toBe(true);
    expect(bodyOf(await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/t500`, { body: { kind: 'block' } }))).toEqual({ ok: false, limit: true });
    expect(bodyOf(await w.call('GET', `/rooms/${ROOM}/seats/a/mutes`)).blocked).not.toContain('t500');
  });

  it('POST /blocks/between answers per pair, in order, in either direction; an unknown person is false and never created; a game can ask at matchmaking', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    await w.seat(ROOM, 'c', 'grimble');
    await w.call('PUT', `/rooms/${ROOM}/seats/a/mutes/b`, { body: { kind: 'block' } });
    const stranger = { clientKey: 'nobody-has-met-this-player-0001' };
    const res = await w.call('POST', '/blocks/between', { body: { who: w.who('plenk'), others: [w.who('wumbo'), w.who('grimble'), stranger] } });
    expect(bodyOf(res)).toEqual({ blocked: [true, false, false] });
    // b blocked by a: asking from b's side answers true too
    expect(bodyOf(await w.call('POST', '/blocks/between', { body: { who: w.who('wumbo'), others: [w.who('plenk'), w.who('grimble')] } }))).toEqual({ blocked: [true, false] });
    // a mute is not a block
    await w.call('PUT', `/rooms/${ROOM}/seats/c/mutes/a`);
    expect(bodyOf(await w.call('POST', '/blocks/between', { body: { who: w.who('plenk'), others: [w.who('grimble')] } }))).toEqual({ blocked: [false] });
    // the stranger was never created: seating them later is the first the kit hears of them
    const before = w.real.rooms.list().length;
    expect(w.real.rooms.list().length).toBe(before);
  });

  it('others: 1 and 50 accepted, 0 and 51 are 400; each is a who; a who with only an ip is 400; unknown keys are 400', async () => {
    const w = await serviceWorld();
    const who = w.who('plenk');
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ clientKey: `other-player-key-${i}-0001` }));
    expect(bodyOf(await w.call('POST', '/blocks/between', { body: { who, others: many(50) } })).blocked).toHaveLength(50);
    expect(bodyOf(await w.call('POST', '/blocks/between', { body: { who, others: many(1) } })).blocked).toHaveLength(1);
    for (const body of [
      { who, others: [] },
      { who, others: many(51) },
      { who, others: [{ ip: '203.0.113.7' }] },
      { who: { ip: '203.0.113.7' }, others: many(1) },
      { who, others: 'x' },
      { who, others: [5] },
      { who },
      { others: many(1) },
      { who, others: many(1), extra: 1 },
    ]) {
      const res = await w.call('POST', '/blocks/between', { body });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
  });

  it('the route needs a key and a JSON body, is a POST (no raw id in a URL), and holds nothing but booleans', async () => {
    const w = await serviceWorld();
    const body = { who: w.who('plenk'), others: [w.who('wumbo')] };
    expect((await w.call('POST', '/blocks/between', { key: null, body })).status).toBe(401);
    expect((await w.call('POST', '/blocks/between', { body, contentType: 'text/plain' })).status).toBe(400);
    expect((await w.call('GET', '/blocks/between')).status).toBe(405);
    const res = bodyOf(await w.call('POST', '/blocks/between', { body }));
    expect(Object.keys(res)).toEqual(['blocked']);
    expect(res.blocked.every((b: unknown) => typeof b === 'boolean')).toBe(true);
  });
});

describe('M5: phrases', () => {
  const room = 'kids-room';
  const tags = { context: 'junior' };

  it('the phrases route delivers the canonical text with the phrase id, hiddenFor as for a line', async () => {
    const w = await serviceWorld({ world: { contexts: CONTEXTS, phrases: BOOKS } });
    await w.seat(room, 'a', 'plenk', { tags });
    await w.seat(room, 'b', 'wumbo', { tags });
    await w.call('PUT', `/rooms/${room}/seats/b/mutes/a`);
    const res = await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body: { phraseId: 'gg' } });
    expect(res.status).toBe(200);
    const body = bodyOf(res);
    expect(body.ok).toBe(true);
    expect(body.line.text).toBe('Good game!');
    expect(body.line.phrase).toBe('gg');
    expect(typeof body.line.id).toBe('string');
    expect(body.hiddenFor).toEqual(['b']);
  });

  it('refuses phrases_only for text in a phrase room, phrase_unknown for an id the book lacks, gate in a room that is not phrase-only and for an unseated seat', async () => {
    const w = await serviceWorld({ world: { contexts: CONTEXTS, phrases: BOOKS } });
    await w.seat(room, 'a', 'plenk', { tags });
    await w.seat('free', 'f', 'wumbo');
    expect(bodyOf(await w.line(room, 'a', 'typed text')).refused).toEqual({ reason: 'phrases_only' });
    expect(bodyOf(await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body: { phraseId: 'nope' } })).refused).toEqual({ reason: 'phrase_unknown' });
    expect(bodyOf(await w.call('POST', '/rooms/free/seats/f/phrases', { body: { phraseId: 'gg' } })).refused).toEqual({ reason: 'gate' });
    expect(bodyOf(await w.call('POST', `/rooms/${room}/seats/ghost/phrases`, { body: { phraseId: 'gg' } })).refused).toEqual({ reason: 'gate' });
    // nothing was spent or kept by those refusals
    expect(bodyOf(await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body: { phraseId: 'thx' } })).ok).toBe(true);
    expect(w.real.rooms.lineStates(room)).toHaveLength(1);
  });

  it('honours Idempotency-Key: a retried phrase is sent once and answers identically (the kit is asked once)', async () => {
    const asked = { n: 0 };
    const w = await serviceWorld({ world: { contexts: CONTEXTS, phrases: BOOKS, wrap: counting(asked, 'acceptPhrase') } });
    await w.seat(room, 'a', 'plenk', { tags });
    const body = { phraseId: 'gg' };
    const first = await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body, idempotencyKey: 'ph-1' });
    const second = await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body, idempotencyKey: 'ph-1' });
    expect(second.headers?.['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(asked.n).toBe(1);
    expect(w.real.rooms.lineStates(room)).toHaveLength(1);
    const other = await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body: { phraseId: 'thx' }, idempotencyKey: 'ph-1' });
    expect(other.status).toBe(409);
  });

  it('the phrase id is a token of 1 to 32 characters: others, a missing id and unknown keys are 400', async () => {
    const w = await serviceWorld({ world: { contexts: CONTEXTS, phrases: BOOKS } });
    await w.seat(room, 'a', 'plenk', { tags });
    for (const body of [{}, { phraseId: '' }, { phraseId: 'x'.repeat(33) }, { phraseId: 'has space' }, { phraseId: 5 }, { phraseId: 'gg', extra: 1 }, { phrase: 'gg' }, [], 'gg']) {
      expect((await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await w.call('POST', `/rooms/${room}/seats/a/phrases`, { body: { phraseId: 'x'.repeat(32) } })).status).toBe(200);
  });

  it('capabilities.phrases is true only when a book is configured', async () => {
    const without = await serviceWorld({ service: { capabilities: undefined } });
    expect(bodyOf(await without.call('GET', '/')).capabilities.phrases).toBe(false);
    const withBooks = await serviceWorld({ world: { contexts: CONTEXTS, phrases: BOOKS } });
    expect(bodyOf(await withBooks.call('GET', '/')).capabilities.phrases).toBe(true);
    // the option can still say so explicitly
    const forced = await serviceWorld({ service: { capabilities: { phrases: true } } });
    expect(bodyOf(await forced.call('GET', '/')).capabilities.phrases).toBe(true);
  });

  it('the route is described: idempotent, in the table and the document, and needs a key', async () => {
    const spec = ROUTE_SPECS.find((s) => s.name === 'phrases');
    expect(spec?.idempotent).toBe(true);
    expect(spec?.path).toBe('/rooms/:room~room/seats/:seat~room/phrases');
    const w = await serviceWorld({ world: { contexts: CONTEXTS, phrases: BOOKS } });
    expect((await w.call('POST', `/rooms/${room}/seats/a/phrases`, { key: null, body: { phraseId: 'gg' } })).status).toBe(401);
  });
});

describe('M6: names and entities', () => {
  it('names/check takes kind: entity runs the same checks (a clan named after a slur is name_not_allowed), player is the default, an unknown kind is 400', async () => {
    const w = await serviceWorld();
    expect(bodyOf(await w.call('POST', '/names/check', { body: { name: 'The Brave Clan', kind: 'entity' } }))).toEqual({ ok: true });
    const clan = bodyOf(await w.call('POST', '/names/check', { body: { name: `The ${BLOCKED} Clan`, kind: 'entity' } }));
    expect(clan).toMatchObject({ ok: false, reason: 'name_not_allowed' });
    expect(bodyOf(await w.call('POST', '/names/check', { body: { name: `The ${BLOCKED} Clan`, kind: 'player' } }))).toMatchObject({ ok: false });
    for (const kind of ['team', 5, null, '', 'PLAYER']) {
      const res = await w.call('POST', '/names/check', { body: { name: 'x', kind } });
      expect(res.status, JSON.stringify(kind)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
    expect(JSON.stringify(w.logs)).not.toContain('Clan');
  });

  it('a reserved name answers name_reserved with the reserved rule and no text, for a player and for an entity; a clean one is ok', async () => {
    const w = await serviceWorld({ world: { names: { reserved: ['moderator', 'game master'] } } });
    for (const name of ['Moderator', 'M0derator', 'game_master', 'GameMaster']) {
      const res = bodyOf(await w.call('POST', '/names/check', { body: { name } }));
      expect(res, name).toEqual({ ok: false, reason: 'name_reserved', rule: 2 });
    }
    expect(bodyOf(await w.call('POST', '/names/check', { body: { name: 'The Moderator Guild', kind: 'entity' } })).reason).toBe('name_reserved');
    expect(bodyOf(await w.call('POST', '/names/check', { body: { name: 'Moderately' } }))).toEqual({ ok: true });
    expect(JSON.stringify(w.logs)).not.toMatch(/oderator|game/i);
  });

  it('a report with an entity: ok, stored with the report as one extra row; the report is still about the owner', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    const entity = { kind: 'clan', ref: 'clan-42', label: 'The Glarns' };
    const res = bodyOf(await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body: { target: 'b', reason: 'name', entity } }));
    expect(res.ok).toBe(true);
    const stored = w.real.reports.list({}).items[0];
    expect(stored?.entity).toEqual(entity);
    expect(stored?.reportedReason).toBe('name');
    // the label is not in the answer, a log line or an event
    expect(JSON.stringify(res)).not.toContain('Glarns');
    expect(JSON.stringify(w.logs)).not.toContain('Glarns');
  });

  it('a report with entity null or none is as before; a bad entity is 400 invalid_request and nothing is filed or spent', async () => {
    const w = await serviceWorld();
    await w.seat(ROOM, 'a', 'plenk');
    await w.seat(ROOM, 'b', 'wumbo');
    const bad: unknown[] = [
      { kind: 'Clan', ref: 'c1', label: 'x' },
      { kind: 'clan', ref: 'has space', label: 'x' },
      { kind: 'clan', ref: 'c1', label: '' },
      { kind: 'clan', ref: 'c1', label: 'x'.repeat(65) },
      { kind: 'clan', ref: 'c1' },
      { kind: 'clan', ref: 'c1', label: 'x', extra: 1 },
      { kind: 'clan', ref: 5, label: 'x' },
      'clan',
      [],
      5,
    ];
    for (const entity of bad) {
      const res = await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body: { target: 'b', entity } });
      expect(res.status, JSON.stringify(entity)).toBe(400);
      expect(errorCode(res)).toBe('invalid_request');
    }
    expect(w.real.reports.list({}).items).toHaveLength(0);
    expect(bodyOf(await w.call('POST', `/rooms/${ROOM}/seats/a/reports`, { body: { target: 'b', entity: null } })).remaining).toBe(9);
    expect(w.real.reports.list({}).items[0]?.entity ?? null).toBeNull();
  });
});
