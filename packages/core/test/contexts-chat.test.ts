import { describe, expect, it } from 'vitest';
import { contextsWorld, DAY, delivered, reasonOf, SEC } from './contextsWorld.js';
import type { ContextsWorld } from './contextsWorld.js';

// M1: what a room's context does to a line: the unknown-context gate, the profanity mode, the pace, the filters and the least account age.

const SNERP = 'you absolute snerp';
const unknownLogs = (w: ContextsWorld): number => w.logged.filter(([e]) => e === 'chatwarden.context_unknown').length;

describe('a room tagged with an undeclared context', () => {
  it('refuses every line gate and logs one chatwarden.context_unknown per room, not per line', async () => {
    const w = await contextsWorld({ kids: {} });
    const a = w.player('R1', { tags: { context: 'kidz' } });
    const b = w.player('R1');
    for (let i = 0; i < 3; i += 1) {
      expect(reasonOf(w.cw.chat.accept('R1', i % 2 === 0 ? a : b, `hello ${i}`)), `line ${i}`).toBe('gate');
      w.clock.t += 6 * SEC;
    }
    expect(unknownLogs(w)).toBe(1);
    const c = w.player('R2', { tags: { context: 'kidz' } });
    expect(reasonOf(w.cw.chat.accept('R2', c, 'hello'))).toBe('gate');
    expect(unknownLogs(w)).toBe(2);
  });

  it('the log line carries no room id, seat, text or context name', async () => {
    const w = await contextsWorld({});
    const a = w.player('room-secret-1', { tags: { context: 'typo' } });
    w.cw.chat.accept('room-secret-1', a, 'my private words');
    const line = w.logged.find(([e]) => e === 'chatwarden.context_unknown');
    expect(line).toBeDefined();
    const text = JSON.stringify(line);
    for (const leak of ['room-secret-1', 'typo', 'private', a]) expect(text).not.toContain(leak);
  });

  it('a throwing gate hook still fails closed first, and a gate that allows does not hide the unknown context', async () => {
    const throwing = await contextsWorld({}, { gate: () => { throw new Error('down'); } });
    const a = throwing.player('R1', { tags: { context: 'nope' } });
    expect(reasonOf(throwing.cw.chat.accept('R1', a, 'hi'))).toBe('gate');
    expect(throwing.logged.some(([e]) => e === 'chat.gate_failed')).toBe(true);
    expect(unknownLogs(throwing)).toBe(0);
    const open = await contextsWorld({}, { gate: () => true });
    const b = open.player('R1', { tags: { context: 'nope' } });
    expect(reasonOf(open.cw.chat.accept('R1', b, 'hi'))).toBe('gate');
    expect(unknownLogs(open)).toBe(1);
  });

  it('staff is refused too (a typo fails shut for everyone), and a declared context in another room is untouched', async () => {
    const w = await contextsWorld({ kids: {} });
    const a = w.player('R1', { tags: { context: 'kidz' } });
    expect(reasonOf(w.cw.chat.accept('R1', a, 'hi', { staff: true }))).toBe('gate');
    const b = w.player('R2', { tags: { context: 'kids' } });
    expect(delivered(w.cw.chat.accept('R2', b, 'hi'))).toBe(true);
    expect(unknownLogs(w)).toBe(1);
  });

  it('a refusal for an unknown context earns no strike and keeps no evidence', async () => {
    const w = await contextsWorld({});
    const a = w.player('R1', { tags: { context: 'nope' } });
    w.cw.chat.accept('R1', a, 'you zorbak');
    expect(w.store.loadStrikes(0)).toHaveLength(0);
  });

  it('closing the room and opening it again with a declared tag speaks, and the log is once per open room', async () => {
    const w = await contextsWorld({ kids: {} });
    const a = w.player('R1', { tags: { context: 'kidz' } });
    expect(reasonOf(w.cw.chat.accept('R1', a, 'hi'))).toBe('gate');
    w.cw.rooms.close('R1');
    const b = w.player('R1', { tags: { context: 'kidz' } });
    expect(reasonOf(w.cw.chat.accept('R1', b, 'hi'))).toBe('gate');
    expect(unknownLogs(w)).toBe(2);
    w.cw.rooms.close('R1');
    const c = w.player('R1', { tags: { context: 'kids' } });
    expect(delivered(w.cw.chat.accept('R1', c, 'hi'))).toBe(true);
  });
});

