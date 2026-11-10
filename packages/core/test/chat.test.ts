import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/chat.js';
import type { ChatResult } from '../src/chat.js';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { MuteService } from '../src/mutes.js';
import { NoticeService } from '../src/notices.js';
import { CommunityRules, STARTER_RULES } from '../src/rules.js';
import type { RuleRef } from '../src/rules.js';
import { applySanction, revokeSanction, SanctionIndex } from '../src/sanctions.js';
import { StrikeService } from '../src/strikes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, Matcher, ProfanityFilter, SanctionKind, SubjectId } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

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
  spans(text: string) {
    return [...text.matchAll(/\bzorbak\b/gi)].map((m) => ({ start: m.index, end: m.index + m[0].length, termId: 'syn:zorbak' }));
  },
};
// Synthetic profanity only: the stub filter treats the word 'snerp' as swearing and stars it.
const filter: ProfanityFilter = {
  apply: (t) => ({ hit: /\bsnerp\b/i.test(t), text: t.replace(/\bsnerp\b/gi, '*****') }),
};

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
class RewritesRule extends MemoryStore {
  /** When not undefined, `loadSanctions` reports this as every row's rule (a corrupt or pre-rules value). */
  storedRule: string | null | undefined = undefined;
  override loadSanctions(now: number) {
    return super.loadSanctions(now).map((r) => (this.storedRule === undefined ? r : { ...r, rule: this.storedRule }));
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
  profanity?: ProfanityFilter | undefined;
  profanityMode?: 'allow' | 'star' | 'refuse';
  gate?: (roomId: string, subject: SubjectId | null) => boolean;
  onAutoRestrict?: (subject: SubjectId | null, second: boolean) => void;
  /** Hand the chat service a NoticeService: true is a real one on the same store, or pass a replacement. */
  notices?: boolean | NoticeService;
  /** The push hook of the real NoticeService. */
  notify?: (subject: SubjectId, event: { type: 'notice_pending'; count: number }) => unknown;
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
  const realNotices = new NoticeService({
    store,
    subjects,
    rules: new CommunityRules(STARTER_RULES),
    clock,
    matcher: stubMatcher,
    logger: quiet,
    notify: opts.notify,
  });
  const notices =
    opts.notices === undefined || opts.notices === false ? undefined : opts.notices === true ? realNotices : opts.notices;
  const chat = new ChatService({
    notices,
    roster,
    buffer,
    subjects,
    sanctions,
    store,
    strikes,
    mutes,
    clock,
    matcher: 'matcher' in opts ? opts.matcher : stubMatcher,
    profanity: opts.profanity,
    profanityMode: opts.profanityMode,
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
    extra: { automated?: boolean; includeIp?: boolean; rule?: RuleRef; gapNote?: string } = {},
  ) => {
    return await applySanction(
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
        rule: extra.rule ?? 1,
        ...(extra.gapNote === undefined ? {} : { gapNote: extra.gapNote }),
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
    realNotices,
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
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + H, byModerator: true, rule: 1 });
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
  });

  it('an automated row reports byModerator false', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H, { automated: true });
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + H, byModerator: false, rule: 1 });
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
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + 2 * H, byModerator: true, rule: 1 });
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
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + 3 * H, byModerator: true, rule: 1 });

    const e2 = setup();
    const s2 = e2.sit('p1', who('k1')) as SubjectId;
    await e2.sanction(s2, 'chat', null);
    await e2.sanction(s2, 'ban', 3 * H);
    expect(refusal(e2.say('p1', 'hi'))).toMatchObject({ until: null });

    const e3 = setup();
    const s3 = e3.sit('p1', who('k1')) as SubjectId;
    await e3.sanction(s3, 'chat', 3 * H, { automated: true });
    await e3.sanction(s3, 'ban', H);
    expect(refusal(e3.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: NOW + 3 * H, byModerator: false, rule: 1 });
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
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: e.clock.t + 2 * H, byModerator: true, rule: 1 });
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

class FlakySanctions extends MemoryStore {
  failWrites = false;
  override insertSanctionGroup(...args: Parameters<MemoryStore['insertSanctionGroup']>): boolean {
    if (this.failWrites) throw new Error('disk full');
    return super.insertSanctionGroup(...args);
  }
}

