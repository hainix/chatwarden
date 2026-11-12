import { describe, expect, expectTypeOf, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { ChatService } from '../src/chat.js';
import type { ChatResult, RefuseReason } from '../src/chat.js';
import { createChatwarden } from '../src/chatwarden.js';
import type { Chatwarden } from '../src/chatwarden.js';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { MuteService } from '../src/mutes.js';
import type { PaceReason, ResolvedPace } from '../src/pace.js';
import { ProfileError } from '../src/profile.js';
import { SanctionIndex } from '../src/sanctions.js';
import { StrikeService } from '../src/strikes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, Matcher, ProfanityFilter, RawWho, SubjectId } from '../src/types.js';

const SEC = 1000;
const NOW = 1_800_000_000_000;
const ROOM = 'R1';
const OFF: ResolvedPace = { slowModeMs: null, burst: null, duplicateWindowMs: null };

const who = (clientKey: string | null): Identifiers => ({ clientKey, accountId: null, ipHash: null });

type Logs = Array<{ event: string; detail?: Record<string, string | number | boolean> }>;

interface Opts {
  /** The pace in force; omit `pace` altogether (the 0.1.6 construction) with `noPaceDep`. */
  pace?: ResolvedPace;
  noPaceDep?: boolean;
  settings?: (roomId: string) => ResolvedPace;
  canonical?: (s: SubjectId) => SubjectId;
  onFlood?: (info: { roomId: string; subject: SubjectId }) => void;
  profanityMode?: 'allow' | 'star' | 'refuse';
  gate?: (roomId: string, subject: SubjectId | null) => boolean;
}

/** Synthetic terms only: the matcher blocks 'zorbak', the profanity filter stars 'snerp'. Both count their calls. */
function setup(opts: Opts = {}) {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Logs = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const quiet: Logger = { warn() {} };
  const subjects = new SubjectIndex(store, clock, { logger: quiet });
  const roster = new RoomRoster();
  const buffer = new EvidenceBuffer({ clock });
  const sanctions = new SanctionIndex({ enabled: () => true, subjects });
  const strikes = new StrikeService(store, clock, subjects, { logger: quiet });
  const mutes = new MuteService(store, clock, subjects, { logger: quiet });
  const calls = { match: 0, spans: 0, profanity: 0 };
  const matcher: Matcher = {
    match(text) {
      calls.match += 1;
      return /\bzorbak\b/i.test(text) ? { termId: 'syn:zorbak' } : null;
    },
    spans(text) {
      calls.spans += 1;
      return [...text.matchAll(/\bzorbak\b/gi)].map((m) => ({ start: m.index, end: m.index + m[0].length, termId: 'syn:zorbak' }));
    },
  };
  const profanity: ProfanityFilter = {
    apply: (t) => {
      calls.profanity += 1;
      return { hit: /\bsnerp\b/i.test(t), text: t.replace(/\bsnerp\b/gi, '*****') };
    },
  };
  const cfg = { pace: opts.pace ?? OFF };
  const flooded: Array<{ roomId: string; subject: SubjectId }> = [];
  const chat = new ChatService({
    roster,
    buffer,
    subjects,
    sanctions,
    store,
    strikes,
    mutes,
    clock,
    matcher,
    profanity,
    profanityMode: opts.profanityMode ?? 'star',
    gate: opts.gate,
    logger,
    ...(opts.noPaceDep === true
      ? {}
      : {
          pace: {
            settings: opts.settings ?? (() => cfg.pace),
            canonical: opts.canonical ?? ((s: SubjectId) => subjects.canonical(s)),
            onFlood: opts.onFlood ?? ((info: { roomId: string; subject: SubjectId }) => void flooded.push(info)),
          },
        }),
  });
  const sit = (seat: string, ids: Identifiers | null, room = ROOM): SubjectId | null => {
    const subject = ids === null ? null : subjects.resolve(ids);
    roster.seat(room, seat, subject, `H-${seat}`);
    return subject;
  };
  const say = (seat: string, text: string, room = ROOM): ChatResult => chat.accept(room, seat, text);
  return { store, clock, logs, subjects, roster, buffer, calls, cfg, chat, sit, say, flooded };
}

const refusal = (r: ChatResult) => {
  if (!('refuse' in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.refuse;
};
const reasonOf = (r: ChatResult): string => ('refuse' in r ? r.refuse.reason : 'deliver');

describe('the result type', () => {
  it("the result still has two arms: 'deliver' in r narrows as before", () => {
    // Type-level only (checked by tsc, never called): `'deliver' in r` still splits the two arms.
    const narrows = (r: ChatResult): void => {
      if ('deliver' in r) {
        expectTypeOf(r).toEqualTypeOf<{ deliver: { lineId: string; text: string } }>();
        expectTypeOf(r.deliver.text).toEqualTypeOf<string>();
      } else {
        expectTypeOf(r.refuse.reason).toEqualTypeOf<RefuseReason>();
        expectTypeOf(r.refuse.retryAfterMs).toEqualTypeOf<number | undefined>();
      }
    };
    void narrows;
    expectTypeOf<PaceReason>().toExtend<RefuseReason>();
    const all: RefuseReason[] = ['empty', 'length', 'rate', 'gate', 'restricted', 'blocked', 'profanity', 'slow_mode', 'flood', 'duplicate'];
    expect(all).toHaveLength(10);
  });
});

// A scripted run; the table below is copied from the run of this exact script before the pacing change (0.1.6 behaviour). Each entry is the seconds
// since the last line, the seat and the text. p1 and p2 are known people, p3 is a guest.
const SCRIPT: Array<[number, string, string]> = [
  [0, 'p1', 'hello'],
  [0, 'p1', 'hello'],
  [1, 'p1', 'gg'],
  [1, 'p1', 'gg'],
  [0, 'p1', 'one more'],
  [10, 'p2', 'hi there'],
  [0, 'p2', ''],
  [0, 'p2', '   '],
  [1, 'p2', 'x'.repeat(201)],
  [1, 'p2', 'x'.repeat(200)],
  [0, 'p3', 'a guest line'],
  [0, 'p3', 'a guest line'],
  [0, 'p3', 'a guest line'],
  [0, 'p3', 'a guest line'],
  [6, 'p3', 'a guest line'],
  [6, 'p1', 'this is snerp talking'],
  [1, 'p1', 'zorbak'],
  [6, 'p1', 'zorbak'],
  [6, 'p1', 'fine words'],
  [6, 'p1', 'ZORBAK again'],
  [6, 'p1', 'after three strikes'],
  [1, 'p1', '?!'],
  [10, 'p2', 'ok'],
  [0, 'p2', 'ok'],
  [0, 'p2', 'ok'],
  [0, 'p2', 'ok'],
  [20, 'p2', 'Hello, World!'],
  [6, 'p2', 'hello world'],
  [6, 'p2', 'HELLO   WORLD'],
  [6, 'p2', '你好吗'],
  [6, 'p2', '你好吗'],
  [6, 'p2', '🙂🙂🙂'],
  [6, 'p2', '🙂🙂🙂'],
  [1, 'p3', 'snerp'],
  [6, 'p3', 'zorbak'],
  [6, 'p3', 'zorbak'],
  [6, 'p3', 'zorbak'],
  [6, 'p3', 'afterwards'],
  [0, 'p9', 'nobody is seated here'],
  [6, 'p2', 'the last line'],
];

/** The result of each scripted line, as a short string (a delivery's line id is dropped). */
const GOLDEN: string[] = [
  'D hello',
  'D hello',
  'D gg',
  'R {"reason":"rate"}',
  'R {"reason":"rate"}',
  'D hi there',
  'R {"reason":"empty"}',
  'R {"reason":"empty"}',
  'R {"reason":"length"}',
  `D ${'x'.repeat(200)}`,
  'D a guest line',
  'D a guest line',
  'D a guest line',
  'R {"reason":"rate"}',
  'D a guest line',
  'D this is ***** talking',
  'R {"reason":"blocked","rule":1}',
  'R {"reason":"blocked","rule":1}',
  'D fine words',
  'R {"reason":"blocked","rule":1}',
  'R {"reason":"restricted","until":1800001845000,"byModerator":false,"rule":1}',
  'R {"reason":"restricted","until":1800001845000,"byModerator":false,"rule":1}',
  'D ok',
  'D ok',
  'D ok',
  'R {"reason":"rate"}',
  'D Hello, World!',
  'D hello world',
  'D HELLO   WORLD',
  'D 你好吗',
  'D 你好吗',
  'D 🙂🙂🙂',
  'D 🙂🙂🙂',
  'D *****',
  'R {"reason":"blocked","rule":1}',
  'R {"reason":"blocked","rule":1}',
  'R {"reason":"blocked","rule":1}',
  'R {"reason":"restricted","until":1800001937000,"byModerator":false,"rule":1}',
  'R {"reason":"gate"}',
  'D the last line',
];

function runScript(e: ReturnType<typeof setup>): string[] {
  e.sit('p1', who('k1'));
  e.sit('p2', who('k2'));
  e.sit('p3', null);
  const out: string[] = [];
  for (const [dt, seat, text] of SCRIPT) {
    e.clock.t += dt * SEC;
    const r = e.say(seat, text);
    out.push('deliver' in r ? `D ${r.deliver.text}` : `R ${JSON.stringify(r.refuse)}`);
  }
  return out;
}

describe('off by default', () => {
  it('a scripted run of 40 lines gives the same results as the 0.1.6 expectation', () => {
    expect(SCRIPT).toHaveLength(40);
    expect(runScript(setup({ noPaceDep: true }))).toEqual(GOLDEN);
  });

  it('the same run with the pace dep present and every check off is identical', () => {
    expect(runScript(setup({ pace: OFF }))).toEqual(GOLDEN);
    expect(runScript(setup({ settings: () => ({ slowModeMs: null, burst: null, duplicateWindowMs: null }) }))).toEqual(GOLDEN);
  });

  it('the golden run holds every old reason it claims to', () => {
    const reasons = new Set(GOLDEN.map((g) => /"reason":"(\w+)"/.exec(g)?.[1]).filter(Boolean));
    for (const r of ['empty', 'length', 'rate', 'gate', 'blocked', 'restricted']) expect(reasons.has(r), r).toBe(true);
    expect(GOLDEN.some((g) => g.startsWith('D '))).toBe(true);
    expect(GOLDEN.some((g) => g.includes('*****'))).toBe(true);
  });
});

describe('slow_mode, flood and duplicate through chat.accept', () => {
  it('each pacing refusal has reason and retryAfterMs and nothing else (no rule, noticeId, until, byModerator or text)', () => {
    const e = setup({ pace: { slowModeMs: 2000, burst: { lines: 3, windowMs: 20_000 }, duplicateWindowMs: 30_000 } });
    e.sit('p1', who('k1'));
    // A blocked line spends its slot like any other.
    expect(reasonOf(e.say('p1', 'zorbak is not here'))).toBe('blocked');
    e.clock.t += 500;
    const slow = refusal(e.say('p1', 'zorbak hello'));
    expect(Object.keys(slow).sort()).toEqual(['reason', 'retryAfterMs']);
    expect(slow).toEqual({ reason: 'slow_mode', retryAfterMs: 1500 });
    e.clock.t += 1500;
    expect(reasonOf(e.say('p1', 'hello there'))).toBe('deliver');
    e.clock.t += 2 * SEC;
    expect(reasonOf(e.say('p1', 'a third distinct line'))).toBe('deliver');
    e.clock.t += 2 * SEC;
    const flood = refusal(e.say('p1', 'fourth line'));
    expect(Object.keys(flood).sort()).toEqual(['reason', 'retryAfterMs']);
    expect(flood.reason).toBe('flood');
    e.cfg.pace = { ...OFF, duplicateWindowMs: 30_000 };
    const dup = refusal(e.say('p1', 'A Third, distinct line!'));
    expect(Object.keys(dup).sort()).toEqual(['reason', 'retryAfterMs']);
    expect(dup.reason).toBe('duplicate');
    for (const r of [slow, flood, dup]) {
      for (const k of ['rule', 'noticeId', 'until', 'byModerator', 'text', 'lineId']) expect(k in r, k).toBe(false);
      expect(Number.isInteger(r.retryAfterMs)).toBe(true);
      expect(r.retryAfterMs).toBeGreaterThanOrEqual(1);
    }
  });

  it('slow mode: the exact wait, then accepted at the gap', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 3000 } });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'first'))).toBe('deliver');
    e.clock.t += 1000;
    expect(refusal(e.say('p1', 'second'))).toEqual({ reason: 'slow_mode', retryAfterMs: 2000 });
    e.clock.t += 2000;
    expect(reasonOf(e.say('p1', 'second'))).toBe('deliver');
  });

  it('a refused line is trimmed like any other (the check sees the trimmed text)', () => {
    const e = setup({ pace: { ...OFF, duplicateWindowMs: 30_000 } });
    e.sit('p1', who('k1'));
    e.say('p1', '   same words   ');
    e.clock.t += 6 * SEC;
    expect(reasonOf(e.say('p1', 'same words'))).toBe('duplicate');
  });
});

