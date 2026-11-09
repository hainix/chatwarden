import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/chat.js';
import type { ChatResult, Starrer } from '../src/chat.js';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { MuteService } from '../src/mutes.js';
import { applySanction, revokeSanction, SanctionIndex } from '../src/sanctions.js';
import { StrikeService } from '../src/strikes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, Matcher, SanctionKind, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const SEC = 1000;
const MIN = 60_000;
const H = 60 * MIN;
const NOW = 1_800_000_000_000;
const ROOM = 'R1';

// Synthetic term only: the stub matcher blocks any text containing the word 'zorbak'.
const seen: string[] = [];
const stubMatcher: Matcher = {
  match(text: string) {
    seen.push(text);
    return /\bzorbak\b/i.test(text) ? { termId: 'syn:zorbak' } : null;
  },
};
const starrer: Starrer = { star: (t) => t.replace(/\bsnerp\b/gi, '*****') };

const who = (clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers => ({
  clientKey,
  accountId,
  ipHash,
});

class FailingStrikes extends MemoryStore {
  override insertStrike(): void {
    throw new Error('disk full');
  }
}
class FailingSanctions extends MemoryStore {
  override insertSanctionGroup(): boolean {
    throw new Error('disk full');
  }
}

type Logs = Array<{ event: string; detail?: Record<string, string | number | boolean> }>;

interface Opts {
  store?: MemoryStore;
  matcher?: Matcher | undefined;
  starrer?: Starrer | undefined;
  gate?: (roomId: string, subject: SubjectId | null) => boolean;
  onAutoRestrict?: (subject: SubjectId | null, second: boolean) => void;
}

function setup(opts: Opts = {}) {
  const store = opts.store ?? new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Logs = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const quiet: Logger = { warn() {} };
  const subjects = new SubjectIndex(store, clock, { logger: quiet });
  const roster = new RoomRoster();
  const buffer = new EvidenceBuffer({ clock });
  const flags = { sanctionsOn: true };
  const sanctions = new SanctionIndex({ enabled: () => flags.sanctionsOn, subjects });
  const strikes = new StrikeService(store, clock, subjects, { logger: quiet });
  const mutes = new MuteService(store, clock, subjects, { logger: quiet });
  const calls: Array<{ subject: SubjectId | null; second: boolean }> = [];
  const onAutoRestrict =
    opts.onAutoRestrict ?? ((subject: SubjectId | null, second: boolean) => void calls.push({ subject, second }));
  const chat = new ChatService({
    roster,
    buffer,
    subjects,
    sanctions,
    store,
    strikes,
    mutes,
    clock,
    matcher: 'matcher' in opts ? opts.matcher : stubMatcher,
    starrer: opts.starrer,
    gate: opts.gate,
    onAutoRestrict,
    logger,
  });
  /** Seat a known person (resolved from identifiers) in a seat. */
  const sit = (seat: string, ids: Identifiers | null, handle = `H-${seat}`, room = ROOM): SubjectId | null => {
    const subject = ids === null ? null : subjects.resolve(ids);
    roster.seat(room, seat, subject, handle);
    return subject;
  };
  const say = (seat: string, text: string, o?: { audience?: string[] }, room = ROOM): ChatResult =>
    chat.accept(room, seat, text, o);
  /** Apply a stored sanction against `subject` starting at the current instant. */
  const sanction = async (
    subject: SubjectId,
    kind: SanctionKind,
    durationMs: number | null,
    extra: { automated?: boolean; includeIp?: boolean } = {},
  ) => {
    await applySanction(
      store,
      subjects,
      {
        kind,
        subject,
        includeIp: extra.includeIp ?? false,
        durationMs,
        reason: 'test',
        actor: 'mod1',
        source: extra.automated ? 'auto_filter' : 'moderator',
        automated: extra.automated ?? false,
        rule: 1,
      },
      clock.t,
      sanctions,
    );
  };
  /** Advance past the rate window so budget never interferes. */
  const tick = (ms = 6 * SEC) => void (clock.t += ms);
  /** Three blocked lines spaced out; returns the instant of the third. */
  const threeSlurs = (seat = 'p1'): number => {
    for (let i = 0; i < 3; i++) {
      say(seat, 'zorbak');
      if (i < 2) tick();
    }
    return clock.t;
  };
  return {
    store,
    clock,
    logs,
    subjects,
    roster,
    buffer,
    flags,
    sanctions,
    strikes,
    mutes,
    calls,
    chat,
    sit,
    say,
    sanction,
    tick,
    threeSlurs,
  };
}

const refusal = (r: ChatResult) => {
  if (!('refuse' in r)) throw new Error('expected refusal');
  return r.refuse;
};
const delivery = (r: ChatResult) => {
  if (!('deliver' in r)) throw new Error('expected delivery');
  return r.deliver;
};

describe('basics (ChatModerator order: empty, length, rate)', () => {
  it('delivers normal text with a line id', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const d = delivery(e.say('p1', 'hello there'));
    expect(d.text).toBe('hello there');
    expect(d.lineId).toBe('1');
  });

  it('empty and whitespace-only text is the silent "empty" refusal and spends nothing', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', '')).reason).toBe('empty');
    expect(refusal(e.say('p1', '   \n\t ')).reason).toBe('empty');
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
    for (let i = 0; i < 3; i++) delivery(e.say('p1', `ok${i}`)); // full budget still there
  });

  it('trims the text it delivers', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', '  hi  ')).text).toBe('hi');
  });

  it('exactly 200 characters passes, 201 is "length"', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    delivery(e.say('p1', 'a'.repeat(200)));
    e.tick();
    expect(refusal(e.say('p1', 'a'.repeat(201))).reason).toBe('length');
  });

  it('length is judged after trimming', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    delivery(e.say('p1', `  ${'a'.repeat(200)}  `));
  });

  it('a too-long line is not buffered and spends no rate budget', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    for (let i = 0; i < 5; i++) expect(refusal(e.say('p1', 'a'.repeat(201))).reason).toBe('length');
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
    for (let i = 0; i < 3; i++) delivery(e.say('p1', `ok${i}`));
  });

  it('empty is checked before length', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', ' '.repeat(500))).reason).toBe('empty');
  });

  it('the 4th line inside 5 s is "rate"; exactly 5 s after the first it is allowed again', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) delivery(e.say('p1', `m${i}`));
    expect(refusal(e.say('p1', 'm3')).reason).toBe('rate');
    e.clock.t += 4999;
    expect(refusal(e.say('p1', 'm3')).reason).toBe('rate');
    e.clock.t += 1;
    delivery(e.say('p1', 'm4'));
  });

  it('a rate refusal is not buffered', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    for (let i = 0; i < 4; i++) e.say('p1', `m${i}`);
    expect(e.buffer.snapshot(ROOM)).toHaveLength(3);
  });

  it('rate limits do not cross-contaminate seats or rooms', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.sit('p2', who('k2'));
    e.sit('p1', who('k1'), 'H', 'R2');
    for (let i = 0; i < 3; i++) delivery(e.say('p1', `m${i}`));
    expect(refusal(e.say('p1', 'again')).reason).toBe('rate');
    delivery(e.say('p2', 'free'));
    delivery(e.say('p1', 'other room', undefined, 'R2'));
  });
});

