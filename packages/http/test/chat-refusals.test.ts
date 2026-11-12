import { describe, expect, it } from 'vitest';
import type { ChatResult } from '@chatwarden/core';
import type { SendResult } from '../src/chat/wire.js';
import { BLOCKED, chatWorld, NOW, scripted, SEC, spoken } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

const ROOM = 'lobby';
const MARKER = 'trist-9921';
const ALLOWED = ['reason', 'until', 'byModerator', 'rule', 'noticeId', 'retryAfterMs'];

/** The refusal in an answer, asserting the answer's own shape. */
function refusedOf(res: SendResult) {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected a refusal');
  expect(Object.keys(res).sort()).toEqual(['ok', 'refused']);
  for (const key of Object.keys(res.refused)) expect(ALLOWED).toContain(key);
  return res.refused;
}

const say = (w: ChatWorld, s: { send(i: { text: string }): SendResult }, text: string): SendResult => {
  w.advance(2 * SEC);
  return s.send({ text });
};

describe('refusals, one per reason', () => {
  it('length (201 characters)', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    expect(refusedOf(say(w, a.session, 'x'.repeat(201)))).toEqual({ reason: 'length' });
    // exactly 200 is fine
    expect(say(w, a.session, 'x'.repeat(200)).ok).toBe(true);
  });

  it('rate (4 lines in 5 s)', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    for (const t of ['one', 'two', 'three']) expect(a.session.send({ text: t }).ok).toBe(true);
    expect(refusedOf(a.session.send({ text: 'four' }))).toEqual({ reason: 'rate' });
    w.advance(5 * SEC);
    expect(a.session.send({ text: 'five' }).ok).toBe(true);
  });

  it('blocked (a synthetic term), with the rule', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    expect(refusedOf(say(w, a.session, `you ${BLOCKED}`))).toEqual({ reason: 'blocked', rule: 1 });
  });

  it('profanity (a refusing profile)', async () => {
    const w = await chatWorld({ profanity: 'refuse' });
    const a = w.attend(ROOM, 'plenk');
    expect(refusedOf(say(w, a.session, 'oh glarn it'))).toEqual({ reason: 'profanity' });
    expect(say(w, a.session, 'oh fine then').ok).toBe(true);
  });

  it('gate (a closing gate)', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    w.gateState.open = false;
    expect(refusedOf(say(w, a.session, 'hello'))).toEqual({ reason: 'gate' });
    w.gateState.open = true;
    expect(say(w, a.session, 'hello').ok).toBe(true);
  });

  it('restricted (a stored chat sanction), with until and byModerator', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    await w.sanction('chat', ROOM, 'plenk', 3_600_000);
    const refused = refusedOf(say(w, a.session, 'hello'));
    expect(refused).toMatchObject({ reason: 'restricted', until: NOW + 3_600_000, byModerator: true, rule: 2 });
  });

  it('restricted carries the notice id when the sanction came from a decision', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    say(w, a.session, 'rude to wumbo');
    const reported = await w.cw.reports.submit({ roomId: ROOM, reporterSeat: w.seatOf(ROOM, 'wumbo'), targetSeat: w.seatOf(ROOM, 'plenk'), category: 'harassment' });
    if (!reported.ok) throw new Error('report refused');
    const report = w.cw.reports.get(reported.reportId);
    const lineIds = (report?.excerpt ?? []).filter((l) => l.seatId === w.seatOf(ROOM, 'plenk')).map((l) => l.lineId);
    const decided = await w.cw.decide({
      reportId: reported.reportId,
      verdict: 'upheld',
      actor: 'mod@example.test',
      reason: 'private moderator reason',
      actions: [{ subject: w.subjectOf(ROOM, 'plenk'), kind: 'chat', durationMs: 3_600_000, rule: 2, lineIds }],
    });
    expect(decided.ok).toBe(true);
    const refused = refusedOf(say(w, a.session, 'hello again'));
    expect(refused.reason).toBe('restricted');
    expect(refused.byModerator).toBe(true);
    expect(refused.rule).toBe(2);
    expect(typeof refused.noticeId).toBe('string');
    expect(JSON.stringify(refused)).not.toContain('private moderator reason');
    expect(JSON.stringify(refused)).not.toContain('mod@example.test');
    void b;
  });

  it('banned (a stored ban at the door)', async () => {
    const w = await chatWorld();
    w.join('elsewhere', 'plenk');
    await w.sanction('ban', 'elsewhere', 'plenk', 3_600_000);
    const s = w.chat.session(ROOM, w.who('plenk'), { name: 'plenk' });
    expect(s).toEqual({ refused: { reason: 'banned', until: NOW + 3_600_000 } });
  });

  it('a ban that lands while the player is connected: the next line is restricted (the kit treats a ban as a restriction)', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    await w.sanction('ban', ROOM, 'plenk', 3_600_000);
    const refused = refusedOf(say(w, a.session, 'hello'));
    expect(refused.reason).toBe('restricted');
    expect(refused.until).toBe(NOW + 3_600_000);
  });

  it('an empty line answers refused empty and writes nothing', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    for (const text of ['', '   ', '\n\t ']) expect(refusedOf(say(w, a.session, text))).toEqual({ reason: 'empty' });
    expect(a.heard.texts()).toEqual([]);
    expect(b.heard.texts()).toEqual([]);
    const late = spoken();
    b.session.open(late.sink);
    expect(late.of('hello')[0]?.lines).toEqual([]);
  });

  it('the author of a refused line is unseated from nothing: the seat stays', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const before = w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk'));
    expect(before).not.toBeNull();
    say(w, a.session, `you ${BLOCKED}`);
    say(w, a.session, 'x'.repeat(300));
    expect(w.cw.rooms.subjectAt(ROOM, w.seatOf(ROOM, 'plenk'))).toBe(before);
    expect(w.chat.stats()).toEqual({ rooms: 1, members: 1, streams: 1 });
    expect(say(w, a.session, 'a clean line after').ok).toBe(true);
  });
});