describe('restricted(): the typing-indicator lookup answers what accept answers', () => {
  const NONE = { restricted: false, until: null, kind: null };

  /** accept's verdict for the seat, then restricted()'s for the same person: the one must follow from the other. */
  const agree = (e: ReturnType<typeof setup>, seat: string, subject: SubjectId | null, room: string = ROOM) => {
    const answer = e.chat.restricted(subject, room);
    const verdict = e.say(seat, 'hi', undefined, room);
    if ('deliver' in verdict) {
      expect(answer, 'accept delivered').toEqual(NONE);
    } else {
      const r = verdict.refuse;
      expect(r.reason).toBe('restricted');
      expect(answer.restricted, 'accept refused').toBe(true);
      if (r.rule !== undefined) {
        // The speaker's own sanction: restricted() carries the same end, and the kind explains byModerator.
        expect(answer.until).toBe(r.until);
        expect(answer.kind === 'auto').toBe(r.byModerator === false);
      }
    }
    return answer;
  };

  it('a stored chat restriction: restricted, with its end and kind chat', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H);
    expect(e.chat.restricted(s, ROOM)).toEqual({ restricted: true, until: NOW + H, kind: 'chat' });
    expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: NOW + H, kind: 'chat' });
  });

  it('an automated row is kind auto (accept: byModerator false)', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H, { automated: true });
    expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: NOW + H, kind: 'auto' });
  });

  it('a permanent restriction has until null', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', null);
    expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: null, kind: 'chat' });
  });

  it('a stored full ban is kind ban, with its end; a permanent ban has until null', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'ban', H);
    expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: NOW + H, kind: 'ban' });
    const e2 = setup();
    const s2 = e2.sit('p1', who('k1')) as SubjectId;
    await e2.sanction(s2, 'ban', null);
    expect(agree(e2, 'p1', s2)).toEqual({ restricted: true, until: null, kind: 'ban' });
  });

  it('an account-only person, a key-only person and a linked second browser are all found; a stranger is not', async () => {
    const e = setup();
    const byAccount = e.sit('p1', who(null, 'acct-1')) as SubjectId;
    const byKey = e.sit('p2', who('key-2')) as SubjectId;
    await e.sanction(byAccount, 'chat', H);
    await e.sanction(byKey, 'chat', H);
    expect(agree(e, 'p1', byAccount).restricted).toBe(true);
    expect(agree(e, 'p2', byKey).restricted).toBe(true);
    const linked = e.sit('p3', who('key-2b', 'acct-1')) as SubjectId;
    expect(agree(e, 'p3', linked).restricted).toBe(true);
    const other = e.sit('p4', who('key-other')) as SubjectId;
    expect(agree(e, 'p4', other)).toEqual(NONE);
  });

  it('chat plus ban: the longer is reported, permanent beats timed, a tie keeps the stored chat row (as accept)', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H, { automated: true });
    await e.sanction(s, 'ban', 3 * H);
    expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: NOW + 3 * H, kind: 'ban' });

    const e2 = setup();
    const s2 = e2.sit('p1', who('k1')) as SubjectId;
    await e2.sanction(s2, 'chat', null);
    await e2.sanction(s2, 'ban', 3 * H);
    expect(agree(e2, 'p1', s2)).toEqual({ restricted: true, until: null, kind: 'chat' });

    const e3 = setup();
    const s3 = e3.sit('p1', who('k1')) as SubjectId;
    await e3.sanction(s3, 'chat', 3 * H, { automated: true });
    await e3.sanction(s3, 'ban', H);
    expect(agree(e3, 'p1', s3)).toEqual({ restricted: true, until: NOW + 3 * H, kind: 'auto' });
  });

  it('expired (end == now is over) is not restricted', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'chat', H);
    e.clock.t = NOW + H - 1;
    expect(agree(e, 'p1', s).restricted).toBe(true);
    e.clock.t = NOW + H;
    expect(agree(e, 'p1', s)).toEqual(NONE);
  });

  it('a revoked sanction is not restricted', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    const g = await e.sanction(s, 'chat', H);
    expect(e.chat.restricted(s, ROOM).restricted).toBe(true);
    await revokeSanction(e.store, g.groupId, 'mod', e.clock.t, 'ok', e.sanctions);
    expect(agree(e, 'p1', s)).toEqual(NONE);
  });

  it('a restriction of another kind (area), a warning and a note do not count', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'area', H);
    await e.sanction(s, 'warning', null);
    await e.sanction(s, 'note', null);
    expect(agree(e, 'p1', s)).toEqual(NONE);
  });

  it('the kill switch off: nothing is restricted; back on, it is again', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1')) as SubjectId;
    await e.sanction(s, 'ban', H);
    e.flags.sanctionsOn = false;
    expect(agree(e, 'p1', s)).toEqual(NONE);
    e.flags.sanctionsOn = true;
    expect(e.chat.restricted(s, ROOM).restricted).toBe(true);
  });

  it('no subject (a guest without identifiers): not restricted, even with an IP row about', async () => {
    const e = setup();
    const a = e.sit('p1', who('ka', null, 'ip-1')) as SubjectId;
    await e.sanction(a, 'chat', H, { includeIp: true });
    e.sit('p2', null);
    expect(agree(e, 'p2', null)).toEqual(NONE);
    expect(e.chat.restricted(null)).toEqual(NONE);
    expect(e.chat.restricted(null, null)).toEqual(NONE);
  });

  it('an IP row reaches only a person whose latest address it is', async () => {
    const e = setup();
    const a = e.sit('p1', who('ka', null, 'ip-1')) as SubjectId;
    await e.sanction(a, 'chat', H, { includeIp: true });
    const noIp = e.sit('p2', who('kb')) as SubjectId;
    const other = e.sit('p3', who('kc', null, 'ip-2')) as SubjectId;
    expect(agree(e, 'p2', noIp)).toEqual(NONE);
    expect(agree(e, 'p3', other)).toEqual(NONE);
  });

  describe('the in-memory automatic restriction', () => {
    const memory = (store: MemoryStore = new FailingSanctions()) => {
      const e = setup({ store });
      const s = e.sit('p1', who('k1')) as SubjectId;
      const at = e.threeSlurs();
      e.tick(SEC);
      return { e, s, end: at + 30 * MIN };
    };

    it('is kind auto with its end, for the person who earned it', () => {
      const { e, s, end } = memory();
      expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: end, kind: 'auto' });
    });

    it('is scoped to its room when a room is given, and to every room when not', () => {
      const { e, s, end } = memory();
      expect(e.chat.restricted(s, ROOM).until).toBe(end);
      expect(e.chat.restricted(s, 'R2')).toEqual(NONE);
      expect(e.chat.restricted(s)).toEqual({ restricted: true, until: end, kind: 'auto' });
      expect(e.chat.restricted(s, null)).toEqual({ restricted: true, until: end, kind: 'auto' });
      // Control: accept agrees the other room is open.
      e.sit('p1', who('k1'), 'H', 'R2');
      delivery(e.say('p1', 'hi', undefined, 'R2'));
    });

    it('belongs to the person: another person is not restricted', () => {
      const { e, s } = memory();
      const other = e.sit('p2', who('k2')) as SubjectId;
      expect(agree(e, 'p2', other)).toEqual(NONE);
      expect(e.chat.restricted(s, ROOM).restricted).toBe(true);
    });

    it('ends exactly at its end (end == now is over)', () => {
      const { e, s, end } = memory();
      e.clock.t = end - 1;
      expect(e.chat.restricted(s, ROOM).restricted).toBe(true);
      e.clock.t = end;
      expect(agree(e, 'p1', s)).toEqual(NONE);
    });

    it('a longer ban beats the memory entry; a longer memory entry beats a shorter ban (as accept)', async () => {
      const store = new FlakySanctions();
      store.failWrites = true;
      const { e, s, end } = memory(store);
      store.failWrites = false;
      await e.sanction(s, 'ban', 10 * MIN);
      expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: end, kind: 'auto' });
      await e.sanction(s, 'ban', 2 * H);
      expect(agree(e, 'p1', s)).toEqual({ restricted: true, until: e.clock.t + 2 * H, kind: 'ban' });
    });

    it('a guest (no subject) cannot be told from another guest without a seat: restricted() says no, accept still refuses the seat', () => {
      const e = setup();
      e.sit('p1', null);
      e.threeSlurs();
      e.tick(SEC);
      expect(refusal(e.say('p1', 'hi')).reason).toBe('restricted');
      expect(e.chat.restricted(null, ROOM)).toEqual(NONE);
    });
  });

  describe('a bystander on a shared IP learns nothing about the other person', () => {
    const IP_A = 'ip-shared-zq7';
    async function shared(e: ReturnType<typeof setup>) {
      const offender = e.sit('p1', who('key-off-zq7', null, IP_A))!;
      const bystander = e.sit('p2', who('key-by-zq7', null, IP_A))!;
      const g = await e.sanction(offender, 'chat', H, { includeIp: true, rule: 3 });
      const id = e.realNotices.createForSanction(
        { groupId: g.groupId, refCode: g.refCode, kind: 'chat', until: e.clock.t + H, rule: 3, subject: offender },
        [],
        { notify: false },
      );
      return { offender, bystander, g, id };
    }

    it('the bystander is restricted with until null and kind null, and accept gives them no rule or notice either', async () => {
      const e = setup({ notices: true });
      const { bystander } = await shared(e);
      expect(e.chat.restricted(bystander, ROOM)).toEqual({ restricted: true, until: null, kind: null });
      const r = refusal(e.say('p2', 'hi'));
      expect(r.reason).toBe('restricted');
      expect('rule' in r).toBe(false);
      expect('noticeId' in r).toBe(false);
    });

    it('the offender gets their own end and kind', async () => {
      const e = setup({ notices: true });
      const { offender } = await shared(e);
      expect(e.chat.restricted(offender, ROOM)).toEqual({ restricted: true, until: NOW + H, kind: 'chat' });
      expect(refusal(e.say('p1', 'hi'))).toMatchObject({ until: NOW + H, byModerator: true, rule: 3 });
    });

    it('an alias of the offender (linked by account) gets the own answer', async () => {
      const e = setup({ notices: true });
      await shared(e);
      e.sit('p3', who('key-off2-zq7', 'acct-zq7', 'ip-other-zq7'));
      const alias = e.sit('p4', who('key-off-zq7', 'acct-zq7', IP_A)) as SubjectId;
      expect(e.chat.restricted(alias, ROOM)).toEqual({ restricted: true, until: NOW + H, kind: 'chat' });
    });

    it('a bystander with a longer sanction of their own gets their own end and kind', async () => {
      const e = setup({ notices: true });
      const { bystander } = await shared(e);
      await e.sanction(bystander, 'ban', 2 * H, { rule: 4 });
      expect(e.chat.restricted(bystander, ROOM)).toEqual({ restricted: true, until: NOW + 2 * H, kind: 'ban' });
    });

    it('a shorter own sanction under a longer shared-IP row still hides the other person', async () => {
      const e = setup({ notices: true });
      const { bystander } = await shared(e);
      await e.sanction(bystander, 'chat', H / 2, { rule: 4 });
      expect(e.chat.restricted(bystander, ROOM)).toEqual({ restricted: true, until: null, kind: null });
    });

    it('a person on another address is not touched (control); the answer is the same with no notices service', async () => {
      const e = setup();
      const offender = e.sit('p1', who('key-off-zq7', null, IP_A))!;
      const by = e.sit('p2', who('key-by-zq7', null, IP_A))!;
      const far = e.sit('p3', who('key-far-zq7', null, 'ip-far'))!;
      await e.sanction(offender, 'chat', H, { includeIp: true, rule: 3 });
      expect(e.chat.restricted(by, ROOM)).toEqual({ restricted: true, until: null, kind: null });
      expect(e.chat.restricted(far, ROOM)).toEqual(NONE);
    });

    it('the bystander answer carries no identifier of the other person', async () => {
      const e = setup({ notices: true });
      const { offender, bystander } = await shared(e);
      const text = JSON.stringify(e.chat.restricted(bystander, ROOM));
      for (const secret of [offender, bystander, 'key-off-zq7', IP_A, 'M-', 'rule', 'notice']) expect(text).not.toContain(secret);
    });
  });

  describe('same decision as accept', () => {
    it('both go through one shared function: accept calls it, restricted calls it', async () => {
      const e = setup();
      const s = e.sit('p1', who('k1')) as SubjectId;
      await e.sanction(s, 'chat', H);
      const spy = vi.spyOn(e.chat as unknown as { resolveRestriction: () => unknown }, 'resolveRestriction');
      e.say('p1', 'hi');
      expect(spy).toHaveBeenCalledTimes(1);
      e.chat.restricted(s, ROOM);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a stub of the shared function moves both answers together', () => {
      const e = setup();
      const s = e.sit('p1', who('k1')) as SubjectId;
      vi.spyOn(e.chat as unknown as { resolveRestriction: () => unknown }, 'resolveRestriction').mockReturnValue({
        until: NOW + 9 * H,
        byModerator: true,
        groupId: null,
        rule: null,
        own: true,
        kind: 'ban',
      });
      expect(refusal(e.say('p1', 'hi'))).toMatchObject({ reason: 'restricted', until: NOW + 9 * H, byModerator: true });
      expect(e.chat.restricted(s, ROOM)).toEqual({ restricted: true, until: NOW + 9 * H, kind: 'ban' });
    });
  });

  describe('a pure read', () => {
    it('spends no rate budget: the speaker still has all three lines after many lookups', () => {
      const e = setup();
      const s = e.sit('p1', who('k1')) as SubjectId;
      for (let i = 0; i < 50; i++) e.chat.restricted(s, ROOM);
      delivery(e.say('p1', 'one'));
      delivery(e.say('p1', 'two'));
      delivery(e.say('p1', 'three'));
    });

    it('writes no evidence, no strike, no sanction, fires no hook and logs nothing', () => {
      const e = setup({ store: new FailingSanctions() });
      const s = e.sit('p1', who('k1')) as SubjectId;
      const at = e.threeSlurs();
      e.tick(SEC);
      const snap = () =>
        JSON.stringify([e.buffer.snapshot(ROOM), e.store.loadSanctions(at), e.store.loadStrikes(0), e.calls, e.logs]);
      const before = snap();
      for (let i = 0; i < 20; i++) expect(e.chat.restricted(s, ROOM).restricted).toBe(true);
      expect(snap()).toBe(before);
    });

    it('does not sweep an expired in-memory entry (read only)', () => {
      const e = setup({ store: new FailingSanctions() });
      const s = e.sit('p1', who('k1')) as SubjectId;
      const at = e.threeSlurs();
      e.clock.t = at + 31 * MIN;
      expect(e.chat.restricted(s, ROOM)).toEqual(NONE);
      expect((e.chat as unknown as { memRestrictions: Map<string, unknown> }).memRestrictions.size).toBe(1);
    });

    it('answers synchronously with exactly three plain fields', async () => {
      const e = setup();
      const s = e.sit('p1', who('k1')) as SubjectId;
      await e.sanction(s, 'chat', H);
      const answer = e.chat.restricted(s, ROOM);
      expect(answer).not.toBeInstanceOf(Promise);
      expect(Object.keys(answer).sort()).toEqual(['kind', 'restricted', 'until']);
    });
  });

  describe('fail-soft', () => {
    it('a throwing sanction index reads as not restricted, logs the class only, and never throws', () => {
      const e = setup();
      const s = e.sit('p1', who('k1')) as SubjectId;
      e.sanctions.active = () => {
        throw new TypeError('secret-detail k1');
      };
      expect(e.chat.restricted(s, ROOM)).toEqual(NONE);
      expect(e.logs).toEqual([{ event: 'chat.restriction_failed', detail: { error: 'TypeError' } }]);
      delivery(e.say('p1', 'hi')); // accept reads it the same way
    });

    it('a throwing subject index (the address lookup) reads as not restricted', () => {
      const e = setup();
      const s = e.sit('p1', who('k1')) as SubjectId;
      e.subjects.latestIp = () => {
        throw new RangeError('x');
      };
      expect(e.chat.restricted(s, ROOM)).toEqual(NONE);
      expect(e.logs.map((l) => l.event)).toEqual(['chat.restriction_failed']);
    });

    it('garbage arguments never throw', () => {
      const e = setup();
      for (const room of [undefined, null, '', 'nope', 5 as unknown as string, {} as unknown as string]) {
        expect(e.chat.restricted(null, room)).toEqual(NONE);
        expect(e.chat.restricted('s_unknown' as SubjectId, room)).toEqual(NONE);
      }
      expect(e.chat.restricted(undefined as unknown as SubjectId, ROOM)).toEqual(NONE);
    });
  });
});