describe('gate', () => {
  it('a false gate refuses "gate", buffering nothing and spending no rate budget', () => {
    const e = setup({ gate: () => false });
    e.sit('p1', who('k1'));
    for (let i = 0; i < 5; i++) expect(refusal(e.say('p1', 'hi')).reason).toBe('gate');
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
  });

  it('a true gate lets the line through', () => {
    const e = setup({ gate: () => true });
    e.sit('p1', who('k1'));
    delivery(e.say('p1', 'hi'));
  });

  it("is asked with the room and the sender's subject (null for an unknown speaker)", () => {
    const asked: Array<[string, SubjectId | null]> = [];
    const e = setup({ gate: (r, s) => (asked.push([r, s]), true) });
    const known = e.sit('p1', who('k1'));
    e.sit('p2', null);
    e.say('p1', 'a');
    e.say('p2', 'b');
    expect(asked).toEqual([
      [ROOM, known],
      [ROOM, null],
    ]);
  });

  it('is judged per seat: a signed-in seat chats while an anonymous one is refused', () => {
    const e = setup({ gate: (_r, s) => s !== null });
    e.sit('p1', who('k1', 'acct'));
    e.sit('p2', null);
    delivery(e.say('p1', 'hi'));
    expect(refusal(e.say('p2', 'hi')).reason).toBe('gate');
  });

  it('runs before the restriction: a gated restricted sender is told "gate"', async () => {
    const e = setup({ gate: () => false });
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H);
    expect(refusal(e.say('p1', 'hi')).reason).toBe('gate');
  });

  it('runs after the empty check: empty text from a gated sender stays silent', () => {
    const e = setup({ gate: () => false });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', '  ')).reason).toBe('empty');
  });

  it('a throwing gate refuses "gate" (fail closed), logs by class, and does not throw', () => {
    const e = setup({
      gate: () => {
        throw new TypeError('boom secret');
      },
    });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', 'hi')).reason).toBe('gate');
    expect(e.logs.some((l) => l.event === 'chat.gate_failed' && l.detail?.error === 'TypeError')).toBe(true);
    expect(JSON.stringify(e.logs)).not.toContain('secret');
  });

  it('an unknown seat, an unknown room and an unseated seat refuse "gate" without throwing', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(refusal(e.say('nope', 'hi')).reason).toBe('gate');
    expect(refusal(e.say('p1', 'hi', undefined, 'no-such-room')).reason).toBe('gate');
    e.roster.unseat(ROOM, 'p1');
    expect(refusal(e.say('p1', 'hi')).reason).toBe('gate');
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
  });
});

