import { describe, expect, it } from 'vitest';
import { PACE_KEYS_MAX } from '../src/pace.js';
import type { ResolvedPace } from '../src/pace.js';
import { __pacerState, createPacer, normalizeForRepeat } from '../src/pacing.js';
import type { PaceKey, PaceVerdict } from '../src/pacing.js';

const T0 = 1_800_000_000_000;
const OFF: ResolvedPace = { slowModeMs: null, burst: null, duplicateWindowMs: null };

function setup(initial: Partial<ResolvedPace> = {}) {
  const clock = { t: T0, now: () => clock.t };
  const cfg = { pace: { ...OFF, ...initial } as ResolvedPace };
  const pacer = createPacer({ clock, settings: () => cfg.pace });
  const key: PaceKey = { roomId: 'R1', who: 'subject-one' };
  /** Check, and commit when accepted (what the chat path does when `rate` passes). */
  const send = (line: string, k: PaceKey = key): PaceVerdict => {
    const v = pacer.check(k, line);
    if (v.ok) pacer.commit(k, line);
    return v;
  };
  return { clock, cfg, pacer, key, send };
}

const refusal = (v: PaceVerdict) => {
  if (v.ok) throw new Error('expected a refusal');
  return v;
};

describe('slow_mode', () => {
  it('refused inside the gap with the exact retryAfterMs; accepted at exactly the gap; a refused line does not move lastAt', () => {
    const { clock, pacer, key, send } = setup({ slowModeMs: 2000 });
    expect(send('first line')).toEqual({ ok: true });
    clock.t = T0 + 500;
    expect(pacer.check(key, 'second line')).toEqual({ ok: false, reason: 'slow_mode', retryAfterMs: 1500, signalFlood: false });
    clock.t = T0 + 1999;
    expect(pacer.check(key, 'second line')).toEqual({ ok: false, reason: 'slow_mode', retryAfterMs: 1, signalFlood: false });
    // The refusals at +500 and +1999 did not move lastAt: exactly one gap after the first line is open.
    clock.t = T0 + 2000;
    expect(send('second line')).toEqual({ ok: true });
    clock.t = T0 + 2001;
    expect(refusal(pacer.check(key, 'third line')).retryAfterMs).toBe(1999);
  });

  it('another player in the same room, and the same player in another room, are unaffected', () => {
    const { pacer, key, send } = setup({ slowModeMs: 2000 });
    send('first line');
    expect(pacer.check({ roomId: 'R1', who: 'subject-two' }, 'hi there').ok).toBe(true);
    expect(pacer.check({ roomId: 'R2', who: key.who }, 'hi there').ok).toBe(true);
    expect(pacer.check(key, 'hi there').ok).toBe(false);
  });

  it('the first line of a player with no state is accepted, and check alone allocates nothing', () => {
    const { pacer, key } = setup({ slowModeMs: 2000, burst: { lines: 2, windowMs: 5000 }, duplicateWindowMs: 5000 });
    for (let i = 0; i < 50; i += 1) expect(pacer.check(key, 'anything at all').ok).toBe(true);
    expect(pacer.size()).toBe(0);
  });
});