describe('order', () => {
  it('pacing runs after restricted and length and before rate', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 1000 } });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'line one'))).toBe('deliver');
    // Length first: a 201-character line inside the gap is `length`, and spends nothing of the gap.
    e.clock.t += 100;
    expect(reasonOf(e.say('p1', 'x'.repeat(201)))).toBe('length');
    e.clock.t += 900;
    expect(reasonOf(e.say('p1', 'line two'))).toBe('deliver');
    e.clock.t += 1000;
    expect(reasonOf(e.say('p1', 'line three'))).toBe('deliver');
    // Three lines are in the rate window now, so `rate` would refuse the fourth: pacing is asked first and its message wins.
    e.clock.t += 500;
    expect(reasonOf(e.say('p1', 'line four'))).toBe('slow_mode');
    // Past the gap, the rate window (3 in 5 s) is what refuses.
    e.clock.t += 500;
    expect(reasonOf(e.say('p1', 'line four'))).toBe('rate');
  });

  it('gate and empty come before pacing', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 }, gate: (_room, subject) => subject !== null });
    e.sit('p1', who('k1'));
    e.sit('g', null);
    expect(reasonOf(e.say('p1', 'one'))).toBe('deliver');
    expect(reasonOf(e.say('p1', '   '))).toBe('empty');
    expect(reasonOf(e.say('g', 'guests are gated'))).toBe('gate');
    expect(reasonOf(e.say('nobody', 'no seat'))).toBe('gate');
  });

  it('a line that is slow_mode and flood is slow_mode; flood and duplicate is flood', () => {
    const e = setup({ pace: { slowModeMs: 1000, burst: { lines: 2, windowMs: 10_000 }, duplicateWindowMs: 20_000 } });
    e.sit('p1', who('k1'));
    e.say('p1', 'same old line');
    e.clock.t += 1000;
    e.say('p1', 'same old line other');
    e.clock.t += 100;
    // Inside the gap, at the burst limit, and a repeat of the line before: slow mode.
    expect(reasonOf(e.say('p1', 'same old line'))).toBe('slow_mode');
    e.clock.t += 900;
    // Past the gap: still at the burst limit, and a repeat: flood.
    expect(reasonOf(e.say('p1', 'same old line'))).toBe('flood');
  });
});

