import { describe, expect, it } from 'vitest';
import type { ChatResult } from '../src/chat.js';
import { contextsWorld, DAY, delivered, reasonOf, SEC } from './contextsWorld.js';
import type { ContextsWorld } from './contextsWorld.js';

// M5: `cw.chat.acceptPhrase` runs the accept pipeline without the text steps; `accept(text)` in a phrase room is refused `phrases_only`.
// Synthetic words only (zorbak is blocked by the test matcher, snerp is starred by the test profanity filter).

const BOOKS = {
  junior: [
    { id: 'gg', text: 'Good game!' },
    { id: 'help', text: 'Can you help me?', group: 'Ask' },
    { id: 'long', text: 'This phrase is longer than the twenty character limit set here' },
    { id: 'thx', text: 'Thank you' },
    { id: 'wow', text: 'Wow, nice one' },
  ],
};
const CONTEXTS = { junior: { chat: { phrases: 'junior' } } };

/** The test matcher and filter, wrapped so the tests can count their calls after start-up (which looks every phrase up once). */
function spies() {
  const calls = { match: 0, profanity: 0 };
  return {
    calls,
    matcher: {
      match: (t: string) => {
        calls.match += 1;
        return /\bzorbak\b/i.test(t) ? { termId: 'syn:zorbak' } : null;
      },
      spans: () => [],
    },
    profanity: {
      apply: (t: string) => {
        calls.profanity += 1;
        return { hit: /\bsnerp\b/i.test(t), text: t.replace(/\bsnerp\b/gi, '*****') };
      },
    },
  };
}

async function kit(over: Parameters<typeof contextsWorld>[1] = {}, contexts: Parameters<typeof contextsWorld>[0] = CONTEXTS, overrides: Parameters<typeof contextsWorld>[2] = {}): Promise<ContextsWorld> {
  return contextsWorld(contexts, { phrases: BOOKS, ...over }, overrides);
}

const phraseOf = (r: ChatResult): string | undefined => ('deliver' in r ? r.deliver.phrase : undefined);
/** Evidence as a report sees it: file a report in `room` from a bystander seat and read the excerpt's `raw` and `delivered`. */
async function evidence(w: ContextsWorld, room: string, bystander: string, target: string): Promise<Array<{ raw: string; delivered: string | null; blocked: boolean }>> {
  const res = await w.cw.reports.submit({ roomId: room, reporterSeat: bystander, targetSeat: target });
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  const row = w.cw.reports.list({ status: 'open' }).items.find((r) => r.id === res.reportId);
  return (row?.excerpt ?? []).map((l) => ({ raw: l.raw, delivered: l.delivered, blocked: l.blocked }));
}

describe('acceptPhrase: delivery', () => {
  it('delivers the canonical text with phrase set, buffers it as evidence with raw equal to the text, and skips the matcher, profanity and length steps', async () => {
    const s = spies();
    const w = await kit({ matcher: s.matcher, profanity: s.profanity, limits: { chatMaxLength: 20 } });
    const kid = w.player('J', { tags: { context: 'junior' } });
    const other = w.player('J');
    s.calls.match = 0;
    s.calls.profanity = 0;
    const r = w.cw.chat.acceptPhrase('J', kid, 'long');
    expect(r).toMatchObject({ deliver: { text: BOOKS.junior[2]!.text, phrase: 'long' } });
    expect(delivered(r) && r.deliver.lineId).toBeTruthy();
    expect(s.calls).toEqual({ match: 0, profanity: 0 });
    // a free-text line of the same length is too long for the same kit
    const free = w.player('F');
    expect(reasonOf(w.cw.chat.accept('F', free, BOOKS.junior[2]!.text))).toBe('length');
    expect(await evidence(w, 'J', other, kid)).toEqual([{ raw: BOOKS.junior[2]!.text, delivered: BOOKS.junior[2]!.text, blocked: false }]);
  });

  it('the deliver of a free-text line has no phrase key at all', async () => {
    const w = await kit();
    const free = w.player('F');
    const r = w.cw.chat.accept('F', free, 'hello');
    expect(delivered(r)).toBe(true);
    expect('phrase' in (r as { deliver: object }).deliver).toBe(false);
  });

  it('every phrase in the book can be sent, each delivering its own text and id', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    for (const p of BOOKS.junior) {
      const r = w.cw.chat.acceptPhrase('J', kid, p.id);
      expect(r, p.id).toMatchObject({ deliver: { text: p.text, phrase: p.id } });
      w.clock.t += 6 * SEC;
    }
  });

  it('a phrase line counts in the daily line counter like a line, and a refusal counts as refused', async () => {
    const w = await kit({}, CONTEXTS, { desk: { insights: true } });
    const kid = w.player('J', { tags: { context: 'junior' } });
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe(true);
    expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, 'nope'))).toBe('phrase_unknown');
    w.clock.t += 6 * SEC;
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'thx'))).toBe(true);
  });

  it('a phrase line is not matched even when the matcher would hit the line afterwards (the book is trusted text)', async () => {
    // The book passes the start-up check; the matcher is then given a new term (as a live term list does), and the canonical text is still delivered.
    let blocked = false;
    const matcher = { match: (t: string) => (blocked && /good game/i.test(t) ? { termId: 'syn:late' } : /\bzorbak\b/i.test(t) ? { termId: 'syn:zorbak' } : null), spans: () => [] };
    const w = await kit({ matcher });
    const kid = w.player('J', { tags: { context: 'junior' } });
    blocked = true;
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe(true);
    expect(w.store.loadStrikes(0)).toHaveLength(0);
  });

  it('link and phrase filters of the profile do not act on a phrase line (no text steps)', async () => {
    const w = await contextsWorld({ junior: { chat: { phrases: 'junior' } } }, { phrases: { junior: [{ id: 'site', text: 'Visit example.org today' }] } }, { filters: { links: { action: 'refuse' } } });
    const kid = w.player('J', { tags: { context: 'junior' } });
    const free = w.player('F');
    expect(reasonOf(w.cw.chat.accept('F', free, 'Visit http://example.org/x today'))).toBe('link');
    expect(w.cw.chat.acceptPhrase('J', kid, 'site')).toMatchObject({ deliver: { text: 'Visit example.org today', phrase: 'site' } });
  });
});

