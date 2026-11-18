import { describe, expect, expectTypeOf, it } from 'vitest';
import type { KitResponse } from '../src/types.js';
import type { ChatFrame, MuteResult, SendResult, WireLine } from '../src/chat/wire.js';
import { chatWorld, routeWorld, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

// M5: phrase-only rooms over the chat box. `hello.phrases` carries the room's book (null for a free-text room), `POST /rooms/:room/phrases { phrase }` sends one,
// `WireLine.phrase` rides on lines and history, and text in a phrase room is refused `phrases_only`.

const BOOKS = {
  junior: [
    { id: 'gg', text: 'Good game!' },
    { id: 'help', text: 'Can you help me?', group: 'Ask' },
    { id: 'thx', text: 'Thank you' },
  ],
};
const CONTEXTS = { junior: { chat: { phrases: 'junior' } } };
const KIDS = 'kids';
const FREE = 'lobby';
const body = (res: KitResponse): Record<string, unknown> => res.body as Record<string, unknown>;
const tagsFor = (room: string): Record<string, string> | undefined => (room === KIDS ? { context: 'junior' } : undefined);
/** The game's join hook for the tests: `x-name` names the player, the kids room is tagged, and `x-join: null` is a player the game turns away. */
const joinHook = (req: { headers: Record<string, string | undefined> }, room: string) => (req.headers['x-join'] === 'null' ? null : { name: req.headers['x-name'] ?? 'plenk', ...(tagsFor(room) === undefined ? {} : { tags: tagsFor(room)! }) });

async function world() {
  return chatWorld({ contexts: CONTEXTS, phrases: BOOKS });
}

function attendTagged(w: ChatWorld, room: string, name: string) {
  const session = w.join(room, name, {}, tagsFor(room) === undefined ? {} : { tags: tagsFor(room) });
  const heard = spoken();
  const stream = session.open(heard.sink);
  if ('refused' in stream) throw new Error('open refused');
  return { session, heard, stream };
}

const helloOf = (heard: ReturnType<typeof spoken>) => heard.of('hello')[0]!;
const sentLine = (r: SendResult): WireLine => {
  if (!r.ok) throw new Error('refused: ' + JSON.stringify(r.refused));
  return r.line;
};

describe('the wire types', () => {
  it('a line may carry phrase, and hello carries phrases: the room\'s book or null', () => {
    expectTypeOf<WireLine['phrase']>().toEqualTypeOf<string | undefined>();
    type Hello = Extract<ChatFrame, { type: 'hello' }>;
    expectTypeOf<Hello['phrases']>().toEqualTypeOf<{ book: Array<{ id: string; text: string; group?: string }> } | null>();
  });
});

describe('hello', () => {
  it('carries the book for a phrase room and null for every other room', async () => {
    const w = await world();
    const kid = attendTagged(w, KIDS, 'plenk');
    const free = attendTagged(w, FREE, 'wumbo');
    expect(helloOf(kid.heard).phrases).toEqual({ book: BOOKS.junior });
    expect(helloOf(free.heard).phrases).toBeNull();
    expect(Object.hasOwn(helloOf(free.heard), 'phrases')).toBe(true);
  });

  it('a kit with no books says null everywhere', async () => {
    const w = await chatWorld();
    const a = attendTagged(w, KIDS, 'plenk');
    expect(helloOf(a.heard).phrases).toBeNull();
  });

  it('the book is a copy: nothing in it can change what the kit holds, and it holds only id, text and group', async () => {
    const w = await world();
    const kid = attendTagged(w, KIDS, 'plenk');
    const book = helloOf(kid.heard).phrases!.book;
    for (const p of book) expect(Object.keys(p).every((k) => ['id', 'text', 'group'].includes(k))).toBe(true);
    book[0]!.text = 'changed';
    const again = attendTagged(w, KIDS, 'wumbo');
    expect(helloOf(again.heard).phrases!.book[0]!.text).toBe('Good game!');
  });
});

describe('sending a phrase', () => {
  it('delivers the canonical text with phrase to the author and to the room, as one line frame', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    const b = attendTagged(w, KIDS, 'wumbo');
    w.advance(2 * SEC);
    const sent = a.session.sendPhrase({ phrase: 'help' });
    expect(sent).toMatchObject({ ok: true, line: { text: 'Can you help me?', phrase: 'help', mine: true, name: 'plenk' } });
    const heardByB = b.heard.of('line')[0]!.line;
    expect(heardByB).toMatchObject({ text: 'Can you help me?', phrase: 'help', name: 'plenk' });
    expect(heardByB.mine).toBeUndefined();
    expect(a.heard.of('line')[0]!.line).toMatchObject({ phrase: 'help', mine: true });
  });

  it('a free-text line has no phrase key on the wire', async () => {
    const w = await world();
    const a = attendTagged(w, FREE, 'plenk');
    const b = attendTagged(w, FREE, 'wumbo');
    w.advance(2 * SEC);
    const sent = sentLine(a.session.send({ text: 'hello' }));
    expect(Object.hasOwn(sent, 'phrase')).toBe(false);
    expect(Object.hasOwn(b.heard.of('line')[0]!.line, 'phrase')).toBe(false);
  });

  it('a late joiner\'s history keeps the phrase ids and the text', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    w.advance(2 * SEC);
    a.session.sendPhrase({ phrase: 'gg' });
    w.advance(2 * SEC);
    a.session.sendPhrase({ phrase: 'thx' });
    const late = attendTagged(w, KIDS, 'late');
    expect(helloOf(late.heard).lines.map((l) => [l.text, l.phrase])).toEqual([['Good game!', 'gg'], ['Thank you', 'thx']]);
  });

  it('text in a phrase room is refused phrases_only and nothing is written to the room; a phrase in a free room is refused gate', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    const b = attendTagged(w, KIDS, 'wumbo');
    const f = attendTagged(w, FREE, 'free');
    w.advance(2 * SEC);
    expect(a.session.send({ text: 'hello' })).toEqual({ ok: false, refused: { reason: 'phrases_only' } });
    expect(b.heard.of('line')).toHaveLength(0);
    expect(f.session.sendPhrase({ phrase: 'gg' })).toEqual({ ok: false, refused: { reason: 'gate' } });
    expect(a.session.sendPhrase({ phrase: 'nope' })).toEqual({ ok: false, refused: { reason: 'phrase_unknown' } });
    expect(b.heard.of('line')).toHaveLength(0);
  });

  it('a bad value is phrase_unknown and never throws', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    for (const bad of [undefined, null, 7, {}, [], '']) {
      expect(a.session.sendPhrase({ phrase: bad as never }), String(bad)).toEqual({ ok: false, refused: { reason: 'phrase_unknown' } });
    }
    expect(a.session.sendPhrase(undefined as never)).toEqual({ ok: false, refused: { reason: 'phrase_unknown' } });
  });

  it('the kit\'s fixed rate applies: the fourth phrase inside five seconds is rate', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    for (const id of ['gg', 'help', 'thx']) expect(a.session.sendPhrase({ phrase: id }).ok, id).toBe(true);
    expect(a.session.sendPhrase({ phrase: 'gg' })).toMatchObject({ ok: false, refused: { reason: 'rate' } });
  });

  it('a muted author\'s phrase is not shown to the muter, and a phrase line can be muted by its id', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    const b = attendTagged(w, KIDS, 'wumbo');
    w.advance(2 * SEC);
    const line = sentLine(a.session.sendPhrase({ phrase: 'gg' }));
    const result: MuteResult = b.session.muteResult({ lineId: line.id, on: true });
    expect(result).toEqual({ ok: true, hiddenIds: [line.id] });
    w.advance(6 * SEC);
    const before = b.heard.of('line').length;
    a.session.sendPhrase({ phrase: 'thx' });
    expect(b.heard.of('line')).toHaveLength(before);
  });

  it('a phrase line is reportable: the report names the line and its excerpt shows the canonical text', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    const b = attendTagged(w, KIDS, 'wumbo');
    w.advance(2 * SEC);
    const line = sentLine(a.session.sendPhrase({ phrase: 'help' }));
    const out = await b.session.report({ lineId: line.id });
    expect(out.ok).toBe(true);
    const row = w.real.reports.list({ status: 'open' }).items[0]!;
    expect(row.excerpt.map((l) => l.raw)).toEqual(['Can you help me?']);
  });

  it('a retracted phrase line leaves the history', async () => {
    const w = await world();
    const a = attendTagged(w, KIDS, 'plenk');
    w.advance(2 * SEC);
    const line = sentLine(a.session.sendPhrase({ phrase: 'gg' }));
    expect(w.real.rooms.retract(KIDS, line.id)).toEqual({ ok: true, lineIds: [line.id] });
    const late = attendTagged(w, KIDS, 'late');
    expect(helloOf(late.heard).lines).toHaveLength(0);
  });

  it('a banned player is told so, as for a line (the route answers; the session is refused)', async () => {
    const w = await world();
    attendTagged(w, KIDS, 'plenk');
    await w.sanction('ban', KIDS, 'plenk');
    const s = w.chat.session(KIDS, w.who('plenk'), { name: 'plenk', tags: tagsFor(KIDS)! });
    expect('refused' in s && s.refused.reason).toBe('banned');
  });
});