describe('a refused line never escapes (Review Focus 1)', () => {
  const scenarios: Array<[string, (w: ChatWorld, s: { send(i: { text: string }): SendResult }) => SendResult, Parameters<typeof chatWorld>[0]?]> = [
    ['blocked', (w, s) => say(w, s, `you ${BLOCKED} ${MARKER}`)],
    ['length', (w, s) => say(w, s, `${MARKER} ${'x'.repeat(220)}`)],
    [
      'rate',
      (w, s) => {
        for (const t of ['a', 'b', 'c']) s.send({ text: t });
        return s.send({ text: `fourth ${MARKER}` });
      },
    ],
    ['profanity', (w, s) => say(w, s, `oh glarn it ${MARKER}`), { profanity: 'refuse' }],
    [
      'gate',
      (w, s) => {
        w.gateState.open = false;
        return say(w, s, `closed gate ${MARKER}`);
      },
    ],
  ];

  for (const [name, act, over] of scenarios) {
    it(`${name}: the text is in no other stream, not in the ring, not in a later hello, not in any captured log, and not in the author's own answer`, async () => {
      const w = await chatWorld(over ?? {});
      const a = w.attend(ROOM, 'plenk');
      const b = w.attend(ROOM, 'wumbo');
      const res = act(w, a.session);
      expect(res.ok).toBe(false);
      const needles = [MARKER, BLOCKED];
      const hidden = (what: string, text: string) => {
        for (const n of needles) expect(text, `${name}: ${what}`).not.toContain(n);
      };
      hidden('the answer', JSON.stringify(res));
      hidden("the other player's stream", JSON.stringify(b.heard.frames));
      // the author's own stream: only whatever clean lines were sent before, never the refused one
      hidden("the author's stream", JSON.stringify(a.heard.frames.filter((f) => f.type === 'line')));
      const late = w.attend(ROOM, 'glarn');
      hidden('a later hello', JSON.stringify(late.heard.frames));
      hidden('the logs', JSON.stringify(w.logs));
    });
  }

  it('restricted: the text of the refused line is in nothing', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    await w.sanction('chat', ROOM, 'plenk', 3_600_000);
    const res = say(w, a.session, `restricted ${MARKER}`);
    expect(res.ok).toBe(false);
    expect(JSON.stringify([res, b.heard.frames, w.logs])).not.toContain(MARKER);
    const late = w.attend(ROOM, 'glarn');
    expect(JSON.stringify(late.heard.frames)).not.toContain(MARKER);
  });

  it('an empty line leaves no trace either', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    say(w, a.session, '  ');
    expect(w.logs).toEqual([]);
    expect(a.heard.frames).toHaveLength(1); // the hello only
  });
});