describe('flood', () => {
  const burst = { lines: 3, windowMs: 10_000 };

  it('the (N+1)th line is refused with oldest + window - now; accepted once the oldest ages out', () => {
    const { clock, pacer, key, send } = setup({ burst });
    for (const dt of [0, 1000, 2000]) {
      clock.t = T0 + dt;
      expect(send(`line ${dt}`).ok).toBe(true);
    }
    clock.t = T0 + 3000;
    expect(pacer.check(key, 'line four')).toEqual({ ok: false, reason: 'flood', retryAfterMs: 7000, signalFlood: true });
    clock.t = T0 + 9999;
    expect(refusal(pacer.check(key, 'line four')).retryAfterMs).toBe(1);
    clock.t = T0 + 10_000;
    expect(pacer.check(key, 'line four').ok).toBe(true);
  });

  it('N lines spread wider than the window never trip', () => {
    const { clock, send } = setup({ burst });
    for (let i = 0; i < 40; i += 1) {
      clock.t = T0 + i * 4000;
      expect(send(`distinct line ${String.fromCharCode(97 + (i % 26))}${i}`).ok, `line ${i}`).toBe(true);
    }
  });

  it('a refused line is not counted toward the next window', () => {
    const { clock, pacer, key, send } = setup({ burst });
    for (const dt of [0, 1000, 2000]) {
      clock.t = T0 + dt;
      send(`line ${dt}`);
    }
    for (const dt of [3000, 4000, 5000, 6000]) {
      clock.t = T0 + dt;
      expect(pacer.check(key, 'refused one').ok).toBe(false);
    }
    clock.t = T0 + 10_000;
    expect(send('accepted at ten').ok).toBe(true);
    // Live stamps are now 1000, 2000 and 10 000: had a refused line counted, the oldest would be 3000 or later.
    clock.t = T0 + 10_001;
    expect(refusal(pacer.check(key, 'next one')).retryAfterMs).toBe(999);
  });

  it('the first stamps to age out free exactly as many slots', () => {
    const { clock, pacer, key, send } = setup({ burst: { lines: 2, windowMs: 10_000 } });
    clock.t = T0;
    send('line a1');
    clock.t = T0 + 5000;
    send('line b2');
    clock.t = T0 + 9000;
    expect(refusal(pacer.check(key, 'line c3')).retryAfterMs).toBe(1000);
    clock.t = T0 + 10_000;
    expect(send('line c3').ok).toBe(true);
    clock.t = T0 + 10_001;
    expect(refusal(pacer.check(key, 'line d4')).retryAfterMs).toBe(4999);
  });

  it('a burst narrowed after lines were sent counts all live stamps and waits for enough of them to age out', () => {
    const { clock, cfg, pacer, key, send } = setup({ burst: { lines: 6, windowMs: 10_000 } });
    for (const dt of [0, 1000, 2000, 3000, 4000, 5000]) {
      clock.t = T0 + dt;
      expect(send(`line ${dt}`).ok).toBe(true);
    }
    cfg.pace = { ...OFF, burst: { lines: 3, windowMs: 10_000 } };
    clock.t = T0 + 6000;
    // 6 live and a limit of 3: the player may speak once only 2 are live, that is when the stamp at +3000 has aged out (13 000 - 6 000).
    expect(refusal(pacer.check(key, 'one more')).retryAfterMs).toBe(7000);
  });
});