describe('POST /rooms/:room/phrases', () => {
  async function routes() {
    return routeWorld({
      contexts: CONTEXTS,
      phrases: BOOKS,
      routes: { join: joinHook },
    });
  }
  const safe = (res: KitResponse) => {
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(res.headers?.['x-content-type-options']).toBe('nosniff');
  };

  it('200 with the delivered line, and the room hears it', async () => {
    const w = await routes();
    const open = await w.stream(KIDS, w.as('wumbo'));
    const listening = w.listen(open);
    w.advance(2 * SEC);
    const res = await w.post(KIDS, 'phrases', w.as('plenk'), { phrase: 'gg' });
    expect(res.status).toBe(200);
    safe(res);
    expect(body(res)).toMatchObject({ ok: true, line: { text: 'Good game!', phrase: 'gg', mine: true } });
    expect(listening.text()).toContain('event: line');
    expect(listening.text()).toContain('"phrase":"gg"');
    listening.cancel();
  });

  it('a refusal is an answer, not an error: phrase_unknown, gate for a free room, and phrases_only for text on /lines', async () => {
    const w = await routes();
    w.advance(2 * SEC);
    expect(body(await w.post(KIDS, 'phrases', w.as('plenk'), { phrase: 'nope' }))).toEqual({ ok: false, refused: { reason: 'phrase_unknown' } });
    expect(body(await w.post(FREE, 'phrases', w.as('plenk'), { phrase: 'gg' }))).toEqual({ ok: false, refused: { reason: 'gate' } });
    expect(body(await w.post(KIDS, 'lines', w.as('plenk'), { text: 'hello' }))).toEqual({ ok: false, refused: { reason: 'phrases_only' } });
  });

  it('400 for a missing, non-string, over-long or ill-formed phrase id and for extra types, 401 for nobody, 400 for another content type', async () => {
    const w = await routes();
    for (const bad of [{}, { phrase: 7 }, { phrase: null }, { phrase: '' }, { phrase: 'a b' }, { phrase: 'x'.repeat(65) }, { phrase: ['gg'] }, { text: 'gg' }]) {
      const res = await w.post(KIDS, 'phrases', w.as('plenk'), bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      safe(res);
    }
    expect((await w.post(KIDS, 'phrases', {}, { phrase: 'gg' })).status).toBe(401);
    expect((await w.post(KIDS, 'phrases', w.as('plenk'), undefined, { raw: '{"phrase":"gg"}', type: 'text/plain' })).status).toBe(400);
    expect((await w.post(KIDS, 'phrases', w.as('plenk'), undefined, { raw: 'not json' })).status).toBe(400);
  });

  it('403 when the game\'s join hook says no, and the action rate limit is shared with lines', async () => {
    const w = await routes();
    expect((await w.post(KIDS, 'phrases', w.as('plenk', { 'x-join': 'null' }), { phrase: 'gg' })).status).toBe(403);
    const limited = await routeWorld({
      contexts: CONTEXTS,
      phrases: BOOKS,
      routes: { actionRateLimit: { max: 2, windowMs: 10_000 }, join: joinHook },
    });
    expect((await limited.post(KIDS, 'phrases', limited.as('plenk'), { phrase: 'gg' })).status).toBe(200);
    expect((await limited.post(KIDS, 'lines', limited.as('plenk'), { text: 'hi' })).status).toBe(200);
    const third = await limited.post(KIDS, 'phrases', limited.as('plenk'), { phrase: 'thx' });
    expect(third.status).toBe(429);
    expect(third.headers?.['retry-after']).toBeDefined();
  });

  it('a bad Origin is 403 when allowedOrigins is set, as for the other posts', async () => {
    const w = await routeWorld({ contexts: CONTEXTS, phrases: BOOKS, routes: { allowedOrigins: ['https://game.example'], join: joinHook } });
    expect((await w.post(KIDS, 'phrases', w.as('plenk', { origin: 'https://evil.example' }), { phrase: 'gg' })).status).toBe(403);
    expect((await w.post(KIDS, 'phrases', w.as('plenk', { origin: 'https://game.example' }), { phrase: 'gg' })).status).toBe(200);
  });

  it('a refusal carries no text, phrase, seat or subject', async () => {
    const w = await routes();
    const res = await w.post(KIDS, 'phrases', w.as('plenk'), { phrase: 'secretphrase' });
    const text = JSON.stringify(res.body);
    for (const leak of ['secretphrase', 'seat', 'subject', 'Good game']) expect(text).not.toContain(leak);
  });

  it('an unknown route name is still 404 and a GET on the new route is 405 (the table has exactly one new route)', async () => {
    const w = await routes();
    expect((await w.call('POST', `/rooms/${KIDS}/phrase`, { headers: w.as('plenk'), body: { phrase: 'gg' } })).status).toBe(404);
    expect((await w.call('GET', `/rooms/${KIDS}/phrases`, { headers: w.as('plenk') })).status).toBe(405);
  });
});
