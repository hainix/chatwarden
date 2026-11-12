import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ReportRefusal } from '@chatwarden/core';
import { HEARTBEAT, encodeFrame } from '../src/chat/sse.js';
import { CHAT_WIRE_VERSION, refusalOf } from '../src/chat/wire.js';
import type { ChatFrame, MuteTarget, ReportOutcome, SendResult, WireLine, WireMuted, WireRefusal, WireRestriction } from '../src/chat/wire.js';

const line: WireLine = { id: '41', at: 1_800_000_001_000, name: 'tarvo', text: 'anyone for a round?' };

const FRAMES: ChatFrame[] = [
  {
    type: 'hello',
    v: 1,
    epoch: 'k7f2q9',
    room: 'lobby',
    you: { name: 'snerp' },
    maxLength: 200,
    heartbeatMs: 20_000,
    summary: 'Trash talk is part of the game.',
    restriction: null,
    lines: [line],
    muted: [{ ref: 'm_1', name: 'zorbak' }],
  },
  { type: 'line', line: { ...line, mine: true } },
  { type: 'hide', ids: ['3', '4'] },
  { type: 'state', restriction: { until: null, byModerator: true }, muted: [] },
  { type: 'notices' },
  { type: 'bye', reason: 'banned', until: 1_800_003_600_000 },
  { type: 'bye', reason: 'room_closed' },
];

/** Split an encoded event into its physical lines. */
const physical = (s: string): string[] => s.split('\n');

describe('encodeFrame', () => {
  it('one event line, one data line, a blank line, for each frame type', () => {
    for (const frame of FRAMES) {
      const out = encodeFrame(frame);
      const parts = physical(out);
      // event, data, '', '' (the text ends with two newlines)
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe(`event: ${frame.type}`);
      expect(parts[1]?.startsWith('data: ')).toBe(true);
      expect(parts[2]).toBe('');
      expect(parts[3]).toBe('');
      expect(out.endsWith('\n\n')).toBe(true);
      expect(JSON.parse((parts[1] as string).slice('data: '.length))).toEqual(frame);
    }
  });

  it('the data repeats the type so a reader that ignores the event name still works', () => {
    expect(encodeFrame({ type: 'notices' })).toBe('event: notices\ndata: {"type":"notices"}\n\n');
  });

  it('matches the documented hello example', () => {
    const out = encodeFrame(FRAMES[0] as ChatFrame);
    expect(
      out.startsWith('event: hello\ndata: {"type":"hello","v":1,"epoch":"k7f2q9","room":"lobby","you":{"name":"snerp"},"maxLength":200,'),
    ).toBe(true);
  });

  it('a text of newline, carriage return, U+2028 and U+2029 never splits the event', () => {
    // LF, CR, CRLF, U+2028, U+2029 and U+0085 (NEL), each between letters
    const seps = [10, 13, 0x2028, 0x2029, 0x85].map((c) => String.fromCharCode(c));
    const text = `a${seps.join('b')}c${String.fromCharCode(13, 10)}d`;
    const out = encodeFrame({ type: 'line', line: { ...line, text } });
    const parts = physical(out);
    expect(parts).toHaveLength(4);
    expect(out).not.toMatch(/\r/);
    // exactly one blank-line terminator, at the very end
    expect(out.indexOf('\n\n')).toBe(out.length - 2);
    const back = JSON.parse((parts[1] as string).slice(6)) as { line: WireLine };
    expect(back.line.text).toBe(text);
  });

  it('a name with a newline or a colon cannot forge a second event or field', () => {
    const name = 'x\nevent: bye\ndata: {"type":"bye"}\n\n';
    const out = encodeFrame({ type: 'line', line: { ...line, name } });
    expect(physical(out)).toHaveLength(4);
    expect(out.match(/^event: /gm)).toHaveLength(1);
  });

  it('a 200 character line and an emoji-only line round-trip through JSON.parse of the data line', () => {
    for (const text of ['x'.repeat(200), '\u{1F600}\u{1F680}\u{1F9D1}' + String.fromCharCode(0x200d) + '\u{1F680}', '', '"\\\\ quotes </script>']) {
      const out = encodeFrame({ type: 'line', line: { ...line, text } });
      const data = (physical(out)[1] as string).slice('data: '.length);
      expect((JSON.parse(data) as { line: WireLine }).line.text).toBe(text);
    }
  });

  it('U+2028 and U+2029 are escaped in the data line, so a reader that splits on them stays safe', () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const out = encodeFrame({ type: 'line', line: { ...line, text: `a${ls}b${ps}c` } });
    expect(out.includes(ls) || out.includes(ps)).toBe(false);
    expect(out).toContain('a'+String.fromCharCode(92)+'u2028b'+String.fromCharCode(92)+'u2029c');
  });

  it('a lone surrogate stays one well-formed data line, never a broken event', () => {
    const out = encodeFrame({ type: 'line', line: { ...line, text: 'a\uD800b' } });
    expect(physical(out)).toHaveLength(4);
    expect(() => JSON.parse((physical(out)[1] as string).slice(6))).not.toThrow();
  });
});