describe('duplicate', () => {
  const dup = { duplicateWindowMs: 15_000 };

  it('the same text is refused with at + window - now', () => {
    const { clock, pacer, key, send } = setup(dup);
    send('Hello there world');
    clock.t = T0 + 100;
    expect(pacer.check(key, 'Hello there world')).toEqual({ ok: false, reason: 'duplicate', retryAfterMs: 14_900, signalFlood: false });
  });

  it('case, spacing, punctuation and full-width variants are one line; a different line is accepted', () => {
    const { pacer, key, send } = setup(dup);
    send('Hello, World!');
    for (const same of ['hello world', 'HELLO   WORLD', 'hello-world!!!', '  h e l l o w o r l d  ', 'ｈｅｌｌｏ　ｗｏｒｌｄ', 'Hello... World?']) {
      expect(refusal(pacer.check(key, same)).reason, same).toBe('duplicate');
    }
    expect(pacer.check(key, 'hello there').ok).toBe(true);
    expect(pacer.check(key, 'hello worlds').ok).toBe(true);
  });

  it('the third distinct line after two duplicates is fine', () => {
    const { clock, pacer, key, send } = setup(dup);
    send('repeat me please');
    clock.t += 10;
    expect(pacer.check(key, 'repeat me please').ok).toBe(false);
    clock.t += 10;
    expect(pacer.check(key, 'Repeat me, please!').ok).toBe(false);
    clock.t += 10;
    expect(send('something else entirely').ok).toBe(true);
  });

  it('window edge exact: just inside refused, at the edge accepted', () => {
    const { clock, pacer, key, send } = setup(dup);
    send('edge case line');
    clock.t = T0 + 14_999;
    expect(refusal(pacer.check(key, 'edge case line')).retryAfterMs).toBe(1);
    clock.t = T0 + 15_000;
    expect(pacer.check(key, 'edge case line').ok).toBe(true);
  });

  it('a refused duplicate does not extend its own block', () => {
    const { clock, pacer, key, send } = setup(dup);
    send('block me once');
    for (const dt of [5000, 10_000, 14_000]) {
      clock.t = T0 + dt;
      expect(pacer.check(key, 'block me once').ok).toBe(false);
    }
    clock.t = T0 + 15_000;
    expect(send('block me once').ok).toBe(true);
  });

  it('only the last 8 hashes are compared', () => {
    const { clock, pacer, key, send } = setup(dup);
    const lines = Array.from({ length: 9 }, (_, i) => `unique line ${String.fromCharCode(97 + i).repeat(3)}`);
    for (const line of lines) {
      clock.t += 10;
      expect(send(line).ok).toBe(true);
    }
    // The first of nine has fallen out of the eight remembered; the second to ninth are still there.
    expect(pacer.check(key, lines[0]!).ok).toBe(true);
    for (const line of lines.slice(1)) expect(refusal(pacer.check(key, line)).reason, line).toBe('duplicate');
  });

  it('an accepted repeat after the window refreshes the entry rather than stacking it', () => {
    const { clock, pacer, key, send } = setup(dup);
    send('again and again');
    clock.t = T0 + 16_000;
    expect(send('again and again').ok).toBe(true);
    clock.t = T0 + 17_000;
    expect(refusal(pacer.check(key, 'again and again')).retryAfterMs).toBe(14_000);
  });
});

describe('lines that normalize to nothing or almost nothing (review focus 1)', () => {
  const dup = { duplicateWindowMs: 60_000 };

  it.each([['gg'], ['ok'], ['?!'], ['🙂'], ['🙂🙂🙂'], ['!!!!!!!!'], ['...'], ['👍🏽'], ['a'], ['  '], ['​​​'], ['你好']])(
    'normalized length under 3 is never a duplicate: %j',
    (line) => {
      const { clock, pacer, key, send } = setup(dup);
      for (let i = 0; i < 5; i += 1) {
        clock.t += 1;
        expect(send(line).ok, `repeat ${i}`).toBe(true);
      }
      expect(pacer.check(key, line).ok).toBe(true);
    },
  );

  it('an emoji-only line leaves no hash behind, so it never pushes a real one out of the eight', () => {
    const { clock, pacer, key, send } = setup(dup);
    send('real line one');
    for (let i = 0; i < 20; i += 1) {
      clock.t += 1;
      send('🙂🙂🙂');
      send('gg');
    }
    expect(refusal(pacer.check(key, 'real line one')).reason).toBe('duplicate');
  });

  it('a 3-character CJK line is a duplicate when repeated', () => {
    const { pacer, key, send } = setup(dup);
    send('你好吗');
    expect(refusal(pacer.check(key, '你好吗')).reason).toBe('duplicate');
    expect(refusal(pacer.check(key, '你好吗！！')).reason).toBe('duplicate');
    expect(pacer.check(key, '你好吧').ok).toBe(true);
  });

  it('full-width digits and letters normalize to ASCII', () => {
    const { pacer, key, send } = setup(dup);
    send('１２３');
    expect(refusal(pacer.check(key, '123')).reason).toBe('duplicate');
    send('ＡＢＣＤ');
    expect(refusal(pacer.check(key, 'abcd')).reason).toBe('duplicate');
  });

  it('a 200-character line and a lone surrogate do not throw', () => {
    const { clock, pacer, key, send } = setup({ ...dup, slowModeMs: 500, burst: { lines: 5, windowMs: 5000 } });
    const long = 'quissel '.repeat(25);
    expect(long.length).toBe(200);
    for (const line of [long, 'a'.repeat(200), '\ud800', 'ab\ud83d', '\udc00\udc00\udc00xyz', '🙂'.repeat(100), '\u0000\u0000\u0000', 'İİİ', 'ß'.repeat(3)]) {
      clock.t += 1000;
      expect(() => send(line), JSON.stringify(line)).not.toThrow();
      expect(() => pacer.check(key, line)).not.toThrow();
    }
    clock.t += 1000;
    send(long);
    clock.t += 1000;
    expect(refusal(pacer.check(key, long)).reason).toBe('duplicate');
  });

  it('normalizeForRepeat keeps only lower-cased NFKC letters and digits', () => {
    expect(normalizeForRepeat('Hello, World! 123')).toBe('helloworld123');
    expect(normalizeForRepeat('ＨＥＬＬＯ　１２３')).toBe('hello123');
    expect(normalizeForRepeat('🙂🙂🙂')).toBe('');
    expect(normalizeForRepeat('')).toBe('');
    expect(normalizeForRepeat('?!')).toBe('');
    expect(normalizeForRepeat('你好吗')).toBe('你好吗');
    expect(normalizeForRepeat('\ud800')).toBe('');
    expect(normalizeForRepeat('ﬁsh')).toBe('fish');
    expect(normalizeForRepeat('Wörld')).toBe('wörld');
  });
});

