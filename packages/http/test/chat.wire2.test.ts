import { describe, expect, expectTypeOf, it } from 'vitest';
import { encodeFrame } from '../src/chat/sse.js';
import { CHAT_WIRE_VERSION, refusalOf } from '../src/chat/wire.js';
import type { ChatFrame, WireRefusal } from '../src/chat/wire.js';

// R3: chat wire version 2. `hello` gains `mode` and `you.readOnly`; new frames `mode` (per viewer) and `retract`; the refusal reasons `locked`, `new_account` (with `until`) and `probation` (with `retryAfterMs`).

describe('version 2', () => {
  it('CHAT_WIRE_VERSION is 2, and a hello typed with v 1 does not compile', () => {
    expect(CHAT_WIRE_VERSION).toBe(2);
    expectTypeOf<typeof CHAT_WIRE_VERSION>().toEqualTypeOf<2>();
    type Hello = Extract<ChatFrame, { type: 'hello' }>;
    expectTypeOf<Hello['v']>().toEqualTypeOf<2>();
    // @ts-expect-error a version 1 hello is not a ChatFrame any more
    const v1: Hello['v'] = 1;
    expect(v1).toBe(1);
  });

  it('hello carries mode { kind, until } and you.readOnly', () => {
    type Hello = Extract<ChatFrame, { type: 'hello' }>;
    expectTypeOf<Hello['mode']>().toEqualTypeOf<{ kind: 'normal' | 'locked' | 'emergency'; until: number | null }>();
    expectTypeOf<Hello['you']>().toEqualTypeOf<{ name: string; readOnly?: 'locked' | 'new_account' }>();
  });

  it('the mode and retract frames are in the union with their shapes', () => {
    expectTypeOf<Extract<ChatFrame, { type: 'mode' }>>().toEqualTypeOf<{
      type: 'mode';
      mode: { kind: 'normal' | 'locked' | 'emergency'; until: number | null };
      readOnly?: 'locked' | 'new_account';
    }>();
    expectTypeOf<Extract<ChatFrame, { type: 'retract' }>>().toEqualTypeOf<{ type: 'retract'; ids: string[] }>();
  });

  it('every new frame is one SSE event with its type as the event name', () => {
    const frames: ChatFrame[] = [
      { type: 'mode', mode: { kind: 'locked', until: 1_800_000_900_000 }, readOnly: 'locked' },
      { type: 'mode', mode: { kind: 'normal', until: null } },
      { type: 'retract', ids: ['3', '4'] },
    ];
    for (const frame of frames) {
      const out = encodeFrame(frame);
      expect(out.split('\n')).toHaveLength(4);
      expect(out.startsWith(`event: ${frame.type}\ndata: `)).toBe(true);
      expect(JSON.parse(out.split('\n')[1]!.slice('data: '.length))).toEqual(frame);
    }
  });
});

describe('WireRefusal and refusalOf', () => {
  it('accepts locked, new_account and probation (the reason is a string a reader tolerates)', () => {
    const refusals: WireRefusal[] = [
      { reason: 'locked', until: 1_800_000_900_000 },
      { reason: 'new_account', until: 1_800_000_900_000 },
      { reason: 'probation', retryAfterMs: 4000 },
    ];
    expect(refusals).toHaveLength(3);
  });

  it('refusalOf keeps until for the two mode reasons and retryAfterMs for probation, and drops unknown keys', () => {
    expect(refusalOf({ reason: 'locked', until: 1_800_000_900_000, seat: 'p1', handle: 'Tgt', text: 'zorbak' })).toEqual({ reason: 'locked', until: 1_800_000_900_000 });
    expect(refusalOf({ reason: 'new_account', until: 1_800_000_900_000, subject: 's_x', accountAgeDays: 1 })).toEqual({ reason: 'new_account', until: 1_800_000_900_000 });
    expect(refusalOf({ reason: 'probation', retryAfterMs: 4000, rule: undefined, key: 'k' })).toEqual({ reason: 'probation', retryAfterMs: 4000 });
  });

  it('a bad until or retryAfterMs is dropped, not repaired', () => {
    expect(refusalOf({ reason: 'locked', until: 'soon' })).toEqual({ reason: 'locked' });
    expect(refusalOf({ reason: 'probation', retryAfterMs: 0 })).toEqual({ reason: 'probation' });
    expect(refusalOf({ reason: 'probation', retryAfterMs: 1.5 })).toEqual({ reason: 'probation' });
    expect(refusalOf({ reason: 'locked', until: null })).toEqual({ reason: 'locked', until: null });
  });
});