describe('restriction', () => {
  it('a stored chat restriction refuses "restricted" with the end time and byModerator', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H);
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + H, byModerator: true });
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
  });

  it('an automated row reports byModerator false', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H, { automated: true });
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + H, byModerator: false });
  });

  it('a permanent restriction reports until: null', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', null);
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ reason: 'restricted', until: null });
  });

  it('restricts only the person: another seat still chats', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    e.sit('p2', who('k2'));
    await e.sanction(s, 'chat', H);
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    delivery(e.say('p2', 'hi'));
  });

  it('follows the person to another seat', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H);
    e.sit('p3', who('k1'));
    expect(refusal(e.say('p3', 'hi')).reason).toBe('restricted');
  });

  it('follows a person linked by signing in: the second browser is restricted too', async () => {
    const e = setup();
    const a = e.sit('p1', who('ka')) as SubjectId;
    await e.sanction(a, 'chat', H);
    // The same person signs in on a second browser; the account links both keys.
    e.subjects.resolve(who('kb', 'acct'));
    e.subjects.resolve(who('ka', 'acct'));
    e.sit('p2', who('kb', 'acct'));
    expect(refusal(e.say('p2', 'hi')).reason).toBe('restricted');
  });

  it('an expired restriction no longer applies (end == now is over)', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H);
    e.clock.t = NOW + H - 1;
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    e.clock.t = NOW + H;
    delivery(e.say('p1', 'hi'));
  });

  it('a restriction of another kind (area) does not stop chat', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'area', H);
    delivery(e.say('p1', 'hi'));
  });

  it('a restricted sender spends no rate budget', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', 10 * SEC);
    for (let i = 0; i < 6; i++) expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    e.clock.t += 10 * SEC;
    for (let i = 0; i < 3; i++) delivery(e.say('p1', `m${i}`));
  });

  it('a restricted slur is "restricted": no strike, nothing buffered', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H);
    expect(refusal(e.say('p1', 'zorbak')).reason).toBe('restricted');
    expect(e.store.loadStrikes(0)).toEqual([]);
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
  });

  it('a stored full ban silences a seated person: byModerator true, with the ban end', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'ban', 2 * H);
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + 2 * H, byModerator: true });
  });

  it('a permanent ban reports until: null; an expired ban lets chat through', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'ban', null);
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ until: null, byModerator: true });
    const e2 = setup();
    const s2 = e2.sit('p1', who('k1')) as SubjectId;
    await e2.sanction(s2, 'ban', H);
    e2.clock.t += H;
    delivery(e2.say('p1', 'hi'));
  });

  it('with a chat restriction AND a ban the longer is reported; permanent beats timed', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H, { automated: true });
    await e.sanction(s, 'ban', 3 * H);
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + 3 * H, byModerator: true });

    const e2 = setup();
    const s2 = e2.sit('p1', who('k1')) as SubjectId;
    await e2.sanction(s2, 'chat', null);
    await e2.sanction(s2, 'ban', 3 * H);
    expect(refusal(e2.say('p1', 'hi'))).toMatchObject({ until: null });

    const e3 = setup();
    const s3 = e3.sit('p1', who('k1')) as SubjectId;
    await e3.sanction(s3, 'chat', 3 * H, { automated: true });
    await e3.sanction(s3, 'ban', H);
    expect(refusal(e3.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + 3 * H, byModerator: false });
  });

  it('a ban beats a shorter in-memory automatic restriction', async () => {
    const e = setup();
    const s = e.sit('p1', null);
    expect(s).toBeNull();
    e.threeSlurs(); // in memory: 30 min, no subject to store against
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi')).byModerator).toBe(false);
    // The same seat now holds a person who is banned for longer than the memory entry.
    const banned = e.sit('p1', who('k9')) as SubjectId;
    await e.sanction(banned, 'ban', 2 * H);
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: e.clock.t + 2 * H, byModerator: true });
  });

  it('the kill switch off: a stored ban restricts nothing', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'ban', H);
    e.flags.sanctionsOn = false;
    delivery(e.say('p1', 'hi'));
    e.flags.sanctionsOn = true;
    e.tick();
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
  });

  it('an IP row restricts a seated person whose latest IP it is, and only that', async () => {
    const e = setup();
    const a = e.sit('p1', who('ka', null, 'ip-1')) as SubjectId;
    await e.sanction(a, 'chat', H, { includeIp: true });
    e.sit('p2', who('kb', null, 'ip-1')); // a housemate behind the same address
    e.sit('p3', who('kc', null, 'ip-2'));
    expect(refusal(e.say('p2', 'hi'))).toMatchObject({ reason: 'restricted', byModerator: true });
    delivery(e.say('p3', 'hi'));
  });

  it('an IP row never restricts a speaker with no subject (no IP to look up)', async () => {
    const e = setup();
    const a = e.sit('p1', who('ka', null, 'ip-1')) as SubjectId;
    await e.sanction(a, 'chat', H, { includeIp: true });
    e.sit('p2', null);
    delivery(e.say('p2', 'hi'));
  });

  it('never returns an identifier in a refusal', async () => {
    const e = setup();
    const s = e.sit('p1', who('keyval-1', 'acct-9', 'iphash-7')) as SubjectId;
    await e.sanction(s, 'chat', H, { includeIp: true });
    const text = JSON.stringify(e.say('p1', 'hi'));
    for (const secret of [s, 'keyval-1', 'acct-9', 'iphash-7', 'M-']) expect(text).not.toContain(secret);
  });

  it('a throwing sanction index does not throw: the line goes through', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.sanctions.active = () => {
      throw new Error('x');
    };
    delivery(e.say('p1', 'hi'));
    expect(e.logs.some((l) => l.event === 'chat.restriction_failed')).toBe(true);
  });
});

