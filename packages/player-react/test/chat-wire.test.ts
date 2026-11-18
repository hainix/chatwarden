import { describe, expect, expectTypeOf, it } from 'vitest';
import { CHAT_WIRE_VERSION as HTTP_VERSION, encodeFrame } from '@chatwarden/http';
import type {
  ChatFrame as HttpFrame,
  MuteResult as HttpMuteResult,
  MuteTarget as HttpMuteTarget,
  ReportOutcome as HttpReportOutcome,
  SendResult as HttpSendResult,
  WireLine as HttpLine,
  WireMuted as HttpMuted,
  WireRefusal as HttpRefusal,
  WireRestriction as HttpRestriction,
} from '@chatwarden/http';
import { CHAT_WIRE_VERSION, readFrame, readLine, readMuteResult, readRefusal } from '../src/chat/wire.js';
import type { ChatFrame, MuteResult, MuteTarget, SendResult, WireLine, WireMuted, WireRefusal, WireRestriction } from '../src/chat/wire.js';
import { createSseParser } from '../src/chat/sse.js';

const line = (over: Partial<WireLine> = {}): WireLine => ({ id: '41', at: 1_800_000_001_000, name: 'tarvo', text: 'anyone for a round?', ...over });
const hello = (over: Record<string, unknown> = {}): ChatFrame =>
  ({
    type: 'hello',
    v: 2,
    mode: { kind: 'normal', until: null },
    epoch: 'k7f2q9',
    room: 'lobby',
    you: { name: 'snerp' },
    maxLength: 200,
    heartbeatMs: 20_000,
    summary: 'Trash talk is part of the game.',
    restriction: null,
    lines: [line()],
    muted: [],
    phrases: null,
    ...over,
  }) as ChatFrame;