describe('HEARTBEAT', () => {
  it('heartbeat is a comment and starts with a colon', () => {
    expect(HEARTBEAT).toBe(': ping\n\n');
    expect(HEARTBEAT.startsWith(':')).toBe(true);
    expect(HEARTBEAT.endsWith('\n\n')).toBe(true);
    expect(HEARTBEAT).not.toMatch(/^(event|data|id|retry):/m);
  });
});

describe('CHAT_WIRE_VERSION', () => {
  it('is 1 and is what hello carries', () => {
    expect(CHAT_WIRE_VERSION).toBe(1);
    expect((FRAMES[0] as { v: number }).v).toBe(CHAT_WIRE_VERSION);
  });
});

describe('refusalOf', () => {
  it('refusalOf copies the six fields and nothing else', () => {
    const hostile = {
      reason: 'restricted',
      until: 1_800_003_600_000,
      byModerator: true,
      rule: 4,
      noticeId: 'n_9c1',
      retryAfterMs: 1500,
      text: 'zorbak vlemmo',
      seat: 's_1',
      subject: 'sub_1',
      handle: 'tarvo',
      note: 'moderator note',
    } as Record<string, unknown>;
    Object.defineProperty(hostile, '__proto__', { value: { polluted: true }, enumerable: true });
    const out = refusalOf(hostile);
    expect(out).toEqual({
      reason: 'restricted',
      until: 1_800_003_600_000,
      byModerator: true,
      rule: 4,
      noticeId: 'n_9c1',
      retryAfterMs: 1500,
    });
    expect(Object.keys(out).sort()).toEqual(['byModerator', 'noticeId', 'reason', 'retryAfterMs', 'rule', 'until']);
    expect(JSON.stringify(out)).not.toMatch(/zorbak|s_1|sub_1|tarvo|moderator note|polluted/);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('a bare reason gives a bare refusal', () => {
    expect(refusalOf({ reason: 'blocked' })).toEqual({ reason: 'blocked' });
    expect(refusalOf({ reason: 'blocked', rule: 1 })).toEqual({ reason: 'blocked', rule: 1 });
  });

  it('refusalOf: retryAfterMs 0, -1, 1.5, "3", NaN, Infinity and 3600001 are dropped; 1 and 3600000 are kept', () => {
    for (const bad of [0, -1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 3_600_001, null, undefined, {}, [], true]) {
      expect(refusalOf({ reason: 'slow_mode', retryAfterMs: bad })).toEqual({ reason: 'slow_mode' });
    }
    expect(refusalOf({ reason: 'slow_mode', retryAfterMs: 1 })).toEqual({ reason: 'slow_mode', retryAfterMs: 1 });
    expect(refusalOf({ reason: 'slow_mode', retryAfterMs: 3_600_000 })).toEqual({ reason: 'slow_mode', retryAfterMs: 3_600_000 });
  });

  it('until is kept only as a finite number or null', () => {
    expect(refusalOf({ reason: 'restricted', until: null })).toEqual({ reason: 'restricted', until: null });
    expect(refusalOf({ reason: 'restricted', until: 0 })).toEqual({ reason: 'restricted', until: 0 });
    for (const bad of ['5', Number.NaN, Number.POSITIVE_INFINITY, undefined, {}, [], true]) {
      expect(refusalOf({ reason: 'restricted', until: bad })).toEqual({ reason: 'restricted' });
    }
  });

  it('byModerator is kept only as a boolean', () => {
    expect(refusalOf({ reason: 'restricted', byModerator: false })).toEqual({ reason: 'restricted', byModerator: false });
    for (const bad of ['true', 1, 0, null, undefined]) {
      expect(refusalOf({ reason: 'restricted', byModerator: bad })).toEqual({ reason: 'restricted' });
    }
  });

  it('rule is kept only as a positive whole number', () => {
    expect(refusalOf({ reason: 'blocked', rule: 12 })).toEqual({ reason: 'blocked', rule: 12 });
    for (const bad of [0, -3, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(refusalOf({ reason: 'blocked', rule: bad })).toEqual({ reason: 'blocked' });
    }
  });

  it('noticeId is kept only as a string of at most 64 characters', () => {
    const ok = 'n'.repeat(64);
    expect(refusalOf({ reason: 'restricted', noticeId: ok })).toEqual({ reason: 'restricted', noticeId: ok });
    for (const bad of ['n'.repeat(65), 7, null, {}, undefined]) {
      expect(refusalOf({ reason: 'restricted', noticeId: bad })).toEqual({ reason: 'restricted' });
    }
  });

  it('refusalOf: an unknown reason string is kept as a string; a non-string reason becomes "unknown"', () => {
    expect(refusalOf({ reason: 'some_future_reason' })).toEqual({ reason: 'some_future_reason' });
    for (const bad of [undefined, null, 5, {}, [], true, Symbol('x')]) {
      expect(refusalOf({ reason: bad })).toEqual({ reason: 'unknown' });
    }
    expect(refusalOf({})).toEqual({ reason: 'unknown' });
  });

  it('a reason longer than 64 characters (the most a client reads) is "unknown": a custom refusal cannot smuggle text through it', () => {
    expect(refusalOf({ reason: 'r'.repeat(64) })).toEqual({ reason: 'r'.repeat(64) });
    expect(refusalOf({ reason: 'r'.repeat(65) })).toEqual({ reason: 'unknown' });
    expect(refusalOf({ reason: 'you said: ' + 'x'.repeat(200), rule: 2 })).toEqual({ reason: 'unknown', rule: 2 });
    expect(refusalOf({ reason: '' })).toEqual({ reason: '' });
  });

  it('refusalOf never throws for null, a number, an array or a getter that throws', () => {
    for (const bad of [null, undefined, 7, 'text', [], [1, 2], true, () => 1, Symbol('s')]) {
      expect(refusalOf(bad)).toEqual({ reason: 'unknown' });
    }
    const getters = {
      get reason(): string {
        throw new Error('boom: zorbak');
      },
      get until(): number {
        throw new Error('boom');
      },
    };
    expect(refusalOf(getters)).toEqual({ reason: 'unknown' });
    const partly = {
      reason: 'rate',
      get rule(): number {
        throw new Error('boom');
      },
      retryAfterMs: 2000,
    };
    expect(refusalOf(partly)).toEqual({ reason: 'rate', retryAfterMs: 2000 });
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        has() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
      },
    );
    expect(refusalOf(proxy)).toEqual({ reason: 'unknown' });
  });

  it('refusalOf does not read inherited fields', () => {
    const inherited = Object.create({ reason: 'blocked', rule: 3 }) as unknown;
    expect(refusalOf(inherited)).toEqual({ reason: 'unknown' });
  });
});

describe('the wire types', () => {
  it('the wire types compile as documented', () => {
    expectTypeOf<SendResult>().toEqualTypeOf<{ ok: true; line: WireLine } | { ok: false; refused: WireRefusal }>();
    expectTypeOf<MuteTarget>().toEqualTypeOf<{ lineId: string } | { ref: string }>();
    expectTypeOf<ReportOutcome>().toEqualTypeOf<
      { ok: true; remaining: number } | { ok: false; refused: ReportRefusal | 'not_found'; remaining?: number }
    >();
    expectTypeOf<WireRestriction>().toEqualTypeOf<{ until: number | null; byModerator: boolean }>();
    expectTypeOf<WireMuted>().toEqualTypeOf<{ ref: string; name: string }>();
    expectTypeOf<WireLine['mine']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<typeof CHAT_WIRE_VERSION>().toEqualTypeOf<1>();
    expectTypeOf<typeof HEARTBEAT>().toBeString();
    expectTypeOf(encodeFrame).parameters.toEqualTypeOf<[ChatFrame]>();
    expectTypeOf(encodeFrame).returns.toBeString();
    expectTypeOf(refusalOf).returns.toEqualTypeOf<WireRefusal>();
  });

  it('ChatFrame narrows on type', () => {
    const f = FRAMES[0] as ChatFrame;
    if (f.type === 'hello') {
      expectTypeOf(f.v).toEqualTypeOf<1>();
      expectTypeOf(f.lines).toEqualTypeOf<WireLine[]>();
      expectTypeOf(f.restriction).toEqualTypeOf<WireRestriction | null>();
    }
    const g = { type: 'bye', reason: 'shutdown' } as ChatFrame;
    if (g.type === 'bye') expectTypeOf(g.reason).toEqualTypeOf<'banned' | 'room_closed' | 'shutdown'>();
    if (g.type === 'line') expectTypeOf(g.line).toEqualTypeOf<WireLine>();
    if (g.type === 'hide') expectTypeOf(g.ids).toEqualTypeOf<string[]>();
    expect(FRAMES.map((x) => x.type)).toEqual(['hello', 'line', 'hide', 'state', 'notices', 'bye', 'bye']);
  });
});