describe('matcher, strikes and the automatic timeout', () => {
  it('a hit refuses "blocked" and buffers the raw line with blocked=true, delivered=null', () => {
    const e = setup();
    const s = e.sit('p1', who('k1'), 'Pat');
    expect(refusal(e.say('p1', '  you zorbak  '))).toEqual({ reason: 'blocked' });
    expect(e.buffer.snapshot(ROOM)[0]).toMatchObject({
      seatId: 'p1',
      handle: 'Pat',
      subject: s,
      raw: 'you zorbak',
      delivered: null,
      blocked: true,
      audience: null,
      ts: NOW,
    });
  });

  it('the matcher sees the trimmed text', () => {
    const e = setup();
    seen.length = 0;
    e.sit('p1', who('k1'));
    e.say('p1', '  hello  ');
    expect(seen).toEqual(['hello']);
  });

  it('the matched term never reaches the refusal', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const text = JSON.stringify(e.say('p1', 'zorbak'));
    expect(text).not.toContain('zorbak');
    expect(text).not.toContain('syn:');
  });

  it('records a strike for a blocked line, and none for a clean one', () => {
    const e = setup();
    const s = e.sit('p1', who('k1'));
    e.say('p1', 'fine');
    expect(e.store.loadStrikes(0)).toHaveLength(0);
    e.tick();
    e.say('p1', 'zorbak');
    const rows = e.store.loadStrikes(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: s, roomId: ROOM, termId: 'syn:zorbak', rawLine: 'zorbak', at: e.clock.t });
  });

  it('the strike keeps the line the person typed, trimmed (so padding cannot inflate storage), for the later notice', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.say('p1', ' zorbak! ');
    expect(e.store.loadStrikes(0)[0]?.rawLine).toBe('zorbak!');
  });

  it('rate budget spent by a blocked line', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.say('p1', 'zorbak');
    e.say('p1', 'zorbak');
    delivery(e.say('p1', 'clean'));
    expect(refusal(e.say('p1', 'clean 2')).reason).toBe('rate');
  });

  it('a slur sent over the rate limit is a rate refusal, not a strike (rate is checked first)', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) e.say('p1', `m${i}`);
    expect(refusal(e.say('p1', 'zorbak')).reason).toBe('rate');
    expect(e.store.loadStrikes(0)).toEqual([]);
    expect(e.buffer.snapshot(ROOM)).toHaveLength(3);
  });

  it('a slur longer than 200 characters is a length refusal, not a strike', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', `zorbak ${'a'.repeat(300)}`)).reason).toBe('length');
    expect(e.store.loadStrikes(0)).toEqual([]);
  });

  it('without a matcher nothing is ever blocked', () => {
    const e = setup({ matcher: undefined });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'zorbak')).text).toBe('zorbak');
    expect(e.store.loadStrikes(0)).toEqual([]);
  });

  it('a throwing matcher lets the line through and logs by class only', () => {
    const e = setup({
      matcher: {
        match() {
          throw new RangeError('zorbak inside');
        },
      },
    });
    e.sit('p1', who('k1'));
    delivery(e.say('p1', 'hi'));
    expect(e.logs.some((l) => l.event === 'chat.matcher_failed' && l.detail?.error === 'RangeError')).toBe(true);
    expect(JSON.stringify(e.logs)).not.toContain('zorbak');
  });

  it('a blocked line carries its audience into the buffer', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.say('p1', 'zorbak', { audience: ['p1', 'p2'] });
    expect(e.buffer.snapshot(ROOM)[0]?.audience).toEqual(['p1', 'p2']);
  });

  it('two blocked lines are not enough to restrict', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    for (let i = 0; i < 2; i++) {
      e.say('p1', 'zorbak');
      e.tick();
    }
    delivery(e.say('p1', 'fine'));
    expect(e.calls).toEqual([]);
  });

  it('strikes older than an hour do not count', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) {
      e.say('p1', 'zorbak');
      e.clock.t += 31 * MIN;
    }
    expect(e.calls).toEqual([]);
  });

  it('third blocked line within an hour restricts chat 30 min', () => {
    const e = setup();
    const s = e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) {
      expect(refusal(e.say('p1', 'zorbak')).reason).toBe('blocked');
      if (i < 2) e.tick();
    }
    const strikeAt = e.clock.t;
    expect(e.calls).toEqual([{ subject: s, second: false }]);
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hello'))).toEqual({
      reason: 'restricted',
      until: strikeAt + 30 * MIN,
      byModerator: false,
    });
    // Over after exactly 30 minutes.
    e.clock.t = strikeAt + 30 * MIN;
    delivery(e.say('p1', 'hello'));
  });

  it('the stored timeout is an automated chat row from source auto_filter, started at the strike instant', () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    const at = e.threeSlurs();
    const rows = e.store.loadSanctions(at);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'chat',
      targetType: 'subject',
      value: s,
      source: 'auto_filter',
      automated: true,
      actor: 'auto',
      reason: 'auto: repeated slurs',
      startsAt: at,
      endsAt: at + 30 * MIN,
    });
    expect(e.store.loadStrikes(0).map((x) => x.at)).toContain(rows[0]?.startsAt);
  });

  it('the automatic timeout cites Community Rule 1 and carries no rule-gap note', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.threeSlurs();
    const raw = e.store.rawSanctions();
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ kind: 'chat', source: 'auto_filter', rule: '1', gapNote: null, gapStatus: null });
  });

  it('a warning never restricts chat', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1', null, 'ip-1'));
    await e.sanction(s as string, 'warning', null);
    expect('deliver' in e.say('p1', 'hello')).toBe(true);
    e.tick();
    await e.sanction(s as string, 'warning', null);
    e.tick();
    expect('deliver' in e.say('p1', 'still fine')).toBe(true);
  });

  it('a warning does not hide a real timeout or ban', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1'));
    await e.sanction(s as string, 'warning', null);
    await e.sanction(s as string, 'chat', H);
    expect(refusal(e.say('p1', 'hello'))).toMatchObject({ reason: 'restricted' });
  });

  it('the automatic timeout writes no IP row (a timeout must not hit a household)', () => {
    const e = setup();
    e.sit('p1', who('k1', null, 'ip-1'));
    e.threeSlurs();
    expect(e.store.loadSanctions(e.clock.t).map((r) => r.targetType)).toEqual(['subject']);
  });

  it('strikes are per person: the same slur from two seats does not add up', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.sit('p2', who('k2'));
    for (let i = 0; i < 3; i++) {
      e.say(i === 1 ? 'p2' : 'p1', 'zorbak');
      e.tick();
    }
    expect(e.calls).toEqual([]);
  });

  it('strikes follow the person across seats', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.sit('p2', who('k1'));
    for (const seat of ['p1', 'p2', 'p1']) {
      e.say(seat, 'zorbak');
      e.tick();
    }
    expect(e.calls).toHaveLength(1);
  });

  it('a repeat offender gets 24 hours and onAutoRestrict is told it is the second', () => {
    const e = setup();
    const s = e.sit('p1', who('k1'));
    e.threeSlurs();
    e.clock.t += 31 * MIN;
    const second = e.threeSlurs();
    expect(e.calls).toEqual([
      { subject: s, second: false },
      { subject: s, second: true },
    ]);
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: second + 24 * H, byModerator: false });
  });

  it('the strikes that earned a timeout are consumed, also after a restart', async () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.threeSlurs();
    // New process over the same store.
    const quiet: Logger = { warn() {} };
    const subjects2 = new SubjectIndex(e.store, e.clock, { logger: quiet });
    await subjects2.load();
    const strikes2 = new StrikeService(e.store, e.clock, subjects2, { logger: quiet });
    await strikes2.load();
    const s = subjects2.resolve(who('k1')) as SubjectId;
    e.clock.t += 31 * MIN; // timeout over; the old strikes are inside the hour but were consumed
    expect(strikes2.record(s, 'rk', ROOM, 't', 'x').autoRestrict).toBeNull();
    expect(strikes2.record(s, 'rk', ROOM, 't', 'x').autoRestrict).toBeNull();
  });

  it('a speaker with no subject is restricted in memory, enforced at the gate, then forgotten', () => {
    const e = setup();
    e.sit('p1', null);
    const at = e.threeSlurs();
    expect(e.store.loadSanctions(at)).toEqual([]);
    expect(e.calls).toEqual([{ subject: null, second: false }]);
    const end = at + 30 * MIN;
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: end, byModerator: false });
    e.clock.t = end - 1;
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    e.clock.t = end;
    delivery(e.say('p1', 'hi'));
  });

  it('an in-memory restriction is per seat and per room', () => {
    const e = setup();
    e.sit('p1', null);
    e.sit('p2', null);
    e.sit('p1', null, 'H', 'R2');
    e.threeSlurs();
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    delivery(e.say('p2', 'hi'));
    delivery(e.say('p1', 'hi', undefined, 'R2'));
  });

  it('a store that fails while the timeout is applied does not throw and still restricts, in memory', () => {
    const e = setup({ store: new FailingSanctions() });
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) {
      expect(refusal(e.say('p1', 'zorbak')).reason).toBe('blocked');
      if (i < 2) e.tick();
    }
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ reason: 'restricted', byModerator: false });
    expect(e.calls).toHaveLength(1);
  });

  it('the rejected write is logged by class (no unhandled rejection) and carries nothing sensitive', async () => {
    const e = setup({ store: new FailingSanctions() });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    await new Promise((r) => setTimeout(r, 0));
    const log = e.logs.find((l) => l.event === 'chat.auto_restrict_failed');
    expect(log?.detail).toEqual({ error: 'Error' });
    expect(JSON.stringify(e.logs)).not.toMatch(/disk full|zorbak/);
  });

  it('a stored timeout can be revoked: no memory entry is left behind to keep restricting', async () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const at = e.threeSlurs();
    const group = e.store.loadSanctions(at)[0]?.groupId as string;
    await revokeSanction(e.store, group, 'mod', at, 'ok', e.sanctions);
    e.tick(SEC);
    delivery(e.say('p1', 'hi'));
  });

  it('a throwing onAutoRestrict cannot break the chat path and is logged by class', () => {
    const e = setup({
      onAutoRestrict: () => {
        throw new SyntaxError('feed down');
      },
    });
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) {
      expect(refusal(e.say('p1', 'zorbak')).reason).toBe('blocked');
      if (i < 2) e.tick();
    }
    expect(e.logs.some((l) => l.event === 'chat.on_auto_restrict_failed' && l.detail?.error === 'SyntaxError')).toBe(
      true,
    );
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
  });

  it('the kill switch off: the strike is kept and the line blocked, but nothing is enforced or announced', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.flags.sanctionsOn = false;
    for (let i = 0; i < 3; i++) {
      expect(refusal(e.say('p1', 'zorbak')).reason).toBe('blocked');
      if (i < 2) e.tick();
    }
    expect(e.store.loadStrikes(0)).toHaveLength(3);
    expect(e.store.loadSanctions(e.clock.t)).toEqual([]);
    expect(e.calls).toEqual([]);
    e.tick(SEC);
    e.flags.sanctionsOn = true;
    delivery(e.say('p1', 'hi')); // no row, and nothing held in memory either
  });

  it('store throws on strike write: refusal still returned, and the strikes still add up in memory', () => {
    const e = setup({ store: new FailingStrikes() });
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) {
      expect(refusal(e.say('p1', 'zorbak')).reason).toBe('blocked');
      if (i < 2) e.tick();
    }
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
  });

  it('a throwing evidence buffer never makes accept throw', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.buffer.append = () => {
      throw new Error('oom');
    };
    expect(() => e.say('p1', 'hi')).not.toThrow();
    expect(() => e.say('p1', 'zorbak')).not.toThrow();
    expect(refusal(e.say('p1', 'zorbak')).reason).toBe('blocked');
  });
});