describe('matcher, strikes and the automatic timeout', () => {
  it('a hit refuses "blocked" and buffers the raw line with blocked=true, delivered=null', () => {
    const e = setup();
    const s = e.sit('p1', who('k1'), 'Pat');
    expect(refusal(e.say('p1', '  you zorbak  '))).toEqual({ reason: 'blocked', rule: 1 });
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
      rule: 1,
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

  it('a note never restricts chat, however many there are', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1', null, 'ip-1'));
    for (let i = 0; i < 4; i++) {
      await e.sanction(s as string, 'note', null);
      e.tick();
      expect('deliver' in e.say('p1', `still fine ${i}`)).toBe(true);
    }
  });

  it('a note does not hide a real timeout', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1'));
    await e.sanction(s as string, 'note', null);
    await e.sanction(s as string, 'chat', H);
    expect(refusal(e.say('p1', 'hello'))).toMatchObject({ reason: 'restricted' });
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
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: second + 24 * H, byModerator: false, rule: 1 });
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
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: end, byModerator: false, rule: 1 });
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

describe('profanity modes', () => {
  const calls = () => {
    const seenText: string[] = [];
    const spy: ProfanityFilter = {
      apply: (t) => {
        seenText.push(t);
        return filter.apply(t);
      },
    };
    return { spy, seenText };
  };

  it('allow: the filter is never called and the line is delivered as typed', () => {
    const { spy, seenText } = calls();
    const e = setup({ profanity: spy, profanityMode: 'allow' });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'oh snerp it')).text).toBe('oh snerp it');
    expect(seenText).toEqual([]);
  });

  it('star: a clean line is delivered unchanged', () => {
    const e = setup({ profanity: filter, profanityMode: 'star' });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'hello there')).text).toBe('hello there');
  });

  it('refuse: a profane line is refused with exactly { reason: profanity } (no rule, no notice, no time)', () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse', notices: true });
    e.sit('p1', who('k1'));
    expect(e.say('p1', 'oh snerp it')).toEqual({ refuse: { reason: 'profanity' } });
  });

  it('refuse: a clean line is delivered as typed', () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', ' hello there ')).text).toBe('hello there');
  });

  it('refuse: the filter sees the trimmed text', () => {
    const { spy, seenText } = calls();
    const e = setup({ profanity: spy, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    e.say('p1', '  hi snerp  ');
    expect(seenText).toEqual(['hi snerp']);
  });

  it('refuse: is not buffered as evidence, blocked or otherwise', () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    e.say('p1', 'oh snerp it');
    expect(e.buffer.snapshot(ROOM)).toEqual([]);
  });

  it('refuse: spends the rate budget like any other refusal after the rate check', () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) expect(refusal(e.say('p1', 'snerp')).reason).toBe('profanity');
    expect(refusal(e.say('p1', 'a clean line')).reason).toBe('rate');
    e.tick();
    delivery(e.say('p1', 'a clean line'));
  });

  it('refuse: a rate-limited profane line is refused as rate, and the filter is not asked', () => {
    const { spy, seenText } = calls();
    const e = setup({ profanity: spy, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) e.say('p1', 'fine');
    seenText.length = 0;
    expect(refusal(e.say('p1', 'snerp')).reason).toBe('rate');
    expect(seenText).toEqual([]);
  });

  it('refuse: a too-long profane line is refused as length first', () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', `snerp ${'x'.repeat(250)}`)).reason).toBe('length');
  });

  it('refuse: a restricted speaker is told restricted, not profanity', async () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse' });
    const s = e.sit('p1', who('k1'));
    await e.sanction(s!, 'chat', 3_600_000);
    expect(refusal(e.say('p1', 'snerp')).reason).toBe('restricted');
  });

  it('refuse: a line with a slur AND profanity is blocked (strike), not a profanity refusal', () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', 'snerp zorbak'))).toEqual({ reason: 'blocked', rule: 1 });
    expect(e.store.loadStrikes(0)).toHaveLength(1);
  });

  it('refuse: the slur matcher runs before the profanity filter, which is not asked about a blocked line', () => {
    const { spy, seenText } = calls();
    const e = setup({ profanity: spy, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    e.say('p1', 'snerp zorbak');
    expect(seenText).toEqual([]);
  });

  it.each(['star', 'refuse'] as const)(
    '%s: profanity never earns a strike, a sanction, a notice or an automatic timeout, however often',
    (profanityMode) => {
      const e = setup({ profanity: filter, profanityMode, notices: true });
      const s = e.sit('p1', who('k1'));
      for (let i = 0; i < 12; i++) {
        e.say('p1', 'snerp');
        e.tick();
      }
      expect(e.store.loadStrikes(0)).toEqual([]);
      expect(e.store.loadSanctions(e.clock.t)).toEqual([]);
      expect(e.store.loadNotices([s!])).toEqual([]);
      expect(e.calls).toEqual([]);
      delivery(e.say('p1', 'a clean line'));
    },
  );

  it('refuse: each speaker gets their own verdict', () => {
    const e = setup({ profanity: filter, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    e.sit('p2', who('k2'));
    expect(refusal(e.say('p1', 'snerp')).reason).toBe('profanity');
    delivery(e.say('p2', 'hello'));
  });
});

describe('starring and delivery', () => {
  it('stars profanity with the injected filter and delivers the starred text, with no strike', () => {
    const e = setup({ profanity: filter, profanityMode: 'star' });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'oh snerp it')).text).toBe('oh ***** it');
    expect(e.store.loadStrikes(0)).toEqual([]);
  });

  it('a filter with no mode given stars (star is the default mode)', () => {
    const e = setup({ profanity: filter });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'oh snerp it')).text).toBe('oh ***** it');
  });

  it('without a filter text is delivered as typed (trimmed), in every mode', () => {
    for (const profanityMode of ['allow', 'star', 'refuse'] as const) {
      const e = setup({ profanityMode });
      e.sit('p1', who('k1'));
      expect(delivery(e.say('p1', ' oh snerp ')).text).toBe('oh snerp');
    }
  });

  it('a blocked term wins over starring: the line is refused, not starred', () => {
    const e = setup({ profanity: filter, profanityMode: 'star' });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', 'snerp zorbak')).reason).toBe('blocked');
  });

  it('a filter that throws fails open: the line is delivered as typed and the failure is logged by class only', () => {
    const e = setup({
      profanity: {
        apply() {
          throw new RangeError('secret detail');
        },
      },
      profanityMode: 'refuse',
    });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'hi snerp')).text).toBe('hi snerp');
    expect(e.logs).toContainEqual({ event: 'chat.profanity_failed', detail: { error: 'RangeError' } });
    expect(JSON.stringify(e.logs)).not.toContain('secret detail');
  });

  it.each([
    ['null', null],
    ['a text that is not a string', { hit: true, text: 42 }],
    ['a hit that is not a boolean', { hit: 'yes', text: 'x' }],
    ['undefined', undefined],
  ])('a filter that returns %s fails open', (_name, bad) => {
    const e = setup({ profanity: { apply: () => bad as never }, profanityMode: 'refuse' });
    e.sit('p1', who('k1'));
    expect(delivery(e.say('p1', 'hi snerp')).text).toBe('hi snerp');
    expect(e.logs.some((l) => l.event === 'chat.profanity_failed')).toBe(true);
  });

  it('buffers the delivered line: subject, handle, raw, starred text, audience', () => {
    const e = setup({ profanity: filter });
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
    expect(refusal(e.say('p1', PAD + 'zorbak' + PAD))).toEqual({ reason: 'blocked', rule: 1 });
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
    expect(refusal(e.say('p1', PAD + line + PAD))).toEqual({ reason: 'blocked', rule: 1 });
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

describe('K2: refusals cite the rule and point at the notice', () => {
  const noticeFor = (
    e: ReturnType<typeof setup>,
    subject: SubjectId,
    groupId: string,
    refCode: string,
    until: number | null,
    rule: RuleRef | null = 1,
    kind: 'chat' | 'ban' = 'chat',
  ) => e.realNotices.createForSanction({ groupId, refCode, kind, until, rule, subject }, [], { notify: false });

  it('a blocked refusal carries rule 1 and no notice id', () => {
    const e = setup({ notices: true });
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', 'zorbak'))).toEqual({ reason: 'blocked', rule: 1 });
  });

  it('a blocked refusal carries rule 1 even without a notices service', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    expect(refusal(e.say('p1', 'zorbak'))).toEqual({ reason: 'blocked', rule: 1 });
  });

  it('a restricted refusal carries the sanction rule and the group notice id', async () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    const g = await e.sanction(s, 'chat', H, { rule: 3 });
    const id = noticeFor(e, s, g.groupId, g.refCode, e.clock.t + H, 3);
    expect(refusal(e.say('p1', 'hi'))).toEqual({
      reason: 'restricted',
      until: e.clock.t + H,
      byModerator: true,
      rule: 3,
      noticeId: id,
    });
  });

  it('a ban also cites its rule and notice', async () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    const g = await e.sanction(s, 'ban', null, { rule: 2 });
    const id = noticeFor(e, s, g.groupId, g.refCode, null, 2, 'ban');
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ reason: 'restricted', until: null, rule: 2, noticeId: id });
  });

  it('a restricted refusal with no notice for the group has the rule and no noticeId', async () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    await e.sanction(s, 'chat', H, { rule: 4 });
    const r = refusal(e.say('p1', 'hi'));
    expect(r).toMatchObject({ reason: 'restricted', rule: 4 });
    expect('noticeId' in r).toBe(false);
  });

  it('without a notices service a restricted refusal still cites the rule, never a notice id', async () => {
    const e = setup();
    const s = e.sit('p1', who('k1'))!;
    await e.sanction(s, 'chat', H, { rule: 5 });
    const r = refusal(e.say('p1', 'hi'));
    expect(r).toMatchObject({ reason: 'restricted', rule: 5 });
    expect('noticeId' in r).toBe(false);
  });

  it("an 'uncovered' sanction omits the rule but still points at its notice", async () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    const g = await e.sanction(s, 'chat', H, { rule: 'uncovered', gapNote: 'private note' });
    const id = noticeFor(e, s, g.groupId, g.refCode, e.clock.t + H, 'uncovered');
    const r = refusal(e.say('p1', 'hi'));
    expect('rule' in r).toBe(false);
    expect(r).toMatchObject({ reason: 'restricted', noticeId: id });
  });

  it('points at the newest notice that is not withdrawn', async () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    const g = await e.sanction(s, 'chat', H);
    const first = noticeFor(e, s, g.groupId, g.refCode, e.clock.t + H);
    e.clock.t += 1;
    const second = noticeFor(e, s, g.groupId, g.refCode, e.clock.t + H);
    expect(second).not.toBe(first);
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ noticeId: second });
    e.realNotices.withdrawGroup(g.groupId);
    expect('noticeId' in refusal(e.say('p1', 'hi again'))).toBe(false);
  });

  describe('the notice lookup is cached (no store read per attempt)', () => {
    class Counting extends MemoryStore {
      lookups = 0;
      override findNoticeForGroup(groupId: string) {
        this.lookups += 1;
        return super.findNoticeForGroup(groupId);
      }
    }

    it('50 restricted attempts make at most one findNoticeForGroup call and all carry the notice id', async () => {
      const store = new Counting();
      const e = setup({ store, notices: true });
      const s = e.sit('p1', who('k1'))!;
      const g = await e.sanction(s, 'chat', 60 * H, { rule: 3 });
      const id = noticeFor(e, s, g.groupId, g.refCode, e.clock.t + 60 * H, 3);
      store.lookups = 0;
      for (let i = 0; i < 50; i++) {
        expect(refusal(e.say('p1', 'hi'))).toMatchObject({ reason: 'restricted', rule: 3, noticeId: id });
      }
      expect(store.lookups).toBeLessThanOrEqual(1);
    });

    it('a restriction with no notice reads the store once over 50 attempts, and has no noticeId', async () => {
      const store = new Counting();
      const e = setup({ store, notices: true });
      const s = e.sit('p1', who('k1'))!;
      await e.sanction(s, 'chat', 60 * H, { rule: 3 });
      store.lookups = 0;
      for (let i = 0; i < 50; i++) expect('noticeId' in refusal(e.say('p1', 'hi'))).toBe(false);
      expect(store.lookups).toBe(1);
    });

    it('withdrawing the group drops the notice id from the next attempt', async () => {
      const store = new Counting();
      const e = setup({ store, notices: true });
      const s = e.sit('p1', who('k1'))!;
      const g = await e.sanction(s, 'chat', 60 * H);
      const id = noticeFor(e, s, g.groupId, g.refCode, e.clock.t + 60 * H);
      expect(refusal(e.say('p1', 'hi'))).toMatchObject({ noticeId: id });
      e.realNotices.withdrawGroup(g.groupId);
      expect('noticeId' in refusal(e.say('p1', 'hi again'))).toBe(false);
    });

    it('the automatic timeout is pointed at its own notice, then repeat attempts read no store', () => {
      const store = new Counting();
      const e = setup({ store, notices: true });
      const s = e.sit('p1', who('k1'))!;
      e.threeSlurs();
      e.tick();
      store.lookups = 0;
      const first = refusal(e.say('p1', 'hello'));
      expect(first).toMatchObject({ reason: 'restricted', byModerator: false });
      const id = (first as { noticeId?: string }).noticeId;
      expect(typeof id).toBe('string');
      for (let i = 0; i < 20; i++) {
        e.tick();
        expect(refusal(e.say('p1', 'hello'))).toMatchObject({ noticeId: id });
      }
      expect(store.lookups).toBeLessThanOrEqual(1);
      expect(s).toBeTruthy();
    });

    it('a bystander on the shared-IP row never gets the owner notice id, cached or not (R19)', async () => {
      const store = new Counting();
      const e = setup({ store, notices: true });
      const owner = e.sit('p1', who('k1', null, 'iphash-shared'))!;
      const g = await e.sanction(owner, 'chat', 60 * H, { includeIp: true, rule: 3 });
      noticeFor(e, owner, g.groupId, g.refCode, e.clock.t + 60 * H, 3);
      e.sit('p2', who('k2', null, 'iphash-shared'));
      for (let i = 0; i < 5; i++) {
        const mine = refusal(e.say('p1', 'hi'));
        expect(mine).toMatchObject({ reason: 'restricted', noticeId: expect.any(String) });
        const theirs = refusal(e.say('p2', 'hi'));
        expect(theirs).toMatchObject({ reason: 'restricted' });
        expect('noticeId' in theirs).toBe(false);
        expect('rule' in theirs).toBe(false);
        e.tick();
      }
    });
  });

  it('a seen notice is still pointed at (the player can read it again)', async () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    const g = await e.sanction(s, 'chat', H);
    const id = noticeFor(e, s, g.groupId, g.refCode, e.clock.t + H);
    expect(e.realNotices.ack(s, id)).toBe(true);
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ noticeId: id });
  });

  it('a throwing notices lookup still refuses correctly, with the rule and without a notice id, and logs', async () => {
    const broken = {
      noticeIdForGroup: () => {
        throw new TypeError('db gone');
      },
    } as unknown as NoticeService;
    const e = setup({ notices: broken });
    const s = e.sit('p1', who('k1'))!;
    await e.sanction(s, 'chat', H, { rule: 3 });
    const r = refusal(e.say('p1', 'hi'));
    expect(r).toEqual({ reason: 'restricted', until: e.clock.t + H, byModerator: true, rule: 3 });
    expect(e.logs.find((l) => l.event === 'chat.notice_lookup_failed')?.detail).toEqual({ error: 'TypeError' });
  });

  it('a broken notice store behind the real service gives the same fail-open refusal', async () => {
    class BrokenLookup extends MemoryStore {
      override findNoticeForGroup(): never {
        throw new Error('disk gone');
      }
    }
    const e = setup({ store: new BrokenLookup(), notices: true });
    const s = e.sit('p1', who('k1'))!;
    await e.sanction(s, 'chat', H, { rule: 3 });
    expect(refusal(e.say('p1', 'hi'))).toEqual({ reason: 'restricted', until: e.clock.t + H, byModerator: true, rule: 3 });
  });

  it('a stored sanction with an unreadable rule omits the rule and still refuses', async () => {
    const e = setup({ store: new RewritesRule(), notices: true });
    const s = e.sit('p1', who('k1'))!;
    await e.sanction(s, 'chat', H);
    (e.store as RewritesRule).storedRule = 'bogus';
    await e.sanctions.load(e.store, e.clock.t);
    const r = refusal(e.say('p1', 'hi'));
    expect(r).toMatchObject({ reason: 'restricted', byModerator: true });
    expect('rule' in r).toBe(false);
  });

  it('a pre-rules sanction (null rule) omits the rule', async () => {
    const e = setup({ store: new RewritesRule(), notices: true });
    const s = e.sit('p1', who('k1'))!;
    await e.sanction(s, 'chat', H);
    (e.store as RewritesRule).storedRule = null;
    await e.sanctions.load(e.store, e.clock.t);
    expect('rule' in refusal(e.say('p1', 'hi'))).toBe(false);
  });

  it('the in-memory fallback restriction cites the automatic-filter rule (1 by default) but has no notice id', () => {
    const e = setup({ store: new FailingSanctions(), notices: true });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    e.tick();
    const r = refusal(e.say('p1', 'hello'));
    expect(r).toMatchObject({ reason: 'restricted', byModerator: false, rule: 1 });
    expect('noticeId' in r).toBe(false);
  });

  it('no refusal carries an identifier', async () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('client-key-zq7', 'acct-zq7', 'iphash-zq7'))!;
    const g = await e.sanction(s, 'chat', H);
    noticeFor(e, s, g.groupId, g.refCode, e.clock.t + H);
    const text = JSON.stringify([refusal(e.say('p1', 'hi')), refusal(e.say('p1', 'zorbak'))]);
    for (const secret of [s, 'client-key-zq7', 'acct-zq7', 'iphash-zq7', g.groupId]) expect(text).not.toContain(secret);
  });
});