describe('what a refusal spends and what a delivery commits', () => {
  it('a rate-refused line commits nothing to pacing (the burst count)', () => {
    const e = setup({ pace: { ...OFF, burst: { lines: 4, windowMs: 60_000 } } });
    e.sit('p1', who('k1'));
    for (const t of ['a1 line', 'a2 line', 'a3 line']) {
      expect(reasonOf(e.say('p1', t))).toBe('deliver');
      e.clock.t += 1;
    }
    expect(reasonOf(e.say('p1', 'a4 line'))).toBe('rate');
    // The rate window has passed. Had the refused line been counted there would be four stamps and a flood.
    e.clock.t += 5 * SEC;
    expect(reasonOf(e.say('p1', 'a5 line'))).toBe('deliver');
  });

  it('a rate-refused line commits nothing to pacing (the repeat memory, and slow mode)', () => {
    const e = setup({ pace: { ...OFF, duplicateWindowMs: 60_000 } });
    e.sit('p1', who('k1'));
    for (const t of ['b1 line', 'b2 line', 'b3 line']) {
      e.say('p1', t);
      e.clock.t += 1;
    }
    expect(reasonOf(e.say('p1', 'refused by rate'))).toBe('rate');
    e.clock.t += 5 * SEC;
    expect(reasonOf(e.say('p1', 'refused by rate'))).toBe('deliver');

    const s = setup({ pace: { ...OFF, slowModeMs: 10_000 } });
    s.sit('p1', who('k1'));
    expect(reasonOf(s.say('p1', 'slow one'))).toBe('deliver');
    // Rate is never what refuses here (3 per 5 s with a 10 s gap), so this is a plain control: slow mode holds.
    s.clock.t += 9_999;
    expect(reasonOf(s.say('p1', 'slow two'))).toBe('slow_mode');
  });

  it('a matcher-blocked line commits (its slot is spent)', () => {
    const slow = setup({ pace: { ...OFF, slowModeMs: 5000 } });
    slow.sit('p1', who('k1'));
    expect(reasonOf(slow.say('p1', 'zorbak'))).toBe('blocked');
    slow.clock.t += 1000;
    expect(reasonOf(slow.say('p1', 'a clean line'))).toBe('slow_mode');
    slow.clock.t += 4000;
    expect(reasonOf(slow.say('p1', 'a clean line'))).toBe('deliver');

    const dup = setup({ pace: { ...OFF, duplicateWindowMs: 60_000 } });
    dup.sit('p1', who('k1'));
    expect(reasonOf(dup.say('p1', 'zorbak'))).toBe('blocked');
    dup.clock.t += 6 * SEC;
    // The repeat is refused as a repeat, before the matcher: one strike, not two.
    expect(reasonOf(dup.say('p1', 'zorbak'))).toBe('duplicate');
    expect(dup.store.loadStrikes(0)).toHaveLength(1);
  });

  it('a profanity-refused line commits', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 }, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'snerp'))).toBe('profanity');
    e.clock.t += 1000;
    expect(reasonOf(e.say('p1', 'a clean line'))).toBe('slow_mode');
  });

  it('a pacing-refused line spends no rate budget', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 1000 } });
    e.sit('p1', who('k1'));
    e.say('p1', 'one');
    // Ten slow-mode refusals inside the gap...
    for (let i = 0; i < 10; i += 1) {
      e.clock.t += 50;
      expect(reasonOf(e.say('p1', `try ${i}`))).toBe('slow_mode');
    }
    // ...and the rate window (3 in 5 s) still has room for two more lines.
    e.clock.t += 600;
    expect(reasonOf(e.say('p1', 'two'))).toBe('deliver');
    e.clock.t += 1000;
    expect(reasonOf(e.say('p1', 'three'))).toBe('deliver');
  });
});