describe('order and purity', () => {
  it('slow_mode beats flood, flood beats duplicate', () => {
    const { clock, pacer, key, send } = setup({ slowModeMs: 1000, burst: { lines: 2, windowMs: 10_000 }, duplicateWindowMs: 15_000 });
    send('same old line');
    clock.t = T0 + 1;
    // Cannot send a second one by `send` (slow mode), so commit directly as the chat path would have before the gap was set.
    pacer.commit(key, 'same old line');
    clock.t = T0 + 2;
    expect(refusal(pacer.check(key, 'same old line')).reason).toBe('slow_mode');
    clock.t = T0 + 1001;
    // Slow mode has passed; two live stamps fill the burst, and the line is also a repeat: flood wins.
    const v = refusal(pacer.check(key, 'same old line'));
    expect(v.reason).toBe('flood');
    expect(v.retryAfterMs).toBe(10_000 - 1001);
    // A different line is still a flood, not a duplicate.
    expect(refusal(pacer.check(key, 'a different line')).reason).toBe('flood');
  });

  it('with only duplicate and flood on, a repeat at the burst limit is flood; below it, duplicate', () => {
    const { clock, cfg, pacer, key, send } = setup({ burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 15_000 });
    send('repeat after me');
    clock.t += 10;
    expect(refusal(pacer.check(key, 'repeat after me')).reason).toBe('duplicate');
    clock.t += 10;
    send('second line here');
    clock.t += 10;
    send('third line here');
    clock.t += 10;
    expect(refusal(pacer.check(key, 'repeat after me')).reason).toBe('flood');
    cfg.pace = { ...OFF, duplicateWindowMs: 15_000 };
    expect(refusal(pacer.check(key, 'repeat after me')).reason).toBe('duplicate');
  });

  it("a verdict's refusal changes no timing state (check twice, same answer)", () => {
    const { clock, pacer, key, send } = setup({ slowModeMs: 2000, burst: { lines: 2, windowMs: 10_000 }, duplicateWindowMs: 15_000 });
    send('state line one');
    clock.t = T0 + 2000;
    send('state line two');
    clock.t = T0 + 2500;
    const a = pacer.check(key, 'state line one');
    const b = pacer.check(key, 'state line one');
    const c = pacer.check(key, 'state line one');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(pacer.size()).toBe(1);
    // After 40 refused checks the accept time is the arithmetic of the committed lines only.
    for (let i = 0; i < 40; i += 1) pacer.check(key, 'state line one');
    clock.t = T0 + 10_000;
    expect(pacer.check(key, 'state line three').ok).toBe(true);
    clock.t = T0 + 9999;
    expect(refusal(pacer.check(key, 'state line three')).reason).toBe('flood');
  });

  it('a check set to null does nothing', () => {
    const { clock, pacer, key, send } = setup({ slowModeMs: 2000 });
    send('only slow mode on');
    clock.t += 1;
    // Burst and duplicate are null: a repeat, and a burst of lines, are only held by slow mode.
    expect(refusal(pacer.check(key, 'only slow mode on')).reason).toBe('slow_mode');
    clock.t = T0 + 2000;
    expect(send('only slow mode on').ok).toBe(true);
    clock.t = T0 + 4000;
    expect(send('only slow mode on').ok).toBe(true);
  });

  it('all three off: nothing is refused, nothing is allocated', () => {
    const { pacer, key } = setup();
    for (let i = 0; i < 1000; i += 1) {
      expect(pacer.check(key, 'same line')).toEqual({ ok: true });
      pacer.commit(key, 'same line');
    }
    expect(pacer.size()).toBe(0);
  });
});

