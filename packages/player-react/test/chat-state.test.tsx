import { describe, expect, it } from 'vitest';
import { chatReducer, createChatState, initialChatState } from '../src/chat/state.js';
import type { ChatAction, ChatState } from '../src/chat/state.js';
import type { ChatFrame, WireLine } from '../src/chat/wire.js';

const L = (id: string, at: number, text = `line ${id}`, extra: Partial<WireLine> = {}): WireLine => ({ id, at, name: 'tarvo', text, ...extra });
const hello = (over: Partial<Extract<ChatFrame, { type: 'hello' }>> = {}): ChatFrame => ({
  type: 'hello',
  v: 1,
  epoch: 'e1',
  room: 'lobby',
  you: { name: 'snerp' },
  maxLength: 200,
  summary: 'Trash talk is part of the game.',
  restriction: null,
  lines: [],
  muted: [],
  ...over,
});
const frame = (f: ChatFrame): ChatAction => ({ type: 'frame', frame: f });
const run = (actions: ChatAction[], from: ChatState = initialChatState): ChatState => actions.reduce(chatReducer, from);
const ids = (s: ChatState): string[] => s.lines.map((l) => l.id);

describe('the initial state', () => {
  it('ready is false before hello and true after', () => {
    expect(initialChatState.ready).toBe(false);
    expect(initialChatState.status).toBe('connecting');
    expect(initialChatState.lines).toEqual([]);
    expect(initialChatState.epoch).toBeNull();
    expect(initialChatState.you).toBeNull();
    expect(initialChatState.closed).toBeNull();
    expect(initialChatState.restriction).toBeNull();
    expect(initialChatState.muted).toEqual([]);
    const s = run([frame(hello())]);
    expect(s.ready).toBe(true);
    expect(s.status).toBe('open');
    expect(s.you).toEqual({ name: 'snerp' });
    expect(s.maxLength).toBe(200);
    expect(s.summary).toBe('Trash talk is part of the game.');
  });

  it('a frame other than hello does not make the state ready, and is ignored before hello', () => {
    const s = run([frame({ type: 'line', line: L('1', 1) }), frame({ type: 'hide', ids: ['1'] }), frame({ type: 'state', restriction: { until: null, byModerator: true }, muted: [{ ref: 'r', name: 'a' }] }), frame({ type: 'notices' })]);
    expect(s.ready).toBe(false);
    expect(s.lines).toEqual([]);
    expect(s.restriction).toBeNull();
    expect(s.muted).toEqual([]);
  });

  it('the initial state is never mutated by the reducer', () => {
    const before = JSON.stringify(initialChatState);
    run([frame(hello({ lines: [L('1', 1)] })), { type: 'sent', line: L('2', 2) }]);
    expect(JSON.stringify(initialChatState)).toBe(before);
  });
});

describe('hello replaces state on a new epoch and merges on the same epoch', () => {
  it('a new epoch replaces the lines', () => {
    const s = run([frame(hello({ lines: [L('1', 10), L('2', 20)] })), frame(hello({ epoch: 'e2', lines: [L('1', 30, 'fresh start')] }))]);
    expect(s.epoch).toBe('e2');
    expect(s.lines).toEqual([L('1', 30, 'fresh start')]);
  });

  it('a new epoch with no lines empties the list', () => {
    const s = run([frame(hello({ lines: [L('1', 10)] })), frame(hello({ epoch: 'e2', lines: [] }))]);
    expect(s.lines).toEqual([]);
  });

  it('the same epoch merges by id, newer copy wins', () => {
    const s = run([frame(hello({ lines: [L('1', 10, 'old'), L('2', 20)] })), frame(hello({ lines: [L('2', 20, 'same'), L('3', 30)] }))]);
    expect(ids(s)).toEqual(['1', '2', '3']);
    expect(s.lines[1]?.text).toBe('same');
  });

  it('hello replaces you, maxLength, summary, restriction and muted', () => {
    const s = run([
      frame(hello({ restriction: { until: 9, byModerator: true }, muted: [{ ref: 'a', name: 'x' }] })),
      frame(hello({ you: { name: 'vlemmo' }, maxLength: 120, summary: 'New standard.', restriction: null, muted: [] })),
    ]);
    expect(s).toMatchObject({ you: { name: 'vlemmo' }, maxLength: 120, summary: 'New standard.', restriction: null, muted: [] });
  });

  it('a hello clears closed and sets status open', () => {
    const s = run([frame(hello()), { type: 'status', status: 'reconnecting' }, frame(hello())]);
    expect(s.status).toBe('open');
    expect(s.closed).toBeNull();
  });

  it('a line that was mine stays mine when the snapshot copy lacks the flag', () => {
    const s = run([frame(hello({ lines: [L('1', 10, 'x', { mine: true })] })), frame(hello({ lines: [L('1', 10, 'x')] }))]);
    expect(s.lines[0]?.mine).toBe(true);
  });
});