describe('cost', () => {
  it('with a counting matcher a pace-refused line never reaches match, spans or the profanity filter and writes no evidence, strike or notice', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 } });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'a clean line'))).toBe('deliver');
    const before = { ...e.calls };
    const lines = e.buffer.snapshot(ROOM).length;
    for (const text of ['zorbak', 'snerp talks', 'zorbak snerp']) {
      e.clock.t += 100;
      expect(reasonOf(e.say('p1', text))).toBe('slow_mode');
    }
    expect(e.calls).toEqual(before);
    expect(e.buffer.snapshot(ROOM)).toHaveLength(lines);
    expect(e.store.loadStrikes(0)).toHaveLength(0);
    expect(e.store.loadNotices([e.subjects.resolve(who('k1')) as SubjectId])).toHaveLength(0);
  });

  it('the same holds for flood and duplicate refusals', () => {
    const f = setup({ pace: { ...OFF, burst: { lines: 2, windowMs: 60_000 } } });
    f.sit('p1', who('k1'));
    f.say('p1', 'one line');
    f.clock.t += 1;
    f.say('p1', 'two line');
    const after = { ...f.calls };
    f.clock.t += 1;
    expect(reasonOf(f.say('p1', 'zorbak'))).toBe('flood');
    expect(f.calls).toEqual(after);
    expect(f.store.loadStrikes(0)).toHaveLength(0);

    const d = setup({ pace: { ...OFF, duplicateWindowMs: 60_000 } });
    d.sit('p1', who('k1'));
    d.say('p1', 'zorbak');
    const seen = { ...d.calls };
    d.clock.t += 6 * SEC;
    expect(reasonOf(d.say('p1', 'zorbak'))).toBe('duplicate');
    expect(d.calls).toEqual(seen);
  });
});

describe('retryAfterMs', () => {
  it('is present for exactly slow_mode, flood and duplicate and absent for every other reason', () => {
    const seen = new Map<string, boolean>();
    const note = (r: ChatResult): void => {
      const x = refusal(r);
      seen.set(x.reason, 'retryAfterMs' in x);
    };
    // empty, gate, length, blocked, profanity, rate
    const a = setup({ profanityMode: 'refuse', gate: (_r, s) => s !== null });
    a.sit('p1', who('k1'));
    a.sit('g', null);
    note(a.say('p1', ''));
    note(a.say('g', 'guest'));
    note(a.say('p1', 'x'.repeat(201)));
    note(a.say('p1', 'zorbak'));
    a.clock.t += 6 * SEC;
    note(a.say('p1', 'snerp'));
    a.clock.t += 6 * SEC;
    for (const t of ['r1', 'r2', 'r3', 'r4']) {
      a.clock.t += 1;
      const r = a.say('p1', `line ${t}`);
      if ('refuse' in r) note(r);
    }
    // the pacing reasons
    const b = setup({ pace: { slowModeMs: 1000, burst: { lines: 2, windowMs: 30_000 }, duplicateWindowMs: 30_000 } });
    b.sit('p1', who('k1'));
    b.say('p1', 'first');
    b.clock.t += 100;
    note(b.say('p1', 'second'));
    b.clock.t += 1000;
    b.say('p1', 'second');
    b.clock.t += 1100;
    note(b.say('p1', 'third'));
    b.cfg.pace = { ...OFF, duplicateWindowMs: 30_000 };
    note(b.say('p1', 'second'));
    expect([...seen.keys()].sort()).toEqual(['blocked', 'duplicate', 'empty', 'flood', 'gate', 'length', 'profanity', 'rate', 'slow_mode']);
    for (const [reason, has] of seen) expect(has, reason).toBe(['slow_mode', 'flood', 'duplicate'].includes(reason));
  });
});

