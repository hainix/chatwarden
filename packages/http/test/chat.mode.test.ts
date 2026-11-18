import { describe, expect, it } from 'vitest';
import { chatWorld, MIN, routeWorld, SEC, spoken } from './chat-world.js';

// R3: a room's mode reaches the chat box. `hello` carries the mode and the viewer's read-only state; a `mode` frame goes to every stream when the mode changes and when it ends (the broadcaster's own timer),
// with `readOnly` computed per viewer. The kit decides every line (it checks the clock itself), so a late timer can never make an answer wrong. `staff` and `evidenceRef` come from the `join` hook only.

const ROOM = 'lobby';
// An account id says its own age: new-<name> is a day old, old-<name> is 90 days. Every player has their own account (the same id would be the same person).
const signals = { accountAgeDays: (ids: readonly string[]) => (ids[0]?.startsWith('new-') === true ? 1 : ids[0]?.startsWith('old-') === true ? 90 : undefined) };

type ModeFrame = { type: 'mode'; mode: { kind: string; until: number | null }; readOnly?: string };
const modes = (h: ReturnType<typeof spoken>): ModeFrame[] => h.frames.filter((f) => (f as { type: string }).type === 'mode') as unknown as ModeFrame[];

const newbie = (name: string) => ({ accountId: `new-${name}` });
const veteran = (name: string) => ({ accountId: `old-${name}` });

describe('hello and the mode frame', () => {
  it('hello carries mode { kind, until } and you.readOnly only when the viewer cannot post; a normal room has kind normal and no readOnly', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', veteran('plenk'));
    const hello = a.heard.of('hello')[0] as unknown as { mode: unknown; you: Record<string, unknown> };
    expect(hello.mode).toEqual({ kind: 'normal', until: null });
    expect(hello.you).toEqual({ name: 'plenk' });
  });

  it('a hello into a locked room says locked with the end and readOnly locked for a non-staff viewer', async () => {
    const w = await chatWorld({ signals });
    w.attend(ROOM, 'wumbo', veteran('wumbo'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 10 * MIN });
    const late = w.attend(ROOM, 'plenk', veteran('plenk'));
    const hello = late.heard.of('hello')[0] as unknown as { mode: unknown; you: Record<string, unknown> };
    expect(hello.mode).toEqual({ kind: 'locked', until: w.clock.t + 10 * MIN });
    expect(hello.you).toEqual({ name: 'plenk', readOnly: 'locked' });
  });

  it('a staff member (the join hook\'s word) is never read-only, in a locked room or an emergency', async () => {
    const w = await chatWorld({ signals });
    const staff = w.join(ROOM, 'modmo', newbie('modmo'), { staff: true });
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 10 * MIN });
    const heard = spoken();
    staff.open(heard.sink);
    expect((heard.of('hello')[0] as unknown as { you: Record<string, unknown> }).you).toEqual({ name: 'modmo' });
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 10 * MIN });
    expect(modes(heard).at(-1)).toEqual({ type: 'mode', mode: { kind: 'emergency', until: w.clock.t + 10 * MIN } });
  });

  it('setMode sends a mode frame to every open stream with readOnly computed per viewer: a staff member none, a 1-day account new_account in an emergency, a veteran none', async () => {
    const w = await chatWorld({ signals });
    const young = w.attend(ROOM, 'plenk', newbie('plenk'));
    const old = w.attend(ROOM, 'wumbo', veteran('wumbo'));
    const staff = spoken();
    w.join(ROOM, 'modmo', newbie('modmo'), { staff: true }).open(staff.sink);
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 10 * MIN });
    const until = w.clock.t + 10 * MIN;
    expect(modes(young.heard)).toEqual([{ type: 'mode', mode: { kind: 'emergency', until }, readOnly: 'new_account' }]);
    expect(modes(old.heard)).toEqual([{ type: 'mode', mode: { kind: 'emergency', until } }]);
    expect(modes(staff)).toEqual([{ type: 'mode', mode: { kind: 'emergency', until } }]);
  });

  it('in a locked room every non-staff viewer is read-only locked', async () => {
    const w = await chatWorld({ signals });
    const young = w.attend(ROOM, 'plenk', newbie('plenk'));
    const old = w.attend(ROOM, 'wumbo', veteran('wumbo'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 10 * MIN });
    for (const h of [young.heard, old.heard]) expect(modes(h)[0]).toMatchObject({ mode: { kind: 'locked' }, readOnly: 'locked' });
  });

  it('normal clears: a mode frame with kind normal and until null, no readOnly, to every stream at once', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', newbie('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 10 * MIN });
    w.real.rooms.setMode(ROOM, 'normal');
    expect(modes(a.heard).at(-1)).toEqual({ type: 'mode', mode: { kind: 'normal', until: null } });
  });

  it('a mode of another room, or of a room the broadcaster does not hold, sends nothing', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend('room-a', 'plenk', veteran('plenk'));
    w.real.rooms.setMode('room-b', 'locked');
    w.real.rooms.setMode('room-nobody', 'locked');
    expect(modes(a.heard)).toEqual([]);
  });
});

