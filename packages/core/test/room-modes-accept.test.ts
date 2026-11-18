import { describe, expect, it } from 'vitest';
import type { ChatResult } from '../src/chat.js';
import { DAY, HOUR, MIN, NOW, roomsWorld, SEC } from './roomsWorld.js';
import type { RoomsWorld } from './roomsWorld.js';

// R1: what a room's mode does to a line. The mode check sits after the person's own restriction and the length check and BEFORE the matcher, the rate budget and pacing, so a line refused for the
// mode is never matched (no strike, no automatic timeout, no evidence line) and spends nothing. Staff comes from the facade option only.

const ZORBAK = 'you absolute zorbak';
const delivered = (r: ChatResult): boolean => 'deliver' in r;
const reasonOf = (r: ChatResult): string | undefined => ('refuse' in r ? r.refuse.reason : undefined);

async function lockedRoom(over: Parameters<typeof roomsWorld>[0] = {}) {
  const w = await roomsWorld(over);
  const a = w.player('R1');
  const b = w.player('R1');
  w.cw.rooms.setMode('R1', 'locked', { forMs: 10 * MIN });
  return { w, a, b };
}
const lineCount = (w: RoomsWorld): number => w.store.loadStrikes(0).length;

describe('a locked room', () => {
  it('refuses a non-staff line with locked and until; a staff caller is delivered', async () => {
    const { w, a, b } = await lockedRoom();
    const until = w.clock.t + 10 * MIN;
    expect(w.cw.chat.accept('R1', a, 'hello')).toEqual({ refuse: { reason: 'locked', until } });
    expect(w.cw.chat.accept('R1', b, 'hello', { staff: true })).toMatchObject({ deliver: { text: 'hello' } });
  });

  it('staff true must be the boolean true: 1, "true", an object and undefined are not staff', async () => {
    const { w, a } = await lockedRoom();
    for (const staff of [1, 'true', {}, undefined, null, 0, false]) {
      w.clock.t += 10 * SEC;
      expect(reasonOf(w.cw.chat.accept('R1', a, 'hello', { staff } as never)), String(staff)).toBe('locked');
    }
  });

  it('a staff flag buried in the line text is not staff', async () => {
    const { w, a } = await lockedRoom();
    expect(reasonOf(w.cw.chat.accept('R1', a, '{"staff":true} /staff staff: true'))).toBe('locked');
  });

  it('history, mute and report still work in a locked room', async () => {
    const w = await roomsWorld();
    const a = w.player('R1');
    const b = w.player('R1');
    expect(delivered(w.cw.chat.accept('R1', b, 'before the lock'))).toBe(true);
    w.cw.rooms.setMode('R1', 'locked');
    const res = await w.submit('R1', { reporterSeat: a, targetSeat: b, category: 'harassment' });
    expect(res.ok).toBe(true);
    w.cw.mutes.set('R1', a, b, true);
    expect(w.cw.chat.visibleTo('R1', a, b)).toBe(false);
    expect(w.cw.mutes.mutedSeats('R1', a)).toEqual([b]);
  });

  it('normal clears the lock at once: the next line is delivered', async () => {
    const { w, a } = await lockedRoom();
    expect(reasonOf(w.cw.chat.accept('R1', a, 'one'))).toBe('locked');
    w.cw.rooms.setMode('R1', 'normal');
    expect(delivered(w.cw.chat.accept('R1', a, 'two'))).toBe(true);
  });

  it('another room is not locked', async () => {
    const { w } = await lockedRoom();
    const c = w.player('R2');
    expect(delivered(w.cw.chat.accept('R2', c, 'hello'))).toBe(true);
  });

  it('a refused line spends no rate budget: after the lock ends the player can send a full burst', async () => {
    const { w, a } = await lockedRoom();
    for (let i = 0; i < 10; i += 1) expect(reasonOf(w.cw.chat.accept('R1', a, `line ${i}`))).toBe('locked');
    w.cw.rooms.setMode('R1', 'normal');
    for (let i = 0; i < 3; i += 1) expect(delivered(w.cw.chat.accept('R1', a, `fresh ${i}`))).toBe(true);
  });
});