describe('the key', () => {
  it('a known player is keyed by canonical subject: re-seating keeps the state', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 } });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'hello'))).toBe('deliver');
    e.roster.unseat(ROOM, 'p1');
    e.sit('p4', who('k1'));
    e.clock.t += 1000;
    expect(reasonOf(e.say('p4', 'hello again'))).toBe('slow_mode');
  });

  it('a guest is keyed by seat: a guest in a new seat starts fresh, and two guests are independent', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 } });
    e.sit('g1', null);
    e.sit('g2', null);
    expect(reasonOf(e.say('g1', 'hello'))).toBe('deliver');
    expect(reasonOf(e.say('g2', 'hello'))).toBe('deliver');
    e.clock.t += 1000;
    expect(reasonOf(e.say('g1', 'again'))).toBe('slow_mode');
    expect(reasonOf(e.say('g2', 'again'))).toBe('slow_mode');
    e.roster.unseat(ROOM, 'g1');
    e.sit('g3', null);
    expect(reasonOf(e.say('g3', 'a fresh seat'))).toBe('deliver');
  });

  it('two subjects the index merged into one canonical person share the state', () => {
    const a = who('k1');
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 }, canonical: (s) => (s === e.subjects.resolve(who('k2')) ? (e.subjects.resolve(a) as SubjectId) : s) });
    e.sit('p1', a);
    e.sit('p2', who('k2'));
    expect(reasonOf(e.say('p1', 'one'))).toBe('deliver');
    e.clock.t += 1000;
    expect(reasonOf(e.say('p2', 'two'))).toBe('slow_mode');
  });

  it('the same person in two rooms has two independent states', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 } });
    e.sit('p1', who('k1'), 'A');
    e.sit('p1', who('k1'), 'B');
    expect(reasonOf(e.say('p1', 'hello', 'A'))).toBe('deliver');
    expect(reasonOf(e.say('p1', 'hello', 'B'))).toBe('deliver');
    e.clock.t += 1000;
    expect(reasonOf(e.say('p1', 'again', 'A'))).toBe('slow_mode');
  });

  it('a guest and a person whose subject text looks like a seat key do not meet', () => {
    const e = setup({ pace: { ...OFF, slowModeMs: 5000 } });
    e.sit('p1', who('k1'));
    e.sit('p2', null);
    e.say('p1', 'hello');
    expect(reasonOf(e.say('p2', 'hello'))).toBe('deliver');
  });
});

describe('onFlood', () => {
  const pace: ResolvedPace = { ...OFF, burst: { lines: 2, windowMs: 10_000 } };

  it('is called once per window for a known subject, with the canonical subject, and never for slow_mode or duplicate', () => {
    const e = setup({ pace: { slowModeMs: null, burst: { lines: 2, windowMs: 10_000 }, duplicateWindowMs: 60_000 } });
    const s1 = e.sit('p1', who('k1')) as SubjectId;
    e.say('p1', 'one line');
    e.clock.t += 1000;
    e.say('p1', 'two line');
    e.clock.t += 1000;
    expect(reasonOf(e.say('p1', 'three line'))).toBe('flood');
    expect(e.flooded).toEqual([{ roomId: ROOM, subject: s1 }]);
    for (const t of [3000, 4000, 9000]) {
      e.clock.t = NOW + t;
      expect(reasonOf(e.say('p1', 'three line'))).toBe('flood');
    }
    expect(e.flooded).toHaveLength(1);
    // A repeat while under the burst limit is a duplicate: no signal.
    e.clock.t = NOW + 30_000;
    e.say('p1', 'later line');
    e.clock.t += 6 * SEC;
    expect(reasonOf(e.say('p1', 'later line'))).toBe('duplicate');
    expect(e.flooded).toHaveLength(1);
    // The next window: signalled again.
    e.clock.t = NOW + 40_000;
    e.say('p1', 'fresh one');
    e.clock.t += 1000;
    e.say('p1', 'fresh two');
    e.clock.t += 1000;
    expect(reasonOf(e.say('p1', 'fresh three'))).toBe('flood');
    expect(e.flooded).toHaveLength(2);
  });

  it('is never called for a guest', () => {
    const e = setup({ pace });
    e.sit('g1', null);
    e.say('g1', 'one line');
    e.clock.t += 1000;
    e.say('g1', 'two line');
    e.clock.t += 1000;
    expect(reasonOf(e.say('g1', 'three line'))).toBe('flood');
    expect(e.flooded).toEqual([]);
  });

  it('is told the canonical subject, not the seat occupant\'s own', () => {
    const e = setup({ pace, canonical: () => 's_the_canonical_one' });
    e.sit('p1', who('k1'));
    e.say('p1', 'one line');
    e.clock.t += 1000;
    e.say('p1', 'two line');
    e.clock.t += 1000;
    e.say('p1', 'three line');
    expect(e.flooded).toEqual([{ roomId: ROOM, subject: 's_the_canonical_one' }]);
  });

  it('a throw from it is absorbed and logged by class only', () => {
    const e = setup({
      pace,
      onFlood: () => {
        throw new TypeError('quissel s_secret_subject_id');
      },
    });
    e.sit('p1', who('k1'));
    e.say('p1', 'one line');
    e.clock.t += 1000;
    e.say('p1', 'two line');
    e.clock.t += 1000;
    expect(refusal(e.say('p1', 'three line')).reason).toBe('flood');
    expect(e.logs).toEqual([{ event: 'chatwarden.pace_failed', detail: { error: 'TypeError' } }]);
    expect(JSON.stringify(e.logs)).not.toContain('quissel');
    expect(JSON.stringify(e.logs)).not.toContain('s_secret');
  });

  it('a rejected promise from it is absorbed too', async () => {
    const e = setup({ pace, onFlood: () => Promise.reject(new RangeError('x')) as never });
    e.sit('p1', who('k1'));
    e.say('p1', 'one line');
    e.clock.t += 1000;
    e.say('p1', 'two line');
    e.clock.t += 1000;
    expect(refusal(e.say('p1', 'three line')).reason).toBe('flood');
    await Promise.resolve();
    await Promise.resolve();
    expect(e.logs).toEqual([{ event: 'chatwarden.pace_failed', detail: { error: 'RangeError' } }]);
  });

  it('no onFlood dep is fine', () => {
    const e = setup({ pace });
    e.sit('p1', who('k1'));
    e.say('p1', 'one line');
    e.clock.t += 1000;
    e.say('p1', 'two line');
    e.clock.t += 1000;
    expect(refusal(e.say('p1', 'three line')).reason).toBe('flood');
  });
});