describe('the timer at until', () => {
  it('the broadcaster\'s own timer sends a normal mode frame when the mode ends', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', newbie('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    expect(modes(a.heard)).toHaveLength(1);
    w.advance(5 * MIN - 1);
    expect(modes(a.heard)).toHaveLength(1);
    w.advance(1);
    expect(modes(a.heard).at(-1)).toEqual({ type: 'mode', mode: { kind: 'normal', until: null } });
    expect(modes(a.heard)).toHaveLength(2);
    // and it was the only one
    w.advance(10 * MIN);
    expect(modes(a.heard)).toHaveLength(2);
  });

  it('a second setMode replaces the first: the old timer does nothing, the new one ends it', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', veteran('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 2 * MIN });
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 10 * MIN });
    w.advance(2 * MIN);
    expect(modes(a.heard).map((f) => f.mode.kind)).toEqual(['locked', 'emergency']);
    w.advance(8 * MIN);
    expect(modes(a.heard).map((f) => f.mode.kind)).toEqual(['locked', 'emergency', 'normal']);
  });

  it('normal before until cancels the timer: no second normal frame', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', veteran('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    w.real.rooms.setMode(ROOM, 'normal');
    w.advance(10 * MIN);
    expect(modes(a.heard).map((f) => f.mode.kind)).toEqual(['locked', 'normal']);
  });

  it('a late timer cannot make a refusal wrong: after until the kit says normal on the very next line, and the one normal frame is not repeated when the timer then fires', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', veteran('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 60_000 });
    // the clock passes `until` but the timer has not fired yet
    w.clock.t += 61 * SEC;
    const res = a.session.send({ text: 'hello' });
    expect(res.ok).toBe(true);
    expect(modes(a.heard).map((f) => f.mode.kind)).toEqual(['locked', 'normal']);
    w.advance(MIN);
    expect(modes(a.heard).map((f) => f.mode.kind)).toEqual(['locked', 'normal']);
  });

  it('closing the room cancels its timer', async () => {
    const w = await chatWorld({ signals });
    w.attend(ROOM, 'plenk', veteran('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    const timers = w.pending();
    w.chat.closeRoom(ROOM);
    expect(w.pending()).toBeLessThan(timers);
  });
});

describe('what a refusal says', () => {
  it('a line in a locked room is refused locked with until; the same player is delivered once it ends', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', veteran('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    w.advance(SEC);
    expect(a.session.send({ text: 'hello' })).toEqual({ ok: false, refused: { reason: 'locked', until: w.clock.t - SEC + 5 * MIN } });
    w.advance(5 * MIN);
    expect(a.session.send({ text: 'hello' }).ok).toBe(true);
  });

  it('a young account in an emergency is refused new_account with until', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', newbie('plenk'));
    w.real.rooms.setMode(ROOM, 'emergency', { forMs: 5 * MIN });
    expect(a.session.send({ text: 'hello' })).toEqual({ ok: false, refused: { reason: 'new_account', until: w.clock.t + 5 * MIN } });
  });
});

