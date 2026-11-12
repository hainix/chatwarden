import { describe, expect, expectTypeOf, it } from 'vitest';
import { CHAT_WIRE_VERSION as HTTP_VERSION } from '@chatwarden/http';
import type {
  ChatFrame as HttpFrame,
  MuteTarget as HttpMuteTarget,
  ReportOutcome as HttpReportOutcome,
  SendResult as HttpSendResult,
  WireLine as HttpLine,
  WireMuted as HttpMuted,
  WireRefusal as HttpRefusal,
  WireRestriction as HttpRestriction,
} from '@chatwarden/http';
import { CHAT_WIRE_VERSION, readFrame, readLine, readRefusal } from '../src/chat/wire.js';
import type { ChatFrame, MuteTarget, SendResult, WireLine, WireMuted, WireRefusal, WireRestriction } from '../src/chat/wire.js';
import { createSseParser } from '../src/chat/sse.js';

const line = (over: Partial<WireLine> = {}): WireLine => ({ id: '41', at: 1_800_000_001_000, name: 'tarvo', text: 'anyone for a round?', ...over });
const hello = (over: Record<string, unknown> = {}): ChatFrame =>
  ({
    type: 'hello',
    v: 1,
    epoch: 'k7f2q9',
    room: 'lobby',
    you: { name: 'snerp' },
    maxLength: 200,
    summary: 'Trash talk is part of the game.',
    restriction: null,
    lines: [line()],
    muted: [],
    ...over,
  }) as ChatFrame;

/** One frame as the server writes it on the stream (section 7). */
const encode = (frame: ChatFrame): string => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
/** The frame a client reads back from the text, the way sseTransport does. */
function roundTrip(frame: ChatFrame): ChatFrame | null {
  let out: ChatFrame | null | undefined;
  createSseParser((ev) => {
    out = readFrame(JSON.parse(ev.data) as unknown, ev.data.length);
  }).push(encode(frame));
  return out ?? null;
}

describe('the client types and the http types are assignable in both directions and CHAT_WIRE_VERSION is equal', () => {
  it('every wire type is the same type as the http one', () => {
    expectTypeOf<WireLine>().toEqualTypeOf<HttpLine>();
    expectTypeOf<WireRestriction>().toEqualTypeOf<HttpRestriction>();
    expectTypeOf<WireMuted>().toEqualTypeOf<HttpMuted>();
    expectTypeOf<WireRefusal>().toEqualTypeOf<HttpRefusal>();
    expectTypeOf<ChatFrame>().toEqualTypeOf<HttpFrame>();
    expectTypeOf<SendResult>().toEqualTypeOf<HttpSendResult>();
    expectTypeOf<MuteTarget>().toEqualTypeOf<HttpMuteTarget>();
    expectTypeOf<ChatFrame>().toExtend<HttpFrame>();
    expectTypeOf<HttpFrame>().toExtend<ChatFrame>();
    expectTypeOf<SendResult>().toExtend<HttpSendResult>();
    expectTypeOf<HttpSendResult>().toExtend<SendResult>();
    expectTypeOf<HttpReportOutcome>().not.toBeAny();
  });

  it('the version is the same number on both sides', () => {
    expect(CHAT_WIRE_VERSION).toBe(HTTP_VERSION);
    expect(CHAT_WIRE_VERSION).toBe(1);
  });

  it('the control: a frame type the other side lacks is not equal (the check can fail)', () => {
    type Narrower = Exclude<ChatFrame, { type: 'notices' }>;
    expectTypeOf<Narrower>().not.toEqualTypeOf<HttpFrame>();
  });
});

describe('readFrame accepts what encodeFrame writes, for every frame type', () => {
  const frames: ChatFrame[] = [
    hello(),
    hello({ restriction: { until: 1_800_003_600_000, byModerator: true }, muted: [{ ref: 'm1', name: 'quissel' }], lines: [line({ mine: true })] }),
    hello({ restriction: { until: null, byModerator: false }, lines: [] }),
    { type: 'line', line: line({ id: '42', text: 'gg' }) },
    { type: 'line', line: line({ id: '43', mine: true }) },
    { type: 'hide', ids: ['3', '4'] },
    { type: 'state', restriction: null, muted: [] },
    { type: 'state', restriction: { until: 5, byModerator: false }, muted: [{ ref: 'r', name: 'vlemmo' }] },
    { type: 'notices' },
    { type: 'bye', reason: 'banned', until: 1_800_000_000_000 },
    { type: 'bye', reason: 'banned', until: null },
    { type: 'bye', reason: 'room_closed' },
    { type: 'bye', reason: 'shutdown' },
  ];
  it.each(frames.map((f, i) => [`${f.type} #${i}`, f] as const))('%s', (_n, frame) => {
    expect(roundTrip(frame)).toEqual(frame);
  });

  it('covers all six frame types', () => {
    expect(new Set(frames.map((f) => f.type))).toEqual(new Set(['hello', 'line', 'hide', 'state', 'notices', 'bye']));
  });

  it('text with newlines, CR, U+2028 and quotes survives the stream', () => {
    const text = 'a\nb\rc d "e" \\f';
    expect(roundTrip({ type: 'line', line: line({ text }) })).toEqual({ type: 'line', line: line({ text }) });
  });
});