describe('K2: the automatic timeout creates a notice', () => {
  it('creates one chat notice citing rule 1, tied to the stored sanction', () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    const until = e.threeSlurs() + 30 * MIN;
    const rows = e.store.rawNotices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'chat', rule: '1', until, subject: s, ackedAt: null, withdrawnAt: null });
    const stored = e.store.loadSanctions(e.clock.t);
    expect(rows[0]?.groupId).toBe(stored[0]?.groupId);
    expect(rows[0]?.refCode).toBe(stored[0]?.refCode);
    expect(rows[0]?.excerpt).toHaveLength(1);
    expect(rows[0]?.excerpt[0]?.day).toBe(new Date(e.clock.t).toISOString().slice(0, 10));
  });

  it('the excerpt is the triggering line, masked: the matched term never appears', () => {
    const e = setup({ notices: true });
    e.sit('p1', who('k1'));
    for (let i = 0; i < 2; i++) {
      e.say('p1', 'zorbak');
      e.tick();
    }
    e.say('p1', 'you are a zorbak ok');
    expect(e.store.rawNotices()[0]?.excerpt[0]?.text).toBe('you are a ****** ok');
    expect(JSON.stringify(e.store.rawNotices())).not.toContain('zorbak');
  });

  it('with a matcher that gives no spans the whole line is starred', () => {
    const store = new MemoryStore();
    const e = setup({ store });
    const noSpans = new NoticeService({
      store,
      subjects: e.subjects,
      rules: new CommunityRules(STARTER_RULES),
      clock: e.clock,
      matcher: { match: stubMatcher.match },
    });
    const e2 = setup({ store, notices: noSpans });
    e2.sit('p1', who('k1'));
    e2.threeSlurs();
    const text = store.rawNotices()[0]?.excerpt[0]?.text;
    expect(text).toBe('******');
  });

  it('the player is told a notice is pending (notify on)', () => {
    const pushed: Array<{ subject: SubjectId; count: number }> = [];
    const e = setup({ notices: true, notify: (subject, ev) => void pushed.push({ subject, count: ev.count }) });
    const s = e.sit('p1', who('k1'))!;
    e.threeSlurs();
    expect(pushed).toEqual([{ subject: s, count: 1 }]);
  });

  it('a throwing or rejecting notify hook never breaks the timeout', async () => {
    for (const notify of [
      () => {
        throw new Error('boom');
      },
      () => Promise.reject(new Error('boom')),
    ]) {
      const e = setup({ notices: true, notify });
      e.sit('p1', who('k1'));
      e.threeSlurs();
      await Promise.resolve();
      expect(e.store.loadSanctions(e.clock.t)).toHaveLength(1);
      expect(e.calls).toHaveLength(1);
    }
  });

  it('a later restricted refusal points at the notice the timeout made', () => {
    const e = setup({ notices: true });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    e.tick();
    const id = e.store.rawNotices()[0]?.id;
    expect(refusal(e.say('p1', 'hello'))).toMatchObject({ reason: 'restricted', byModerator: false, rule: 1, noticeId: id });
  });

  it('the repeat 24 h penalty makes a second notice', () => {
    const e = setup({ notices: true });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    e.clock.t += 31 * MIN;
    e.threeSlurs();
    const rows = e.store.rawNotices();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.until).toBe(e.clock.t + 24 * H);
  });

  it('no notice below the strike threshold, and none for ordinary lines', () => {
    const e = setup({ notices: true });
    e.sit('p1', who('k1'));
    e.say('p1', 'zorbak');
    e.tick();
    e.say('p1', 'zorbak');
    e.tick();
    e.say('p1', 'fine');
    expect(e.store.rawNotices()).toEqual([]);
  });

  it('the memory fallback (no stored sanction) creates no notice', () => {
    const e = setup({ store: new FailingSanctions(), notices: true });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    expect(e.store.rawNotices()).toEqual([]);
  });

  it('a guest with no subject gets no stored sanction and no notice', () => {
    const e = setup({ notices: true });
    e.sit('p1', null);
    e.threeSlurs();
    expect(e.store.rawNotices()).toEqual([]);
  });

  it('with sanctions switched off no notice is made', () => {
    const e = setup({ notices: true });
    e.sit('p1', who('k1'));
    e.flags.sanctionsOn = false;
    e.threeSlurs();
    expect(e.store.rawNotices()).toEqual([]);
  });

  it('without a notices service the timeout is exactly as before', () => {
    const e = setup();
    e.sit('p1', who('k1'));
    e.threeSlurs();
    expect(e.store.rawNotices()).toEqual([]);
    expect(e.store.loadSanctions(e.clock.t)).toHaveLength(1);
    expect(e.calls).toHaveLength(1);
  });

  it('a notice that cannot be created is logged, the restriction stands and the hook is still told', () => {
    const broken = {
      createForSanction: () => {
        throw new RangeError('disk full');
      },
      noticeIdForGroup: () => null,
    } as unknown as NoticeService;
    const e = setup({ notices: broken });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    expect(e.store.loadSanctions(e.clock.t)).toHaveLength(1);
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ reason: 'restricted', rule: 1 });
    expect(e.logs.find((l) => l.event === 'chat.notice_failed')?.detail).toEqual({ error: 'RangeError' });
    expect(e.calls).toHaveLength(1);
  });

  it('a failed notice insert leaves no half row, the restriction stands', () => {
    class FailingNotices extends MemoryStore {
      override insertNotice(): void {
        throw new Error('disk full');
      }
    }
    const e = setup({ store: new FailingNotices(), notices: true });
    e.sit('p1', who('k1'));
    e.threeSlurs();
    expect(e.store.rawNotices()).toEqual([]);
    expect(e.store.loadSanctions(e.clock.t)).toHaveLength(1);
    expect(e.logs.some((l) => l.event === 'chat.notice_failed' && l.detail?.error === 'Error')).toBe(true);
  });

  it('what the player is shown carries no identifier, and no log line does either', () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('client-key-zq7', 'acct-zq7'))!;
    e.threeSlurs();
    const row = e.store.rawNotices()[0]!;
    const shown = JSON.stringify(e.realNotices.pending(s));
    for (const secret of [s, 'client-key-zq7', 'acct-zq7', row.groupId ?? '']) expect(shown).not.toContain(secret);
    expect(JSON.stringify(e.logs)).not.toContain(s);
  });

  it('the notice is pending for the player and is not a must-acknowledge warning', () => {
    const e = setup({ notices: true });
    const s = e.sit('p1', who('k1'))!;
    e.threeSlurs();
    const pending = e.realNotices.pending(s);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'chat', rule: 1, mustAcknowledge: false });
  });
});