describe('acceptPhrase: the same pipeline as accept', () => {
  it('an unseated seat, a gate hook that says no, and a gate that throws are refused gate, as accept does', async () => {
    const w = await kit({ gate: (room) => room !== 'CLOSED' });
    w.player('CLOSED', { seat: 'x', tags: { context: 'junior' } });
    expect(reasonOf(w.cw.chat.acceptPhrase('J', 'nobody', 'gg'))).toBe('gate');
    expect(reasonOf(w.cw.chat.acceptPhrase('CLOSED', 'x', 'gg'))).toBe('gate');
    const throwing = await kit({ gate: () => { throw new Error('down'); } });
    const t = throwing.player('J', { tags: { context: 'junior' } });
    expect(reasonOf(throwing.cw.chat.acceptPhrase('J', t, 'gg'))).toBe('gate');
  });

  it('a restricted player is refused restricted, as for accept (a ban or timeout earned in another room applies)', async () => {
    const w = await kit();
    const free = w.player('F', { seat: 'f1', account: 'acct-shared-aaaa' });
    const kid = w.player('J', { seat: 'k1', account: 'acct-shared-aaaa', tags: { context: 'junior' } });
    let last = '';
    for (let i = 0; i < 12 && last !== 'restricted'; i += 1) {
      last = reasonOf(w.cw.chat.accept('F', free, 'you zorbak')) ?? 'delivered';
      w.clock.t += 6 * SEC;
    }
    expect(last).toBe('restricted');
    expect(reasonOf(w.cw.chat.accept('F', free, 'hello'))).toBe('restricted');
    expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe('restricted');
  });

  it('minAccountAgeDays: a young, unknown or guest account is account_too_new; an old one and staff are delivered; nothing is kept or spent', async () => {
    const contexts = { junior: { chat: { phrases: 'junior', minAccountAgeDays: 7 } } };
    const w = await kit({}, contexts);
    const old = w.player('J', { ageDays: 30, tags: { context: 'junior' } });
    const young = w.player('J', { ageDays: 1 });
    const unknown = w.player('J');
    const guest = w.player('J', { account: null });
    expect(delivered(w.cw.chat.acceptPhrase('J', old, 'gg'))).toBe(true);
    for (const [name, seat] of [['young', young], ['unknown', unknown], ['guest', guest]] as const) {
      for (let i = 0; i < 5; i += 1) expect(reasonOf(w.cw.chat.acceptPhrase('J', seat, 'gg')), name).toBe('account_too_new');
    }
    expect(delivered(w.cw.chat.acceptPhrase('J', young, 'gg', { staff: true }))).toBe(true);
    // five refusals each spent no rate budget: the staff line above went through on a seat that had been refused five times already
  });

  it('pacing applies: slow mode refuses with retryAfterMs and spends nothing, and the same phrase twice is a duplicate where duplicates are off-limits', async () => {
    const contexts = { junior: { chat: { phrases: 'junior' }, pace: { slowModeMs: 3000, duplicateWindowMs: 20_000 } } };
    const w = await kit({}, contexts);
    const kid = w.player('J', { tags: { context: 'junior' } });
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe(true);
    w.clock.t += SEC;
    const slow = w.cw.chat.acceptPhrase('J', kid, 'thx');
    expect(slow).toMatchObject({ refuse: { reason: 'slow_mode' } });
    expect((slow as { refuse: { retryAfterMs?: number } }).refuse.retryAfterMs).toBeGreaterThan(0);
    w.clock.t += 3 * SEC;
    expect(w.cw.chat.acceptPhrase('J', kid, 'gg')).toMatchObject({ refuse: { reason: 'duplicate' } });
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'thx'))).toBe(true);
  });

  it('the fixed rate applies: the fourth phrase inside five seconds is rate, and it is spent per room and seat', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    const other = w.player('J');
    for (const id of ['gg', 'help', 'thx']) expect(delivered(w.cw.chat.acceptPhrase('J', kid, id)), id).toBe(true);
    expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, 'wow'))).toBe('rate');
    expect(delivered(w.cw.chat.acceptPhrase('J', other, 'wow'))).toBe(true);
    w.clock.t += 5 * SEC;
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'wow'))).toBe(true);
  });

  it('a locked room refuses a phrase from a player and lets staff through, as for accept', async () => {
    const w = await kit({}, CONTEXTS, { rooms: {} });
    const kid = w.player('J', { tags: { context: 'junior' } });
    w.cw.rooms.setMode('J', 'locked', { forMs: 30 * 60_000 });
    expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe('locked');
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'gg', { staff: true }))).toBe(true);
  });

  it('a refusal writes and spends exactly what the same refusal does for accept', async () => {
    // For each refusal, the phrase room and a text room end in the same place: nothing kept, no strike, and the rate budget as it was.
    const contexts = { junior: { chat: { phrases: 'junior', minAccountAgeDays: 7 } }, text: { chat: { minAccountAgeDays: 7 } } };
    const w = await kit({}, contexts);
    const kid = w.player('J', { ageDays: 1, tags: { context: 'junior' } });
    const txt = w.player('T', { ageDays: 1, tags: { context: 'text' } });
    const watcherJ = w.player('J', { ageDays: 30 });
    const watcherT = w.player('T', { ageDays: 30 });
    for (let i = 0; i < 6; i += 1) {
      expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe('account_too_new');
      expect(reasonOf(w.cw.chat.accept('T', txt, 'hello'))).toBe('account_too_new');
    }
    expect(w.store.loadStrikes(0)).toHaveLength(0);
    // now old enough: both rooms deliver three, and the fourth is rate, so neither room spent anything before
    w.ages.set([...w.ages.keys()][0]!, 30);
    w.ages.set([...w.ages.keys()][1]!, 30);
    w.clock.t += DAY;
    for (const id of ['gg', 'help', 'thx']) expect(delivered(w.cw.chat.acceptPhrase('J', kid, id))).toBe(true);
    for (const t of ['a', 'b', 'c']) expect(delivered(w.cw.chat.accept('T', txt, t))).toBe(true);
    expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, 'wow'))).toBe('rate');
    expect(reasonOf(w.cw.chat.accept('T', txt, 'd'))).toBe('rate');
    expect([watcherJ, watcherT]).toHaveLength(2);
  });
});