describe('unknown type, missing field, wrong type, array, null, string: null', () => {
  const boom = (): never => {
    throw new Error('boom');
  };
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'hello'],
    ['a number', 7],
    ['true', true],
    ['an array', [{ type: 'notices' }]],
    ['an empty object', {}],
    ['an unknown type', { type: 'confetti' }],
    ['a non-string type', { type: 7 }],
    ['a prototype-ish type', { type: 'constructor' }],
    ['hello without lines', { ...hello(), lines: undefined }],
    ['hello without epoch', { ...hello(), epoch: undefined }],
    ['hello with a numeric epoch', { ...hello(), epoch: 7 }],
    ['hello without room', { ...hello(), room: undefined }],
    ['hello with you as a string', { ...hello(), you: 'snerp' }],
    ['hello with you.name a number', { ...hello(), you: { name: 7 } }],
    ['hello with maxLength a string', { ...hello(), maxLength: '200' }],
    ['hello with maxLength 0', { ...hello(), maxLength: 0 }],
    ['hello with maxLength NaN', { ...hello(), maxLength: Number.NaN }],
    ['hello with maxLength 1.5', { ...hello(), maxLength: 1.5 }],
    ['hello with summary missing', { ...hello(), summary: undefined }],
    ['hello with restriction undefined', { ...hello(), restriction: undefined }],
    ['hello with restriction a string', { ...hello(), restriction: 'yes' }],
    ['hello with restriction.until a string', { ...hello(), restriction: { until: 'soon', byModerator: true } }],
    ['hello with restriction.byModerator missing', { ...hello(), restriction: { until: null } }],
    ['hello with lines an object', { ...hello(), lines: {} }],
    ['hello with muted missing', { ...hello(), muted: undefined }],
    ['hello from a newer wire version', { ...hello(), v: 2 }],
    ['hello with no version', { ...hello(), v: undefined }],
    ['line without line', { type: 'line' }],
    ['line with line null', { type: 'line', line: null }],
    ['line with a numeric id', { type: 'line', line: { ...line(), id: 42 } }],
    ['line with an empty id', { type: 'line', line: { ...line(), id: '' } }],
    ['line with at a string', { type: 'line', line: { ...line(), at: 'now' } }],
    ['line with at Infinity', { type: 'line', line: { ...line(), at: Number.POSITIVE_INFINITY } }],
    ['line with name missing', { type: 'line', line: { ...line(), name: undefined } }],
    ['line with text a number', { type: 'line', line: { ...line(), text: 3 } }],
    ['hide with ids a string', { type: 'hide', ids: '3' }],
    ['hide without ids', { type: 'hide' }],
    ['state without muted', { type: 'state', restriction: null }],
    ['state without restriction', { type: 'state', muted: [] }],
    ['bye with an unknown reason', { type: 'bye', reason: 'because' }],
    ['bye without a reason', { type: 'bye' }],
    ['bye with until a string', { type: 'bye', reason: 'banned', until: 'later' }],
  ])('%s', (_name, raw) => {
    expect(readFrame(raw)).toBeNull();
  });

  it('never throws for any JSON value, a getter that throws, or a revoked proxy', () => {
    const trap = new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const throwing = {
      get type(): string {
        return boom();
      },
    };
    for (const raw of [trap, proxy, throwing, Object.create(null), () => 1, Symbol('x'), 10n]) {
      expect(() => readFrame(raw)).not.toThrow();
      expect(readFrame(raw)).toBeNull();
    }
  });
});