describe('the POST answer and the stream\'s copy of a line are one line', () => {
  it('answer first, then the stream', () => {
    const mine = L('43', 100, 'hello', { mine: true });
    const s = run([frame(hello()), { type: 'sent', line: mine }, frame({ type: 'line', line: mine })]);
    expect(s.lines).toEqual([mine]);
  });

  it('stream first, then the answer', () => {
    const mine = L('43', 100, 'hello', { mine: true });
    const s = run([frame(hello()), frame({ type: 'line', line: mine }), { type: 'sent', line: mine }]);
    expect(s.lines).toEqual([mine]);
  });

  it('the same line arriving three times is one line', () => {
    const l = L('5', 5);
    const s = run([frame(hello()), frame({ type: 'line', line: l }), frame({ type: 'line', line: l }), frame({ type: 'line', line: { ...l } })]);
    expect(s.lines).toHaveLength(1);
  });

  it('a duplicate returns the same state object when nothing changed', () => {
    const l = L('5', 5);
    const s1 = run([frame(hello()), frame({ type: 'line', line: l })]);
    expect(chatReducer(s1, frame({ type: 'line', line: { ...l } }))).toBe(s1);
  });
});

describe('lines older than the snapshot survive a same-epoch reconnect', () => {
  it('lines before the snapshot window are kept', () => {
    const before = [L('1', 10), L('2', 20), L('3', 30)];
    const s = run([frame(hello({ lines: before })), { type: 'status', status: 'reconnecting' }, frame(hello({ lines: [L('3', 30), L('4', 40), L('5', 50)] }))]);
    expect(ids(s)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('lines inside the snapshot window that the snapshot lacks are gone (the viewer muted their author while away)', () => {
    const s = run([frame(hello({ lines: [L('1', 10), L('2', 20), L('3', 30)] })), frame(hello({ lines: [L('1', 10), L('3', 30), L('4', 40)] }))]);
    expect(ids(s)).toEqual(['1', '3', '4']);
  });

  it('an empty snapshot keeps what was there', () => {
    const s = run([frame(hello({ lines: [L('1', 10), L('2', 20)] })), frame(hello({ lines: [] }))]);
    expect(ids(s)).toEqual(['1', '2']);
  });

  it('a line with the same time as the snapshot start but a lower id is older, and survives', () => {
    const s = run([frame(hello({ lines: [L('8', 50), L('9', 50)] })), frame(hello({ lines: [L('9', 50), L('10', 60)] }))]);
    expect(ids(s)).toEqual(['8', '9', '10']);
  });

  it('reconnect does not reorder or duplicate', () => {
    const s = run([
      frame(hello({ lines: [L('1', 10), L('2', 20)] })),
      frame({ type: 'line', line: L('3', 30) }),
      frame(hello({ lines: [L('2', 20), L('3', 30)] })),
      frame({ type: 'line', line: L('4', 40) }),
    ]);
    expect(ids(s)).toEqual(['1', '2', '3', '4']);
  });
});

describe('hide removes by id; state replaces restriction and muted', () => {
  it('hide removes those ids and no others', () => {
    const s = run([frame(hello({ lines: [L('1', 1), L('2', 2), L('3', 3)] })), frame({ type: 'hide', ids: ['1', '3', 'nope'] })]);
    expect(ids(s)).toEqual(['2']);
  });

  it('hide of nothing present returns the same state', () => {
    const s1 = run([frame(hello({ lines: [L('1', 1)] }))]);
    expect(chatReducer(s1, frame({ type: 'hide', ids: ['9'] }))).toBe(s1);
    expect(chatReducer(s1, frame({ type: 'hide', ids: [] }))).toBe(s1);
  });

  it('state replaces restriction and muted, and leaves lines alone', () => {
    const s = run([
      frame(hello({ lines: [L('1', 1)], muted: [{ ref: 'a', name: 'x' }] })),
      frame({ type: 'state', restriction: { until: 99, byModerator: true }, muted: [{ ref: 'b', name: 'y' }, { ref: 'c', name: 'z' }] }),
    ]);
    expect(s.restriction).toEqual({ until: 99, byModerator: true });
    expect(s.muted).toEqual([{ ref: 'b', name: 'y' }, { ref: 'c', name: 'z' }]);
    expect(ids(s)).toEqual(['1']);
    const cleared = chatReducer(s, frame({ type: 'state', restriction: null, muted: [] }));
    expect(cleared.restriction).toBeNull();
    expect(cleared.muted).toEqual([]);
  });

  it('a notices frame changes nothing', () => {
    const s1 = run([frame(hello())]);
    expect(chatReducer(s1, frame({ type: 'notices' }))).toBe(s1);
  });
});

describe('the cap drops the oldest', () => {
  it('keeps the newest maxLines when a snapshot is larger', () => {
    const lines = Array.from({ length: 10 }, (_v, i) => L(String(i + 1), i + 1));
    const s = run([frame(hello({ lines }))], createChatState(4));
    expect(ids(s)).toEqual(['7', '8', '9', '10']);
  });

  it('keeps the newest maxLines as lines stream in', () => {
    const s = run([frame(hello()), ...Array.from({ length: 6 }, (_v, i) => frame({ type: 'line', line: L(String(i + 1), i + 1) }))], createChatState(3));
    expect(ids(s)).toEqual(['4', '5', '6']);
  });

  it('a line older than everything kept, when full, is not added', () => {
    const s = run([frame(hello({ lines: [L('5', 50), L('6', 60)] })), frame({ type: 'line', line: L('1', 10) })], createChatState(2));
    expect(ids(s)).toEqual(['5', '6']);
  });

  it('the default cap is 200', () => {
    const lines = Array.from({ length: 250 }, (_v, i) => L(String(i + 1), i + 1));
    const s = run([frame(hello({ lines }))]);
    expect(s.lines).toHaveLength(200);
    expect(s.lines[0]?.id).toBe('51');
  });

  it('setMaxLines lowers the cap and trims at once', () => {
    const s = run([frame(hello({ lines: [L('1', 1), L('2', 2), L('3', 3)] })), { type: 'maxLines', maxLines: 2 }]);
    expect(ids(s)).toEqual(['2', '3']);
    expect(s.maxLines).toBe(2);
  });

  it('a cap below 1 or not a number is ignored', () => {
    const s1 = run([frame(hello({ lines: [L('1', 1)] }))]);
    expect(chatReducer(s1, { type: 'maxLines', maxLines: 0 })).toBe(s1);
    expect(chatReducer(s1, { type: 'maxLines', maxLines: Number.NaN })).toBe(s1);
  });
});

describe('ordering by at then numeric id, with ids that sort wrongly as strings ("9" before "10")', () => {
  it('"9" comes before "10" at the same time', () => {
    const s = run([frame(hello({ lines: [L('10', 5), L('9', 5), L('100', 5), L('2', 5)] }))]);
    expect(ids(s)).toEqual(['2', '9', '10', '100']);
  });

  it('at wins over id', () => {
    const s = run([frame(hello({ lines: [L('1', 30), L('99', 10), L('50', 20)] }))]);
    expect(ids(s)).toEqual(['99', '50', '1']);
  });

  it('a late-arriving older line lands in its place', () => {
    const s = run([frame(hello({ lines: [L('1', 10), L('3', 30)] })), frame({ type: 'line', line: L('2', 20) })]);
    expect(ids(s)).toEqual(['1', '2', '3']);
  });

  it('ids longer than a safe integer still order numerically', () => {
    const big1 = '9007199254740993';
    const big2 = '9007199254740994';
    const s = run([frame(hello({ lines: [L(big2, 5), L(big1, 5), L('99', 5)] }))]);
    expect(ids(s)).toEqual(['99', big1, big2]);
  });

  it('leading zeros do not change the order', () => {
    const s = run([frame(hello({ lines: [L('010', 5), L('9', 5)] }))]);
    expect(ids(s)).toEqual(['9', '010']);
  });

  it('a non-numeric id sorts after numeric ones at the same time, deterministically', () => {
    const s = run([frame(hello({ lines: [L('b', 5), L('7', 5), L('a', 5)] }))]);
    expect(ids(s)).toEqual(['7', 'a', 'b']);
  });

  it('the result is the same whatever order lines arrive in', () => {
    const all = [L('1', 1), L('2', 2), L('9', 2), L('10', 2), L('11', 3)];
    const forward = run([frame(hello()), ...all.map((l) => frame({ type: 'line', line: l }))]);
    const backward = run([frame(hello()), ...[...all].reverse().map((l) => frame({ type: 'line', line: l }))]);
    expect(ids(forward)).toEqual(ids(backward));
    expect(ids(forward)).toEqual(['1', '2', '9', '10', '11']);
  });
});

describe('status, bye and closing', () => {
  it('bye banned closes with why and until', () => {
    const s = run([frame(hello({ lines: [L('1', 1)] })), frame({ type: 'bye', reason: 'banned', until: 12345 })]);
    expect(s.closed).toEqual({ why: 'banned', until: 12345 });
    expect(s.status).toBe('closed');
    expect(ids(s)).toEqual(['1']);
  });

  it('bye room_closed and shutdown', () => {
    expect(run([frame(hello()), frame({ type: 'bye', reason: 'room_closed' })]).closed).toEqual({ why: 'room_closed' });
    expect(run([frame(hello()), frame({ type: 'bye', reason: 'shutdown' })]).closed).toEqual({ why: 'shutdown' });
  });

  it('bye banned with a null until keeps the null', () => {
    expect(run([frame(hello()), frame({ type: 'bye', reason: 'banned', until: null })]).closed).toEqual({ why: 'banned', until: null });
  });

  it('the transport\'s closed status after a bye keeps the until', () => {
    const s = run([frame(hello()), frame({ type: 'bye', reason: 'banned', until: 7 }), { type: 'status', status: 'closed', why: 'banned' }]);
    expect(s.closed).toEqual({ why: 'banned', until: 7 });
    expect(s.status).toBe('closed');
  });

  it('closed with unauthorized and forbidden carry the why', () => {
    expect(run([{ type: 'status', status: 'closed', why: 'unauthorized' }]).closed).toEqual({ why: 'unauthorized' });
    expect(run([{ type: 'status', status: 'closed', why: 'forbidden' }]).closed).toEqual({ why: 'forbidden' });
  });

  it('a closed status with no why sets the status only', () => {
    const s = run([{ type: 'status', status: 'closed' }]);
    expect(s.status).toBe('closed');
    expect(s.closed).toBeNull();
  });

  it('connecting, reconnecting and open set the status and keep the lines', () => {
    const s = run([frame(hello({ lines: [L('1', 1)] })), { type: 'status', status: 'reconnecting' }]);
    expect(s.status).toBe('reconnecting');
    expect(s.ready).toBe(true);
    expect(ids(s)).toEqual(['1']);
    expect(run([{ type: 'status', status: 'connecting' }]).status).toBe('connecting');
  });

  it('a status that is already current returns the same state', () => {
    const s = run([frame(hello())]);
    expect(chatReducer(s, { type: 'status', status: 'open' })).toBe(s);
  });

  it('reset returns to a clean state and keeps the cap', () => {
    const s = run([frame(hello({ lines: [L('1', 1)] })), { type: 'reset' }], createChatState(7));
    expect(s).toEqual(createChatState(7));
    expect(s.ready).toBe(false);
  });
});
