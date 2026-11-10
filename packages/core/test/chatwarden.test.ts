import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { DecisionAction } from '../src/decide.js';
import { defineRules, STARTER_RULES } from '../src/rules.js';
import type { ProfanityConfig } from '../src/profile.js';
import type { Logger, Matcher, Platform, ProfanityFilter, RawWho } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const R = 'room';
const SUBJECT_RE = /^s_[A-Za-z0-9_-]{22}$/;

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

/** A matcher that blocks the one synthetic word. */
const blocker: Matcher = { match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null) };

/** A synthetic filter: treats the word 'heck' as swearing and stars it. Records what it was asked about. */
function stubFilter(): ProfanityFilter & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    apply(text) {
      seen.push(text);
      return { hit: /\bheck\b/.test(text), text: text.replace(/\bheck\b/g, '****') };
    },
  };
}

async function setup(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const identified: unknown[] = [];
  const platform: Platform = {
    identify(ctx) {
      identified.push(ctx);
      return ctx as RawWho;
    },
  };
  const cw = await createChatwarden({ store, secret: 'facade-secret', platform, clock, logger, ...over });
  return { cw, store, clock, logged, identified };
}

const alice: RawWho = { clientKey: 'key-alice', ip: '198.51.100.1' };
const bob: RawWho = { clientKey: 'key-bob', ip: '198.51.100.2' };

describe('createChatwarden: seating', () => {
  it('seat gives each person their own subject and the same key the same subject', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.rooms.seat(R, 'c', alice, 'Alice again');
    const a = cw.rooms.subjectAt(R, 'a');
    expect(a).toMatch(SUBJECT_RE);
    expect(cw.rooms.subjectAt(R, 'b')).not.toBe(a);
    expect(cw.rooms.subjectAt(R, 'c')).toBe(a);
  });

  it('seatConnection asks the platform to identify the context, once, and seats the result', async () => {
    const { cw, identified } = await setup();
    cw.rooms.seatConnection(R, 'a', alice, 'Alice');
    expect(identified).toEqual([alice]);
    const a = cw.rooms.subjectAt(R, 'a');
    cw.rooms.seat(R, 'b', alice, 'Alice');
    expect(cw.rooms.subjectAt(R, 'b')).toBe(a);
  });

  it('seat does not call identify', async () => {
    const { cw, identified } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(identified).toEqual([]);
  });

  it('subjectAt is null for an empty seat, an unknown room and an unidentifiable guest', async () => {
    const { cw } = await setup();
    expect(cw.rooms.subjectAt(R, 'a')).toBeNull();
    cw.rooms.seat(R, 'g', {}, 'Guest');
    expect(cw.rooms.subjectAt(R, 'g')).toBeNull();
    expect(cw.rooms.subjectAt('nowhere', 'a')).toBeNull();
  });

  it('unseat empties the seat', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.unseat(R, 'a');
    expect(cw.rooms.subjectAt(R, 'a')).toBeNull();
    expect(cw.chat.accept(R, 'a', 'hello')).toEqual({ refuse: { reason: 'gate' } });
  });

  it('close forgets seats and drops the room evidence', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    const line = cw.chat.accept(R, 'a', 'hello');
    expect('deliver' in line).toBe(true);
    cw.rooms.close(R);
    expect(cw.rooms.subjectAt(R, 'a')).toBeNull();
    // Reseat: the old line is gone from the evidence, so a report that names it cannot find it.
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    if (!('deliver' in line)) throw new Error('unreachable');
    const res = await cw.reports.submit({
      roomId: R,
      reporterSeat: 'b',
      targetSeat: 'zz',
      category: 'harassment',
      lineId: line.deliver.lineId,
    });
    expect(res).toEqual({ ok: false, refused: 'not_player' });
  });
});

describe('createChatwarden: chat', () => {
  it('delivers a line and refuses a blocked one through the injected matcher', async () => {
    const { cw } = await setup({ matcher: blocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const ok = cw.chat.accept(R, 'a', 'hello');
    expect(ok).toMatchObject({ deliver: { text: 'hello' } });
    expect(cw.chat.accept(R, 'a', 'you zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 1 } });
  });

  it('without a matcher nothing is blocked', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toMatchObject({ deliver: { text: 'zorbak' } });
  });

  it('applies the profanity filter to delivered text (the standard profile stars)', async () => {
    const { cw } = await setup({ profanity: stubFilter() });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'oh heck')).toMatchObject({ deliver: { text: 'oh ****' } });
  });

  it('profile strict refuses a profane line with the profanity reason, and creates no strike or sanction', async () => {
    const { cw, store } = await setup({ profanity: stubFilter(), profile: 'strict' });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'oh heck')).toEqual({ refuse: { reason: 'profanity' } });
    expect(store.loadStrikes(0)).toEqual([]);
    expect(store.loadSanctions(NOW)).toEqual([]);
  });

  it('the profanity mode comes from the profile: an override to allow never calls the filter', async () => {
    const filter = stubFilter();
    const { cw } = await setup({ profanity: filter, overrides: { profanity: { mode: 'allow' } } });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'oh heck')).toMatchObject({ deliver: { text: 'oh heck' } });
    expect(filter.seen).toEqual([]);
  });

  it('an override to refuse turns a relaxed profile strict about swearing', async () => {
    const { cw } = await setup({
      profanity: stubFilter(),
      profile: 'relaxed',
      overrides: { profanity: { mode: 'refuse' } },
    });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'oh heck')).toEqual({ refuse: { reason: 'profanity' } });
  });

  describe('profanityPackage', () => {
    const fakePackage = () => {
      const configs: ProfanityConfig[] = [];
      return {
        configs,
        pkg: {
          createProfanityFilter(config: ProfanityConfig) {
            configs.push(config);
            return stubFilter();
          },
        },
      };
    };

    it('builds the filter from the resolved profile and uses it', async () => {
      const { configs, pkg } = fakePackage();
      const { cw } = await setup({ profanityPackage: pkg, overrides: { profanity: { style: 'grawlix', add: ['snerp'] } } });
      expect(configs).toEqual([cw.profile.profanity]);
      expect(configs[0]).toMatchObject({ mode: 'star', style: 'grawlix', add: ['snerp'] });
      cw.rooms.seat(R, 'a', alice, 'Alice');
      expect(cw.chat.accept(R, 'a', 'oh heck')).toMatchObject({ deliver: { text: 'oh ****' } });
    });

    it('is built once for strict too, and refuses', async () => {
      const { configs, pkg } = fakePackage();
      const { cw } = await setup({ profanityPackage: pkg, profile: 'strict' });
      expect(configs).toHaveLength(1);
      expect(configs[0]?.mode).toBe('refuse');
      cw.rooms.seat(R, 'a', alice, 'Alice');
      expect(cw.chat.accept(R, 'a', 'oh heck')).toEqual({ refuse: { reason: 'profanity' } });
    });

    it('with mode allow nothing is built', async () => {
      const { configs, pkg } = fakePackage();
      const { cw } = await setup({ profanityPackage: pkg, overrides: { profanity: { mode: 'allow' } } });
      expect(configs).toEqual([]);
      cw.rooms.seat(R, 'a', alice, 'Alice');
      expect(cw.chat.accept(R, 'a', 'oh heck')).toMatchObject({ deliver: { text: 'oh heck' } });
    });

    it('a ready filter wins over the package, which is then not asked to build', async () => {
      const { configs, pkg } = fakePackage();
      const own: ProfanityFilter = { apply: (t) => ({ hit: true, text: `own:${t}` }) };
      const { cw } = await setup({ profanity: own, profanityPackage: pkg });
      expect(configs).toEqual([]);
      cw.rooms.seat(R, 'a', alice, 'Alice');
      expect(cw.chat.accept(R, 'a', 'x')).toMatchObject({ deliver: { text: 'own:x' } });
    });

    it('a package that throws on the config fails creation (a bad language is a startup error)', async () => {
      const pkg = {
        createProfanityFilter(): ProfanityFilter {
          throw new RangeError('unknown language');
        },
      };
      await expect(setup({ profanityPackage: pkg })).rejects.toThrow(RangeError);
    });

    it('a package that returns something that is not a filter fails creation', async () => {
      const pkg = { createProfanityFilter: () => ({}) as ProfanityFilter };
      await expect(setup({ profanityPackage: pkg })).rejects.toThrow(TypeError);
    });
  });

  it.each(['strict', 'standard', 'relaxed'] as const)('%s (profanity not allowed) without any filter warns once at creation that swearing will not be handled', async (profile) => {
    const s = await setup({ profile });
    expect(s.logged.filter(([e]) => e === 'chatwarden.no_profanity_filter')).toHaveLength(1);
  });

  it('the default profile (star) without any filter warns once too', async () => {
    const s = await setup();
    expect(s.logged.filter(([e]) => e === 'chatwarden.no_profanity_filter')).toHaveLength(1);
  });

  it('mode allow never warns, with or without a filter', async () => {
    const s = await setup({ overrides: { profanity: { mode: 'allow' } } });
    expect(s.logged.some(([e]) => e === 'chatwarden.no_profanity_filter')).toBe(false);
  });

  it('star or refuse with a ready filter or a package does not warn', async () => {
    const pkg = { createProfanityFilter: (): ProfanityFilter => ({ apply: (t) => ({ hit: false, text: t }) }) };
    const own: ProfanityFilter = { apply: (t) => ({ hit: false, text: t }) };
    for (const extra of [{ profanity: own }, { profanityPackage: pkg }]) {
      for (const profile of ['relaxed', 'standard', 'strict'] as const) {
        const s = await setup({ profile, ...extra });
        expect(s.logged.some(([e]) => e === 'chatwarden.no_profanity_filter')).toBe(false);
      }
    }
  });

  it('the gate hook is passed through with the sender subject', async () => {
    const seen: unknown[] = [];
    const { cw } = await setup({
      gate: (room, subject) => {
        seen.push([room, subject]);
        return false;
      },
    });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'hello')).toEqual({ refuse: { reason: 'gate' } });
    expect(seen).toEqual([[R, cw.rooms.subjectAt(R, 'a')]]);
  });

  it('the logger reaches the components', async () => {
    const { cw, logged } = await setup({
      gate: () => {
        throw new TypeError('boom');
      },
    });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.chat.accept(R, 'a', 'hello');
    expect(logged.filter(([e]) => e !== 'chatwarden.no_matcher' && e !== 'chatwarden.no_profanity_filter')).toEqual([
      ['chat.gate_failed', { error: 'TypeError' }],
    ]);
  });

  it('three blocked lines earn an automatic timeout and onAutoRestrict hears of it', async () => {
    const told: Array<[unknown, boolean]> = [];
    const { cw } = await setup({ matcher: blocker, onAutoRestrict: (s, second) => void told.push([s, second]) });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(told).toEqual([[cw.rooms.subjectAt(R, 'a'), false]]);
    const next = cw.chat.accept(R, 'a', 'hello');
    expect(next).toMatchObject({ refuse: { reason: 'restricted', byModerator: false } });
  });

  it('visibleTo honours a mute set through the facade', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(true);
    cw.mutes.set(R, 'a', 'b', true);
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(false);
    expect(cw.chat.visibleTo(R, 'b', 'a')).toBe(true);
    expect(cw.chat.visibleTo(R, 'a', 'a')).toBe(true);
    cw.mutes.set(R, 'a', 'b', false);
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(true);
  });
});