describe('review fixes: async hook, non-boolean gate, in-memory restriction belongs to the person', () => {
  it('an async onAutoRestrict that rejects is logged and raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const e = setup({
        onAutoRestrict: (async () => {
          throw new SyntaxError('feed down');
        }) as unknown as () => void,
      });
      e.sit('p1', who('k1'));
      e.threeSlurs();
      await new Promise((r) => setTimeout(r, 10));
      expect(e.logs.some((l) => l.event === 'chat.on_auto_restrict_failed' && l.detail?.error === 'SyntaxError')).toBe(
        true,
      );
      expect(JSON.stringify(e.logs)).not.toContain('feed down');
      expect(unhandled).toEqual([]);
      e.tick(SEC);
      expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('an async onAutoRestrict that resolves is fine and logs nothing', async () => {
    const e = setup({ onAutoRestrict: (async () => undefined) as unknown as () => void });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    await new Promise((r) => setTimeout(r, 0));
    expect(e.logs).toEqual([]);
  });

  it('a gate that returns a non-boolean (a Promise, a truthy value) does not pass', () => {
    const asyncGate = (() => Promise.resolve(true)) as unknown as () => boolean;
    const e = setup({ gate: asyncGate });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', 'hi')).reason).toBe('gate');
    const e2 = setup({ gate: (() => 1) as unknown as () => boolean });
    e2.sit('p1', who('k1'));
    expect(refusal(e2.say('p1', 'hi')).reason).toBe('gate');
  });

  it('seat changes hands after a memory fallback: the new occupant can chat', () => {
    const e = setup();
    e.sit('p1', null, 'Guest');
    e.threeSlurs();
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    e.sit('p1', who('k2'), 'Newcomer');
    delivery(e.say('p1', 'hello'));
  });

  it('a stored-fallback timeout (write failed) also stays with the person, not the seat', () => {
    const e = setup({ store: new FailingSanctions() });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    e.tick(SEC);
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    e.sit('p1', who('k2'));
    delivery(e.say('p1', 'hello'));
  });

  it('the same person staying in the seat is still restricted (also re-seated, and linked by merge)', () => {
    const e = setup({ store: new FailingSanctions() });
    e.sit('p1', who('ka'));
    e.threeSlurs();
    e.tick(SEC);
    e.sit('p1', who('ka'), 'renamed');
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
    // Merged into another subject since: still the same person.
    e.subjects.resolve(who('kb', 'acct'));
    e.subjects.resolve(who('ka', 'acct'));
    e.sit('p1', who('kb', 'acct'));
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
  });

  it('a guest who leaves and a different guest sits: both have no subject, so the entry still applies (accepted)', () => {
    const e = setup();
    e.sit('p1', null, 'Guest A');
    e.threeSlurs();
    e.tick(SEC);
    e.sit('p1', null, 'Guest B');
    expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
  });

  it("a roomId containing ':' does not collide with another room's seat", () => {
    const e = setup();
    // 'a:b' + seat 'c' versus 'a' + seat 'b:c' would both be 'a:b:c' with a colon separator.
    e.sit('c', null, 'G1', 'a:b');
    e.sit('b:c', null, 'G2', 'a');
    for (let i = 0; i < 3; i++) {
      e.say('c', 'zorbak', undefined, 'a:b');
      if (i < 2) e.tick();
    }
    e.tick(SEC);
    expect(refusal(e.say('c', 'hi', undefined, 'a:b')).reason).toBe('restricted');
    delivery(e.say('b:c', 'hi', undefined, 'a'));
  });
});