describe('signalFlood', () => {
  const burst = { lines: 2, windowMs: 10_000 };

  it('is true once per burst window per key and false for the rest; true again in the next window', () => {
    const { clock, pacer, key, send } = setup({ burst });
    send('flood line one');
    clock.t = T0 + 1000;
    send('flood line two');
    clock.t = T0 + 2000;
    expect(refusal(pacer.check(key, 'a third one')).signalFlood).toBe(true);
    for (const dt of [2001, 3000, 5000, 9999]) {
      clock.t = T0 + dt;
      const v = refusal(pacer.check(key, 'a third one'));
      expect(v.reason).toBe('flood');
      expect(v.signalFlood, `at +${dt}`).toBe(false);
    }
    // The block ends, the player sends two more and trips it again in a later window.
    clock.t = T0 + 10_000;
    expect(send('after the block').ok).toBe(true);
    clock.t = T0 + 11_000;
    expect(send('after the block two').ok).toBe(true);
    clock.t = T0 + 11_500;
    // The window of the first signal (at +2000) has not passed yet: no second signal.
    expect(refusal(pacer.check(key, 'tripping again')).signalFlood).toBe(false);
    clock.t = T0 + 12_000;
    expect(refusal(pacer.check(key, 'tripping again')).signalFlood).toBe(true);
    clock.t = T0 + 12_001;
    expect(refusal(pacer.check(key, 'tripping again')).signalFlood).toBe(false);
  });

  it('is false for slow_mode and duplicate refusals', () => {
    const { clock, pacer, key, send } = setup({ slowModeMs: 1000, duplicateWindowMs: 10_000 });
    send('ordinary line');
    clock.t += 10;
    expect(refusal(pacer.check(key, 'ordinary line')).signalFlood).toBe(false);
    clock.t += 2000;
    expect(refusal(pacer.check(key, 'ordinary line')).signalFlood).toBe(false);
  });

  it('is per key: another person in the room trips independently', () => {
    const { clock, pacer, send } = setup({ burst });
    const a: PaceKey = { roomId: 'R1', who: 'alpha' };
    const b: PaceKey = { roomId: 'R1', who: 'beta' };
    send('line one a', a);
    clock.t += 1;
    send('line two a', a);
    send('line one b', b);
    clock.t += 1;
    send('line two b', b);
    clock.t += 1;
    expect(refusal(pacer.check(a, 'three')).signalFlood).toBe(true);
    expect(refusal(pacer.check(b, 'three')).signalFlood).toBe(true);
    expect(refusal(pacer.check(a, 'three')).signalFlood).toBe(false);
  });

  it('a clock that stepped back does not silence a later flood for ever', () => {
    const { clock, pacer, key, send } = setup({ burst });
    clock.t = T0 + 1_000_000;
    send('line one');
    clock.t += 1;
    send('line two');
    clock.t += 1;
    expect(refusal(pacer.check(key, 'three')).signalFlood).toBe(true);
    clock.t = T0; // back by 1 000 002 ms
    expect(refusal(pacer.check(key, 'three')).signalFlood).toBe(true);
  });
});