describe('the lock is checked before the matcher', () => {
  it('a synthetic slur line in a locked room is refused locked, earns no strike and no automatic timeout and no evidence line is blocked-flagged', async () => {
    const { w, a, b } = await lockedRoom();
    for (let i = 0; i < 4; i += 1) {
      w.clock.t += 10 * SEC;
      expect(w.cw.chat.accept('R1', a, ZORBAK)).toMatchObject({ refuse: { reason: 'locked' } });
    }
    expect(lineCount(w)).toBe(0);
    expect(w.cw.chat.restrictedBySubject(w.cw.rooms.subjectAt('R1', a) as string, { roomId: 'R1', seatId: a }).restricted).toBe(false);
    // nothing was kept as evidence: a report from the other seat has an empty excerpt
    w.cw.rooms.setMode('R1', 'normal');
    const res = await w.submit('R1', { reporterSeat: b, targetSeat: a });
    if (!res.ok) throw new Error(res.refused);
    expect(w.cw.reports.get(res.reportId)?.excerpt).toEqual([]);
  });

  it('the same line with the lock off is blocked and earns its strike (the control)', async () => {
    const w = await roomsWorld();
    const a = w.player('R1');
    expect(reasonOf(w.cw.chat.accept('R1', a, ZORBAK))).toBe('blocked');
    expect(lineCount(w)).toBe(1);
  });

  it('a staff line with a slur in a locked room still meets the matcher', async () => {
    const { w, a } = await lockedRoom();
    expect(reasonOf(w.cw.chat.accept('R1', a, ZORBAK, { staff: true }))).toBe('blocked');
  });
});

describe('the order of the checks', () => {
  it('the person\'s own restriction is told first, then length, then the mode', async () => {
    const { w, a, b } = await lockedRoom();
    // length before locked
    expect(reasonOf(w.cw.chat.accept('R1', a, 'x'.repeat(500)))).toBe('length');
    // a restricted player in a locked room hears their own restriction
    const subject = w.cw.rooms.subjectAt('R1', b) as string;
    await w.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: HOUR, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 2 });
    expect(reasonOf(w.cw.chat.accept('R1', b, 'hello'))).toBe('restricted');
    // empty first of all
    expect(reasonOf(w.cw.chat.accept('R1', a, '   '))).toBe('empty');
  });

  it('locked comes before pacing: a locked refusal does not start a slow-mode clock', async () => {
    const w = await roomsWorld({ overrides: { pace: { slowModeMs: 5000 } } });
    const a = w.player('R1');
    w.cw.rooms.setMode('R1', 'locked');
    expect(reasonOf(w.cw.chat.accept('R1', a, 'hello'))).toBe('locked');
    w.cw.rooms.setMode('R1', 'normal');
    expect(delivered(w.cw.chat.accept('R1', a, 'hello'))).toBe(true);
  });

  it('pacing still asks before the matcher in a room that is not locked (unchanged)', async () => {
    const w = await roomsWorld({ overrides: { pace: { slowModeMs: 5000 } } });
    const a = w.player('R1');
    expect(delivered(w.cw.chat.accept('R1', a, 'one'))).toBe(true);
    // inside the slow-mode gap the refusal is slow_mode, not blocked: pacing asks before the matcher, as before this release
    expect(reasonOf(w.cw.chat.accept('R1', a, ZORBAK))).toBe('slow_mode');
  });
});