describe('K2 R19: a bystander on a shared IP is told nothing about the offender', () => {
  const IP_A = 'ip-shared-zq7';

  async function shared(e: ReturnType<typeof setup>) {
    const offender = e.sit('p1', who('key-off-zq7', null, IP_A))!;
    const bystander = e.sit('p2', who('key-by-zq7', null, IP_A))!;
    const g = await e.sanction(offender, 'chat', H, { includeIp: true, rule: 3 });
    const id = e.realNotices.createForSanction(
      { groupId: g.groupId, refCode: g.refCode, kind: 'chat', until: e.clock.t + H, rule: 3, subject: offender },
      [],
      { notify: false },
    );
    return { offender, bystander, g, id };
  }

  it('the bystander is refused (restricted, with an end) but gets no rule and no notice id', async () => {
    const e = setup({ notices: true });
    const { offender, bystander } = await shared(e);
    expect(offender).not.toBe(bystander);
    const r = refusal(e.say('p2', 'hi'));
    expect(r).toEqual({ reason: 'restricted', until: e.clock.t + H, byModerator: true });
    expect('rule' in r).toBe(false);
    expect('noticeId' in r).toBe(false);
  });

  it('the offender still gets both', async () => {
    const e = setup({ notices: true });
    const { id } = await shared(e);
    expect(refusal(e.say('p1', 'hi'))).toEqual({
      reason: 'restricted',
      until: e.clock.t + H,
      byModerator: true,
      rule: 3,
      noticeId: id,
    });
  });

  it('an alias of the offender (linked by account) still gets both', async () => {
    const e = setup({ notices: true });
    const { id } = await shared(e);
    // A second browser of the same person: same account, a different key and no shared address.
    e.sit('p3', who('key-off2-zq7', 'acct-zq7', 'ip-other-zq7'));
    e.sit('p4', who('key-off-zq7', 'acct-zq7', IP_A));
    const alias = e.sit('p3', who('key-off2-zq7', 'acct-zq7', 'ip-other-zq7'));
    expect(e.subjects.canonical(alias!)).toBe(e.subjects.canonical(e.sit('p4', who('key-off-zq7', 'acct-zq7', IP_A))!));
    expect(refusal(e.say('p3', 'hi'))).toMatchObject({ reason: 'restricted', rule: 3, noticeId: id });
  });

  it('a guest with no subject is not reached by the IP row (control)', async () => {
    const e = setup({ notices: true });
    await shared(e);
    e.sit('p5', null);
    // A guest has no known address, so the sanction cannot reach them: they chat normally (control).
    delivery(e.say('p5', 'hello'));
  });

  it('the bystander gets neither extra without a notices service either', async () => {
    const e = setup();
    const offender = e.sit('p1', who('key-off-zq7', null, IP_A))!;
    e.sit('p2', who('key-by-zq7', null, IP_A));
    await e.sanction(offender, 'chat', H, { includeIp: true, rule: 3 });
    expect(refusal(e.say('p2', 'hi'))).toEqual({ reason: 'restricted', until: e.clock.t + H, byModerator: true });
    expect(refusal(e.say('p1', 'hi'))).toMatchObject({ rule: 3 });
  });

  it('a bystander who has a sanction of their own gets their own rule and notice, not the offender', async () => {
    const e = setup({ notices: true });
    const { bystander } = await shared(e);
    const g2 = await e.sanction(bystander, 'chat', 2 * H, { rule: 4 });
    const id2 = e.realNotices.createForSanction(
      { groupId: g2.groupId, refCode: g2.refCode, kind: 'chat', until: e.clock.t + 2 * H, rule: 4, subject: bystander },
      [],
      { notify: false },
    );
    expect(refusal(e.say('p2', 'hi'))).toMatchObject({ until: e.clock.t + 2 * H, rule: 4, noticeId: id2 });
  });

  it('a shorter own sanction under a longer shared-IP row still hides the other person', async () => {
    const e = setup({ notices: true });
    const { bystander } = await shared(e);
    const g2 = await e.sanction(bystander, 'chat', H / 2, { rule: 4 });
    const r = refusal(e.say('p2', 'hi'));
    // The longer row is the offender's (via the address), so the bystander is told nothing about it.
    expect(r).toMatchObject({ reason: 'restricted', until: e.clock.t + H });
    expect('rule' in r).toBe(false);
    expect('noticeId' in r).toBe(false);
    void g2;
  });
});