describe('createChatwarden: mutes', () => {
  it('mutedSeats lists the seats whose occupant the viewer muted', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.rooms.seat(R, 'c', { clientKey: 'key-cy' }, 'Cy');
    cw.mutes.set(R, 'a', 'c', true);
    cw.mutes.set(R, 'a', 'b', true);
    expect(cw.mutes.mutedSeats(R, 'a')).toEqual(['b', 'c']);
    expect(cw.mutes.mutedSeats(R, 'b')).toEqual([]);
  });

  it('is a no-op when either seat is empty or has no subject', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'g', {}, 'Guest');
    cw.mutes.set(R, 'a', 'g', true);
    cw.mutes.set(R, 'a', 'empty', true);
    cw.mutes.set(R, 'empty', 'a', true);
    cw.mutes.set(R, 'g', 'a', true);
    expect(cw.mutes.mutedSeats(R, 'a')).toEqual([]);
    expect(cw.mutes.mutedSeats(R, 'g')).toEqual([]);
  });

  it('follows the person, not the seat: a new occupant of the muted seat is not muted', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    cw.mutes.set(R, 'a', 'b', true);
    cw.rooms.seat(R, 'b', { clientKey: 'key-new' }, 'Newcomer');
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(true);
    cw.rooms.seat(R, 'b', bob, 'Bob');
    expect(cw.chat.visibleTo(R, 'a', 'b')).toBe(false);
  });

  it('survives a restart on the same store', async () => {
    const store = new MemoryStore();
    const first = await setup({}, store);
    first.cw.rooms.seat(R, 'a', alice, 'Alice');
    first.cw.rooms.seat(R, 'b', bob, 'Bob');
    first.cw.mutes.set(R, 'a', 'b', true);
    await first.cw.flush();
    const second = await setup({}, store);
    second.cw.rooms.seat(R, 'a', alice, 'Alice');
    second.cw.rooms.seat(R, 'b', bob, 'Bob');
    expect(second.cw.mutes.mutedSeats(R, 'a')).toEqual(['b']);
  });
});

describe('createChatwarden: reports', () => {
  async function reportSetup(over: Partial<ChatwardenOptions> = {}) {
    const s = await setup({ matcher: blocker, ...over });
    s.cw.rooms.seat(R, 'a', alice, 'Alice');
    s.cw.rooms.seat(R, 'b', bob, 'Bob');
    return s;
  }

  it('stores a report with the blocked line in the excerpt and tells onReport', async () => {
    const heard: string[] = [];
    const { cw, store } = await reportSetup({ onReport: (r) => void heard.push(r.id) });
    cw.chat.accept(R, 'a', 'you zorbak');
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    expect(res).toMatchObject({ ok: true });
    expect(heard).toHaveLength(1);
    expect(store.loadRoomReportPairs(R)).toHaveLength(1);
  });

  it('refuses a self-report and a report from a guest', async () => {
    const { cw } = await reportSetup();
    cw.rooms.seat(R, 'g', {}, 'Guest');
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'a', targetSeat: 'a', category: 'spam' })).toEqual({
      ok: false,
      refused: 'self',
    });
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'g', targetSeat: 'a', category: 'spam' })).toEqual({
      ok: false,
      refused: 'off',
    });
  });

  it('enabled() false turns report intake off and is read per call', async () => {
    let on = false;
    const { cw } = await reportSetup({ enabled: () => on });
    const input = { roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'spam' as const };
    expect(await cw.reports.submit(input)).toEqual({ ok: false, refused: 'off' });
    on = true;
    expect(await cw.reports.submit(input)).toMatchObject({ ok: true });
  });
});

describe('createChatwarden: sanctions and doors', () => {
  const chatSanction = (subject: string) => ({
    kind: 'chat' as const,
    subject,
    includeIp: false,
    durationMs: H,
    reason: 'private note',
    actor: 'mod@example.test',
    source: 'moderator' as const,
    automated: false,
    rule: 1,
  });

  it('a chat sanction refuses the next line as restricted, with a time and no identifiers; revoke lifts it', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    const { groupId, refCode } = await cw.sanctions.apply(chatSanction(subject));
    expect(refCode).toMatch(/^M-/);
    const refused = cw.chat.accept(R, 'a', 'hello');
    expect(refused).toEqual({ refuse: { reason: 'restricted', until: NOW + H, byModerator: true, rule: 1 } });
    expect(JSON.stringify(refused)).not.toContain(subject);
    expect(await cw.sanctions.revoke(groupId, 'mod@example.test', 'mistake')).toBe(true);
    expect(await cw.sanctions.revoke(groupId, 'mod@example.test', 'again')).toBe(false);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
    clock.t += H;
  });

  it('a ban closes the doors for that person, found by a fresh connection with the same key', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toBeNull();
    const { groupId, refCode } = await cw.sanctions.apply({ ...chatSanction(subject), kind: 'ban' });
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toEqual({ kind: 'ban', until: NOW + H, refCode });
    expect(cw.doors.check('join', { clientKey: 'key-bob' })).toBeNull();
    await cw.sanctions.revoke(groupId, 'mod@example.test', 'mistake');
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toBeNull();
  });

  it('enabled() false switches enforcement off for chat and doors (the kill switch)', async () => {
    let on = true;
    const { cw } = await setup({ enabled: () => on });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    await cw.sanctions.apply({ ...chatSanction(subject), kind: 'ban' });
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ refuse: { reason: 'restricted' } });
    on = false;
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
    expect(cw.doors.check('join', { clientKey: 'key-alice' })).toBeNull();
  });

  it('rejects a non-positive duration', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    await expect(cw.sanctions.apply({ ...chatSanction(subject), durationMs: 0 })).rejects.toThrow();
  });
});