describe('starring and delivery', () => {
  it('stars profanity with the injected starrer and delivers the starred text, with no strike', () => {
    const e = setup({ starrer });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'oh snerp it')).text).toBe('oh ***** it');
    expect(e.store.loadStrikes(0)).toEqual([]);
  });

  it('without a starrer text is delivered as typed (trimmed)', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', ' oh snerp ')).text).toBe('oh snerp');
  });

  it('a blocked term wins over starring: the line is refused, not starred', () => {
    const e = setup({ starrer });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', 'snerp zorbak')).reason).toBe('blocked');
  });

  it('a throwing starrer does not throw out of accept', () => {
    const e = setup({
      starrer: {
        star() {
          throw new Error('x');
        },
      },
    });
    e.sit('p1', who('k1'));
    expect(() => e.say('p1', 'hi')).not.toThrow();
  });

  it('buffers the delivered line: subject, handle, raw, starred text, audience', () => {
    const e = setup({ starrer });
    const s = e.sit('p1', who('k1'), 'Pat');
    const d = delivery(e.say('p1', '  oh snerp ', { audience: ['p1', 'p2'] }));
    expect(e.buffer.get(ROOM, d.lineId)).toMatchObject({
      lineId: d.lineId,
      ts: NOW,
      seatId: 'p1',
      handle: 'Pat',
      subject: s,
      raw: 'oh snerp',
      delivered: 'oh *****',
      blocked: false,
      audience: ['p1', 'p2'],
    });
  });

  it('a line with no audience option goes to the whole room (audience null)', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const d = delivery(e.say('p1', 'hi'));
    expect(e.buffer.get(ROOM, d.lineId)?.audience).toBeNull();
  });

  it("the caller's audience array is copied, not shared", () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const aud = ['p1', 'p2'];
    const d = delivery(e.say('p1', 'hi', { audience: aud }));
    aud.push('p9');
    expect(e.buffer.get(ROOM, d.lineId)?.audience).toEqual(['p1', 'p2']);
  });

  it('line ids are distinct per line, blocked lines included', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const a = delivery(e.say('p1', 'one')).lineId;
    e.say('p1', 'zorbak');
    const b = delivery(e.say('p1', 'two')).lineId;
    expect(new Set([a, b]).size).toBe(2);
    expect(e.buffer.snapshot(ROOM).map((l) => l.lineId)).toEqual(['1', '2', '3']);
  });

  it('a seat that changed hands: each line names the person who held the seat then', () => {
    const e = setup();
    const first = e.sit('p1', who('k1'), 'Ann');
    const a = delivery(e.say('p1', 'mine'));
    e.sit('p1', who('k2'), 'Bob');
    e.tick();
    const b = delivery(e.say('p1', 'his'));
    expect(e.buffer.get(ROOM, a.lineId)).toMatchObject({ subject: first, handle: 'Ann' });
    const second = e.buffer.get(ROOM, b.lineId);
    expect(second).toMatchObject({ handle: 'Bob' });
    expect(second?.subject).not.toBe(first);
  });

  it('a speaker with no subject is buffered with a null subject', () => {
    const e = setup();
    e.sit('p1', null, 'Guest');
    const d = delivery(e.say('p1', 'hi'));
    expect(e.buffer.get(ROOM, d.lineId)).toMatchObject({ subject: null, handle: 'Guest' });
  });

  it('a delivery carries only the line id and the text', () => {
    const e = setup();
    e.sit('p1', who('keyval-1', 'acct-9', 'iphash-7'));
    const r = e.say('p1', 'hi');
    expect(Object.keys(delivery(r)).sort()).toEqual(['lineId', 'text']);
    expect(Object.keys(r)).toEqual(['deliver']);
  });
});