describe('keys', () => {
  it('a key is room plus person: the same person in another room, and another person, are unaffected', () => {
    const { pacer, send } = setup({ slowModeMs: 5000, burst: { lines: 2, windowMs: 10_000 }, duplicateWindowMs: 15_000 });
    const k: PaceKey = { roomId: 'R1', who: 'alpha' };
    send('same words', k);
    expect(pacer.check(k, 'same words').ok).toBe(false);
    expect(pacer.check({ roomId: 'R2', who: 'alpha' }, 'same words').ok).toBe(true);
    expect(pacer.check({ roomId: 'R1', who: 'beta' }, 'same words').ok).toBe(true);
  });

  it('room and person ids that run together never collide', () => {
    const { pacer, send } = setup({ slowModeMs: 5000 });
    send('first words', { roomId: 'a', who: 'b:c' });
    expect(pacer.check({ roomId: 'a:b', who: 'c' }, 'first words').ok).toBe(true);
    expect(pacer.check({ roomId: 'a', who: 'b' }, 'first words').ok).toBe(true);
    expect(pacer.check({ roomId: 'a', who: 'b:c' }, 'first words').ok).toBe(false);
  });

  it('prototype-looking ids are ordinary keys', () => {
    const { pacer, send } = setup({ slowModeMs: 5000 });
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) {
      expect(pacer.check({ roomId: id, who: id }, 'hello there').ok, id).toBe(true);
      send('hello there', { roomId: id, who: id });
      expect(pacer.check({ roomId: id, who: id }, 'hello there').ok, id).toBe(false);
    }
  });

  it('a guest key (seat:) and a person key are separate', () => {
    const { pacer, send } = setup({ slowModeMs: 5000 });
    send('guest line', { roomId: 'R1', who: 'seat:p1' });
    expect(pacer.check({ roomId: 'R1', who: 'seat:p2' }, 'guest line').ok).toBe(true);
    expect(pacer.check({ roomId: 'R1', who: 'seat:p1' }, 'guest line').ok).toBe(false);
  });
});

describe('the clock (review focus 2)', () => {
  const settings: ResolvedPace = { slowModeMs: 3000, burst: { lines: 3, windowMs: 7000 }, duplicateWindowMs: 11_000 };
  const windowOf = { slow_mode: 3000, flood: 7000, duplicate: 11_000 } as const;

  const inRange = (v: PaceVerdict): void => {
    const r = refusal(v);
    expect(Number.isInteger(r.retryAfterMs), String(r.retryAfterMs)).toBe(true);
    expect(r.retryAfterMs).toBeGreaterThanOrEqual(1);
    expect(r.retryAfterMs).toBeLessThanOrEqual(windowOf[r.reason]);
  };

  it('retryAfterMs is an integer from 1 up to the window, also for two lines in the same millisecond', () => {
    for (const [name, pace, repeat] of [
      ['slow_mode', { ...OFF, slowModeMs: 3000 }, false],
      ['flood', { ...OFF, burst: { lines: 2, windowMs: 7000 } }, false],
      ['duplicate', { ...OFF, duplicateWindowMs: 11_000 }, true],
    ] as const) {
      const { pacer, key } = setup(pace);
      pacer.commit(key, 'first words here');
      if (name === 'flood') pacer.commit(key, 'second words here');
      const v = pacer.check(key, repeat ? 'first words here' : 'new words here');
      expect(refusal(v).reason).toBe(name);
      inRange(v);
      expect(refusal(v).retryAfterMs).toBe(windowOf[name]);
    }
  });

  it('a fractional clock still gives a whole number', () => {
    const { clock, pacer, key, send } = setup(settings);
    clock.t = T0 + 0.25;
    send('fraction line');
    clock.t = T0 + 1000.6;
    inRange(pacer.check(key, 'next words'));
    inRange(pacer.check(key, 'fraction line'));
  });

  it('a clock that steps backwards never gives retryAfterMs above the window', () => {
    const { clock, pacer, key } = setup(settings);
    clock.t = T0 + 1_000_000;
    pacer.commit(key, 'line one here');
    clock.t += 5;
    pacer.commit(key, 'line two here');
    clock.t += 5;
    pacer.commit(key, 'line three here');
    for (const back of [1, 10, 2999, 3000, 3001, 6999, 7000, 11_000, 500_000, 1_000_000]) {
      clock.t = T0 + 1_000_010 - back;
      for (const line of ['line one here', 'something new']) {
        const v = pacer.check(key, line);
        if (!v.ok) inRange(v);
      }
      // Forward again after a step back: still a valid verdict.
      clock.t = T0 + 1_000_010 + back;
      const w = pacer.check(key, 'line one here');
      if (!w.ok) inRange(w);
    }
  });

  it('a clock far ahead and back never yields NaN or an out-of-range wait', () => {
    const { clock, send } = setup(settings);
    for (const t of [T0, T0 + 50, T0 - 100, T0 + 10, T0 - 1_000_000, T0 + 2_000_000, T0 + 2_000_001, 0, 1, 2]) {
      clock.t = t;
      const v = send(`line at ${String.fromCharCode(97 + (Math.abs(t) % 26))}${Math.abs(t) % 1000}`);
      if (!v.ok) inRange(v);
    }
  });
});