describe('profanity by context', () => {
  it('chat.accept in a refuse-mode context refuses swearing that the base profile stars; the same line in the base is starred', async () => {
    const w = await contextsWorld({ kids: { profanity: { mode: 'refuse' } } });
    const kid = w.player('K', { tags: { context: 'kids' } });
    const base = w.player('B');
    expect(reasonOf(w.cw.chat.accept('K', kid, SNERP))).toBe('profanity');
    expect(w.cw.chat.accept('B', base, SNERP)).toMatchObject({ deliver: { text: 'you absolute *****' } });
  });

  it('an allow context leaves swearing alone while the base stars it; star in a context over an allow base stars', async () => {
    const w = await contextsWorld({ ranked: { profanity: { mode: 'allow' } }, calm: { profanity: { mode: 'star' } } });
    const r = w.player('RK', { tags: { context: 'ranked' } });
    const b = w.player('BS');
    expect(w.cw.chat.accept('RK', r, SNERP)).toMatchObject({ deliver: { text: SNERP } });
    expect(w.cw.chat.accept('BS', b, SNERP)).toMatchObject({ deliver: { text: 'you absolute *****' } });
    const allowBase = await contextsWorld({ calm: { profanity: { mode: 'star' } } }, {}, { profanity: { mode: 'allow' } });
    const c = allowBase.player('C', { tags: { context: 'calm' } });
    const d = allowBase.player('D');
    expect(allowBase.cw.chat.accept('C', c, SNERP)).toMatchObject({ deliver: { text: 'you absolute *****' } });
    expect(allowBase.cw.chat.accept('D', d, SNERP)).toMatchObject({ deliver: { text: SNERP } });
  });

  it('a refused profane line in a context is not kept as a blocked line and earns no strike', async () => {
    const w = await contextsWorld({ kids: { profanity: { mode: 'refuse' } } });
    const kid = w.player('K', { tags: { context: 'kids' } });
    w.cw.chat.accept('K', kid, SNERP);
    expect(w.store.loadStrikes(0)).toHaveLength(0);
  });

  it('the matcher still blocks a slur in every context, whatever the profanity mode', async () => {
    const w = await contextsWorld({ ranked: { profanity: { mode: 'allow' } } });
    const r = w.player('RK', { tags: { context: 'ranked' } });
    expect(reasonOf(w.cw.chat.accept('RK', r, 'you zorbak'))).toBe('blocked');
  });
});

describe('pace and filters by context', () => {
  it('a context slow mode paces its rooms only', async () => {
    const w = await contextsWorld({ kids: { pace: { slowModeMs: 3000 } } });
    const kid = w.player('K', { tags: { context: 'kids' } });
    const base = w.player('B');
    expect(delivered(w.cw.chat.accept('K', kid, 'one'))).toBe(true);
    w.clock.t += SEC;
    expect(w.cw.chat.accept('K', kid, 'two')).toMatchObject({ refuse: { reason: 'slow_mode' } });
    expect(delivered(w.cw.chat.accept('B', base, 'one'))).toBe(true);
    w.clock.t += SEC;
    expect(delivered(w.cw.chat.accept('B', base, 'two'))).toBe(true);
    w.clock.t += 3 * SEC;
    expect(delivered(w.cw.chat.accept('K', kid, 'three'))).toBe(true);
  });

  it('a context that refuses links refuses them in its rooms only', async () => {
    const w = await contextsWorld({ kids: { filters: { links: { action: 'refuse' } } } });
    const kid = w.player('K', { tags: { context: 'kids' } });
    const base = w.player('B');
    expect(reasonOf(w.cw.chat.accept('K', kid, 'see http://example.org/x'))).toBe('link');
    expect(delivered(w.cw.chat.accept('B', base, 'see http://example.org/x'))).toBe(true);
  });

  it('a context that turns a base filter off lets it through in its rooms only', async () => {
    const w = await contextsWorld({ open: { filters: { links: null } } }, {}, { filters: { links: { action: 'refuse' } } });
    const open = w.player('O', { tags: { context: 'open' } });
    const base = w.player('B');
    expect(delivered(w.cw.chat.accept('O', open, 'see http://example.org/x'))).toBe(true);
    expect(reasonOf(w.cw.chat.accept('B', base, 'see http://example.org/x'))).toBe('link');
  });

  it('a context whose filters cite a Community Rule that does not exist is refused at creation', async () => {
    await expect(contextsWorld({ kids: { filters: { links: { action: 'refuse', rule: 999 } } } })).rejects.toThrow(/contexts\.kids\.filters/);
  });
});