describe('createChatwarden: chat.restricted (typing indicator)', () => {
  const NONE = { restricted: false, until: null, kind: null };
  const sanction = (subject: string, over: Record<string, unknown> = {}) => ({
    kind: 'chat' as const,
    subject,
    includeIp: false,
    durationMs: H,
    reason: 'private note',
    actor: 'mod@example.test',
    source: 'moderator' as const,
    automated: false,
    rule: 1,
    ...over,
  });
  const subjectOf = (cw: Awaited<ReturnType<typeof setup>>['cw'], seat: string): string => {
    const s = cw.rooms.subjectAt(R, seat);
    if (s === null) throw new Error('expected a subject');
    return s;
  };

  it('is synchronous and answers { restricted: false, until: null, kind: null } for a person nobody knows', async () => {
    const { cw } = await setup();
    const answer = cw.chat.restricted({ clientKey: 'never-seen' });
    expect(answer).not.toBeInstanceOf(Promise);
    expect(answer).toEqual(NONE);
    expect(cw.chat.restricted({})).toEqual(NONE);
    expect(cw.chat.restricted({ ip: '203.0.113.9' })).toEqual(NONE);
  });

  it('a chat sanction: the same person is found by key, by account, or by key and address; accept agrees', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', { clientKey: 'key-alice', accountId: 'acct-alice', ip: '198.51.100.1' }, 'Alice');
    await cw.sanctions.apply(sanction(subjectOf(cw, 'a')));
    const expected = { restricted: true, until: NOW + H, kind: 'chat' };
    expect(cw.chat.restricted({ clientKey: 'key-alice' })).toEqual(expected);
    expect(cw.chat.restricted({ accountId: 'acct-alice' })).toEqual(expected);
    expect(cw.chat.restricted({ clientKey: 'key-alice', ip: '198.51.100.1' }, { roomId: R })).toEqual(expected);
    expect(cw.chat.restricted(alice, { roomId: null })).toEqual(expected);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ refuse: { reason: 'restricted', until: NOW + H, byModerator: true } });
  });

  it('a ban is kind ban; permanent has until null; revoke and expiry lift it', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = subjectOf(cw, 'a');
    const ban = await cw.sanctions.apply(sanction(subject, { kind: 'ban', durationMs: null }));
    expect(cw.chat.restricted(alice)).toEqual({ restricted: true, until: null, kind: 'ban' });
    await cw.sanctions.revoke(ban.groupId, 'mod@example.test', 'mistake');
    expect(cw.chat.restricted(alice)).toEqual(NONE);
    await cw.sanctions.apply(sanction(subject));
    expect(cw.chat.restricted(alice).restricted).toBe(true);
    clock.t = NOW + H;
    expect(cw.chat.restricted(alice)).toEqual(NONE);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
  });

  it('a person who is not restricted, and another person, read false while a stranger sanction exists', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    await cw.sanctions.apply(sanction(subjectOf(cw, 'a')));
    expect(cw.chat.restricted(bob)).toEqual(NONE);
    expect(cw.chat.restricted(alice).restricted).toBe(true);
  });

  it('an area sanction does not restrict chat', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    await cw.sanctions.apply(sanction(subjectOf(cw, 'a'), { kind: 'area' }));
    expect(cw.chat.restricted(alice, { roomId: R })).toEqual(NONE);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
  });

  it('enabled() false switches it off with the rest of enforcement', async () => {
    let on = true;
    const { cw } = await setup({ enabled: () => on });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    await cw.sanctions.apply(sanction(subjectOf(cw, 'a'), { kind: 'ban' }));
    expect(cw.chat.restricted(alice).restricted).toBe(true);
    on = false;
    expect(cw.chat.restricted(alice)).toEqual(NONE);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
  });

  it('an address alone finds nobody, even when an address row exists', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    await cw.sanctions.apply(sanction(subjectOf(cw, 'a'), { includeIp: true }));
    expect(cw.chat.restricted({ ip: alice.ip })).toEqual(NONE);
  });

  it('a housemate on the sanctioned address is restricted, and told nothing else: no end, no kind', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', { clientKey: 'key-alice', ip: '198.51.100.50' }, 'Alice');
    cw.rooms.seat(R, 'b', { clientKey: 'key-bob', ip: '198.51.100.50' }, 'Bob');
    cw.rooms.seat(R, 'c', { clientKey: 'key-cy', ip: '198.51.100.51' }, 'Cy');
    await cw.sanctions.apply(sanction(subjectOf(cw, 'a'), { includeIp: true, rule: 3 }));
    expect(cw.chat.restricted({ clientKey: 'key-alice' })).toEqual({ restricted: true, until: NOW + H, kind: 'chat' });
    expect(cw.chat.restricted({ clientKey: 'key-bob' })).toEqual({ restricted: true, until: null, kind: null });
    expect(cw.chat.restricted({ clientKey: 'key-cy' })).toEqual(NONE);
    // accept tells the housemate the same: restricted, with no rule and no notice.
    const frame = cw.chat.accept(R, 'b', 'hello');
    expect(frame).toMatchObject({ refuse: { reason: 'restricted' } });
    const refuse = (frame as { refuse: Record<string, unknown> }).refuse;
    expect('rule' in refuse).toBe(false);
    expect('noticeId' in refuse).toBe(false);
    expect(JSON.stringify(cw.chat.restricted({ clientKey: 'key-bob' }))).not.toMatch(/key-|198\.51|s_|rule|notice/);
  });

  it('the automatic timeout reads as kind auto, with the same end accept reports', async () => {
    const { cw } = await setup({ matcher: spanBlocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    const refused = cw.chat.accept(R, 'a', 'hi') as { refuse: { until: number; byModerator: boolean } };
    expect(refused.refuse.byModerator).toBe(false);
    expect(cw.chat.restricted(alice)).toEqual({ restricted: true, until: refused.refuse.until, kind: 'auto' });
  });

  it('an in-memory automatic timeout (the sanction could not be stored) is found, scoped by roomId', async () => {
    class FailingSanctions extends MemoryStore {
      override insertSanctionGroup(): boolean {
        throw new Error('disk full');
      }
    }
    const { cw } = await setup({ matcher: spanBlocker }, new FailingSanctions());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    const refused = cw.chat.accept(R, 'a', 'hi') as { refuse: { until: number } };
    const expected = { restricted: true, until: refused.refuse.until, kind: 'auto' };
    expect(cw.chat.restricted(alice)).toEqual(expected);
    expect(cw.chat.restricted(alice, { roomId: R })).toEqual(expected);
    expect(cw.chat.restricted(alice, { roomId: 'elsewhere' })).toEqual(NONE);
    expect(cw.chat.restricted(bob, { roomId: R })).toEqual(NONE);
  });

  it('a guest without identifiers reads false, as does an empty identity', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'g', {}, 'Guest');
    expect(cw.chat.restricted({})).toEqual(NONE);
    expect(cw.chat.restricted({ clientKey: '', accountId: '', ip: 'unknown' })).toEqual(NONE);
    expect(cw.chat.restricted({ ip: null })).toEqual(NONE);
  });

  it('with roomId and seatId it is accept for the seat: a guest after three slurs, and a person with two seats', async () => {
    const { cw } = await setup({ matcher: spanBlocker });
    cw.rooms.seat(R, 'g', {}, 'Guest');
    cw.rooms.seat(R, 'g2', {}, 'Guest 2');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'g', 'zorbak');
    const refused = cw.chat.accept(R, 'g', 'hi') as { refuse: { until: number } };
    expect(cw.chat.accept(R, 'g2', 'hi')).toMatchObject({ deliver: {} });
    const expected = { restricted: true, until: refused.refuse.until, kind: 'auto' };
    expect(cw.chat.restricted({}, { roomId: R, seatId: 'g' })).toEqual(expected);
    expect(cw.chat.restricted({}, { roomId: R, seatId: 'g2' })).toEqual(NONE);
    expect(cw.chat.restricted({}, { roomId: R })).toEqual(NONE); // no seat: one guest cannot be told from another
    expect(cw.chat.restricted({}, { seatId: 'g' })).toEqual(NONE); // a seat id means nothing without its room
  });

  it('a person with two seats: the timeout is on the seat that earned it, as in accept', async () => {
    class FailingSanctions extends MemoryStore {
      override insertSanctionGroup(): boolean {
        throw new Error('disk full');
      }
    }
    const { cw } = await setup({ matcher: spanBlocker }, new FailingSanctions());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'a2', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
    expect(cw.chat.accept(R, 'a2', 'hi')).toMatchObject({ deliver: {} });
    expect(cw.chat.restricted(alice, { roomId: R, seatId: 'a' })).toMatchObject({ restricted: true, kind: 'auto' });
    expect(cw.chat.restricted(alice, { roomId: R, seatId: 'a2' })).toEqual(NONE);
    expect(cw.chat.restricted(alice, { roomId: R })).toMatchObject({ restricted: true, kind: 'auto' });
  });

  it('an empty roomId or seatId reads like none given', async () => {
    class FailingSanctions extends MemoryStore {
      override insertSanctionGroup(): boolean {
        throw new Error('disk full');
      }
    }
    const { cw } = await setup({ matcher: spanBlocker }, new FailingSanctions());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.restricted(alice, { roomId: '' }).restricted).toBe(true);
    expect(cw.chat.restricted(alice, { roomId: R, seatId: '' }).restricted).toBe(true);
    expect(cw.chat.restricted(alice, { roomId: '', seatId: 'a' }).restricted).toBe(true);
  });

  it('the kill switch silences an in-memory timeout, then it applies again', async () => {
    class FailingSanctions extends MemoryStore {
      override insertSanctionGroup(): boolean {
        throw new Error('disk full');
      }
    }
    let on = true;
    const { cw, clock } = await setup({ matcher: spanBlocker, enabled: () => on }, new FailingSanctions());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.restricted(alice, { roomId: R, seatId: 'a' }).restricted).toBe(true);
    clock.t += 6_000; // past the rate window, so a delivery below is the kill switch's doing
    on = false;
    expect(cw.chat.restricted(alice, { roomId: R, seatId: 'a' })).toEqual(NONE);
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ deliver: {} });
    on = true;
    expect(cw.chat.restricted(alice, { roomId: R, seatId: 'a' }).restricted).toBe(true);
  });

  it('is a pure read: no rate budget, no event, no new row, no log line, no notice made', async () => {
    const { cw, store, logged } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.rooms.seat(R, 'b', bob, 'Bob');
    await cw.sanctions.apply(sanction(subjectOf(cw, 'a')));
    const events: string[] = [];
    for (const type of ['report.created', 'report.closed', 'sanction.applied', 'sanction.revoked', 'gap.created', 'auto.restricted'] as const) {
      cw.on(type, () => void events.push(type));
    }
    const rows = () => JSON.stringify([store.loadSanctions(0), store.loadStrikes(0)]);
    const before = rows();
    const logsBefore = logged.length;
    for (let i = 0; i < 50; i++) {
      cw.chat.restricted(alice);
      cw.chat.restricted(bob);
    }
    await cw.flush();
    expect(rows()).toBe(before);
    expect(logged).toHaveLength(logsBefore);
    expect(events).toEqual([]);
    // Bob never spent a line of budget: three go through.
    for (const text of ['one', 'two', 'three']) expect(cw.chat.accept(R, 'b', text)).toMatchObject({ deliver: {} });
  });

  it('a lookup that fails reads as not restricted and logs only the error class', async () => {
    const { cw, logged } = await setup();
    const startup = logged.length;
    expect(cw.chat.restricted(null as unknown as RawWho)).toEqual(NONE);
    expect(cw.chat.restricted(undefined as unknown as RawWho, { roomId: R })).toEqual(NONE);
    expect(logged.length).toBe(startup + 1); // the second failure inside the same minute is held back
    for (const [event, detail] of logged.slice(startup)) {
      expect(event).toBe('chatwarden.restricted_failed');
      expect(detail).toEqual({ error: 'TypeError' });
    }
  });

  it('logs a failing lookup at most once a minute and counts what it held back', async () => {
    const { cw, logged, clock } = await setup();
    const startup = logged.length;
    for (let i = 0; i < 30; i++) expect(cw.chat.restricted(null as unknown as RawWho)).toEqual(NONE);
    expect(logged).toHaveLength(startup + 1);
    clock.t += 59_999;
    cw.chat.restricted(null as unknown as RawWho);
    expect(logged).toHaveLength(startup + 1);
    clock.t += 1;
    cw.chat.restricted(null as unknown as RawWho);
    expect(logged).toHaveLength(startup + 2);
    expect(logged[startup + 1]).toEqual(['chatwarden.restricted_failed', { error: 'TypeError', suppressed: 30 }]);
  });

  it('never carries an identifier, whatever the person', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', { clientKey: 'key-secret-1', accountId: 'acct-secret-1', ip: '198.51.100.77' }, 'Alice');
    const subject = subjectOf(cw, 'a');
    await cw.sanctions.apply(sanction(subject, { includeIp: true }));
    const text = JSON.stringify(cw.chat.restricted({ clientKey: 'key-secret-1', accountId: 'acct-secret-1', ip: '198.51.100.77' }));
    for (const secret of [subject, 'key-secret-1', 'acct-secret-1', '198.51.100.77', 'M-']) expect(text).not.toContain(secret);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['kind', 'restricted', 'until']);
  });
});

describe('createChatwarden: lifecycle', () => {
  it('loads stored sanctions before it returns: the first line on a restarted kit is already refused', async () => {
    const store = new MemoryStore();
    const first = await setup({}, store);
    first.cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = first.cw.rooms.subjectAt(R, 'a');
    if (subject === null) throw new Error('expected a subject');
    await first.cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: H,
      reason: 'r',
      actor: 'mod',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    await first.cw.flush();

    const second = await setup({}, store);
    second.cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(second.cw.chat.accept(R, 'a', 'hello')).toMatchObject({ refuse: { reason: 'restricted' } });
  });

  it('works with the default clock when none is given', async () => {
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: 's',
      platform: { identify: () => ({ clientKey: 'k' }) },
    });
    cw.rooms.seatConnection(R, 'a', null, 'Alice');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ deliver: { text: 'hi' } });
    await cw.close();
  });

  it('purge runs against the store with the injected clock and the given policy', async () => {
    const { cw } = await setup();
    expect(await cw.purge()).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 0, audit: 0, webhookKeys: 0 });
    await expect(cw.purge({ reportsMs: -1 })).rejects.toThrow(/invalid reportsMs/);
  });

  it('flush waits for identity writes; close flushes then closes the store', async () => {
    const order: string[] = [];
    class SpyStore extends MemoryStore {
      override async saveSubject(...args: Parameters<MemoryStore['saveSubject']>): Promise<void> {
        await Promise.resolve();
        order.push('saveSubject');
        return super.saveSubject(...args);
      }
      override close(): void {
        order.push('close');
      }
    }
    const { cw } = await setup({}, new SpyStore());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    await cw.close();
    expect(order).toEqual(['saveSubject', 'close']);
  });
});