describe('visibleTo', () => {
  it('visibleTo hides a muted sender from that viewer only, never from the sender', () => {
    const e = setup();
    const viewer = e.sit('p1', who('k1')) as SubjectId;
    const sender = e.sit('p2', who('k2')) as SubjectId;
    e.sit('p3', who('k3'));
    e.mutes.set(viewer, sender, true);
    expect(e.chat.visibleTo(ROOM, 'p1', 'p2')).toBe(false); // the muter
    expect(e.chat.visibleTo(ROOM, 'p3', 'p2')).toBe(true); // another viewer
    expect(e.chat.visibleTo(ROOM, 'p2', 'p2')).toBe(true); // the sender's own seat
    expect(e.chat.visibleTo(ROOM, 'p2', 'p1')).toBe(true); // directional
  });

  it("the sender's own seat is visible even when they muted themselves", () => {
    const e = setup();
    const a = e.sit('p1', who('k1')) as SubjectId;
    e.mutes.set(a, a, true);
    expect(e.chat.visibleTo(ROOM, 'p1', 'p1')).toBe(true);
  });

  it('is visible when nobody muted anyone', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.sit('p2', who('k2'));
    expect(e.chat.visibleTo(ROOM, 'p1', 'p2')).toBe(true);
  });

  it('a mute follows the muted person to another seat', () => {
    const e = setup();
    const viewer = e.sit('p1', who('k1')) as SubjectId;
    const target = e.sit('p2', who('k2')) as SubjectId;
    e.mutes.set(viewer, target, true);
    e.sit('p4', who('k2'));
    expect(e.chat.visibleTo(ROOM, 'p1', 'p4')).toBe(false);
  });

  it('a seat that changed hands is judged by its current occupant', () => {
    const e = setup();
    const viewer = e.sit('p1', who('k1')) as SubjectId;
    const target = e.sit('p2', who('k2')) as SubjectId;
    e.mutes.set(viewer, target, true);
    expect(e.chat.visibleTo(ROOM, 'p1', 'p2')).toBe(false);
    e.sit('p2', who('k9'));
    expect(e.chat.visibleTo(ROOM, 'p1', 'p2')).toBe(true);
  });

  it('seats with no subject (AI, unknown) are visible', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.sit('p2', null);
    e.sit('p3', null);
    expect(e.chat.visibleTo(ROOM, 'p1', 'p2')).toBe(true);
    expect(e.chat.visibleTo(ROOM, 'p3', 'p1')).toBe(true);
  });

  it('unknown seats and unknown rooms are visible and never throw', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(e.chat.visibleTo(ROOM, 'p1', 'ghost')).toBe(true);
    expect(e.chat.visibleTo(ROOM, 'ghost', 'p1')).toBe(true);
    expect(e.chat.visibleTo('nowhere', 'a', 'b')).toBe(true);
  });

  it('a broken mute store must not silence the room: any error means visible', () => {
    const e = setup();
    const viewer = e.sit('p1', who('k1')) as SubjectId;
    const target = e.sit('p2', who('k2')) as SubjectId;
    e.mutes.set(viewer, target, true);
    e.mutes.isMuted = () => {
      throw new Error('broken');
    };
    expect(e.chat.visibleTo(ROOM, 'p1', 'p2')).toBe(true);
  });

  it('a muted line is still delivered and buffered as evidence (visibility is a delivery decision)', () => {
    const e = setup();
    const viewer = e.sit('p1', who('k1')) as SubjectId;
    const target = e.sit('p2', who('k2')) as SubjectId;
    e.mutes.set(viewer, target, true);
    const d = delivery(e.say('p2', 'hello'));
    expect(e.buffer.get(ROOM, d.lineId)?.delivered).toBe('hello');
  });
});

