import { describe, expect, it } from 'vitest';
import { chatWorld, routeWorld, SEC } from './chat-world.js';
import type { SendResult } from '../src/chat/wire.js';

// Pacing through the real core (flood control, design 4; the chat box, design 8.3): slow mode, the burst limit and repeat refusal reach the
// player as `slow_mode`, `flood` and `duplicate` with a wait, carry nothing else, and leave no trace of the refused line.

const ROOM = 'lobby';
const MARKER = 'pace-marker-4432';

function refusedOf(res: SendResult) {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected a refusal');
  expect(Object.keys(res).sort()).toEqual(['ok', 'refused']);
  return res.refused;
}

describe('slow_mode, flood and duplicate over the real routes of the kit', () => {
  it('with cw.rooms.setPace slow mode 3000: a second line inside the gap is refused slow_mode with retryAfterMs 3000 minus the elapsed time', async () => {
    const w = await chatWorld();
    w.real.rooms.setPace(ROOM, { slowModeMs: 3000 });
    const a = w.attend(ROOM, 'plenk');
    expect(a.session.send({ text: 'first line' }).ok).toBe(true);
    w.advance(1000);
    expect(refusedOf(a.session.send({ text: 'second line' }))).toEqual({ reason: 'slow_mode', retryAfterMs: 2000 });
    w.advance(1999);
    expect(refusedOf(a.session.send({ text: 'second line' }))).toEqual({ reason: 'slow_mode', retryAfterMs: 1 });
    w.advance(1);
    expect(a.session.send({ text: 'second line' }).ok).toBe(true);
  });

  it('burst 3 per 10 s: the fourth line is flood; each answer carries only reason and retryAfterMs', async () => {
    const w = await chatWorld({ pace: { burst: { lines: 3, windowMs: 10_000 } } });
    const a = w.attend(ROOM, 'plenk');
    for (const t of ['one', 'two', 'three']) {
      expect(a.session.send({ text: t }).ok).toBe(true);
      w.advance(1500);
    }
    const refused = refusedOf(a.session.send({ text: 'four' }));
    expect(refused.reason).toBe('flood');
    expect(Object.keys(refused).sort()).toEqual(['reason', 'retryAfterMs']);
    expect(Number.isInteger(refused.retryAfterMs)).toBe(true);
    // The oldest line (4.5 s ago) leaves the window after 5.5 s.
    expect(refused.retryAfterMs).toBe(5500);
    w.advance(5500);
    expect(a.session.send({ text: 'four' }).ok).toBe(true);
  });

  it('the repeat of a line is duplicate, whatever the case and punctuation, until its window passes', async () => {
    const w = await chatWorld({ pace: { duplicateWindowMs: 15_000 } });
    const a = w.attend(ROOM, 'plenk');
    expect(a.session.send({ text: 'Same words here' }).ok).toBe(true);
    w.advance(2 * SEC);
    expect(refusedOf(a.session.send({ text: 'same  WORDS, here!' }))).toEqual({ reason: 'duplicate', retryAfterMs: 13_000 });
    // A different line is fine, and a short one ("gg") is never a repeat.
    expect(a.session.send({ text: 'something else' }).ok).toBe(true);
    expect(a.session.send({ text: 'gg' }).ok).toBe(true);
    w.advance(4 * SEC);
    expect(a.session.send({ text: 'gg' }).ok).toBe(true);
    w.advance(9 * SEC);
    expect(a.session.send({ text: 'Same words here' }).ok).toBe(true);
  });

  it('the refused pace line is in no stream, no ring, no log and no evidence; the kit asks nothing of the player but a wait', async () => {
    const w = await chatWorld({ pace: { duplicateWindowMs: 15_000 } });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    expect(a.session.send({ text: `${MARKER} says hello` }).ok).toBe(true);
    w.advance(2 * SEC);
    expect(refusedOf(a.session.send({ text: `${MARKER} says hello` })).reason).toBe('duplicate');
    // Everyone heard the accepted line once.
    expect(b.heard.texts().filter((t) => t.includes(MARKER))).toHaveLength(1);
    expect(a.heard.texts().filter((t) => t.includes(MARKER))).toHaveLength(1);
    // A stream opened later holds one line in its snapshot (the ring did not move).
    const late = w.attend(ROOM, 'tarvo');
    const hello = late.heard.of('hello')[0] as unknown as { lines: Array<{ text: string }> };
    expect(hello.lines.filter((l) => l.text.includes(MARKER))).toHaveLength(1);
    expect(JSON.stringify(w.logs)).not.toContain(MARKER);
    // The evidence buffer: a report on the author holds the one accepted line.
    const reported = await w.real.reports.submit({ roomId: ROOM, reporterSeat: w.seatOf(ROOM, 'wumbo'), targetSeat: w.seatOf(ROOM, 'plenk'), category: 'harassment' });
    if (!reported.ok) throw new Error('report refused');
    const report = w.real.reports.get(reported.reportId);
    expect(report?.excerpt.filter((l) => l.raw.includes(MARKER))).toHaveLength(1);
  });

  it('pace overrides per room: one room paced, another not', async () => {
    const w = await chatWorld();
    w.real.rooms.setPace('paced-room', { slowModeMs: 5000 });
    const p = w.attend('paced-room', 'plenk');
    const f = w.attend('free-room', 'plenk');
    expect(p.session.send({ text: 'one' }).ok).toBe(true);
    expect(f.session.send({ text: 'one' }).ok).toBe(true);
    w.advance(500);
    expect(refusedOf(p.session.send({ text: 'two' })).reason).toBe('slow_mode');
    expect(f.session.send({ text: 'two' }).ok).toBe(true);
    // Clearing the override frees the room again.
    w.real.rooms.setPace('paced-room', null);
    expect(p.session.send({ text: 'two' }).ok).toBe(true);
  });

  it('pace is per player: a second player in a slow room is not held by the first', async () => {
    const w = await chatWorld({ pace: { slowModeMs: 5000 } });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'wumbo');
    expect(a.session.send({ text: 'hello' }).ok).toBe(true);
    expect(b.session.send({ text: 'hello' }).ok).toBe(true);
    expect(refusedOf(a.session.send({ text: 'again' })).reason).toBe('slow_mode');
  });

  it('a pacing refusal is not a rate refusal and spends nothing: the line after the wait is not rate-limited', async () => {
    const w = await chatWorld({ pace: { slowModeMs: 1000 } });
    const a = w.attend(ROOM, 'plenk');
    expect(a.session.send({ text: 'one' }).ok).toBe(true);
    for (let i = 0; i < 6; i += 1) expect(refusedOf(a.session.send({ text: 'too soon' })).reason).toBe('slow_mode');
    w.advance(1000);
    expect(a.session.send({ text: 'two' }).ok).toBe(true);
  });
});

describe('over the routes', () => {
  it('POST /rooms/:room/lines answers a pacing refusal as ok false with reason and retryAfterMs only', async () => {
    const w = await routeWorld({ pace: { slowModeMs: 3000 } });
    const h = w.as('plenk');
    const first = await w.post(ROOM, 'lines', h, { text: 'first' });
    expect((first.body as { ok: boolean }).ok).toBe(true);
    w.advance(1000);
    const second = await w.post(ROOM, 'lines', h, { text: 'second' });
    expect(second.body).toEqual({ ok: false, refused: { reason: 'slow_mode', retryAfterMs: 2000 } });
  });
});