describe('createChatwarden: retention on by default', () => {
  const DAY = 24 * H;
  const SIX_H = 6 * H;
  afterEach(() => {
    vi.useRealTimers();
  });

  const oldReport = (id: string) => ({
    id,
    createdAt: NOW - 100 * DAY,
    roomId: `room-${id}`,
    tags: {},
    reporterSubject: `s_rep_${id}`,
    reporterSeat: 'p1',
    reporterHandle: 'A',
    targetSubject: `s_tgt_${id}`,
    targetSeat: 'p2',
    targetHandle: 'B',
    category: 'harassment' as const,
    note: null,
    lineId: null,
    excerpt: [],
    people: [],
    status: 'open' as const,
  });

  it('purges every 6 h by default, not before', async () => {
    vi.useFakeTimers();
    const { cw, store, clock } = await setup();
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(SIX_H - 1);
    expect(store.rawReports()).toHaveLength(1);
    clock.t += SIX_H;
    await vi.advanceTimersByTimeAsync(1);
    expect(store.rawReports()).toHaveLength(0);
    // And again on the next tick.
    store.insertReport(oldReport('r2'));
    await vi.advanceTimersByTimeAsync(SIX_H);
    expect(store.rawReports()).toHaveLength(0);
    await cw.close();
  });

  it('everyMs and the policy fields are honoured', async () => {
    vi.useFakeTimers();
    const { cw, store, clock } = await setup({ retention: { everyMs: 1000, reportsMs: 10 * DAY } });
    store.insertReport({ ...oldReport('r1'), createdAt: NOW - 20 * DAY });
    store.insertReport({ ...oldReport('r2'), createdAt: NOW - 5 * DAY });
    await vi.advanceTimersByTimeAsync(999);
    expect(store.rawReports()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.rawReports().map((r) => r.id)).toEqual(['r2']);
    expect(clock.t).toBe(NOW);
    await cw.close();
  });

  it('a policy object without everyMs keeps the 6 h default', async () => {
    vi.useFakeTimers();
    const { cw, store } = await setup({ retention: { reportsMs: DAY } });
    store.insertReport({ ...oldReport('r1'), createdAt: NOW - 2 * DAY });
    await vi.advanceTimersByTimeAsync(SIX_H - 1);
    expect(store.rawReports()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.rawReports()).toHaveLength(0);
    await cw.close();
  });

  it('retention: false starts no timer and never purges', async () => {
    vi.useFakeTimers();
    const { cw, store } = await setup({ retention: false });
    expect(vi.getTimerCount()).toBe(0);
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(1000 * H);
    expect(store.rawReports()).toHaveLength(1);
    await cw.close();
  });

  it('the default starts exactly one timer, and it does not keep the process alive (unref)', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { cw } = await setup();
    expect(vi.getTimerCount()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0]?.value as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
    await cw.close();
    spy.mockRestore();
  });

  it('close stops the timer: no purge afterwards', async () => {
    vi.useFakeTimers();
    const { cw, store } = await setup();
    await cw.close();
    expect(vi.getTimerCount()).toBe(0);
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(100 * H);
    expect(store.rawReports()).toHaveLength(1);
  });

  it('close twice is harmless', async () => {
    vi.useFakeTimers();
    const { cw } = await setup();
    await cw.close();
    await expect(cw.close()).resolves.toBeUndefined();
  });

  it('a failing purge is logged (event and error class only), never thrown, and the timer keeps going', async () => {
    vi.useFakeTimers();
    class Flaky extends MemoryStore {
      fail = true;
      override purgeReports(before: number, keepBadFaithSince: number): number {
        if (this.fail) throw new RangeError('secret-detail disk full');
        return super.purgeReports(before, keepBadFaithSince);
      }
    }
    const store = new Flaky();
    const { cw, logged } = await setup({ retention: { everyMs: 1000 } }, store);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged.filter(([e]) => e === 'chatwarden.purge_failed')).toEqual([
      ['chatwarden.purge_failed', { error: 'RangeError' }],
    ]);
    expect(JSON.stringify(logged)).not.toContain('secret-detail');
    store.fail = false;
    store.insertReport(oldReport('r1'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.rawReports()).toHaveLength(0);
    await cw.close();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects retention.everyMs = %s at creation', async (bad) => {
    await expect(setup({ retention: { everyMs: bad } })).rejects.toThrow(/retention\.everyMs/);
  });

  it('a manual purge() uses the configured policy unless the caller overrides it', async () => {
    const { cw, store } = await setup({ retention: false });
    store.insertReport({ ...oldReport('r1'), createdAt: NOW - 2 * DAY });
    expect((await cw.purge()).reports).toBe(0);
    expect((await cw.purge({ reportsMs: DAY })).reports).toBe(1);
  });
});

describe('createChatwarden: retention timer hardening', () => {
  const throwingLogger: Logger = {
    warn() {
      throw new Error('logger broke');
    },
  };
  const asyncBadLogger = { warn: () => Promise.reject(new Error('async')) } as unknown as Logger;
  const rejections: unknown[] = [];
  const onRejection = (r: unknown): void => void rejections.push(r);
  const settle = (): Promise<void> => new Promise<void>((r) => process.nextTick(r));
  beforeEach(() => {
    rejections.length = 0;
    process.on('unhandledRejection', onRejection);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  class FailingStore extends MemoryStore {
    override purgeReports(): number {
      throw new RangeError('disk full');
    }
  }

  it('a throwing logger inside the purge failure path never produces an unhandledRejection', async () => {
    vi.useFakeTimers();
    const { cw } = await setup(
      { retention: { everyMs: 10 }, logger: throwingLogger, matcher: blocker },
      new FailingStore(),
    );
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('an async logger that rejects inside the purge failure path never produces an unhandledRejection', async () => {
    vi.useFakeTimers();
    const { cw } = await setup(
      { retention: { everyMs: 10 }, logger: asyncBadLogger, matcher: blocker },
      new FailingStore(),
    );
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('a throwing clock inside the timer is caught, logged, and the timer keeps going', async () => {
    vi.useFakeTimers();
    let broken = false;
    const clock = {
      now: () => {
        if (broken) throw new TypeError('clock broke');
        return NOW;
      },
    };
    const { cw, logged } = await setup({ retention: { everyMs: 10 }, clock, matcher: blocker });
    broken = true;
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    expect(logged.filter(([e]) => e === 'chatwarden.purge_failed')).toEqual([
      ['chatwarden.purge_failed', { error: 'TypeError' }],
      ['chatwarden.purge_failed', { error: 'TypeError' }],
      ['chatwarden.purge_failed', { error: 'TypeError' }],
    ]);
    await cw.close();
  });

  it('a throwing clock AND a throwing logger inside the timer is silent', async () => {
    vi.useFakeTimers();
    let broken = false;
    const clock = {
      now: () => {
        if (broken) throw new TypeError('clock broke');
        return NOW;
      },
    };
    const { cw } = await setup({ retention: { everyMs: 10 }, clock, logger: throwingLogger, matcher: blocker });
    broken = true;
    await vi.advanceTimersByTimeAsync(30);
    await settle();
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('everyMs 2_147_483_648 throws RangeError', async () => {
    const err = await setup({ retention: { everyMs: 2_147_483_648 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toBe('retention.everyMs must be at most 2147483647');
  });

  it.each([2_147_483_649, 1e12])('everyMs %s also throws RangeError', async (big) => {
    await expect(setup({ retention: { everyMs: big } })).rejects.toBeInstanceOf(RangeError);
  });

  it('everyMs 2_147_483_647 is accepted and schedules at exactly that interval', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const { cw } = await setup({ retention: { everyMs: 2_147_483_647 }, matcher: blocker });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(2_147_483_647);
    await cw.close();
  });

  it('the no_matcher warning with a throwing logger does not reject createChatwarden', async () => {
    const { cw } = await setup({ logger: throwingLogger, retention: false });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'hello')).toBeDefined();
    await cw.close();
  });

  it('the no_matcher warning with an async-rejecting logger does not reject or leak', async () => {
    const { cw } = await setup({ logger: asyncBadLogger, retention: false });
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(rejections).toEqual([]);
    await cw.close();
  });

  it('the no_matcher warning with the default logger and a throwing console.warn does not reject', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console broke');
    });
    const { cw } = await setup({ logger: undefined, retention: false });
    await cw.close();
  });
});

describe('createChatwarden: no matcher warning', () => {
  it('logs chatwarden.no_matcher once at creation when no matcher is given', async () => {
    const { cw, logged } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    cw.chat.accept(R, 'a', 'hello');
    cw.chat.accept(R, 'a', 'hello again');
    expect(logged.filter(([e]) => e === 'chatwarden.no_matcher')).toEqual([['chatwarden.no_matcher', undefined]]);
  });

  it('logs nothing about it when a matcher is given', async () => {
    const { logged } = await setup({ matcher: blocker });
    expect(logged.filter(([e]) => e === 'chatwarden.no_matcher')).toEqual([]);
  });
});

// --- K2: rules, decisions and notices ------------------------------------------------------------------------

const ID_RE = /s_[A-Za-z0-9_-]{22}|[0-9a-f]{32}/;
const DAY = 86_400_000;

/** A registry where slurs are CR 3 and CR 1 is something else, so a hard-coded "1" cannot pass by luck. */
const customRules = () =>
  defineRules([
    { number: 1, title: 'Be kind', text: 'Be kind.' },
    { number: 2, title: 'No spam', text: 'No spam.' },
    { number: 3, title: 'No slurs', text: 'No slurs.' },
    { number: 4, title: 'Old rule', text: 'Retired.', retired: true },
  ]);

const spanBlocker: Matcher = {
  match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null),
  spans: (t) => {
    const i = t.toLowerCase().indexOf('zorbak');
    return i < 0 ? [] : [{ start: i, end: i + 6, termId: 'syn:zorbak' }];
  },
};

/** Alice and Bob seated, Alice has written one clean and one blocked line, Bob has reported her. */
async function reported(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const s = await setup({ matcher: spanBlocker, ...over }, store);
  const { cw } = s;
  cw.rooms.seat(R, 'a', alice, 'Alice');
  cw.rooms.seat(R, 'b', bob, 'Bob');
  const clean = cw.chat.accept(R, 'a', 'hello there');
  cw.chat.accept(R, 'a', 'you zorbak');
  cw.chat.accept(R, 'b', 'bob line');
  if (!('deliver' in clean)) throw new Error('expected a delivered line');
  const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  if (!res.ok) throw new Error('expected the report to be stored');
  const report = store.loadReport(res.reportId);
  if (report === null) throw new Error('expected a stored report');
  const own = report.excerpt.filter((l) => l.seatId === 'a').map((l) => l.lineId);
  const bobLine = report.excerpt.find((l) => l.seatId === 'b')?.lineId;
  const a = cw.rooms.subjectAt(R, 'a');
  const b = cw.rooms.subjectAt(R, 'b');
  if (a === null || b === null) throw new Error('expected subjects');
  return { ...s, reportId: res.reportId, own, bobLine, a, b, cleanLineId: clean.deliver.lineId };
}

type Reported = Awaited<ReturnType<typeof reported>>;

const warnAlice = (r: Reported, over: Partial<DecisionAction> = {}) =>
  r.cw.decide({
    reportId: r.reportId,
    verdict: 'upheld',
    actor: 'mod@example.test',
    reason: 'private reason text',
    actions: [{ subject: r.a, kind: 'warning', durationMs: null, rule: 2, lineIds: r.own, ...over }],
  });

describe('createChatwarden: rules', () => {
  it('exposes the starter registry by default', async () => {
    const { cw } = await setup();
    expect(cw.rules.active().map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cw.rules.get(1)?.title).toBe(STARTER_RULES[0]?.title);
  });

  it('exposes the registry the adopter passed, as given', async () => {
    const rules = customRules();
    const { cw } = await setup({ rules });
    expect(cw.rules).toBe(rules);
  });
});

describe('createChatwarden: autoRestrictRule', () => {
  it('defaults to CR 1 for the blocked refusal, the stored timeout and its notice', async () => {
    const { cw } = await setup({ matcher: spanBlocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 1 } });
    cw.chat.accept(R, 'a', 'zorbak');
    cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted', rule: 1 } });
    expect(cw.notices.pending(alice).map((n) => n.rule)).toEqual([1]);
  });

  it('a custom registry where slurs are CR 3 makes blocked refusals, auto timeouts and their notices cite 3', async () => {
    const { cw, store } = await setup({ matcher: spanBlocker, rules: customRules(), autoRestrictRule: 3 });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 3 } });
    cw.chat.accept(R, 'a', 'zorbak');
    cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted', rule: 3 } });
    const subject = cw.rooms.subjectAt(R, 'a');
    const stored = store.loadSanctions(NOW).filter((r) => r.value === subject);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((r) => r.rule === '3')).toBe(true);
    const notices = cw.notices.pending(alice);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'chat', rule: 3, ruleLabel: 'Community Rule 3: No slurs' });
  });

  it('the in-memory fallback restriction cites the configured rule too (and still has no notice id)', async () => {
    class FailingSanctions extends MemoryStore {
      override insertSanctionGroup(): boolean {
        throw new Error('disk full');
      }
    }
    const { cw } = await setup({ matcher: spanBlocker, rules: customRules(), autoRestrictRule: 3 }, new FailingSanctions());
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    const r = cw.chat.accept(R, 'a', 'hi');
    expect(r).toEqual({ refuse: { reason: 'restricted', until: expect.any(Number), byModerator: false, rule: 3 } });
  });

  it('is validated at creation: a retired, unknown, zero, fractional or non-finite number throws the same RangeError', async () => {
    const messages = new Set<string>();
    for (const bad of [4, 9, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await setup({ rules: customRules(), autoRestrictRule: bad }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      messages.add((err as RangeError).message);
    }
    expect([...messages]).toHaveLength(1);
    expect([...messages][0]).not.toMatch(/\d/);
  });

  it('a rejected option closes nothing', async () => {
    const store = new MemoryStore();
    const closed = vi.spyOn(store, 'close');
    await expect(setup({ autoRestrictRule: 99 }, store)).rejects.toThrow(RangeError);
    expect(closed).not.toHaveBeenCalled();
  });

  it('a registry without CR 1 needs an explicit autoRestrictRule', async () => {
    const rules = defineRules([{ number: 2, title: 'Only', text: 'Only rule.' }]);
    await expect(setup({ rules })).rejects.toThrow(RangeError);
    const { cw } = await setup({ rules, autoRestrictRule: 2, matcher: spanBlocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 2 } });
  });
});