describe('minAccountAgeDays', () => {
  it('an account older than the limit speaks; younger, a guest, and an age that is null or throws are refused account_too_new (fail closed)', async () => {
    const w = await contextsWorld({ whisper: { chat: { minAccountAgeDays: 7 } } });
    const old = w.player('W', { ageDays: 30, tags: { context: 'whisper' } });
    const exact = w.player('W', { ageDays: 7 });
    const young = w.player('W', { ageDays: 6 });
    const unknown = w.player('W');
    const guest = w.player('W', { account: null });
    const throws = w.player('W', { ageDays: 'throw' });
    expect(delivered(w.cw.chat.accept('W', old, 'hi'))).toBe(true);
    expect(delivered(w.cw.chat.accept('W', exact, 'hi'))).toBe(true);
    for (const [name, seat] of [['young', young], ['unknown', unknown], ['guest', guest], ['throws', throws]] as const) {
      expect(reasonOf(w.cw.chat.accept('W', seat, 'hi')), name).toBe('account_too_new');
    }
  });

  it('is a pause, not a sanction: no strike, nothing kept, and it spends no rate budget', async () => {
    const w = await contextsWorld({ whisper: { chat: { minAccountAgeDays: 7 } } });
    const young = w.player('W', { ageDays: 1, tags: { context: 'whisper' } });
    for (let i = 0; i < 6; i += 1) expect(reasonOf(w.cw.chat.accept('W', young, i === 0 ? 'you zorbak' : `hi ${i}`))).toBe('account_too_new');
    expect(w.store.loadStrikes(0)).toHaveLength(0);
    w.ages.set([...w.ages.keys()][0]!, 30);
    w.clock.t += DAY;
    expect(delivered(w.cw.chat.accept('W', young, 'hi'))).toBe(true);
  });

  it('the base and other contexts have no age rule, and staff is exempt', async () => {
    const w = await contextsWorld({ whisper: { chat: { minAccountAgeDays: 365 } }, free: {} });
    const a = w.player('W', { ageDays: 1, tags: { context: 'whisper' } });
    const b = w.player('F', { ageDays: 1, tags: { context: 'free' } });
    const c = w.player('N', { ageDays: 1 });
    expect(reasonOf(w.cw.chat.accept('W', a, 'hi'))).toBe('account_too_new');
    expect(delivered(w.cw.chat.accept('W', a, 'hi', { staff: true }))).toBe(true);
    expect(delivered(w.cw.chat.accept('F', b, 'hi'))).toBe(true);
    expect(delivered(w.cw.chat.accept('N', c, 'hi'))).toBe(true);
  });

  it('minAccountAgeDays null is no rule, and a context with only an age rule keeps the base profanity mode', async () => {
    const w = await contextsWorld({ a: { chat: { minAccountAgeDays: null } }, b: { chat: { minAccountAgeDays: 1 } } });
    const x = w.player('A', { tags: { context: 'a' } });
    const y = w.player('B', { ageDays: 5, tags: { context: 'b' } });
    expect(delivered(w.cw.chat.accept('A', x, 'hi'))).toBe(true);
    expect(w.cw.chat.accept('B', y, SNERP)).toMatchObject({ deliver: { text: 'you absolute *****' } });
  });

  it('postingState is not changed by a context (the age rule is a chat-time refusal only)', async () => {
    const w = await contextsWorld({ whisper: { chat: { minAccountAgeDays: 7 } } });
    const young = w.player('W', { ageDays: 1, tags: { context: 'whisper' } });
    expect(w.cw.rooms.postingState('W', young)).toBe('ok');
  });
});
