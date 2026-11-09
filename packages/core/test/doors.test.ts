import { describe, expect, it } from 'vitest';
import { DoorService } from '../src/doors.js';
import { makeHasher } from '../src/hasher.js';
import { applySanction, revokeSanction, SanctionIndex, type SanctionInput } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Hasher, Logger, RawWho, SanctionKind, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const IP = '198.51.100.7';
const REF_RE = /^M-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

function setup(opts: { enabled?: () => boolean } = {}) {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const hasher = makeHasher('door-secret');
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const sanctions = new SanctionIndex({ enabled: opts.enabled ?? (() => true), subjects });
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const doors = new DoorService({ hasher, subjects, sanctions, clock, logger });
  /** Seat a person the way the adopter would: resolve their identifiers (this is what links). */
  const seat = (w: RawWho): SubjectId => {
    const s = subjects.resolve({
      clientKey: w.clientKey ? hasher.clientKey(w.clientKey) : null,
      accountId: w.accountId ?? null,
      ipHash: w.ip ? hasher.ip(w.ip) : null,
    });
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  const ban = (
    subject: SubjectId,
    kind: SanctionKind,
    over: Partial<SanctionInput> = {},
  ): Promise<{ groupId: string; refCode: string }> =>
    applySanction(
      store,
      subjects,
      {
        kind,
        subject,
        includeIp: false,
        durationMs: H,
        reason: 'private-reason-text',
        actor: 'mod@x.com',
        source: 'moderator',
        automated: false,
        rule: 1,
        ...over,
      },
      clock.t,
      sanctions,
    );
  return { store, clock, hasher, subjects, sanctions, logged, logger, doors, seat, ban };
}

const who: RawWho = { clientKey: 'tok-1', accountId: 'acct-1', ip: IP };

describe('DoorService: join and create refuse a ban only', () => {
  it('a ban on the browser key is found, with its end and ref code', async () => {
    const t = setup();
    const { refCode } = await t.ban(t.seat({ clientKey: 'tok-1' }), 'ban');
    expect(t.doors.check('join', who)).toEqual({ kind: 'ban', until: NOW + H, refCode });
    expect(t.doors.check('create', who)).toEqual({ kind: 'ban', until: NOW + H, refCode });
    expect(refCode).toMatch(REF_RE);
  });

  it('a ban on the account is found from a fresh browser (other key, other address)', async () => {
    const t = setup();
    await t.ban(t.seat({ accountId: 'acct-1' }), 'ban');
    expect(t.doors.check('join', { clientKey: 'fresh', accountId: 'acct-1', ip: '192.0.2.99' })).not.toBeNull();
  });

  it('a permanent ban reports until: null', async () => {
    const t = setup();
    await t.ban(t.seat({ accountId: 'acct-1' }), 'ban', { durationMs: null });
    expect(t.doors.check('join', who)).toMatchObject({ kind: 'ban', until: null });
  });

  it('an area or chat sanction does not refuse join or create', async () => {
    const t = setup();
    const s = t.seat(who);
    await t.ban(s, 'area');
    await t.ban(s, 'chat');
    expect(t.doors.check('join', who)).toBeNull();
    expect(t.doors.check('create', who)).toBeNull();
  });

  it('an area ban does not hide behind a shorter ban: join sees only the ban', async () => {
    const t = setup();
    const s = t.seat(who);
    await t.ban(s, 'area', { durationMs: 5 * H });
    const { refCode } = await t.ban(s, 'ban', { durationMs: H });
    expect(t.doors.check('join', who)).toEqual({ kind: 'ban', until: NOW + H, refCode });
  });
});

describe('DoorService: public and matchmaking refuse an area ban or a ban', () => {
  it.each(['public', 'matchmaking'] as const)('%s refuses an area ban, with its kind', async (door) => {
    const t = setup();
    const { refCode } = await t.ban(t.seat(who), 'area');
    expect(t.doors.check(door, who)).toEqual({ kind: 'area', until: NOW + H, refCode });
  });

  it.each(['public', 'matchmaking'] as const)('%s refuses a ban', async (door) => {
    const t = setup();
    const { refCode } = await t.ban(t.seat(who), 'ban', { durationMs: null });
    expect(t.doors.check(door, who)).toEqual({ kind: 'ban', until: null, refCode });
  });

  it.each(['public', 'matchmaking'] as const)('%s does not refuse a chat sanction alone', async (door) => {
    const t = setup();
    await t.ban(t.seat(who), 'chat');
    expect(t.doors.check(door, who)).toBeNull();
  });

  it('an area ban keeps them off public tables but not off friends tables', async () => {
    const t = setup();
    await t.ban(t.seat(who), 'area');
    expect(t.doors.check('public', who)).not.toBeNull();
    expect(t.doors.check('join', who)).toBeNull();
    expect(t.doors.check('create', who)).toBeNull();
  });

  it('with both kinds active the longer wins', async () => {
    const t = setup();
    const s = t.seat(who);
    await t.ban(s, 'area', { durationMs: H });
    const b = await t.ban(s, 'ban', { durationMs: 3 * H });
    expect(t.doors.check('public', who)).toEqual({ kind: 'ban', until: NOW + 3 * H, refCode: b.refCode });
    const a = await t.ban(s, 'area', { durationMs: 5 * H });
    expect(t.doors.check('public', who)).toEqual({ kind: 'area', until: NOW + 5 * H, refCode: a.refCode });
  });

  it('permanent beats timed across kinds', async () => {
    const t = setup();
    const s = t.seat(who);
    await t.ban(s, 'ban', { durationMs: 3 * H });
    const a = await t.ban(s, 'area', { durationMs: null });
    expect(t.doors.check('matchmaking', who)).toEqual({ kind: 'area', until: null, refCode: a.refCode });
  });

  it('on equal ends the ban is reported rather than the area ban', async () => {
    const t = setup();
    const s = t.seat(who);
    await t.ban(s, 'area', { durationMs: H });
    const b = await t.ban(s, 'ban', { durationMs: H });
    expect(t.doors.check('public', who)).toEqual({ kind: 'ban', until: NOW + H, refCode: b.refCode });
  });
});

describe('DoorService: IP', () => {
  it('a ban seen by IP alone refuses within its 24 h', async () => {
    const t = setup();
    const s = t.seat({ accountId: 'someone', ip: IP });
    const { refCode } = await t.ban(s, 'ban', { includeIp: true, durationMs: 30 * DAY });
    expect(t.doors.check('join', { ip: IP })).toEqual({ kind: 'ban', until: NOW + DAY, refCode });
    t.clock.t = NOW + 23 * H;
    expect(t.doors.check('join', { ip: IP })).not.toBeNull();
  });

  it('after 24 h the address no longer refuses, though the person is still banned by key and account', async () => {
    const t = setup();
    const s = t.seat({ clientKey: 'tok-1', accountId: 'acct-1', ip: IP });
    await t.ban(s, 'ban', { includeIp: true, durationMs: 30 * DAY });
    t.clock.t = NOW + 25 * H;
    expect(t.doors.check('join', { ip: IP })).toBeNull();
    expect(t.doors.check('join', who)).toMatchObject({ kind: 'ban', until: NOW + 30 * DAY });
  });

  it('an IP-only area ban refuses public doors from that address, not friends doors', async () => {
    const t = setup();
    await t.ban(t.seat({ accountId: 'someone', ip: IP }), 'area', { includeIp: true });
    expect(t.doors.check('public', { ip: IP })).not.toBeNull();
    expect(t.doors.check('matchmaking', { ip: IP })).not.toBeNull();
    expect(t.doors.check('join', { ip: IP })).toBeNull();
  });

  it("an unrelated address is not refused by someone else's IP ban", async () => {
    const t = setup();
    await t.ban(t.seat({ accountId: 'someone', ip: IP }), 'ban', { includeIp: true });
    expect(t.doors.check('join', { ip: '192.0.2.200' })).toBeNull();
  });

  it('two people behind one household IP stay separate when the ban names no address', async () => {
    const t = setup();
    const a = t.seat({ clientKey: 'tok-a', ip: IP });
    t.seat({ clientKey: 'tok-b', ip: IP });
    await t.ban(a, 'ban', { includeIp: false });
    expect(t.doors.check('join', { clientKey: 'tok-a', ip: IP })).not.toBeNull();
    expect(t.doors.check('join', { clientKey: 'tok-b', ip: IP })).toBeNull();
  });

  it('the "unknown" address sentinel is never matched (it would tie every such caller together)', async () => {
    const t = setup();
    await t.ban(t.seat({ accountId: 'someone', ip: IP }), 'ban', { includeIp: true });
    expect(t.doors.check('join', { clientKey: 'x', ip: 'unknown' })).toBeNull();
    expect(t.doors.check('join', { clientKey: 'x', ip: null })).toBeNull();
    expect(t.doors.check('join', { clientKey: 'x', ip: '' })).toBeNull();
  });
});

describe('DoorService: one person, two browsers, linked by signing in', () => {
  it('a ban follows the person to a second browser once signing in has linked them', async () => {
    const t = setup();
    const s = t.seat({ clientKey: 'browser-1', accountId: 'acct-1' });
    t.seat({ clientKey: 'browser-2', accountId: 'acct-1' });
    await t.ban(s, 'ban');
    expect(t.doors.check('join', { clientKey: 'browser-2' })).not.toBeNull();
    expect(t.doors.check('join', { clientKey: 'browser-1' })).not.toBeNull();
    expect(t.doors.check('join', { accountId: 'acct-1' })).not.toBeNull();
  });

  it('a ban written on one subject applies to the other browser only after signing in links them', async () => {
    const t = setup();
    const a = t.seat({ clientKey: 'browser-1' });
    t.clock.t += 10;
    const b = t.seat({ accountId: 'acct-1' });
    await t.ban(b, 'ban');
    expect(t.doors.check('join', { clientKey: 'browser-1' })).toBeNull(); // not linked yet
    t.seat({ clientKey: 'browser-1', accountId: 'acct-1' }); // signing in links
    expect(t.doors.check('join', { clientKey: 'browser-1' })).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('a key and an account that are not linked yet are each checked, and the longer ban is reported', async () => {
    const t = setup();
    const a = t.seat({ clientKey: 'browser-1' });
    t.clock.t += 10;
    const b = t.seat({ accountId: 'acct-1' });
    await t.ban(b, 'ban', { durationMs: 2 * H });
    await t.ban(a, 'ban', { durationMs: H });
    const at = t.clock.t; // both bans were written at this time
    expect(t.doors.check('join', { clientKey: 'browser-1', accountId: 'acct-1' })).toMatchObject({ until: at + 2 * H });
    // the account's ban counts although the key's subject is the older one
    expect(t.doors.check('join', { accountId: 'acct-1' })).toMatchObject({ until: at + 2 * H });
    expect(t.doors.check('join', { clientKey: 'browser-1' })).toMatchObject({ until: at + H });
  });

  it('an unrelated person is not refused', async () => {
    const t = setup();
    await t.ban(t.seat({ clientKey: 'other-tok', accountId: 'someone-else' }), 'ban');
    expect(t.doors.check('join', who)).toBeNull();
    expect(t.doors.check('public', who)).toBeNull();
  });
});

describe('DoorService: a door check never mints or merges people', () => {
  it('an unknown caller creates no subject and writes nothing to the store', async () => {
    const t = setup();
    t.seat({ clientKey: 'known' });
    await t.subjects.flush();
    const before = await t.store.loadSubjects();
    for (const door of ['join', 'create', 'public', 'matchmaking'] as const) {
      t.doors.check(door, { clientKey: 'stranger', accountId: 'stranger-acct', ip: '203.0.113.5' });
    }
    await t.subjects.flush();
    expect(await t.store.loadSubjects()).toEqual(before);
    expect(t.subjects.lookup({ clientKey: t.hasher.clientKey('stranger'), accountId: null, ipHash: null })).toBeNull();
  });

  it("a known key with an unknown account does not link the account to the key's subject", () => {
    const t = setup();
    const s = t.seat({ clientKey: 'known' });
    t.doors.check('join', { clientKey: 'known', accountId: 'brand-new' });
    expect(t.subjects.lookup({ clientKey: null, accountId: 'brand-new', ipHash: null })).toBeNull();
    expect(t.subjects.identifiersOf(s).accounts).toEqual([]);
  });

  it('a key and an account of two subjects are not merged by a check', () => {
    const t = setup();
    const a = t.seat({ clientKey: 'k1' });
    const b = t.seat({ accountId: 'a1' });
    t.doors.check('join', { clientKey: 'k1', accountId: 'a1' });
    expect(t.subjects.canonical(a)).toBe(a);
    expect(t.subjects.canonical(b)).toBe(b);
  });
});

describe('DoorService: boundaries, switches and unknown callers', () => {
  it('a sanction whose end equals now no longer applies; one tick earlier it does', async () => {
    const t = setup();
    await t.ban(t.seat(who), 'ban');
    t.clock.t = NOW + H - 1;
    expect(t.doors.check('join', who)).not.toBeNull();
    t.clock.t = NOW + H;
    expect(t.doors.check('join', who)).toBeNull();
  });

  it('a revoked sanction no longer refuses', async () => {
    const t = setup();
    const { groupId } = await t.ban(t.seat(who), 'ban');
    expect(t.doors.check('join', who)).not.toBeNull();
    await revokeSanction(t.store, groupId, 'mod', NOW, 'mistake', t.sanctions);
    expect(t.doors.check('join', who)).toBeNull();
  });

  it('sanctions switched off enforce nothing, and the switch is read per call', async () => {
    let on = true;
    const t = setup({ enabled: () => on });
    await t.ban(t.seat(who), 'ban');
    expect(t.doors.check('join', who)).not.toBeNull();
    on = false;
    expect(t.doors.check('join', who)).toBeNull();
    expect(t.doors.check('public', who)).toBeNull();
    on = true;
    expect(t.doors.check('join', who)).not.toBeNull();
  });

  it('a caller with nothing known (or only empty values) is let through', async () => {
    const t = setup();
    await t.ban(t.seat(who), 'ban');
    expect(t.doors.check('join', {})).toBeNull();
    expect(t.doors.check('join', { clientKey: '', accountId: '', ip: '' })).toBeNull();
  });

  it('uses the injected clock, not the wall clock', async () => {
    const t = setup();
    await t.ban(t.seat(who), 'ban');
    t.clock.t = NOW + 10 * DAY;
    expect(t.doors.check('join', who)).toBeNull();
  });
});

describe('DoorService: what a refusal carries', () => {
  it('has exactly kind, until and refCode: no reason, identifier, hash or subject id', async () => {
    const t = setup();
    const s = t.seat({ clientKey: 'tok-secret', accountId: 'acct-secret', ip: IP });
    await t.ban(s, 'ban', { includeIp: true, rule: 4 });
    const res = t.doors.check('join', { clientKey: 'tok-secret', accountId: 'acct-secret', ip: IP });
    expect(res).not.toBeNull();
    expect(Object.keys(res ?? {}).sort()).toEqual(['kind', 'refCode', 'until']);
    const text = JSON.stringify(res);
    for (const secret of [
      'tok-secret',
      'acct-secret',
      IP,
      t.hasher.clientKey('tok-secret'),
      t.hasher.ip(IP),
      s,
      'private-reason-text',
      'mod@x.com',
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('DoorService: a failure lets the caller through and never throws', () => {
  it('a throwing sanction index lets them through and logs without identifiers', async () => {
    const t = setup();
    await t.ban(t.seat({ clientKey: 'tok-secret', accountId: 'acct-secret', ip: IP }), 'ban');
    t.sanctions.active = () => {
      throw new TypeError('boom with tok-secret');
    };
    let res: unknown = 'unset';
    expect(() => {
      res = t.doors.check('join', { clientKey: 'tok-secret', accountId: 'acct-secret', ip: IP });
    }).not.toThrow();
    expect(res).toBeNull();
    expect(t.logged).toHaveLength(1);
    expect(t.logged[0]?.[0]).toBe('doors.check_failed');
    expect(t.logged[0]?.[1]).toEqual({ error: 'TypeError' });
    expect(JSON.stringify(t.logged)).not.toContain('tok-secret');
    expect(JSON.stringify(t.logged)).not.toContain(IP);
  });

  it('a throwing subject lookup lets them through', () => {
    const t = setup();
    t.subjects.lookup = () => {
      throw new RangeError('x');
    };
    expect(t.doors.check('public', who)).toBeNull();
    expect(t.logged[0]).toEqual(['doors.check_failed', { error: 'RangeError' }]);
  });

  it('a throwing hasher lets them through', () => {
    const t = setup();
    const bad: Hasher = {
      clientKey: () => {
        throw new Error('no key');
      },
      ip: () => 'x',
    };
    const doors = new DoorService({ hasher: bad, subjects: t.subjects, sanctions: t.sanctions, clock: t.clock, logger: t.logger });
    expect(doors.check('join', who)).toBeNull();
    expect(t.logged[0]).toEqual(['doors.check_failed', { error: 'Error' }]);
  });

  it('a non-Error throw is logged by its type', () => {
    const t = setup();
    t.sanctions.active = () => {
      throw 'a string';
    };
    t.seat(who);
    expect(t.doors.check('join', who)).toBeNull();
    expect(t.logged[0]).toEqual(['doors.check_failed', { error: 'string' }]);
  });

  it('a throwing logger does not turn a failure into a throw', () => {
    const t = setup();
    t.sanctions.active = () => {
      throw new Error('boom');
    };
    t.seat(who);
    const doors = new DoorService({
      hasher: t.hasher,
      subjects: t.subjects,
      sanctions: t.sanctions,
      clock: t.clock,
      logger: {
        warn() {
          throw new Error('logger down');
        },
      },
    });
    expect(doors.check('join', who)).toBeNull();
  });

  it('an unknown door kind lets them through', async () => {
    const t = setup();
    await t.ban(t.seat(who), 'ban');
    expect(t.doors.check('lobby' as never, who)).toBeNull();
  });

  it('defaults the logger to console.warn', () => {
    const t = setup();
    t.sanctions.active = () => {
      throw new Error('boom');
    };
    t.seat(who);
    const doors = new DoorService({ hasher: t.hasher, subjects: t.subjects, sanctions: t.sanctions, clock: t.clock });
    const seen: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void seen.push(a);
    try {
      expect(doors.check('join', who)).toBeNull();
    } finally {
      console.warn = orig;
    }
    expect(seen[0]?.[0]).toBe('doors.check_failed');
  });
});

describe('DoorService: a warning never refuses at a door', () => {
  const doorKinds = ['join', 'create', 'public', 'matchmaking'] as const;

  it.each(doorKinds)('%s lets a warned person through, with and without an IP', async (door) => {
    const t = setup();
    const s = t.seat(who);
    await t.ban(s, 'warning', { durationMs: null });
    expect(t.doors.check(door, who)).toBeNull();
    // Another browser of the same person, and a stranger on the same IP.
    expect(t.doors.check(door, { clientKey: 'tok-1' })).toBeNull();
    expect(t.doors.check(door, { ip: IP })).toBeNull();
  });

  it.each(doorKinds)('%s lets a person with several warnings through', async (door) => {
    const t = setup();
    const s = t.seat(who);
    for (let i = 0; i < 3; i++) await t.ban(s, 'warning', { durationMs: null });
    expect(t.doors.check(door, who)).toBeNull();
  });

  it('a warning does not hide a real ban of the same person', async () => {
    const t = setup();
    const s = t.seat(who);
    await t.ban(s, 'warning', { durationMs: null });
    await t.ban(s, 'ban');
    expect(t.doors.check('join', who)).toMatchObject({ kind: 'ban' });
  });
});