/** One frame as the server writes it on the stream (section 7): the real encoder of `@chatwarden/http`. */
const encode = (frame: ChatFrame): string => encodeFrame(frame);
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
    expectTypeOf<MuteResult>().toEqualTypeOf<HttpMuteResult>();
    expectTypeOf<ChatFrame>().toExtend<HttpFrame>();
    expectTypeOf<HttpFrame>().toExtend<ChatFrame>();
    expectTypeOf<SendResult>().toExtend<HttpSendResult>();
    expectTypeOf<HttpSendResult>().toExtend<SendResult>();
    expectTypeOf<HttpReportOutcome>().not.toBeAny();
  });

  it('the version is the same number on both sides', () => {
    expect(CHAT_WIRE_VERSION).toBe(HTTP_VERSION);
    expect(CHAT_WIRE_VERSION).toBe(2);
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
    { type: 'state', restriction: null, muted: [{ ref: 'b1', name: 'tarvo', block: true }, { ref: 'm2', name: 'quissel' }] },
    hello({ muted: [{ ref: 'b2', name: 'fenrisk', block: true }] }),
    { type: 'notices' },
    { type: 'bye', reason: 'banned', until: 1_800_000_000_000 },
    { type: 'bye', reason: 'banned', until: null },
    { type: 'bye', reason: 'room_closed' },
    { type: 'bye', reason: 'shutdown' },
    { type: 'bye', reason: 'replaced' },
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
    ['hello from a newer wire version', { ...hello(), v: 3 }],
    ['hello from an older wire version', { ...hello(), v: 1 }],
    ['hello with no mode', { ...hello(), mode: undefined }],
    ['hello with a mode of an unknown kind', { ...hello(), mode: { kind: 'frozen', until: null } }],
    ['mode frame with no mode', { type: 'mode' }],
    ['mode frame with an until that is a string', { type: 'mode', mode: { kind: 'locked', until: 'soon' } }],
    ['retract frame with ids not an array', { type: 'retract', ids: '3' }],
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

  it('now, the server clock, is kept when it is a finite number and left out otherwise', () => {
    expect(readFrame({ ...hello(), now: 1_800_000_000_000 })).toEqual({ ...hello(), now: 1_800_000_000_000 });
    for (const bad of ['soon', null, Number.NaN, Number.POSITIVE_INFINITY, -1, {}]) expect(readFrame({ ...hello(), now: bad }), String(bad)).toEqual(hello());
    expect(readFrame(hello())).not.toHaveProperty('now');
  });

  it('a hello with no heartbeatMs (an older server) gets the default 20 s', () => {
    const raw: Record<string, unknown> = { ...hello() };
    delete raw.heartbeatMs;
    expect(readFrame(raw)).toEqual(hello());
  });

  it('an unusable heartbeatMs (a string, 0, 1.5, negative, huge, NaN) is the default, not a dropped frame', () => {
    for (const bad of ['20000', 0, 1.5, -5, 3_600_001, Number.NaN, null]) expect(readFrame({ ...hello(), heartbeatMs: bad }), String(bad)).toEqual(hello());
    expect(readFrame({ ...hello(), heartbeatMs: 60_000 })).toEqual(hello({ heartbeatMs: 60_000 }));
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
      '{"type":"hello","v":2,"mode":{"kind":"normal","until":null},"epoch":"e","room":"r","maxLength":200,"summary":"s","restriction":{"until":null,"byModerator":false,"__proto__":{"polluted":true}},' +
      '"you":{"name":"snerp","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}},' +
      '"lines":[{"id":"1","at":1,"name":"a","text":"b","__proto__":{"polluted":true},"constructor":"x"}],"muted":[{"ref":"r","name":"n","__proto__":{"polluted":true}}],' +
      '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}';
    const out = readFrame(JSON.parse(text) as unknown);
    if (out?.type !== 'hello') throw new Error('expected a hello');
    expect(polluted()).toBe(false);
    expect(Object.keys(out).sort()).toEqual(['epoch', 'heartbeatMs', 'lines', 'maxLength', 'mode', 'muted', 'phrases', 'restriction', 'room', 'summary', 'type', 'v', 'you']);
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
      expect(readFrame({ type: 'hello', v: 2, mode: { kind: 'normal', until: null }, room: 'r', you: { name: 'a' }, maxLength: 200, summary: 's', restriction: null, lines: [], muted: [] })).toBeNull();
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

describe('blocks on the wire (M4)', () => {
  it('a muted entry keeps block true and drops anything else a server might send as block', () => {
    const out = readFrame(hello({ muted: [{ ref: 'a', name: 'x', block: true }, { ref: 'b', name: 'y', block: false }, { ref: 'c', name: 'z', block: 1 }, { ref: 'd', name: 'w', block: 'true' }, { ref: 'e', name: 'v' }] }));
    expect(out).toMatchObject({ type: 'hello' });
    if (out === null || out.type !== 'hello') throw new Error('not a hello');
    expect(out.muted).toEqual([{ ref: 'a', name: 'x', block: true }, { ref: 'b', name: 'y' }, { ref: 'c', name: 'z' }, { ref: 'd', name: 'w' }, { ref: 'e', name: 'v' }]);
    expect(Object.keys(out.muted[1] as object)).toEqual(['ref', 'name']);
  });

  it('a state frame reads block the same way', () => {
    const out = readFrame({ type: 'state', restriction: null, muted: [{ ref: 'a', name: 'x', block: true }, { ref: 'b', name: 'y' }] });
    expect(out).toEqual({ type: 'state', restriction: null, muted: [{ ref: 'a', name: 'x', block: true }, { ref: 'b', name: 'y' }] });
  });

  it('a mute result reads limit true, and only true', () => {
    expect(readMuteResult({ ok: false, hiddenIds: [], limit: true })).toEqual({ ok: false, hiddenIds: [], limit: true });
    expect(readMuteResult({ ok: true, hiddenIds: ['1'] })).toEqual({ ok: true, hiddenIds: ['1'] });
    expect(readMuteResult({ ok: false, hiddenIds: [], limit: false })).toEqual({ ok: false, hiddenIds: [] });
    expect(readMuteResult({ ok: false, hiddenIds: [], limit: 'yes' })).toEqual({ ok: false, hiddenIds: [] });
  });

  it('the wire version is 2 on both sides and the two WireMuted types carry the same optional block', () => {
    expect(CHAT_WIRE_VERSION).toBe(HTTP_VERSION);
    expectTypeOf<WireMuted>().toEqualTypeOf<HttpMuted>();
    expectTypeOf<WireMuted['block']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<MuteResult['limit']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<HttpMuteResult['limit']>().toEqualTypeOf<true | undefined>();
  });
});

// M5: phrase-only rooms. `WireLine.phrase`, `hello.phrases` (`{ book: [{ id, text, group? }] }` or null) and the refusal reasons `phrases_only`, `phrase_unknown`, `account_too_new`.
describe('phrases on the wire (M5)', () => {
  const BOOK = [
    { id: 'gg', text: 'Good game!' },
    { id: 'help', text: 'Can you help me?', group: 'Ask' },
  ];

  it('the two copies agree on the new members', () => {
    expectTypeOf<WireLine['phrase']>().toEqualTypeOf<HttpLine['phrase']>();
    expectTypeOf<WireLine['phrase']>().toEqualTypeOf<string | undefined>();
    type Hello = Extract<ChatFrame, { type: 'hello' }>;
    type HttpHello = Extract<HttpFrame, { type: 'hello' }>;
    expectTypeOf<Hello['phrases']>().toEqualTypeOf<HttpHello['phrases']>();
    expectTypeOf<Hello['phrases']>().toEqualTypeOf<{ book: Array<{ id: string; text: string; group?: string }> } | null>();
  });

  it('a hello with a book and one with null round-trip through the real encoder', () => {
    const withBook = roundTrip(hello({ phrases: { book: BOOK } }));
    expect(withBook).toMatchObject({ type: 'hello', phrases: { book: BOOK } });
    expect(roundTrip(hello({ phrases: null }))).toMatchObject({ type: 'hello', phrases: null });
  });

  it('a hello with no phrases key reads as null (an older server), and a malformed one reads as null, never as a book', () => {
    for (const bad of [undefined, 7, 'gg', [], { book: 'gg' }, { book: {} }, { other: BOOK }]) {
      const frame = readFrame({ ...(hello() as object), phrases: bad });
      expect(frame, JSON.stringify(bad)).toMatchObject({ type: 'hello', phrases: null });
    }
  });

  it('book items are copied field by field: bad items are dropped, long text and groups are cut, ids must be tokens, unknown fields are left behind', () => {
    const frame = readFrame({
      ...(hello() as object),
      phrases: {
        book: [
          { id: 'ok', text: 'fine', group: 'G', extra: 'x' },
          { id: '', text: 'no id' },
          { id: 'a b', text: 'bad id' },
          { id: 'x'.repeat(33), text: 'long id' },
          { id: 'notext' },
          { id: 'num', text: 5 },
          null,
          'str',
          { id: 'cut', text: 't'.repeat(300), group: 'g'.repeat(100) },
          { id: 'g2', text: 'fine', group: 4 },
        ],
      },
    }) as Extract<ChatFrame, { type: 'hello' }>;
    const book = frame.phrases?.book ?? [];
    expect(book.map((p) => p.id)).toEqual(['ok', 'cut', 'g2']);
    expect(book[0]).toEqual({ id: 'ok', text: 'fine', group: 'G' });
    expect(book[1]!.text).toHaveLength(100);
    expect(book[1]!.group).toHaveLength(24);
    expect(Object.hasOwn(book[2]!, 'group')).toBe(false);
  });

  it('the book is capped at 300 phrases and a prototype-polluting key lands nowhere', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, text: `t${i}` }));
    const frame = readFrame({ ...(hello() as object), phrases: { book: many } }) as Extract<ChatFrame, { type: 'hello' }>;
    expect(frame.phrases?.book).toHaveLength(300);
    const polluted = JSON.parse('{"type":"hello","v":2,"epoch":"e","room":"r","you":{"name":"a"},"mode":{"kind":"normal","until":null},"maxLength":200,"summary":"","restriction":null,"lines":[],"muted":[],"phrases":{"book":[{"id":"a","text":"b","__proto__":{"x":1}}]}}') as unknown;
    const read = readFrame(polluted) as Extract<ChatFrame, { type: 'hello' }>;
    expect(({} as { x?: number }).x).toBeUndefined();
    expect(Object.keys(read.phrases?.book[0] ?? {})).toEqual(['id', 'text']);
  });

  it('a line keeps its phrase id when it is a token, and drops it otherwise', () => {
    expect(readLine({ id: '1', at: 1, name: 'a', text: 'Good game!', phrase: 'gg' })).toEqual({ id: '1', at: 1, name: 'a', text: 'Good game!', phrase: 'gg' });
    for (const bad of ['', 'a b', 'x'.repeat(33), 5, null, {}, ['gg']]) {
      const l = readLine({ id: '1', at: 1, name: 'a', text: 'hi', phrase: bad });
      expect(l, JSON.stringify(bad)).toEqual({ id: '1', at: 1, name: 'a', text: 'hi' });
    }
  });

  it('a line frame and a hello history line carry the phrase through the encoder', () => {
    const l = line({ phrase: 'gg', text: 'Good game!' });
    expect(roundTrip({ type: 'line', line: l })).toEqual({ type: 'line', line: l });
    const h = roundTrip(hello({ lines: [l], phrases: { book: BOOK } })) as Extract<ChatFrame, { type: 'hello' }>;
    expect(h.lines[0]).toEqual(l);
  });

  it('readRefusal keeps the three new reasons by name and nothing else', () => {
    for (const reason of ['phrases_only', 'phrase_unknown', 'account_too_new']) {
      expect(readRefusal({ reason, text: 'Good game!', seat: 's1' })).toEqual({ reason });
    }
  });
});