describe('staff and the evidence ref come from the join hook only', () => {
  it('member.staff is passed to accept: a staff member is delivered in a locked room', async () => {
    const w = await chatWorld({ signals });
    const staff = w.join(ROOM, 'modmo', veteran('modmo'), { staff: true });
    const other = w.attend(ROOM, 'plenk', veteran('plenk'));
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    w.advance(SEC);
    expect(staff.send({ text: 'a staff line' }).ok).toBe(true);
    expect(other.heard.texts()).toEqual(['a staff line']);
  });

  it('a request body field named staff is ignored by the routes', async () => {
    const w = await routeWorld({ signals });
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    const res = await w.post(ROOM, 'lines', w.as('plenk', { 'x-account': 'old-plenk' }), { text: 'hello', staff: true, member: { staff: true } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, refused: { reason: 'locked' } });
    const viaHeader = await w.post(ROOM, 'lines', w.as('plenk', { 'x-account': 'old-plenk', 'x-staff': '1' }), { text: 'hello' });
    expect(viaHeader.body).toMatchObject({ ok: false, refused: { reason: 'locked' } });
  });

  it('staff from the join hook works through the routes', async () => {
    const w = await routeWorld({
      signals,
      routes: { join: (req) => ({ name: req.headers['x-name'] ?? 'plenk', ...(req.headers['x-staff'] === '1' ? { staff: true } : {}) }) },
    });
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    const res = await w.post(ROOM, 'lines', w.as('modmo', { 'x-account': 'old-modmo', 'x-staff': '1' }), { text: 'hello' });
    expect(res.body).toMatchObject({ ok: true });
  });

  it('member.staff must be the boolean true: "true", 1 and an object are not staff', async () => {
    const w = await chatWorld({ signals });
    for (const [i, staff] of (['true', 1, {}, 'yes'] as const).entries()) {
      const s = w.join(ROOM, `pl${i}`, veteran(`pl${i}`), { staff: staff as never });
      w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
      w.advance(SEC);
      expect(s.send({ text: 'hello' }), String(staff)).toMatchObject({ ok: false, refused: { reason: 'locked' } });
      w.real.rooms.setMode(ROOM, 'normal');
    }
  });

  it('evidenceRef from the join hook reaches a chat-box report, and a body field named evidenceRef is ignored', async () => {
    const w = await chatWorld({ signals });
    const author = w.attend(ROOM, 'plenk', veteran('plenk'));
    const reporter = w.join(ROOM, 'wumbo', veteran('wumbo'), { evidenceRef: 'match_42:t-1' });
    w.advance(2 * SEC);
    const line = author.session.send({ text: 'something rude' });
    if (!line.ok) throw new Error('refused');
    const res = await reporter.report({ lineId: line.line.id, evidenceRef: 'from-the-body' } as never);
    expect(res.ok).toBe(true);
    const stored = w.store.listReports({ limit: 5 });
    expect(stored.map((r) => r.evidenceRef)).toEqual(['match_42:t-1']);
  });

  it('with no evidenceRef from the hook a report has none, whatever the request says', async () => {
    const w = await routeWorld({ signals });
    const author = w.attend(ROOM, 'plenk', veteran('plenk'));
    w.advance(2 * SEC);
    const sent = author.session.send({ text: 'something rude' });
    if (!sent.ok) throw new Error('refused');
    const res = await w.post(ROOM, 'report', w.as('wumbo', { 'x-account': 'old-wumbo' }), { lineId: sent.line.id, evidenceRef: 'from-the-body' });
    expect(res.status).toBe(200);
    expect(w.store.listReports({ limit: 5 }).map((r) => r.evidenceRef)).toEqual([null]);
  });
});

describe('a mode and the history', () => {
  it('history is still delivered in a locked room (hello keeps its lines)', async () => {
    const w = await chatWorld({ signals });
    const a = w.attend(ROOM, 'plenk', veteran('plenk'));
    w.advance(2 * SEC);
    a.session.send({ text: 'before the lock' });
    w.real.rooms.setMode(ROOM, 'locked', { forMs: 5 * MIN });
    const late = w.attend(ROOM, 'wumbo', veteran('wumbo'));
    expect(late.heard.of('hello')[0]?.lines.map((l) => l.text)).toEqual(['before the lock']);
  });
});