describe('never throws', () => {
  it('survives garbage input', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    for (const bad of [undefined, null, 42, {}] as unknown[]) {
      expect(() => e.chat.accept(ROOM, 'p1', bad as string)).not.toThrow();
    }
  });
});

describe('final review: padded lines, rate key separator', () => {
  const PAD = ' '.repeat(1_000_000);

  it('a 150-char line padded with 1 MB of spaces each side is delivered; the buffered raw is the trimmed text', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const line = 'a'.repeat(150);
    const d = delivery(e.say('p1', PAD + line + PAD));
    expect(d.text).toBe(line);
    const [row] = e.buffer.snapshot(ROOM);
    expect(row?.raw.length).toBeLessThanOrEqual(200); // first: a failing string diff of 2 MB is very slow
    expect(row?.raw).toBe(line);
  });

  it('a blocked line padded with 1 MB of spaces: buffered raw and the strike rawLine are the trimmed text', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', PAD + 'zorbak' + PAD))).toEqual({ reason: 'blocked' });
    const [row] = e.buffer.snapshot(ROOM);
    expect(row?.raw.length).toBeLessThanOrEqual(200);
    expect(row?.raw).toBe('zorbak');
    const strikes = e.store.loadStrikes(0);
    expect(strikes).toHaveLength(1);
    expect(strikes[0]?.rawLine.length).toBeLessThanOrEqual(200);
    expect(strikes[0]?.rawLine).toBe('zorbak');
  });

  it('a blocked 150-char line padded with spaces keeps raw and rawLine at most 200 characters', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    const line = 'a'.repeat(140) + ' zorbak';
    expect(refusal(e.say('p1', PAD + line + PAD))).toEqual({ reason: 'blocked' });
    expect(e.buffer.snapshot(ROOM)[0]?.raw.length).toBeLessThanOrEqual(200);
    expect(e.store.loadStrikes(0)[0]?.rawLine.length).toBeLessThanOrEqual(200);
  });

  it('a trimmed line over 200 is still refused for length even with padding (control)', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', PAD + 'a'.repeat(201) + PAD))).toEqual({ reason: 'length' });
    expect(e.buffer.snapshot(ROOM)).toHaveLength(0);
  });

  it('a ":" in an id does not share a rate budget: room "a:b"/seat "c" vs room "a"/seat "b:c"', () => {
    const e = setup();
    e.sit('c', who('k1'), 'H1', 'a:b');
    e.sit('b:c', who('k2'), 'H2', 'a');
    for (let i = 0; i < 3; i++) delivery(e.say('c', `hi ${i}`, undefined, 'a:b'));
    expect(refusal(e.say('c', 'hi 3', undefined, 'a:b'))).toEqual({ reason: 'rate' });
    delivery(e.say('b:c', 'other seat, own budget', undefined, 'a'));
  });

  it('the same room and seat still share one budget (control)', () => {
    const e = setup();
    e.sit('c', who('k1'), 'H1', 'a:b');
    for (let i = 0; i < 3; i++) delivery(e.say('c', `hi ${i}`, undefined, 'a:b'));
    expect(refusal(e.say('c', 'again', undefined, 'a:b'))).toEqual({ reason: 'rate' });
  });
});