describe('phrase rooms and free rooms', () => {
  it('accept(text) in a phrase room is refused phrases_only with no strike, no buffer and no rate spent', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    const other = w.player('J');
    for (let i = 0; i < 6; i += 1) expect(reasonOf(w.cw.chat.accept('J', kid, i === 0 ? 'you zorbak' : `free text ${i}`))).toBe('phrases_only');
    expect(w.store.loadStrikes(0)).toHaveLength(0);
    // no rate was spent: three phrases still go through at once, and nothing was buffered
    for (const id of ['gg', 'help', 'thx']) expect(delivered(w.cw.chat.acceptPhrase('J', kid, id)), id).toBe(true);
    expect((await evidence(w, 'J', other, kid)).map((l) => l.raw)).toEqual(['Good game!', 'Can you help me?', 'Thank you']);
  });

  it('staff typing text in a phrase room is refused too (a phrase room is phrase-only for everyone)', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    expect(reasonOf(w.cw.chat.accept('J', kid, 'hello', { staff: true }))).toBe('phrases_only');
  });

  it('an empty line is still empty, not phrases_only (stay silent)', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    expect(reasonOf(w.cw.chat.accept('J', kid, '   '))).toBe('empty');
  });

  it('acceptPhrase in a free room is refused gate, in a room with no tag and in a context without a book', async () => {
    const w = await kit({}, { junior: { chat: { phrases: 'junior' } }, free: {} });
    const base = w.player('B');
    const free = w.player('F', { tags: { context: 'free' } });
    expect(reasonOf(w.cw.chat.acceptPhrase('B', base, 'gg'))).toBe('gate');
    expect(reasonOf(w.cw.chat.acceptPhrase('F', free, 'gg'))).toBe('gate');
    expect(delivered(w.cw.chat.accept('B', base, 'hello'))).toBe(true);
  });

  it('an unknown id is phrase_unknown with nothing spent; a wrong type or an inherited name is too', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    for (const bad of ['nope', '', 'GG', 'gg ', '__proto__', 'constructor', 'toString']) expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, bad)), bad).toBe('phrase_unknown');
    for (const bad of [7, null, undefined, {}, ['gg']]) expect(reasonOf(w.cw.chat.acceptPhrase('J', kid, bad as never))).toBe('phrase_unknown');
    for (const id of ['gg', 'help', 'thx']) expect(delivered(w.cw.chat.acceptPhrase('J', kid, id)), id).toBe(true);
  });

  it('a room with an undeclared context is refused gate for a phrase, as for text', async () => {
    const w = await kit();
    const kid = w.player('Z', { tags: { context: 'typo' } });
    expect(reasonOf(w.cw.chat.acceptPhrase('Z', kid, 'gg'))).toBe('gate');
  });

  it('two phrase rooms with different books each send their own, and an id of the other book is unknown', async () => {
    const books = { a: [{ id: 'one', text: 'Hello from A' }], b: [{ id: 'two', text: 'Hello from B' }] };
    const w = await contextsWorld({ ca: { chat: { phrases: 'a' } }, cb: { chat: { phrases: 'b' } } }, { phrases: books });
    const x = w.player('RA', { tags: { context: 'ca' } });
    const y = w.player('RB', { tags: { context: 'cb' } });
    expect(w.cw.chat.acceptPhrase('RA', x, 'one')).toMatchObject({ deliver: { text: 'Hello from A' } });
    expect(reasonOf(w.cw.chat.acceptPhrase('RA', x, 'two'))).toBe('phrase_unknown');
    expect(w.cw.chat.acceptPhrase('RB', y, 'two')).toMatchObject({ deliver: { text: 'Hello from B' } });
  });

  it('a kit with no books answers gate to acceptPhrase and does not change what accept does', async () => {
    const w = await contextsWorld({});
    const a = w.player('R');
    expect(reasonOf(w.cw.chat.acceptPhrase('R', a, 'gg'))).toBe('gate');
    expect(delivered(w.cw.chat.accept('R', a, 'hello'))).toBe(true);
  });
});