describe('live settings', () => {
  it('a longer window saved after a line does not apply a stale longer one; turning a check off applies at once', () => {
    const { clock, cfg, pacer, key, send } = setup({ duplicateWindowMs: 60_000, slowModeMs: 10_000, burst: { lines: 2, windowMs: 60_000 } });
    send('windowed line');
    clock.t = T0 + 5000;
    expect(pacer.check(key, 'windowed line').ok).toBe(false);
    // Shortened: the old longer window must not apply.
    cfg.pace = { ...OFF, duplicateWindowMs: 3000 };
    expect(pacer.check(key, 'windowed line').ok).toBe(true);
    cfg.pace = { ...OFF, slowModeMs: 4000 };
    expect(pacer.check(key, 'windowed line').ok).toBe(true);
    cfg.pace = { ...OFF, slowModeMs: 6000 };
    expect(refusal(pacer.check(key, 'windowed line')).retryAfterMs).toBe(1000);
    // Off at once.
    cfg.pace = OFF;
    expect(pacer.check(key, 'windowed line').ok).toBe(true);
  });

  it('a check turned on after lines were sent works from what was recorded since', () => {
    const { clock, cfg, pacer, key, send } = setup({ slowModeMs: 1000 });
    send('recorded under slow mode');
    clock.t += 1500;
    cfg.pace = { ...OFF, slowModeMs: 1000, duplicateWindowMs: 60_000 };
    // The line sent before duplicate checking was on left no hash: it cannot be called a repeat.
    expect(pacer.check(key, 'recorded under slow mode').ok).toBe(true);
    send('recorded under slow mode');
    clock.t += 1500;
    expect(refusal(pacer.check(key, 'recorded under slow mode')).reason).toBe('duplicate');
  });

  it('the settings function is read per room and on every call', () => {
    const clock = { t: T0, now: () => clock.t };
    const asked: string[] = [];
    const pacer = createPacer({
      clock,
      settings: (roomId) => {
        asked.push(roomId);
        return roomId === 'quiet' ? { ...OFF, slowModeMs: 5000 } : OFF;
      },
    });
    pacer.commit({ roomId: 'quiet', who: 'x' }, 'hello there');
    pacer.commit({ roomId: 'loud', who: 'x' }, 'hello there');
    expect(pacer.check({ roomId: 'quiet', who: 'x' }, 'hello there').ok).toBe(false);
    expect(pacer.check({ roomId: 'loud', who: 'x' }, 'hello there').ok).toBe(true);
    expect(asked).toContain('quiet');
    expect(asked).toContain('loud');
    expect(asked.length).toBeGreaterThanOrEqual(4);
  });
});