describe('createChatwarden: decide and the player notices', () => {
  it('warning with the reported lines: the target gets a notice with their own lines only; the reporter gets an outcome', async () => {
    const r = await reported();
    const { cw } = r;
    expect(cw.notices.pending(alice)).toEqual([]);
    expect(cw.notices.pendingWarning(alice)).toBe(false);
    expect((await warnAlice(r)).ok).toBe(true);
    const [n] = cw.notices.pending(alice);
    expect(cw.notices.pending(alice)).toHaveLength(1);
    expect(n).toMatchObject({ kind: 'warning', rule: 2, mustAcknowledge: true, until: null });
    expect(n?.excerpt.map((l) => l.text)).toEqual(['hello there', 'you ******']);
    expect(r.own).toContain(r.cleanLineId);
    expect(r.bobLine).toBeDefined();
    expect(cw.notices.pendingWarning(alice)).toBe(true);
    const outcome = cw.notices.pending(bob);
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({ kind: 'report_outcome', excerpt: [], rule: null, refCode: null });
    const text = JSON.stringify([cw.notices.pending(alice), outcome, cw.notices.record(alice)]);
    expect(text).not.toMatch(ID_RE);
    expect(text).not.toContain('private reason text');
    expect(text).not.toContain('bob line');
    expect(text).not.toContain('mod@example.test');
    expect(text).not.toContain('zorbak');
  });

  it('ack removes it from pending, clears pendingWarning, and keeps it in the record', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    const [n] = cw.notices.pending(alice);
    if (n === undefined) throw new Error('expected a notice');
    expect(cw.notices.record(alice).map((x) => x.id)).toEqual([n.id]);
    expect(cw.notices.ack(alice, n.id)).toBe(true);
    expect(cw.notices.ack(alice, n.id)).toBe(true);
    expect(cw.notices.pending(alice)).toEqual([]);
    expect(cw.notices.pendingWarning(alice)).toBe(false);
    expect(cw.notices.record(alice).map((x) => x.id)).toEqual([n.id]);
  });

  it("one player cannot ack another player's notice, and an unknown id is false", async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    const [n] = cw.notices.pending(alice);
    if (n === undefined) throw new Error('expected a notice');
    expect(cw.notices.ack(bob, n.id)).toBe(false);
    expect(cw.notices.ack(alice, 'nope')).toBe(false);
    expect(cw.notices.ack(alice, '')).toBe(false);
    expect(cw.notices.pending(alice)).toHaveLength(1);
  });

  it('an unknown person gets empty lists and false, and is not created', async () => {
    const { cw, store } = await setup();
    const ghost: RawWho = { clientKey: 'key-ghost', accountId: 'acct-ghost', ip: '198.51.100.9' };
    const before = (await store.loadSubjects()).subjects.length;
    expect(cw.notices.pending(ghost)).toEqual([]);
    expect(cw.notices.record(ghost)).toEqual([]);
    expect(cw.notices.pendingWarning(ghost)).toBe(false);
    expect(cw.notices.ack(ghost, 'anything')).toBe(false);
    expect(cw.notices.pending({})).toEqual([]);
    await cw.flush();
    expect((await store.loadSubjects()).subjects.length).toBe(before);
    // Control: once seated they are known.
    cw.rooms.seat(R, 'g', ghost, 'Ghost');
    await cw.flush();
    expect((await store.loadSubjects()).subjects.length).toBe(before + 1);
  });

  it('an IP alone never finds a notice', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    expect(cw.notices.pending({ ip: '198.51.100.1' })).toEqual([]);
    expect(cw.notices.pending({ clientKey: 'other', ip: '198.51.100.1' })).toEqual([]);
    expect(cw.notices.pending(alice)).toHaveLength(1);
  });

  it('a notice follows the person across an account link', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r);
    cw.rooms.seat(R, 'a2', { clientKey: 'key-alice', accountId: 'acct-alice' }, 'Alice');
    await cw.flush();
    expect(cw.notices.pending({ accountId: 'acct-alice' })).toHaveLength(1);
  });

  it('decide is idempotent: the same decision twice is a replay and sends no second notice', async () => {
    const r = await reported();
    const first = await warnAlice(r);
    const second = await warnAlice(r);
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: true });
    expect(r.cw.notices.pending(alice)).toHaveLength(1);
    expect(r.cw.notices.pending(bob)).toHaveLength(1);
  });

  it('refuses to put another player line in a notice', async () => {
    const r = await reported();
    const res = await warnAlice(r, { lineIds: [r.bobLine ?? 'x'] });
    expect(res).toEqual({ ok: false, error: 'invalid' });
    expect(r.cw.notices.pending(alice)).toEqual([]);
  });

  it('a decide store failure rejects with the store error and writes nothing (documented pass-through)', async () => {
    class FailingDecision extends MemoryStore {
      fail = false;
      override insertDecision(...args: Parameters<MemoryStore['insertDecision']>): void {
        if (this.fail) throw new Error('disk full');
        super.insertDecision(...args);
      }
    }
    const store = new FailingDecision();
    const r = await reported({}, store);
    store.fail = true;
    await expect(warnAlice(r)).rejects.toThrow('disk full');
    expect(r.cw.notices.pending(alice)).toEqual([]);
    expect(r.cw.notices.pending(bob)).toEqual([]);
  });

  it('an uncovered decision needs a gap note and shows up in gaps.list without a subject id', async () => {
    const r = await reported();
    const { cw, a } = r;
    expect(await warnAlice(r, { rule: 'uncovered', lineIds: [] })).toEqual({ ok: false, error: 'invalid' });
    const ok = await warnAlice(r, { rule: 'uncovered', gapNote: 'trading accounts', lineIds: [] });
    if (!ok.ok) throw new Error('expected ok');
    const rows = cw.gaps.list();
    expect(rows).toEqual([
      {
        groupId: ok.groups[0]?.groupId,
        refCode: ok.groups[0]?.refCode,
        at: NOW,
        actor: 'mod@example.test',
        note: 'trading accounts',
        rule: 'uncovered',
        status: 'open',
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(ID_RE);
    expect(JSON.stringify(rows)).not.toContain(a);
    // The player never sees the note.
    expect(JSON.stringify(cw.notices.pending(alice))).not.toContain('trading accounts');
    // Closing: once, then false; an unknown group is false.
    const g = ok.groups[0]?.groupId ?? '';
    expect(cw.gaps.close(g, 'ruled', '9', 'boss')).toBe(true);
    expect(cw.gaps.close(g, 'not_a_rule', null, 'boss')).toBe(false);
    expect(cw.gaps.close('nope', 'ruled', '9', 'boss')).toBe(false);
    expect(cw.gaps.list()[0]).toMatchObject({ status: 'ruled' });
  });

  it('gaps.list is empty when nothing is uncovered', async () => {
    const { cw } = await setup();
    expect(cw.gaps.list()).toEqual([]);
  });
});

describe('createChatwarden: revoke withdraws the notice (R16)', () => {
  it('revoke: the pending notice is gone and it is no longer in the record', async () => {
    const r = await reported();
    const { cw } = r;
    const res = await warnAlice(r, { kind: 'chat', durationMs: H });
    if (!res.ok) throw new Error('expected ok');
    expect(cw.notices.pending(alice)).toHaveLength(1);
    expect(cw.notices.record(alice)).toHaveLength(1);
    expect(await cw.sanctions.revoke(res.groups[0]?.groupId ?? '', 'mod', 'mistake')).toBe(true);
    expect(cw.notices.pending(alice)).toEqual([]);
    expect(cw.notices.record(alice)).toEqual([]);
    expect(cw.chat.accept(R, 'a', 'hello')).toMatchObject({ deliver: {} });
  });

  it('a seen notice leaves the record on revoke too, and a second revoke is false', async () => {
    const r = await reported();
    const { cw } = r;
    const res = await warnAlice(r);
    if (!res.ok) throw new Error('expected ok');
    const [n] = cw.notices.pending(alice);
    cw.notices.ack(alice, n?.id ?? '');
    const g = res.groups[0]?.groupId ?? '';
    expect(await cw.sanctions.revoke(g, 'mod', 'mistake')).toBe(true);
    expect(cw.notices.record(alice)).toEqual([]);
    expect(await cw.sanctions.revoke(g, 'mod', 'again')).toBe(false);
  });

  it('revoking an unknown group is false and changes nothing', async () => {
    const r = await reported();
    await warnAlice(r);
    expect(await r.cw.sanctions.revoke('nope', 'mod', 'x')).toBe(false);
    expect(r.cw.notices.pending(alice)).toHaveLength(1);
  });

  it('a revoke of a sanction applied directly (no notice) still works', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const subject = cw.rooms.subjectAt(R, 'a') ?? '';
    const { groupId } = await cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: H,
      reason: 'private note',
      actor: 'mod',
      source: 'moderator',
      automated: false,
      rule: 1,
    });
    expect(await cw.sanctions.revoke(groupId, 'mod', 'x')).toBe(true);
  });
});