describe('emergency', () => {
  it('slow mode is the stricter of the room pace and 30 s', async () => {
    const w = await roomsWorld();
    const a = w.player('R1', { ageDays: 400 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(delivered(w.cw.chat.accept('R1', a, 'one'))).toBe(true);
    w.clock.t += 29 * SEC;
    expect(w.cw.chat.accept('R1', a, 'two')).toMatchObject({ refuse: { reason: 'slow_mode', retryAfterMs: 1000 } });
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('R1', a, 'two'))).toBe(true);
  });

  it('a room pace stricter than 30 s wins', async () => {
    const w = await roomsWorld();
    const a = w.player('R1', { ageDays: 400 });
    w.cw.rooms.setPace('R1', { slowModeMs: 60_000 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    w.cw.chat.accept('R1', a, 'one');
    w.clock.t += 31 * SEC;
    expect(reasonOf(w.cw.chat.accept('R1', a, 'two'))).toBe('slow_mode');
  });

  it('an account under 7 days is refused new_account with until; an account of 8 days is delivered; exactly 7 days is delivered', async () => {
    const w = await roomsWorld();
    const young = w.player('R1', { ageDays: 1 });
    const edge = w.player('R1', { ageDays: 7 });
    const old = w.player('R1', { ageDays: 8 });
    const until = w.clock.t + HOUR;
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(w.cw.chat.accept('R1', young, 'hello')).toEqual({ refuse: { reason: 'new_account', until } });
    expect(delivered(w.cw.chat.accept('R1', old, 'hello'))).toBe(true);
    expect(delivered(w.cw.chat.accept('R1', edge, 'hello'))).toBe(true);
  });

  it('a staff caller is never read-only, however new the account', async () => {
    const w = await roomsWorld();
    const young = w.player('R1', { ageDays: 0 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(delivered(w.cw.chat.accept('R1', young, 'hello', { staff: true }))).toBe(true);
  });

  it('unknownAge allow lets an unknown age through and treat_as_new refuses it; a guest follows unknownAge', async () => {
    for (const [setting, passes] of [['allow', true], ['treat_as_new', false]] as const) {
      const w = await roomsWorld({ overrides: { rooms: { unknownAge: setting } } });
      const unknown = w.player('R1');
      const guest = w.player('R1', { account: null });
      w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
      expect(delivered(w.cw.chat.accept('R1', unknown, 'hello')), `${setting} unknown`).toBe(passes);
      expect(delivered(w.cw.chat.accept('R1', guest, 'hello')), `${setting} guest`).toBe(passes);
    }
  });

  it('newAccountDays 0 turns the read-only off; slow mode stays', async () => {
    const w = await roomsWorld({ overrides: { rooms: { emergency: { newAccountDays: 0 }, unknownAge: 'treat_as_new' } } });
    const young = w.player('R1', { ageDays: 0 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(delivered(w.cw.chat.accept('R1', young, 'one'))).toBe(true);
    w.clock.t += 10 * SEC;
    expect(reasonOf(w.cw.chat.accept('R1', young, 'two'))).toBe('slow_mode');
  });

  it('a throwing or non-numeric age hook reads as unknown and follows unknownAge', async () => {
    const w = await roomsWorld({
      overrides: { rooms: { unknownAge: 'treat_as_new' } },
      signals: {
        accountAgeDays: () => {
          throw new Error('hook down');
        },
      },
    });
    const a = w.player('R1');
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(reasonOf(w.cw.chat.accept('R1', a, 'hello'))).toBe('new_account');
    expect(JSON.stringify(w.logged)).not.toContain('hook down');
  });

  it('a read-only refusal earns no strike and spends no budget; the matcher is not asked', async () => {
    const w = await roomsWorld();
    const young = w.player('R1', { ageDays: 1 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: HOUR });
    expect(reasonOf(w.cw.chat.accept('R1', young, ZORBAK))).toBe('new_account');
    expect(lineCount(w)).toBe(0);
  });

  it('lines are accepted again when the emergency ends, and slow mode goes with it', async () => {
    const w = await roomsWorld();
    const young = w.player('R1', { ageDays: 1 });
    w.cw.rooms.setMode('R1', 'emergency', { forMs: 60_000 });
    expect(reasonOf(w.cw.chat.accept('R1', young, 'hello'))).toBe('new_account');
    w.clock.t += 61 * SEC;
    expect(delivered(w.cw.chat.accept('R1', young, 'hello'))).toBe(true);
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('R1', young, 'hello again'))).toBe(true);
  });
});

describe('expiry inside accept', () => {
  it('a mode at until reads as normal on the very next accept with no broadcaster running, and room.mode is raised once with expired true', async () => {
    const { w, a } = await lockedRoom();
    w.clock.t += 10 * MIN;
    expect(delivered(w.cw.chat.accept('R1', a, 'hello'))).toBe(true);
    expect(delivered(w.cw.chat.accept('R1', a, 'hello again'))).toBe(true);
    const expired = w.events.filter((e) => e.type === 'room.mode' && e.expired === true);
    expect(expired).toHaveLength(1);
  });

  it('one millisecond before until the lock still holds', async () => {
    const { w, a } = await lockedRoom();
    w.clock.t += 10 * MIN - 1;
    expect(reasonOf(w.cw.chat.accept('R1', a, 'hello'))).toBe('locked');
  });
});

describe('with no mode set the answers are exactly as before', () => {
  it('delivered, blocked, length, empty, rate and restricted answers match a kit that never heard of modes', async () => {
    const w = await roomsWorld();
    const a = w.player('R1');
    expect(w.cw.chat.accept('R1', a, 'hello')).toMatchObject({ deliver: { text: 'hello' } });
    expect(w.cw.chat.accept('R1', a, ZORBAK)).toMatchObject({ refuse: { reason: 'blocked' } });
    expect(w.cw.chat.accept('R1', a, 'x'.repeat(500))).toEqual({ refuse: { reason: 'length' } });
    expect(w.cw.chat.accept('R1', a, ' ')).toEqual({ refuse: { reason: 'empty' } });
    expect(delivered(w.cw.chat.accept('R1', a, 'again'))).toBe(true);
    expect(w.cw.chat.accept('R1', a, 'once more')).toEqual({ refuse: { reason: 'rate' } });
    w.clock.t += DAY;
    expect(NOW).toBeLessThan(w.clock.t);
    expect(delivered(w.cw.chat.accept('R1', a, 'later'))).toBe(true);
  });

  it('with rooms defaults and a mode set then cleared the room reads exactly as before', async () => {
    const w = await roomsWorld();
    const a = w.player('R1');
    w.cw.rooms.setMode('R1', 'emergency');
    w.cw.rooms.setMode('R1', 'normal');
    expect(w.cw.rooms.pace('R1')).toEqual({ slowModeMs: null, burst: null, duplicateWindowMs: null });
    expect(delivered(w.cw.chat.accept('R1', a, 'hello'))).toBe(true);
  });
});