describe('memory', () => {
  it('100 000 distinct keys over time stay at or under 50 000, and the sweep drops quiet keys', () => {
    const { clock, pacer } = setup({ slowModeMs: 600_000 });
    let peak = 0;
    for (let i = 0; i < 100_000; i += 1) {
      clock.t += 1;
      const k: PaceKey = { roomId: `room-${i % 7}`, who: `person-${i}` };
      pacer.check(k, 'a line of chat');
      pacer.commit(k, 'a line of chat');
      const n = pacer.size();
      if (n > peak) peak = n;
    }
    expect(peak).toBeLessThanOrEqual(PACE_KEYS_MAX);
    expect(pacer.size()).toBeGreaterThan(PACE_KEYS_MAX / 2);
    // The newest keys survive the cap; the oldest went.
    expect(pacer.check({ roomId: 'room-0', who: 'person-0' }, 'a line of chat').ok).toBe(true);
    expect(pacer.check({ roomId: `room-${99_999 % 7}`, who: 'person-99999' }, 'a line of chat').ok).toBe(false);
    // Quiet for longer than the window: the next sweep (every 256 calls) empties the map.
    clock.t += 700_000;
    for (let i = 0; i < 512; i += 1) pacer.check({ roomId: 'probe', who: `probe-${i}` }, 'x line');
    expect(pacer.size()).toBe(0);
  });

  it('the sweep keeps keys still inside the longest window and drops the rest', () => {
    const { clock, pacer } = setup({ slowModeMs: 1000, duplicateWindowMs: 20_000 });
    for (let i = 0; i < 100; i += 1) pacer.commit({ roomId: 'R', who: `old-${i}` }, 'old line');
    clock.t += 15_000;
    for (let i = 0; i < 100; i += 1) pacer.commit({ roomId: 'R', who: `new-${i}` }, 'new line');
    clock.t += 6000; // old: 21 000 quiet (past the 20 000 longest); new: 6 000
    for (let i = 0; i < 256; i += 1) pacer.check({ roomId: 'R', who: 'probe' }, 'probe line');
    expect(pacer.size()).toBe(100);
    expect(pacer.check({ roomId: 'R', who: 'new-5' }, 'new line').ok).toBe(false);
  });

  it('a room with every check turned off is swept whole', () => {
    const { clock, cfg, pacer } = setup({ slowModeMs: 600_000 });
    for (let i = 0; i < 50; i += 1) pacer.commit({ roomId: 'R', who: `p-${i}` }, 'some line');
    expect(pacer.size()).toBe(50);
    cfg.pace = OFF;
    clock.t += 1;
    for (let i = 0; i < 256; i += 1) pacer.check({ roomId: 'R', who: 'probe' }, 'probe line');
    expect(pacer.size()).toBe(0);
  });

  it('dropRoom removes a room\'s keys in one step', () => {
    const { pacer, send } = setup({ slowModeMs: 5000 });
    for (let i = 0; i < 30; i += 1) send('room a line', { roomId: 'A', who: `p-${i}` });
    for (let i = 0; i < 20; i += 1) send('room b line', { roomId: 'B', who: `p-${i}` });
    expect(pacer.size()).toBe(50);
    pacer.dropRoom('A');
    expect(pacer.size()).toBe(20);
    expect(pacer.check({ roomId: 'A', who: 'p-0' }, 'room a line').ok).toBe(true);
    expect(pacer.check({ roomId: 'B', who: 'p-0' }, 'room b line').ok).toBe(false);
    pacer.dropRoom('A');
    pacer.dropRoom('never-existed');
    expect(pacer.size()).toBe(20);
  });

  it('no state holds a line\'s text', () => {
    const { clock, pacer, send } = setup({ slowModeMs: 1000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: 30_000 });
    const lines = ['zorbak vlemmo quissel drakkuun', 'Fenrisk, tarvo! snerp glarn', '你好吗 secret words'];
    for (const line of lines) {
      clock.t += 2000;
      send(line, { roomId: 'R1', who: 'subject-one' });
    }
    const dump = JSON.stringify(__pacerState(pacer));
    expect(dump.length).toBeGreaterThan(20);
    for (const word of ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn', 'secret', '你好吗', 'words']) {
      expect(dump.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
    for (const line of lines) expect(dump).not.toContain(normalizeForRepeat(line));
    // The stored value of a line is a short digest: hex only.
    const hashes = [...dump.matchAll(/"h":"([^"]*)"/g)].map((m) => m[1]!);
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