describe('createChatwarden: platform.notify', () => {
  it('feeds the one notice service: decide notifies the target and the reporter with a count', async () => {
    const told: Array<[string, unknown]> = [];
    const platform: Platform = {
      identify: (ctx) => ctx as RawWho,
      notify(who, event) {
        told.push([who, event]);
      },
    };
    const r = await reported({ platform });
    await warnAlice(r);
    expect(told).toHaveLength(2);
    expect(told).toEqual(
      expect.arrayContaining([
        [r.a, { type: 'notice_pending', count: 1 }],
        [r.b, { type: 'notice_pending', count: 1 }],
      ]),
    );
  });

  it('the chat auto timeout notifies too (the same service)', async () => {
    const told: string[] = [];
    const platform: Platform = { identify: (ctx) => ctx as RawWho, notify: (who) => void told.push(who) };
    const { cw } = await setup({ platform, matcher: spanBlocker });
    cw.rooms.seat(R, 'a', alice, 'Alice');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(told).toEqual([cw.rooms.subjectAt(R, 'a')]);
  });

  it('after a merge, notify names the same subject subjectAt gives for the seat (canonical)', async () => {
    const told: string[] = [];
    const platform: Platform = { identify: (ctx) => ctx as RawWho, notify: (who) => void told.push(who) };
    const { cw, clock } = await setup({ platform, matcher: spanBlocker });
    // The older person (with an account) survives a merge, so seat them first.
    cw.rooms.seat(R, 'acct', { clientKey: 'key-old', accountId: 'acct-merge', ip: '198.51.100.7' }, 'Old');
    clock.t += 10;
    cw.rooms.seat(R, 'a', { clientKey: 'key-new', ip: '198.51.100.8' }, 'New');
    const before = cw.rooms.subjectAt(R, 'a');
    // The new browser links the account: the two subjects merge, and seat 'a' still holds the merged-away one.
    cw.rooms.seat(R, 'link', { clientKey: 'key-new', accountId: 'acct-merge', ip: '198.51.100.8' }, 'Linked');
    const after = cw.rooms.subjectAt(R, 'a');
    expect(after).toBe(cw.rooms.subjectAt(R, 'acct'));
    expect(after).not.toBe(before);
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(told).toEqual([after]);
  });

  it('an unmerged seat is unchanged and an empty seat is still null (control)', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const a = cw.rooms.subjectAt(R, 'a');
    expect(a).toMatch(SUBJECT_RE);
    expect(cw.rooms.subjectAt(R, 'a')).toBe(a);
    expect(cw.rooms.subjectAt(R, 'nobody')).toBeNull();
  });

  it('two seats of one merged person report the same subject', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'old', { clientKey: 'k-old', accountId: 'acct-2' }, 'Old');
    clock.t += 10;
    cw.rooms.seat(R, 'new', { clientKey: 'k-new' }, 'New');
    cw.rooms.seat(R, 'link', { clientKey: 'k-new', accountId: 'acct-2' }, 'Link');
    expect(cw.rooms.subjectAt(R, 'new')).toBe(cw.rooms.subjectAt(R, 'old'));
    expect(cw.rooms.subjectAt(R, 'link')).toBe(cw.rooms.subjectAt(R, 'old'));
  });

  it('is called with the platform as this', async () => {
    let self: unknown;
    const platform: Platform = {
      identify: (ctx) => ctx as RawWho,
      notify(this: Platform) {
        self = [this.identify, typeof this.notify];
      },
    };
    const r = await reported({ platform });
    await warnAlice(r);
    expect(self).toEqual([platform.identify, 'function']);
  });

  it('a throwing or rejecting notify never fails decide', async () => {
    for (const make of [
      () => {
        throw new TypeError('boom');
      },
      () => Promise.reject(new TypeError('async boom')),
    ]) {
      const platform: Platform = { identify: (ctx) => ctx as RawWho, notify: make };
      const r = await reported({ platform });
      const res = await warnAlice(r);
      expect(res.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(r.logged.some(([e]) => e === 'notices.notify_failed')).toBe(true);
      expect(r.cw.notices.pending(alice)).toHaveLength(1);
    }
  });

  it('works with no notify at all (control)', async () => {
    const r = await reported();
    expect((await warnAlice(r)).ok).toBe(true);
  });
});

describe('createChatwarden: doors point at the notice', () => {
  it('a decided ban refuses at the door with that person own noticeId', async () => {
    const r = await reported();
    const { cw } = r;
    await warnAlice(r, { kind: 'ban', durationMs: DAY });
    const [n] = cw.notices.pending(alice);
    expect(cw.doors.check('join', alice)).toMatchObject({ kind: 'ban', noticeId: n?.id });
    expect(cw.doors.check('join', bob)).toBeNull();
  });
});