describe('a phrase line in use', () => {
  it('a phrase line is reportable and its excerpt shows the canonical text', async () => {
    const w = await kit();
    const kid = w.player('J', { seat: 'k', tags: { context: 'junior' } });
    const other = w.player('J', { seat: 'o' });
    const r = w.cw.chat.acceptPhrase('J', kid, 'help');
    expect(delivered(r)).toBe(true);
    const res = await w.cw.reports.submit({ roomId: 'J', reporterSeat: other, targetSeat: kid, lineId: delivered(r) ? r.deliver.lineId : '' });
    expect(res.ok).toBe(true);
    const row = w.cw.reports.list({ status: 'open' }).items[0]!;
    expect(row.excerpt.map((l) => l.raw)).toEqual(['Can you help me?']);
    expect(row.lineId).toBe(delivered(r) ? r.deliver.lineId : '');
  });

  it('a phrase line is muteable and blockable like any line: visibleTo follows the mute', async () => {
    const w = await kit();
    const kid = w.player('J', { seat: 'k', tags: { context: 'junior' } });
    const other = w.player('J', { seat: 'o' });
    expect(delivered(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe(true);
    expect(w.cw.chat.visibleTo('J', other, kid)).toBe(true);
    expect(w.cw.mutes.set('J', other, kid, true)).toBe('ok');
    expect(w.cw.chat.visibleTo('J', other, kid)).toBe(false);
  });

  it('a line retracted by a moderator is taken back the same way (the id works with retract)', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    const r = w.cw.chat.acceptPhrase('J', kid, 'gg');
    expect(w.cw.rooms.lineStates('J').map((l) => l.lineId)).toEqual([delivered(r) ? r.deliver.lineId : '']);
  });

  it('the phrase id is the only extra on the result and nothing about the book leaks into a refusal', async () => {
    const w = await kit();
    const kid = w.player('J', { tags: { context: 'junior' } });
    const bad = w.cw.chat.acceptPhrase('J', kid, 'nope');
    expect(bad).toEqual({ refuse: { reason: 'phrase_unknown' } });
    const typed = w.cw.chat.accept('J', kid, 'hello');
    expect(typed).toEqual({ refuse: { reason: 'phrases_only' } });
    expect(phraseOf(w.cw.chat.acceptPhrase('J', kid, 'gg'))).toBe('gg');
  });
});