describe('what an off kit does per line (review M1, M2)', () => {
  it('with every check off, canonical is never asked and no key is built', () => {
    let asked = 0;
    const e = setup({
      pace: OFF,
      canonical: (s) => {
        asked += 1;
        return s;
      },
    });
    e.sit('p1', who('k1'));
    e.sit('g1', null);
    for (let i = 0; i < 5; i += 1) {
      e.clock.t += 6 * SEC;
      expect(reasonOf(e.say('p1', `line ${i}`))).toBe('deliver');
      expect(reasonOf(e.say('g1', `guest ${i}`))).toBe('deliver');
    }
    expect(asked).toBe(0);
  });

  it('with a check on, canonical is asked once for a line (check and commit share the key)', () => {
    let asked = 0;
    const e = setup({
      pace: { ...OFF, slowModeMs: 1000 },
      canonical: (s) => {
        asked += 1;
        return s;
      },
    });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'one'))).toBe('deliver');
    expect(asked).toBe(1);
  });

  it('a canonical that throws lets the line through, logged by class only (it is inside the fence)', () => {
    const e = setup({
      pace: { ...OFF, slowModeMs: 1000 },
      canonical: () => {
        throw new TypeError('s_secret_subject');
      },
    });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'one'))).toBe('deliver');
    expect(reasonOf(e.say('p1', 'two'))).toBe('deliver');
    expect(e.logs).toEqual([{ event: 'chatwarden.pace_failed', detail: { error: 'TypeError' } }]);
    expect(JSON.stringify(e.logs)).not.toContain('s_secret');
  });
});