describe('createChatwarden: history and suggest', () => {
  it('a fresh person has no history and the standard profile suggests a warning for a rude first offence', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const a = cw.rooms.subjectAt(R, 'a') ?? '';
    expect(cw.history(a)).toEqual([]);
    const s = cw.suggest(a, 'rude', 2);
    expect(s).toMatchObject({ outcome: 'warning', label: 'Warning' });
    expect(s.why).toMatch(/^Standard profile: /);
    expect(cw.suggest(a, null, 2)).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY } });
    expect(cw.suggest(a, 'severe', 1)).toMatchObject({ outcome: { kind: 'chat', durationMs: 7 * DAY }, label: 'Restrict chat 7 days' });
    expect(cw.suggest(a, 'rude', 5, { roomId: R })).toMatchObject({ outcome: 'warning' });
  });

  it('suggest reads conduct levels: banter is no action, severe the high column, an old K2 value throws', async () => {
    const { cw } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const a = cw.rooms.subjectAt(R, 'a') ?? '';
    expect(cw.suggest(a, 'banter', 2)).toMatchObject({ outcome: 'none', label: 'No action' });
    expect(cw.suggest(a, 'hostile', 2)).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY } });
    expect(cw.suggest(a, 'severe', 2)).toMatchObject({ outcome: { kind: 'chat', durationMs: 7 * DAY } });
    expect(cw.suggest(a, 'hostile', 5)).toMatchObject({ outcome: { kind: 'area', durationMs: DAY } });
    expect(() => cw.suggest(a, 'high' as never, 2)).toThrow(RangeError);
  });

  it('the facade decide takes the new verdicts: bad_faith needs evidence, fair and unfair are invalid', async () => {
    const r = await reported();
    const { cw, reportId } = r;
    const base = { reportId, actor: 'mod@example.test', reason: 'private reason text', actions: [] };
    expect(await cw.decide({ ...base, verdict: 'fair' as never })).toEqual({ ok: false, error: 'invalid' });
    expect(await cw.decide({ ...base, verdict: 'unfair' as never })).toEqual({ ok: false, error: 'invalid' });
    expect(await cw.decide({ ...base, verdict: 'bad_faith' })).toEqual({ ok: false, error: 'invalid' });
    expect(await cw.decide({ ...base, verdict: 'no_action', evidence: 'x' })).toEqual({ ok: false, error: 'invalid' });
    expect(await cw.decide({ ...base, verdict: 'bad_faith', evidence: 'staff-only-evidence-text' })).toMatchObject({ ok: true });
    for (const who of [alice, bob]) expect(JSON.stringify(cw.notices.pending(who))).not.toContain('staff-only-evidence-text');
  });

  it('a decided warning shows in the history and moves the suggestion up the ladder', async () => {
    const r = await reported();
    const { cw, a } = r;
    await warnAlice(r);
    expect(cw.history(a)).toHaveLength(1);
    expect(cw.history(a)[0]).toMatchObject({ kind: 'warning' });
    expect(cw.suggest(a, 'hostile', 2)).toMatchObject({ outcome: { kind: 'chat', durationMs: 7 * DAY } });
    expect(cw.suggest(a, 'rude', 2)).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY } });
  });

  it('a decided Note is in the history with the room, tells nobody, and does not move the suggestion', async () => {
    const r = await reported();
    const { cw, a, b } = r;
    const res = await warnAlice(r, { kind: 'note' });
    expect(res).toMatchObject({ ok: true });
    expect(cw.history(a)).toEqual([{ kind: 'note', durationMs: 0, startsAt: r.clock.t, revoked: false, automated: false, roomId: R }]);
    // the note does not move the ladder step, but it counts toward "repeated": standard turns a second rude into chat 24 h
    expect(cw.suggest(a, 'severe', 2)).toMatchObject({ outcome: { kind: 'chat', durationMs: 7 * DAY } });
    expect(cw.suggest(a, 'rude', 2, { roomId: R })).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY } });
    expect(cw.notices.pending(alice)).toEqual([]);
    expect(cw.notices.pending(bob)).toEqual([]);
    expect(cw.notices.pendingWarning(alice)).toBe(false);
    expect(cw.doors.check('join', alice)).toBeNull();
    expect(cw.chat.accept(R, 'a', 'still free to talk')).toHaveProperty('deliver');
    expect(b).not.toBe(a);
  });

  it('the facade decide takes the noted verdict: all notes only', async () => {
    const r = await reported();
    const { cw, reportId, a } = r;
    const base = { reportId, actor: 'mod@example.test', reason: 'private reason text', verdict: 'noted' as const };
    expect(await cw.decide({ ...base, actions: [] })).toEqual({ ok: false, error: 'invalid' });
    expect(await cw.decide({ ...base, actions: [{ subject: a, kind: 'warning', durationMs: null, rule: 2 }] })).toEqual({ ok: false, error: 'invalid' });
    expect(await cw.decide({ ...base, actions: [{ subject: a, kind: 'note', durationMs: null, rule: 2 }] })).toMatchObject({ ok: true });
  });

  it('sanctions.apply takes an optional roomId, and it reads back in the history', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'a', alice, 'Alice');
    const a = cw.rooms.subjectAt(R, 'a') ?? '';
    await cw.sanctions.apply({ kind: 'note', subject: a, includeIp: false, durationMs: null, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 2, roomId: 'game-9' });
    await cw.sanctions.apply({ kind: 'note', subject: a, includeIp: false, durationMs: null, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 2 });
    expect(cw.history(a).map((h) => h.roomId)).toEqual(['game-9', null]);
    expect(cw.history(a)[0]?.startsAt).toBe(clock.t);
  });

  it('a record older than the 90-day lookback no longer counts', async () => {
    const r = await reported();
    const { cw, clock, a } = r;
    await warnAlice(r);
    clock.t += 91 * DAY;
    expect(cw.history(a)).toEqual([]);
    expect(cw.suggest(a, 'rude', 2)).toMatchObject({ outcome: 'warning' });
  });

  it('a note that has aged out of the 30 day window no longer makes a repeat', async () => {
    const r = await reported();
    const { cw, clock, a } = r;
    await warnAlice(r, { kind: 'note' });
    expect(cw.suggest(a, 'rude', 2)).toMatchObject({ outcome: { kind: 'chat', durationMs: DAY } });
    clock.t += 31 * DAY;
    expect(cw.history(a)).toHaveLength(1);
    expect(cw.suggest(a, 'rude', 2)).toMatchObject({ outcome: 'warning' });
  });
});

describe('createChatwarden: staff report queue', () => {
  it('get returns the record plus staff refs and the own line ids of every person', async () => {
    const r = await reported();
    const { cw, reportId, a, b, own, bobLine } = r;
    const got = cw.reports.get(reportId);
    if (got === null) throw new Error('expected the report');
    expect(got).toMatchObject({
      id: reportId,
      status: 'open',
      badFaith: false,
      actionedAt: null,
      actionedBy: null,
      modNote: null,
      badFaithEvidence: null,
      targetPerson: a,
      reporterPerson: b,
      category: 'harassment',
    });
    expect(got.people).toEqual([a, b]);
    expect(got.ownLineIds[a]).toEqual(own);
    expect(got.ownLineIds[b]).toEqual([bobLine]);
    expect(Object.keys(got.ownLineIds).sort()).toEqual([a, b].sort());
    // The same excerpt rule as a notice: what the picker offers is accepted by decide.
    expect((await warnAlice(r, { lineIds: got.ownLineIds[a] ?? [] })).ok).toBe(true);
  });

  it('get of an unknown id is null (also after the report was purged, and for odd input)', async () => {
    const { cw } = await reported();
    expect(cw.reports.get('nope')).toBeNull();
    expect(cw.reports.get('')).toBeNull();
    expect(cw.reports.get(undefined as never)).toBeNull();
  });

  it('list is newest first with the same shape as get, and the status filter follows decide', async () => {
    const r = await reported();
    const { cw, reportId, clock } = r;
    clock.t += 1000;
    cw.rooms.seat(R, 'c', { clientKey: 'key-carol', ip: '198.51.100.3' }, 'Carol');
    const second = await cw.reports.submit({ roomId: R, reporterSeat: 'c', targetSeat: 'a', category: 'spam' });
    if (!second.ok) throw new Error('expected a second report');
    const all = cw.reports.list();
    expect(all.items.map((x) => x.id)).toEqual([second.reportId, reportId]);
    expect(all.next).toBeNull();
    expect(all.items[1]).toEqual(cw.reports.get(reportId));
    expect(cw.reports.list({ status: 'open' }).items).toHaveLength(2);
    expect(cw.reports.list({ status: 'actioned' }).items).toEqual([]);
    expect((await warnAlice(r)).ok).toBe(true);
    expect(cw.reports.list({ status: 'open' }).items.map((x) => x.id)).toEqual([second.reportId]);
    const actioned = cw.reports.list({ status: 'actioned' }).items;
    expect(actioned.map((x) => x.id)).toEqual([reportId]);
    expect(actioned[0]).toMatchObject({ status: 'actioned', actionedBy: 'mod@example.test', actionedAt: clock.t });
    expect(cw.reports.list({ status: 'dismissed' }).items).toEqual([]);
  });

  it('list pages with the opaque cursor and clamps the limit', async () => {
    const r = await reported();
    const { cw, store, clock } = r;
    for (let i = 0; i < 4; i++) {
      clock.t += 1;
      const seat = `x${i}`;
      cw.rooms.seat(R, seat, { clientKey: `key-x${i}`, ip: '198.51.100.9' }, `X${i}`);
      const res = await cw.reports.submit({ roomId: R, reporterSeat: seat, targetSeat: 'b', category: 'spam' });
      if (!res.ok) throw new Error('expected a report');
    }
    expect(store.rawReports()).toHaveLength(5);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: ReturnType<typeof cw.reports.list> = cw.reports.list({ limit: 2, ...(cursor === null ? {} : { before: cursor }) });
      seen.push(...page.items.map((x) => x.id));
      cursor = page.next;
      if (cursor === null) break;
    }
    expect(seen).toEqual(store.rawReports().map((x) => x.id).reverse());
    expect(cw.reports.list({ limit: 0 }).items).toHaveLength(1);
    expect(cw.reports.list({ limit: -3 }).items).toHaveLength(1);
    expect(cw.reports.list({ limit: 10_000 }).items).toHaveLength(5);
    expect(typeof cw.reports.list({ limit: 2 }).next).toBe('string');
  });

  it('a malformed cursor or status is a loud ReportQueryError, not an empty page', async () => {
    const { cw } = await reported();
    expect(() => cw.reports.list({ before: '???' })).toThrow(expect.objectContaining({ name: 'ReportQueryError' }));
    expect(() => cw.reports.list({ status: 'closed' as never })).toThrow(expect.objectContaining({ name: 'ReportQueryError' }));
  });

  it('after a merge a report filed earlier shows the CANONICAL person', async () => {
    const r = await reported();
    const { cw, reportId, own, a } = r;
    cw.rooms.seat(R, 'acct', { clientKey: 'key-other', accountId: 'acct-merge', ip: '198.51.100.7' }, 'Other');
    cw.rooms.seat(R, 'link', { clientKey: 'key-alice', accountId: 'acct-merge', ip: '198.51.100.1' }, 'Linked');
    const merged = cw.rooms.subjectAt(R, 'acct');
    expect(merged).toBe(cw.rooms.subjectAt(R, 'a'));
    if (merged === null) throw new Error('expected a subject');
    const got = cw.reports.get(reportId);
    if (got === null) throw new Error('expected the report');
    expect(got.targetPerson).toBe(merged);
    expect(got.people[0]).toBe(merged);
    expect(got.ownLineIds[merged]).toEqual(own);
    // Only canonical refs are offered: the person once, and Bob.
    expect(Object.keys(got.ownLineIds).sort()).toEqual([merged, r.b].sort());
    expect(got.targetSubject).toBe(a);
    expect(cw.reports.list().items[0]?.targetPerson).toBe(merged);
  });

  it('is read-only: reading writes nothing and leaves the stored record untouched', async () => {
    const r = await reported();
    const before = JSON.stringify(r.store.rawReports());
    r.cw.reports.get(r.reportId);
    r.cw.reports.list();
    expect(JSON.stringify(r.store.rawReports())).toBe(before);
  });
});