describe('scripted pacing refusals (a facade whose accept returns slow_mode, flood, duplicate)', () => {
  const pace = (reason: string, extra: Record<string, unknown>): ChatResult => ({ refuse: { reason, ...extra } }) as unknown as ChatResult;

  it('the answer carries the whole-number wait for each reason', async () => {
    for (const reason of ['slow_mode', 'flood', 'duplicate']) {
      const w = await chatWorld({ wrap: scripted(() => pace(reason, { retryAfterMs: 3000 })) });
      const a = w.attend(ROOM, 'plenk');
      const b = w.attend(ROOM, 'wumbo');
      expect(refusedOf(say(w, a.session, `text ${MARKER}`))).toEqual({ reason, retryAfterMs: 3000 });
      expect(b.heard.texts()).toEqual([]);
    }
  });

  it('1 and 3 600 000 are kept; 0, -1, 1.5, "3", NaN, Infinity and 3 600 001 are dropped', async () => {
    const waits: Array<[unknown, number | undefined]> = [
      [1, 1],
      [3_600_000, 3_600_000],
      [0, undefined],
      [-1, undefined],
      [1.5, undefined],
      ['3', undefined],
      [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined],
      [3_600_001, undefined],
      [null, undefined],
    ];
    for (const [given, kept] of waits) {
      const w = await chatWorld({ wrap: scripted(() => pace('slow_mode', { retryAfterMs: given })) });
      const a = w.attend(ROOM, 'plenk');
      const refused = refusedOf(say(w, a.session, 'hi'));
      expect(refused).toEqual(kept === undefined ? { reason: 'slow_mode' } : { reason: 'slow_mode', retryAfterMs: kept });
    }
  });

  it('nothing else leaks: text, seat, subject, handle and a moderator note are dropped', async () => {
    const w = await chatWorld({
      wrap: scripted(() => pace('flood', { retryAfterMs: 2000, text: `leak ${MARKER}`, seat: 'seat-1', subject: 's_abcdefabcdef', handle: 'wumbo', note: 'moderator note', actor: 'mod@example.test' })),
    });
    const a = w.attend(ROOM, 'plenk');
    const res = say(w, a.session, 'hi');
    expect(refusedOf(res)).toEqual({ reason: 'flood', retryAfterMs: 2000 });
    expect(JSON.stringify(res)).not.toMatch(/trist|seat-1|s_abcdef|wumbo|moderator note|mod@example/);
  });

  it('an unknown reason string is passed through as a string, with only its known fields', async () => {
    const w = await chatWorld({ wrap: scripted(() => pace('some_future_reason', { rule: 3, text: MARKER })) });
    const a = w.attend(ROOM, 'plenk');
    expect(refusedOf(say(w, a.session, 'hi'))).toEqual({ reason: 'some_future_reason', rule: 3 });
  });

  it('a malformed answer from the kit is a refusal with reason unknown, never a delivery', async () => {
    for (const bad of [{}, { deliver: null }, { deliver: { lineId: 'x' } }, { deliver: { text: 5 } }, { refuse: null }, { refuse: 5 }, null, 5, 'deliver']) {
      const w = await chatWorld({ wrap: scripted(() => bad as unknown as ChatResult) });
      const a = w.attend(ROOM, 'plenk');
      const b = w.attend(ROOM, 'wumbo');
      const res = a.session.send({ text: 'hi' });
      expect(res).toEqual({ ok: false, refused: { reason: 'unknown' } });
      expect(b.heard.texts()).toEqual([]);
    }
  });
});