describe('a failing pacer never silences chat', () => {
  it('a settings function that throws lets the line through and logs the class once a minute', () => {
    const e = setup({
      settings: () => {
        throw new RangeError('private detail zorbak');
      },
    });
    e.sit('p1', who('k1'));
    expect(reasonOf(e.say('p1', 'hello'))).toBe('deliver');
    e.clock.t += 6 * SEC;
    expect(reasonOf(e.say('p1', 'hello again'))).toBe('deliver');
    expect(e.logs.map((l) => l.event)).toEqual(['chatwarden.pace_failed']);
    expect(e.logs[0]?.detail).toEqual({ error: 'RangeError' });
    expect(JSON.stringify(e.logs)).not.toContain('zorbak');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The facade: the room override, the stored layer and the code profile.

async function world(overrides: Parameters<typeof createChatwarden>[0]['overrides'] = {}, over: Partial<Parameters<typeof createChatwarden>[0]> = {}) {
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logs = [];
  const logger: Logger = { warn: (event, detail) => void logged.push({ event, detail }) };
  const cw: Chatwarden = await createChatwarden({
    store: new MemoryStore(),
    secret: 'pace-chat-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
    matcher: { match: (t) => (/\bzorbak\b/i.test(t) ? { termId: 'syn:zorbak' } : null), spans: () => [] },
    overrides,
    ...over,
  });
  cw.rooms.seat(ROOM, 'p1', { clientKey: 'key-one' }, 'One');
  cw.rooms.seat(ROOM, 'p2', { clientKey: 'key-two' }, 'Two');
  cw.rooms.seat(ROOM, 'g1', {} as RawWho, 'Guest');
  const say = (seat: string, text: string, room = ROOM): string => reasonOf(cw.chat.accept(room, seat, text));
  return { cw, clock, logged, say };
}

const OWNER = { actor: 'owner_ann', reason: 'tuning pace' };

describe('rooms.setPace and rooms.pace', () => {
  it('start off: rooms.pace is all null and nothing is paced', async () => {
    const { cw, say, clock } = await world();
    expect(cw.rooms.pace(ROOM)).toEqual(OFF);
    for (let i = 0; i < 3; i += 1) {
      expect(say('p1', 'same line')).toBe('deliver');
      clock.t += 1;
    }
  });

  it('setPace applies on the next line; null removes', async () => {
    const { cw, say, clock } = await world();
    expect(say('p1', 'before')).toBe('deliver');
    cw.rooms.setPace(ROOM, { slowModeMs: 3000 });
    // Nothing was kept while no check was on, so the first line under the new setting is free; the one after it waits.
    clock.t += 100;
    expect(say('p1', 'first')).toBe('deliver');
    clock.t += 100;
    expect(say('p1', 'second')).toBe('slow_mode');
    expect(cw.rooms.pace(ROOM)).toEqual({ ...OFF, slowModeMs: 3000 });
    cw.rooms.setPace(ROOM, null);
    expect(cw.rooms.pace(ROOM)).toEqual(OFF);
    expect(say('p1', 'second')).toBe('deliver');
  });

  it('{ slowModeMs: null } disables only that check; {} changes nothing', async () => {
    const { cw, say, clock } = await world({ pace: { slowModeMs: 3000, duplicateWindowMs: 60_000 } });
    expect(say('p1', 'repeat after me')).toBe('deliver');
    clock.t += 100;
    cw.rooms.setPace(ROOM, {});
    expect(cw.rooms.pace(ROOM)).toEqual({ slowModeMs: 3000, burst: null, duplicateWindowMs: 60_000 });
    expect(say('p1', 'new line')).toBe('slow_mode');
    cw.rooms.setPace(ROOM, { slowModeMs: null });
    expect(cw.rooms.pace(ROOM)).toEqual({ slowModeMs: null, burst: null, duplicateWindowMs: 60_000 });
    expect(say('p1', 'a different line')).toBe('deliver');
    clock.t += 6000;
    expect(say('p1', 'repeat after me')).toBe('duplicate');
  });

  it('an override of every field to null means no pacing in that room only', async () => {
    const { cw, say, clock } = await world({ pace: { slowModeMs: 3000 } });
    cw.rooms.seat('practice', 'p1', { clientKey: 'key-one' }, 'One');
    cw.rooms.setPace('practice', { slowModeMs: null, burst: null, duplicateWindowMs: null });
    expect(say('p1', 'one', 'practice')).toBe('deliver');
    clock.t += 1;
    expect(say('p1', 'two', 'practice')).toBe('deliver');
    expect(say('p1', 'one')).toBe('deliver');
    clock.t += 1;
    expect(say('p1', 'two')).toBe('slow_mode');
  });

  it('the override is copied: editing the object afterwards changes nothing', async () => {
    const { cw, say, clock } = await world();
    const given = { slowModeMs: 3000, burst: { lines: 5, windowMs: 10_000 } };
    cw.rooms.setPace(ROOM, given);
    given.slowModeMs = 500;
    given.burst.lines = 2;
    expect(cw.rooms.pace(ROOM)).toEqual({ slowModeMs: 3000, burst: { lines: 5, windowMs: 10_000 }, duplicateWindowMs: null });
    say('p1', 'one');
    clock.t += 1000;
    expect(say('p1', 'two')).toBe('slow_mode');
  });

  it('an invalid override throws ProfileError and changes nothing', async () => {
    const { cw, say, clock } = await world();
    cw.rooms.setPace(ROOM, { slowModeMs: 3000 });
    for (const bad of [{ slowModeMs: 1 }, { burst: { lines: 1, windowMs: 5000 } }, { nope: 1 }, { duplicateWindowMs: 'x' }, 5, 'x', []]) {
      let caught: unknown;
      try {
        cw.rooms.setPace(ROOM, bad as never);
      } catch (err) {
        caught = err;
      }
      expect(caught, JSON.stringify(bad)).toBeInstanceOf(ProfileError);
    }
    expect(cw.rooms.pace(ROOM)).toEqual({ ...OFF, slowModeMs: 3000 });
    say('p1', 'one');
    clock.t += 1000;
    expect(say('p1', 'two')).toBe('slow_mode');
  });

  it('a room id that is not a non-empty string is a ProfileError, not a silent no-op', async () => {
    const { cw } = await world();
    for (const id of ['', 5, null, undefined]) expect(() => cw.rooms.setPace(id as never, { slowModeMs: 1000 })).toThrow(ProfileError);
  });

  it('rooms.close drops the override and the room\'s pacing state', async () => {
    const { cw, say, clock } = await world();
    cw.rooms.setPace(ROOM, { slowModeMs: 5000 });
    say('p1', 'one');
    clock.t += 100;
    expect(say('p1', 'two')).toBe('slow_mode');
    cw.rooms.close(ROOM);
    expect(cw.rooms.pace(ROOM)).toEqual(OFF);
    // The room is used again: no override, and no old state.
    cw.rooms.seat(ROOM, 'p1', { clientKey: 'key-one' }, 'One');
    expect(say('p1', 'two')).toBe('deliver');
    clock.t += 1;
    expect(say('p1', 'three')).toBe('deliver');
    // And the state goes with the room even when the profile still paces it.
    cw.policy.save({ pace: { slowModeMs: 5000 } }, { version: 0, ...OWNER });
    clock.t += 10_000;
    say('p1', 'four');
    cw.rooms.close(ROOM);
    cw.rooms.seat(ROOM, 'p1', { clientKey: 'key-one' }, 'One');
    expect(say('p1', 'five')).toBe('deliver');
  });

  it('closing one room does not touch another room\'s override or state', async () => {
    const { cw, say, clock } = await world();
    cw.rooms.seat('other', 'p1', { clientKey: 'key-one' }, 'One');
    cw.rooms.setPace('other', { slowModeMs: 5000 });
    say('p1', 'one', 'other');
    cw.rooms.close(ROOM);
    clock.t += 100;
    expect(say('p1', 'two', 'other')).toBe('slow_mode');
    expect(cw.rooms.pace('other').slowModeMs).toBe(5000);
  });
});

describe('precedence and live settings', () => {
  it('override beats the stored layer, which beats the code profile', async () => {
    const { cw, say, clock } = await world({ pace: { slowModeMs: 1000 } });
    expect(cw.rooms.pace(ROOM).slowModeMs).toBe(1000);
    cw.policy.save({ pace: { slowModeMs: 2000 } }, { version: 0, ...OWNER });
    expect(cw.rooms.pace(ROOM).slowModeMs).toBe(2000);
    cw.rooms.setPace(ROOM, { slowModeMs: 4000 });
    expect(cw.rooms.pace(ROOM).slowModeMs).toBe(4000);
    // The wait the player is told is the override's.
    say('p1', 'one');
    clock.t += 1000;
    const r = cw.chat.accept(ROOM, 'p1', 'two');
    expect(refusalOf(r)).toEqual({ reason: 'slow_mode', retryAfterMs: 3000 });
    cw.rooms.setPace(ROOM, null);
    expect(cw.rooms.pace(ROOM).slowModeMs).toBe(2000);
    cw.policy.reset('pace');
    expect(cw.rooms.pace(ROOM).slowModeMs).toBe(1000);
  });

  it('a saved layer applies to the next line with no restart', async () => {
    const { cw, say, clock } = await world();
    expect(say('p1', 'one')).toBe('deliver');
    cw.policy.save({ pace: { slowModeMs: 3000 } }, { version: 0, ...OWNER });
    clock.t += 500;
    expect(say('p1', 'two')).toBe('deliver');
    clock.t += 500;
    expect(say('p1', 'three')).toBe('slow_mode');
    cw.policy.save({ pace: { slowModeMs: null } }, { version: 1, ...OWNER });
    expect(say('p1', 'three')).toBe('deliver');
  });

  it('a layer window shortened after a line does not apply the older longer one', async () => {
    const { cw, say, clock } = await world({ pace: { duplicateWindowMs: 3_600_000 } });
    say('p1', 'long memory');
    clock.t += 6000;
    expect(say('p1', 'long memory')).toBe('duplicate');
    cw.policy.save({ pace: { duplicateWindowMs: 5000 } }, { version: 0, ...OWNER });
    expect(say('p1', 'long memory')).toBe('deliver');
  });

  it('a code profile with pace paces without any layer', async () => {
    const { say, clock } = await world({ pace: { burst: { lines: 2, windowMs: 10_000 } } });
    expect(say('p1', 'one')).toBe('deliver');
    clock.t += 1;
    expect(say('p1', 'two')).toBe('deliver');
    clock.t += 1;
    expect(say('p1', 'three')).toBe('flood');
  });
});

const refusalOf = (r: ChatResult) => {
  if (!('refuse' in r)) throw new Error('expected a refusal');
  return r.refuse;
};

describe('the merged pace of a room with an override (review M3)', () => {
  it('is one stable object until something changes, and is not rebuilt per line', async () => {
    const { cw, say, clock } = await world({ pace: { slowModeMs: 1000 } });
    cw.rooms.setPace(ROOM, { duplicateWindowMs: 5000 });
    const first = cw.rooms.pace(ROOM);
    expect(cw.rooms.pace(ROOM)).toBe(first);
    for (let i = 0; i < 4; i += 1) {
      clock.t += 6000;
      say('p1', `line ${i}`);
    }
    expect(cw.rooms.pace(ROOM)).toBe(first);
    expect(first).toEqual({ slowModeMs: 1000, burst: null, duplicateWindowMs: 5000 });
  });

  it('follows the stored layer, setPace and close', async () => {
    const { cw } = await world({ pace: { slowModeMs: 1000 } });
    cw.rooms.setPace(ROOM, { duplicateWindowMs: 5000 });
    const first = cw.rooms.pace(ROOM);
    cw.policy.save({ pace: { slowModeMs: 2000 } }, { version: 0, ...OWNER });
    const second = cw.rooms.pace(ROOM);
    expect(second).not.toBe(first);
    expect(second).toEqual({ slowModeMs: 2000, burst: null, duplicateWindowMs: 5000 });
    expect(cw.rooms.pace(ROOM)).toBe(second);
    cw.rooms.setPace(ROOM, { duplicateWindowMs: 7000 });
    expect(cw.rooms.pace(ROOM)).toEqual({ slowModeMs: 2000, burst: null, duplicateWindowMs: 7000 });
    cw.rooms.close(ROOM);
    expect(cw.rooms.pace(ROOM)).toEqual({ slowModeMs: 2000, burst: null, duplicateWindowMs: null });
  });

  it('a room without an override returns the profile\'s own pace object', async () => {
    const { cw } = await world({ pace: { slowModeMs: 1000 } });
    expect(cw.rooms.pace(ROOM)).toBe(cw.profile.pace);
  });
});

describe('setPace snapshots what it is given (review M4)', () => {
  it('reads each field once: a getter that changes its answer cannot slip past the validation', async () => {
    const { cw } = await world();
    let reads = 0;
    const tricky = {
      get slowModeMs(): number {
        reads += 1;
        return reads === 1 ? 3000 : 1;
      },
    };
    cw.rooms.setPace(ROOM, tricky);
    expect(cw.rooms.pace(ROOM).slowModeMs).toBe(3000);
    expect(reads).toBe(1);
  });

  it('a second call replaces the first override, it does not merge into it', async () => {
    const { cw } = await world();
    cw.rooms.setPace(ROOM, { slowModeMs: 3000 });
    cw.rooms.setPace(ROOM, { duplicateWindowMs: 5000 });
    expect(cw.rooms.pace(ROOM)).toEqual({ slowModeMs: null, burst: null, duplicateWindowMs: 5000 });
  });
});

describe('through the facade', () => {
  it('flood works with no onFlood wired (Task 10 supplies it) and guests are paced by seat', async () => {
    const { cw, say, clock } = await world({ pace: { burst: { lines: 2, windowMs: 10_000 } } });
    for (const seat of ['p1', 'g1']) {
      expect(say(seat, 'one')).toBe('deliver');
      clock.t += 1;
      expect(say(seat, 'two')).toBe('deliver');
      clock.t += 1;
      expect(say(seat, 'three')).toBe('flood');
    }
    expect(cw.rooms.pace(ROOM).burst).toEqual({ lines: 2, windowMs: 10_000 });
  });

  it('restricted comes before pacing, and a restricted player\'s refusal carries no retryAfterMs', async () => {
    const { cw, say, clock } = await world({ pace: { slowModeMs: 5000 } });
    const subject = cw.rooms.subjectAt(ROOM, 'p1') as string;
    const done = await cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: 3_600_000,
      reason: 'test',
      actor: 'mod1',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    expect(done.groupId).toBeTruthy();
    clock.t += 10;
    const r = refusalOf(cw.chat.accept(ROOM, 'p1', 'hello'));
    expect(r.reason).toBe('restricted');
    expect('retryAfterMs' in r).toBe(false);
    clock.t += 10;
    expect(say('p1', 'hello again')).toBe('restricted');
  });

  it('length comes before pacing', async () => {
    const { say, clock } = await world({ pace: { slowModeMs: 5000 } });
    say('p1', 'one');
    clock.t += 10;
    expect(say('p1', 'x'.repeat(201))).toBe('length');
  });

  it('a pace-refused slur is never struck, buffered or reported', async () => {
    const { cw, say, clock } = await world({ pace: { slowModeMs: 5000 } });
    say('p1', 'a clean line');
    clock.t += 10;
    expect(say('p1', 'zorbak')).toBe('slow_mode');
    expect(cw.blocked.list({ days: 1 })).toHaveLength(0);
  });
});