describe('createChatwarden: the same scripted conversation under each preset', () => {
  const HOUR = H;
  type Step = { label: string; outcome: unknown };

  /**
   * One conversation, three incidents, each in its own room (game): banter ("loser"), rude, then rude again in a second
   * game 4 hours later. After each suggestion the suggested outcome is applied through `decide`, so the record grows.
   * Returns what `suggest` said at each incident. The expectations below are written out from the ladder table
   * (`ladder.ts`) and the preset, not read back from `suggest`.
   */
  async function conversation(over: Partial<ChatwardenOptions>, rooms: [string, string, string]): Promise<Step[]> {
    const { cw, clock } = await setup(over);
    const offender: RawWho = { clientKey: 'key-offender', ip: '198.51.100.20' };
    const steps: Step[] = [];
    const lines = ['loser', 'you are trash, uninstall', 'still trash, uninstall again'];
    const reporters = ['rep-1', 'rep-2', 'rep-3'];
    const levels = ['banter', 'rude', 'rude'] as const;
    for (let i = 0; i < 3; i++) {
      const room = rooms[i] as string;
      const reporter = reporters[i] as string;
      cw.rooms.seat(room, 'off', offender, 'Offender');
      cw.rooms.seat(room, reporter, { clientKey: `key-${reporter}`, ip: `198.51.100.3${i}` }, 'Reporter');
      expect(cw.chat.accept(room, 'off', lines[i] as string)).toHaveProperty('deliver');
      const sent = await cw.reports.submit({ roomId: room, reporterSeat: reporter, targetSeat: 'off', category: 'harassment' });
      if (!sent.ok) throw new Error('expected the report to be stored');
      const subject = cw.rooms.subjectAt(room, 'off');
      if (subject === null) throw new Error('expected a subject');

      const s = cw.suggest(subject, levels[i] as 'banter' | 'rude', 2, { roomId: room });
      steps.push({ label: s.label, outcome: s.outcome });

      const base = { reportId: sent.reportId, actor: 'mod@example.test', reason: 'private reason text' };
      const o = s.outcome;
      const action = (kind: DecisionAction['kind'], durationMs: number | null): DecisionAction => ({ subject, kind, durationMs, rule: 2 });
      const decided =
        o === 'none'
          ? await cw.decide({ ...base, verdict: 'no_action', actions: [] })
          : o === 'note'
            ? await cw.decide({ ...base, verdict: 'noted', actions: [action('note', null)] })
            : o === 'warning'
              ? await cw.decide({ ...base, verdict: 'upheld', actions: [action('warning', null)] })
              : await cw.decide({ ...base, verdict: 'upheld', actions: [action(o.kind, o.durationMs)] });
      expect(decided).toMatchObject({ ok: true });
      clock.t += 4 * HOUR; // past a 1 hour restriction, far inside every 30 day window
    }
    return steps;
  }

  it('relaxed: none, note, then warning (two rude incidents from different games)', async () => {
    expect(await conversation({ profile: 'relaxed' }, ['g0', 'gameA', 'gameB'])).toEqual([
      { label: 'No action', outcome: 'none' },
      { label: 'Note', outcome: 'note' },
      { label: 'Warning', outcome: 'warning' },
    ]);
  });

  it('relaxed control: the second rude incident in the SAME game is not a repeat (note, note)', async () => {
    expect(await conversation({ profile: 'relaxed' }, ['g0', 'gameA', 'gameA'])).toEqual([
      { label: 'No action', outcome: 'none' },
      { label: 'Note', outcome: 'note' },
      { label: 'Note', outcome: 'note' },
    ]);
  });

  it('standard (also the default): none, warning, then the ladder at step 1, chat for 24 hours', async () => {
    const expected = [
      { label: 'No action', outcome: 'none' },
      { label: 'Warning', outcome: 'warning' },
      { label: 'Restrict chat 24 hours', outcome: { kind: 'chat', durationMs: 24 * HOUR } },
    ];
    expect(await conversation({ profile: 'standard' }, ['g0', 'gameA', 'gameB'])).toEqual(expected);
    expect(await conversation({}, ['g0', 'gameA', 'gameB'])).toEqual(expected);
  });

  it('strict: none, chat for 1 hour, then the ladder at step 2, chat for 7 days', async () => {
    expect(await conversation({ profile: 'strict' }, ['g0', 'gameA', 'gameB'])).toEqual([
      { label: 'No action', outcome: 'none' },
      { label: 'Restrict chat 1 hour', outcome: { kind: 'chat', durationMs: HOUR } },
      { label: 'Restrict chat 7 days', outcome: { kind: 'chat', durationMs: 7 * 24 * HOUR } },
    ]);
  });

  it('an override of one nested field keeps the preset\'s other fields: relaxed + rude warning', async () => {
    const steps = await conversation({ profile: 'relaxed', overrides: { firstOffense: { rude: 'warning' } } }, ['g0', 'gameA', 'gameB']);
    // Rude is now a warning at once; the second rude reads ladder step 1 (relaxed ladder unchanged): chat 24 hours.
    expect(steps.map((x) => x.label)).toEqual(['No action', 'Warning', 'Restrict chat 24 hours']);
  });

  it('banter is never punished under any preset, even for a person with a full record', async () => {
    for (const profile of ['relaxed', 'standard', 'strict'] as const) {
      const steps = await conversation({ profile }, ['g0', 'gameA', 'gameB']);
      expect(steps[0]).toEqual({ label: 'No action', outcome: 'none' });
      const { cw } = await reported({ profile });
      const subject = cw.rooms.subjectAt(R, 'a') ?? '';
      expect(cw.suggest(subject, 'banter', 2)).toMatchObject({ outcome: 'none' });
    }
  });

  it('exposes the profile, limits, summary, rules and documents the facade resolved', async () => {
    const { cw } = await setup({ profile: 'relaxed' });
    expect(cw.profile.id).toBe('relaxed');
    expect(cw.summary).toBe('Trash talk is part of the game. Harassment, threats and hate are not.');
    expect(cw.summary).toBe(cw.profile.summary);
    expect(cw.limits.chatMaxLength).toBe(200);
    expect(cw.documents.codeOfConduct({ format: 'html', gameName: 'Test Game' })).toContain(cw.summary);
    expect(cw.rules.active().length).toBeGreaterThan(0);
  });
});

describe('createChatwarden: names.check', () => {
  /** Reads a name the way `@chatwarden/matcher` does: a handle form is split into words before it is matched. */
  const viewMatcher = (): Matcher & { names: string[]; plain: string[] } => {
    const names: string[] = [];
    const plain: string[] = [];
    // Whole word, with underscores and digits counting as word characters, as chat reads a line.
    const word = /(^|[^\p{L}\p{N}_])zorbak([^\p{L}\p{N}_]|$)/iu;
    const nameWord = /(^|[^\p{L}\p{N}])zorbak([^\p{L}\p{N}]|$)/iu;
    return {
      names,
      plain,
      match: (t) => {
        plain.push(t);
        return word.test(t) ? { termId: 'syn:zorbak' } : null;
      },
      matchName: (n) => {
        names.push(n);
        const view = n.replace(/_+/g, ' ').replace(/\p{N}+/gu, ' ');
        return nameWord.test(view) ? { termId: 'syn:zorbak' } : null;
      },
    };
  };

  it('blocks the synthetic term in handle forms and passes clean names', async () => {
    const { cw } = await setup({ matcher: viewMatcher() });
    for (const name of ['Zorbak_99', 'x_zorbak', 'zorbak123', 'ZORBAK', 'big zorbak']) {
      expect(cw.names.check(name)).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    }
    for (const name of ['Alice', 'quill_42', 'Nightowl', '']) {
      expect(cw.names.check(name)).toEqual({ ok: true });
    }
  });

  it('prefers the matcher\'s matchName over match', async () => {
    const m = viewMatcher();
    const { cw } = await setup({ matcher: m });
    cw.names.check('Zorbak_99');
    expect(m.names).toEqual(['Zorbak_99']);
    expect(m.plain).toEqual([]);
    // The plain matcher alone would have missed it: that is what matchName is for.
    expect(m.match('Zorbak_99')).toBeNull();
  });

  it('falls back to match(name) when the matcher has no matchName', async () => {
    const { cw } = await setup({ matcher: blocker });
    expect(cw.names.check('big zorbak')).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    expect(cw.names.check('Alice')).toEqual({ ok: true });
  });

  it('reports the configured autoRestrictRule', async () => {
    const { cw } = await setup({ matcher: viewMatcher(), rules: customRules(), autoRestrictRule: 3 });
    expect(cw.names.check('zorbak')).toEqual({ ok: false, reason: 'name_not_allowed', rule: 3 });
  });

  it('with no matcher every name is ok', async () => {
    const { cw } = await setup();
    expect(cw.names.check('Zorbak_99')).toEqual({ ok: true });
  });

  it('a throwing matcher lets the name through and logs the error class only', async () => {
    const { cw, logged } = await setup({
      matcher: {
        match: () => {
          throw new RangeError('term list secret');
        },
      },
    });
    expect(cw.names.check('Alice')).toEqual({ ok: true });
    expect(logged).toContainEqual(['chatwarden.names_matcher_failed', { error: 'RangeError' }]);
    expect(JSON.stringify(logged)).not.toContain('secret');
  });

  it('the result holds no term id, subject or the name itself', async () => {
    const { cw } = await setup({ matcher: viewMatcher() });
    const out = JSON.stringify(cw.names.check('Zorbak_99'));
    expect(out).not.toContain('syn:');
    expect(out).not.toContain('Zorbak');
  });

  it('a name that is not a string is a TypeError, not a pass', async () => {
    const { cw } = await setup({ matcher: viewMatcher() });
    for (const bad of [undefined, null, 5, {}, ['zorbak']]) {
      expect(() => cw.names.check(bad as never)).toThrow(TypeError);
    }
  });
});

describe('createChatwarden: names.check, odd inputs', () => {
  const m: Matcher = {
    match: (t) => (/(^|[^\p{L}\p{N}_])zorbak([^\p{L}\p{N}_]|$)/iu.test(t) ? { termId: 'syn:zorbak' } : null),
  };

  it('a whitespace-only name is ok (the caller decides whether a blank name is allowed)', async () => {
    const { cw } = await setup({ matcher: m });
    for (const name of [' ', '   ', '\t\n', '  ']) expect(cw.names.check(name)).toEqual({ ok: true });
  });

  it('a very long name is checked in full, not capped: clean passes, a term at the end is still caught', async () => {
    const { cw } = await setup({ matcher: m });
    const clean = 'a'.repeat(10_000);
    expect(cw.names.check(clean)).toEqual({ ok: true });
    expect(cw.names.check(`${'a '.repeat(5_000)}zorbak`)).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    expect(cw.names.check(`zorbak ${'a '.repeat(5_000)}`)).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
  });
});

describe('createChatwarden: ready', () => {
  it('is true while the store answers schemaVersion()', async () => {
    const { cw } = await setup();
    expect(cw.ready()).toBe(true);
    expect(cw.ready()).toBe(true);
  });

  it('is false, logged by class only, when schemaVersion() throws; true again when it recovers', async () => {
    const store = new MemoryStore();
    const { cw, logged } = await setup({}, store);
    logged.length = 0;
    let down = true;
    const spy = vi.spyOn(store, 'schemaVersion').mockImplementation(() => {
      if (down) throw new TypeError('secret detail 203.0.113.9');
      return 3;
    });
    expect(cw.ready()).toBe(false);
    expect(logged).toEqual([['chatwarden.ready_failed', { error: 'TypeError' }]]);
    expect(JSON.stringify(logged)).not.toContain('secret');
    down = false;
    expect(cw.ready()).toBe(true);
    spy.mockRestore();
  });

  it('never throws, even for a thrown non-error, and never touches anything else in the store', async () => {
    const store = new MemoryStore();
    const { cw } = await setup({}, store);
    vi.spyOn(store, 'schemaVersion').mockImplementation(() => {
      throw 'plain string';
    });
    expect(cw.ready()).toBe(false);
  });
});