describe('what a frame may carry', () => {
  it('ignores unknown fields and builds a fresh object', () => {
    const raw = { ...hello(), extra: 'x', lines: [{ ...line(), seat: 'S1', sneaky: 1 }], you: { name: 'snerp', account: 'a1' } };
    const out = readFrame(raw);
    expect(out).toEqual(hello({ lines: [line()] }));
    expect(out).not.toBe(raw);
    expect(JSON.stringify(out)).not.toMatch(/extra|sneaky|seat|account/);
  });

  it('ignores a `mine` that is not exactly true', () => {
    expect(readFrame({ type: 'line', line: { ...line(), mine: 'yes' } })).toEqual({ type: 'line', line: line() });
    expect(readFrame({ type: 'line', line: { ...line(), mine: false } })).toEqual({ type: 'line', line: line() });
    expect(readFrame({ type: 'line', line: { ...line(), mine: true } })).toEqual({ type: 'line', line: line({ mine: true }) });
  });

  it('drops a bad line or bad muted entry inside a good hello, keeping the rest', () => {
    const out = readFrame({ ...hello(), lines: [line({ id: '1' }), { id: 2 }, null, 'x', line({ id: '3' })], muted: [{ ref: 'r1', name: 'a' }, { ref: 1 }, null] });
    expect(out).toMatchObject({ type: 'hello', lines: [{ id: '1' }, { id: '3' }], muted: [{ ref: 'r1', name: 'a' }] });
  });

  it('hide keeps string ids and drops other values', () => {
    expect(readFrame({ type: 'hide', ids: ['1', 2, null, '3', ''] })).toEqual({ type: 'hide', ids: ['1', '3'] });
  });

  it('bye until is optional; a non-finite until is not a frame', () => {
    expect(readFrame({ type: 'bye', reason: 'shutdown' })).toEqual({ type: 'bye', reason: 'shutdown' });
    expect(readFrame({ type: 'bye', reason: 'banned', until: Number.NaN })).toBeNull();
  });
});

describe('an over-long name or text is cut, a 64 KiB frame is dropped', () => {
  it('cuts a name at 64 and a text at 1 000', () => {
    const out = readFrame({ type: 'line', line: line({ name: 'n'.repeat(500), text: 't'.repeat(5000) }) });
    if (out?.type !== 'line') throw new Error('expected a line');
    expect(out.line.name).toHaveLength(64);
    expect(out.line.text).toHaveLength(1000);
  });

  it('a name of exactly 64 and a text of exactly 1 000 are kept whole', () => {
    const out = readFrame({ type: 'line', line: line({ name: 'n'.repeat(64), text: 't'.repeat(1000) }) });
    if (out?.type !== 'line') throw new Error('expected a line');
    expect(out.line.name).toHaveLength(64);
    expect(out.line.text).toHaveLength(1000);
  });

  it('does not leave half a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(999)}\u{1F600}tail`;
    const out = readFrame({ type: 'line', line: line({ text }) });
    if (out?.type !== 'line') throw new Error('expected a line');
    expect(out.line.text).toBe('a'.repeat(999));
  });

  it('cuts you.name, a muted name and a hello line too', () => {
    const out = readFrame(hello({ you: { name: 'y'.repeat(100) }, muted: [{ ref: 'r', name: 'm'.repeat(100) }], lines: [line({ text: 'x'.repeat(2000), name: 'z'.repeat(100) })] }));
    if (out?.type !== 'hello') throw new Error('expected a hello');
    expect(out.you.name).toHaveLength(64);
    expect(out.muted[0]?.name).toHaveLength(64);
    expect(out.lines[0]?.text).toHaveLength(1000);
    expect(out.lines[0]?.name).toHaveLength(64);
  });

  it('drops a frame whose JSON text exceeded 64 KiB, keeps one at the limit, and keeps one when no length is given', () => {
    const f = { type: 'line', line: line() };
    expect(readFrame(f, 64 * 1024 + 1)).toBeNull();
    expect(readFrame(f, 64 * 1024)).toEqual(f);
    expect(readFrame(f, 10)).toEqual(f);
    expect(readFrame(f)).toEqual(f);
    expect(readFrame(f, Number.NaN)).toEqual(f);
  });

  it('an id longer than 64 characters is not a line id: the line is dropped', () => {
    expect(readFrame({ type: 'line', line: line({ id: '1'.repeat(65) }) })).toBeNull();
    expect(readFrame({ type: 'line', line: line({ id: '1'.repeat(64) }) })).not.toBeNull();
  });
});

describe('__proto__ and constructor keys in a frame do not pollute', () => {
  const polluted = (): boolean => ({} as Record<string, unknown>).polluted === true || Object.hasOwn(Object.prototype, 'polluted');

  it('JSON with __proto__, constructor and prototype keys at every depth lands nowhere', () => {
    const text =
      '{"type":"hello","v":1,"epoch":"e","room":"r","maxLength":200,"summary":"s","restriction":{"until":null,"byModerator":false,"__proto__":{"polluted":true}},' +
      '"you":{"name":"snerp","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}},' +
      '"lines":[{"id":"1","at":1,"name":"a","text":"b","__proto__":{"polluted":true},"constructor":"x"}],"muted":[{"ref":"r","name":"n","__proto__":{"polluted":true}}],' +
      '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}';
    const out = readFrame(JSON.parse(text) as unknown);
    if (out?.type !== 'hello') throw new Error('expected a hello');
    expect(polluted()).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['epoch', 'lines', 'maxLength', 'muted', 'restriction', 'room', 'summary', 'type', 'v', 'you']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    const l = out.lines[0] as WireLine;
    expect(Object.keys(l).sort()).toEqual(['at', 'id', 'name', 'text']);
    expect(Object.getPrototypeOf(l)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.you)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.restriction)).toBe(Object.prototype);
    expect(Object.keys(out.restriction ?? {}).sort()).toEqual(['byModerator', 'until']);
    expect(Object.getPrototypeOf(out.muted[0])).toBe(Object.prototype);
  });

  it('a type of "__proto__" or "constructor" is unknown', () => {
    expect(readFrame(JSON.parse('{"type":"__proto__"}') as unknown)).toBeNull();
    expect(readFrame(JSON.parse('{"type":"constructor","line":{}}') as unknown)).toBeNull();
  });

  it('a polluted Object.prototype is not read as a field', () => {
    (Object.prototype as Record<string, unknown>).epoch = 'inherited';
    try {
      expect(readFrame({ type: 'hello', v: 1, room: 'r', you: { name: 'a' }, maxLength: 200, summary: 's', restriction: null, lines: [], muted: [] })).toBeNull();
    } finally {
      delete (Object.prototype as Record<string, unknown>).epoch;
    }
  });
});

describe('readLine and readRefusal (the answer to a POST)', () => {
  it('readLine checks and cuts a line', () => {
    expect(readLine(line())).toEqual(line());
    expect(readLine({ ...line(), text: 'x'.repeat(2000) })?.text).toHaveLength(1000);
    expect(readLine(null)).toBeNull();
    expect(readLine({ id: '1' })).toBeNull();
  });

  it('readRefusal keeps the documented fields only', () => {
    expect(readRefusal({ reason: 'restricted', until: 5, byModerator: true, rule: 4, noticeId: 'n_9', retryAfterMs: 1500, text: 'leak', seat: 's' })).toEqual({
      reason: 'restricted',
      until: 5,
      byModerator: true,
      rule: 4,
      noticeId: 'n_9',
      retryAfterMs: 1500,
    });
    expect(readRefusal({ reason: 'blocked', rule: 1 })).toEqual({ reason: 'blocked', rule: 1 });
    expect(readRefusal({ reason: 'someday_new' })).toEqual({ reason: 'someday_new' });
  });

  it('drops a field of the wrong type and refuses a missing reason', () => {
    expect(readRefusal({ reason: 'slow_mode', retryAfterMs: 'soon', until: 'x', rule: '1', noticeId: 3, byModerator: 'yes' })).toEqual({ reason: 'slow_mode' });
    expect(readRefusal({ reason: 'slow_mode', retryAfterMs: 0 })).toEqual({ reason: 'slow_mode' });
    expect(readRefusal({ reason: 'slow_mode', retryAfterMs: 1.5 })).toEqual({ reason: 'slow_mode' });
    expect(readRefusal({ reason: 'slow_mode', retryAfterMs: -1 })).toEqual({ reason: 'slow_mode' });
    expect(readRefusal({ reason: 'slow_mode', retryAfterMs: 3_600_001 })).toEqual({ reason: 'slow_mode' });
    expect(readRefusal({ reason: 'slow_mode', retryAfterMs: 3_600_000 })).toEqual({ reason: 'slow_mode', retryAfterMs: 3_600_000 });
    expect(readRefusal({ reason: 'blocked', rule: 0 })).toEqual({ reason: 'blocked' });
    expect(readRefusal({ reason: 'blocked', rule: 2.5 })).toEqual({ reason: 'blocked' });
    expect(readRefusal({ reason: 'banned', until: null })).toEqual({ reason: 'banned', until: null });
    expect(readRefusal({})).toBeNull();
    expect(readRefusal(null)).toBeNull();
    expect(readRefusal({ reason: 7 })).toBeNull();
  });
});
