import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { Chatwarden, ChatwardenOptions } from '../src/chatwarden.js';
import { LIMITS_DEFAULTS } from '../src/limits.js';
import { defineProfile, PRESETS, ProfileError, resolveProfile } from '../src/profile.js';
import { RETENTION_DEFAULTS } from '../src/retention.js';
import { defineRules, starterRules, STARTER_RULES } from '../src/rules.js';
import type { Logger, Matcher, Platform, RawWho } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

// The facade end of K3a Task 5: presets pick a complete setup, `limits` and `retention` tune it, and the floors
// refuse a setup that would forget what the kit still needs.

const NOW = 1_800_000_000_000;
const SEC = 1_000;
const MIN = 60_000;
const H = 3_600_000;
const DAY = 24 * H;
const R = 'room';

const blocker: Matcher = { match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null) };
const platform: Platform = { identify: (ctx) => ctx as RawWho };
const quiet: Logger = { warn() {} };

const who = (n: string): RawWho => ({ clientKey: `key-${n}`, ip: `198.51.100.${n.length}` });

async function setup(over: Partial<ChatwardenOptions> = {}) {
  const clock = { t: NOW, now: () => clock.t };
  const store = new MemoryStore();
  const cw = await createChatwarden({
    store,
    secret: 'config-secret',
    platform,
    clock,
    logger: quiet,
    matcher: blocker,
    retention: false,
    ...over,
  });
  return { cw, clock, store };
}

/** Seat people a..e (a is the one who chats). */
function seatAll(cw: Chatwarden, seats: string[] = ['a', 'b', 'c', 'd', 'e', 'f']): void {
  for (const s of seats) cw.rooms.seat(R, s, who(s), s.toUpperCase());
}

const rejection = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
};

describe('createChatwarden: profile, summary and starter rules', () => {
  it('with no profile it is standard: standard summary, standard rules, standard suggestions', async () => {
    const { cw } = await setup();
    expect(cw.profile).toEqual(PRESETS.standard);
    expect(cw.summary).toBe(PRESETS.standard.summary);
    expect(cw.rules.all()).toEqual(defineRules(STARTER_RULES).all());
    cw.rooms.seat(R, 'a', who('a'), 'A');
    const a = cw.rooms.subjectAt(R, 'a') ?? '';
    expect(cw.suggest(a, 'rude', 2)).toMatchObject({ outcome: 'warning' });
  });

  it.each(['relaxed', 'standard', 'strict'] as const)('%s: summary verbatim, rules for the flavour, profile resolved', async (name) => {
    const { cw } = await setup({ profile: name });
    expect(cw.profile).toEqual(PRESETS[name]);
    expect(cw.summary).toBe(PRESETS[name].summary);
    expect(cw.rules.all()).toEqual(defineRules(starterRules(name)).all());
  });

  it('the three summaries are the standards doc strings', async () => {
    expect((await setup({ profile: 'relaxed' })).cw.summary).toBe(
      'Trash talk is part of the game. Harassment, threats and hate are not.',
    );
    expect((await setup({ profile: 'standard' })).cw.summary).toBe(
      "Keep it friendly. Personal insults, harassment and hate aren't allowed.",
    );
    expect((await setup({ profile: 'strict' })).cw.summary).toBe('Be kind. No swearing, insults or bullying.');
  });

  it('relaxed: CR 2 is the relaxed text and the other rules are the standard ones', async () => {
    const { cw } = await setup({ profile: 'relaxed' });
    expect(cw.rules.get(2)).toEqual({
      number: 2,
      title: 'No harassment or threats',
      text: "Trash talk about the game and each other's play is fine. Harassing, threatening or personally attacking someone, again and again, is not.",
    });
    expect(cw.rules.label(2)).toBe('Community Rule 2: No harassment or threats');
    expect(cw.rules.get(1)).toEqual(STARTER_RULES[0]);
    expect(cw.rules.get(8)).toEqual(STARTER_RULES[7]);
  });

  it('standard keeps the K2 CR 2; strict CR 2 covers swearing and CR 3 is unchanged', async () => {
    expect((await setup({ profile: 'standard' })).cw.rules.get(2)).toEqual(STARTER_RULES[1]);
    const strict = (await setup({ profile: 'strict' })).cw.rules;
    expect(strict.get(2)?.text).toMatch(/swear/i);
    expect(strict.get(3)).toEqual(STARTER_RULES[2]);
  });

  it('suggest uses the resolved profile (no more hard-wired standard)', async () => {
    const relaxed = await setup({ profile: 'relaxed' });
    const strict = await setup({ profile: 'strict' });
    const std = await setup({ profile: 'standard' });
    for (const { cw } of [relaxed, strict, std]) cw.rooms.seat(R, 'a', who('a'), 'A');
    const sub = (cw: Chatwarden): string => cw.rooms.subjectAt(R, 'a') ?? '';
    expect(relaxed.cw.suggest(sub(relaxed.cw), 'rude', 2)).toMatchObject({ outcome: 'note' });
    expect(std.cw.suggest(sub(std.cw), 'rude', 2)).toMatchObject({ outcome: 'warning' });
    expect(strict.cw.suggest(sub(strict.cw), 'rude', 2).why).toMatch(/^Strict profile: /);
    expect(relaxed.cw.suggest(sub(relaxed.cw), 'rude', 2).why).toMatch(/^Relaxed profile: /);
    // banter never punishes, under every preset
    for (const { cw } of [relaxed, strict, std]) expect(cw.suggest(sub(cw), 'banter', 2)).toMatchObject({ outcome: 'none' });
  });

  it('overrides change the resolved profile, and suggest follows them', async () => {
    const { cw } = await setup({
      profile: 'relaxed',
      overrides: { firstOffense: { rude: 'warning' }, profanity: { mode: 'allow' } },
    });
    expect(cw.profile.firstOffense.rude).toBe('warning');
    expect(cw.profile.firstOffense.hostile).toBe(PRESETS.relaxed.firstOffense.hostile); // siblings kept
    expect(cw.profile.profanity.mode).toBe('allow');
    expect(cw.summary).toBe(PRESETS.relaxed.summary);
    cw.rooms.seat(R, 'a', who('a'), 'A');
    expect(cw.suggest(cw.rooms.subjectAt(R, 'a') ?? '', 'rude', 2)).toMatchObject({ outcome: 'warning' });
  });

  it('overrides can change the summary and the rules flavour', async () => {
    const { cw } = await setup({ profile: 'standard', overrides: { summary: 'House rules apply.', rules: 'strict' } });
    expect(cw.summary).toBe('House rules apply.');
    expect(cw.rules.get(2)?.text).toMatch(/swear/i);
    expect(cw.rules.get(3)).toEqual(STARTER_RULES[2]);
  });

  it('accepts a complete custom profile, and overrides apply to it', async () => {
    const custom = defineProfile({ ...PRESETS.strict, id: 'mine', name: 'Mine', summary: 'Our own words.', rules: 'relaxed' });
    const { cw } = await setup({ profile: custom, overrides: { name: 'Mine, tuned' } });
    expect(cw.profile.id).toBe('mine');
    expect(cw.profile.name).toBe('Mine, tuned');
    expect(cw.summary).toBe('Our own words.');
    expect(cw.rules.get(2)?.title).toBe('No harassment or threats');
  });

  it('cw.profile, cw.limits and cw.summary are frozen', async () => {
    const { cw } = await setup();
    expect(Object.isFrozen(cw.profile)).toBe(true);
    expect(Object.isFrozen(cw.profile.firstOffense)).toBe(true);
    expect(Object.isFrozen(cw.limits)).toBe(true);
    expect(Object.isFrozen(cw.limits.strikes)).toBe(true);
    expect(Object.isFrozen(cw.limits.chatRate)).toBe(true);
    expect(Object.isFrozen(cw.limits.reports)).toBe(true);
    expect(typeof cw.summary).toBe('string');
    expect(() => {
      (cw.limits as { chatMaxLength: number }).chatMaxLength = 1;
    }).toThrow(TypeError);
    expect(cw.limits.chatMaxLength).toBe(200);
  });

  it('the profile and limits do not alias what the adopter passed', async () => {
    const limits = { chatMaxLength: 80 };
    const overrides = { summary: 'Before.' };
    const { cw } = await setup({ limits, overrides });
    limits.chatMaxLength = 5;
    overrides.summary = 'After.';
    expect(cw.limits.chatMaxLength).toBe(80);
    expect(cw.summary).toBe('Before.');
  });

  it('opts.rules wins over the profile flavour', async () => {
    const rules = defineRules([{ number: 1, title: 'Be nice', text: 'Be nice to each other.' }]);
    const { cw } = await setup({ profile: 'relaxed', rules });
    expect(cw.rules).toBe(rules);
    expect(cw.summary).toBe(PRESETS.relaxed.summary);
  });

  it('autoRestrictRule is still validated against the profile rules', async () => {
    await expect(setup({ profile: 'relaxed', autoRestrictRule: 99 })).rejects.toBeInstanceOf(RangeError);
    const { cw } = await setup({ profile: 'strict', autoRestrictRule: 2, matcher: blocker });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    expect(cw.chat.accept(R, 'a', 'zorbak')).toEqual({ refuse: { reason: 'blocked', rule: 2 } });
  });

  it('an unknown preset, an unknown override key and a bad override throw ProfileError at creation', async () => {
    expect(await rejection(setup({ profile: 'loose' as never }))).toBeInstanceOf(ProfileError);
    expect(await rejection(setup({ overrides: { nope: 1 } as never }))).toBeInstanceOf(ProfileError);
    const err = await rejection(setup({ overrides: { aiAutoAct: ['banter'] } as never }));
    expect(err).toBeInstanceOf(ProfileError);
    // a bad profile must not leave a half-built kit behind: the store is untouched and no timer was started
  });

  it('a profile that is resolveProfile() output is accepted as is', async () => {
    const p = resolveProfile('relaxed', { name: 'Relaxed+' });
    const { cw } = await setup({ profile: p });
    expect(cw.profile.name).toBe('Relaxed+');
  });
});

describe('createChatwarden: limits default to the K1/K2 behaviour', () => {
  it('cw.limits is the defaults when nothing is passed, and for {}', async () => {
    expect((await setup()).cw.limits).toEqual(LIMITS_DEFAULTS);
    expect((await setup({ limits: {} })).cw.limits).toEqual(LIMITS_DEFAULTS);
  });

  it('200 characters pass, 201 is length; 3 lines per 5 s, the 4th is rate', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'a', who('a'), 'A');
    expect(cw.chat.accept(R, 'a', 'a'.repeat(200))).toHaveProperty('deliver');
    expect(cw.chat.accept(R, 'a', 'a'.repeat(201))).toEqual({ refuse: { reason: 'length' } });
    expect(cw.chat.accept(R, 'a', 'two')).toHaveProperty('deliver');
    expect(cw.chat.accept(R, 'a', 'three')).toHaveProperty('deliver');
    expect(cw.chat.accept(R, 'a', 'four')).toEqual({ refuse: { reason: 'rate' } });
    clock.t += 5 * SEC;
    expect(cw.chat.accept(R, 'a', 'five')).toHaveProperty('deliver');
  });

  it('three slurs in an hour restrict chat for 30 minutes, then it lifts', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat(R, 'a', who('a'), 'A');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
    clock.t += 30 * MIN + SEC;
    expect(cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');
  });

  it('a first report has 9 left of the default ten a day', async () => {
    const { cw } = await setup();
    seatAll(cw, ['a', 'b']);
    cw.chat.accept(R, 'a', 'hello');
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    expect(res).toMatchObject({ ok: true, remaining: 9 });
  });
});

describe('createChatwarden: every limit is honoured when overridden', () => {
  it('chatMaxLength 50: 50 passes, 51 is length', async () => {
    const { cw } = await setup({ limits: { chatMaxLength: 50 } });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    expect(cw.chat.accept(R, 'a', 'a'.repeat(50))).toHaveProperty('deliver');
    expect(cw.chat.accept(R, 'a', 'a'.repeat(51))).toEqual({ refuse: { reason: 'length' } });
    expect(cw.chat.accept(R, 'a', 'a'.repeat(150))).toEqual({ refuse: { reason: 'length' } });
  });

  it('chatMaxLength 500 lets a long line through (the 200 default is a default)', async () => {
    const { cw } = await setup({ limits: { chatMaxLength: 500 } });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    expect(cw.chat.accept(R, 'a', 'a'.repeat(500))).toHaveProperty('deliver');
  });

  it('chatRate count 1: the second line in the window is rate; windowMs decides when it frees up', async () => {
    const { cw, clock } = await setup({ limits: { chatRate: { count: 1, windowMs: 2_000 } } });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    expect(cw.chat.accept(R, 'a', 'one')).toHaveProperty('deliver');
    expect(cw.chat.accept(R, 'a', 'two')).toEqual({ refuse: { reason: 'rate' } });
    clock.t += 1_999;
    expect(cw.chat.accept(R, 'a', 'two')).toEqual({ refuse: { reason: 'rate' } });
    clock.t += 1;
    expect(cw.chat.accept(R, 'a', 'two')).toHaveProperty('deliver');
  });

  it('chatRate count 5: five lines pass, the sixth is rate', async () => {
    const { cw } = await setup({ limits: { chatRate: { count: 5 } } });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    for (let i = 0; i < 5; i++) expect(cw.chat.accept(R, 'a', `line ${i}`)).toHaveProperty('deliver');
    expect(cw.chat.accept(R, 'a', 'six')).toEqual({ refuse: { reason: 'rate' } });
  });

  it('strikes.count 2: two slurs restrict, where the default needs three', async () => {
    const two = await setup({ limits: { strikes: { count: 2 } } });
    two.cw.rooms.seat(R, 'a', who('a'), 'A');
    two.cw.chat.accept(R, 'a', 'zorbak');
    expect(two.cw.chat.accept(R, 'a', 'zorbak')).toMatchObject({ refuse: { reason: 'blocked' } });
    expect(two.cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });

    const control = await setup();
    control.cw.rooms.seat(R, 'a', who('a'), 'A');
    control.cw.chat.accept(R, 'a', 'zorbak');
    control.cw.chat.accept(R, 'a', 'zorbak');
    expect(control.cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');
  });

  it('strikes.count 4: three slurs do not restrict, the fourth does', async () => {
    const { cw, clock } = await setup({ limits: { strikes: { count: 4 }, chatRate: { count: 10 } } });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    for (let i = 0; i < 3; i++) cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');
    cw.chat.accept(R, 'a', 'zorbak');
    clock.t += 1;
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
  });

  it('strikes.windowMs 1 s: slurs 2 s apart never add up', async () => {
    const { cw, clock } = await setup({ limits: { strikes: { count: 2, windowMs: 1_000 } } });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    cw.chat.accept(R, 'a', 'zorbak');
    clock.t += 2 * SEC;
    cw.chat.accept(R, 'a', 'zorbak');
    expect(cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');
  });

  it('strikes.firstMs 1 min: the first restriction lasts one minute', async () => {
    const { cw, clock } = await setup({ limits: { strikes: { count: 2, firstMs: MIN } } });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    cw.chat.accept(R, 'a', 'zorbak');
    cw.chat.accept(R, 'a', 'zorbak');
    clock.t += MIN - SEC;
    expect(cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
    clock.t += 2 * SEC;
    expect(cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');
  });

  it('strikes.repeatMs and repeatLookbackMs: a repeat inside the look-back lasts repeatMs, outside it is the first duration', async () => {
    const limits = { strikes: { count: 2, firstMs: MIN, repeatMs: 10 * MIN, repeatLookbackMs: DAY } };
    const slurTwice = (cw: Chatwarden): void => {
      cw.chat.accept(R, 'a', 'zorbak');
      cw.chat.accept(R, 'a', 'zorbak');
    };

    const inside = await setup({ limits });
    inside.cw.rooms.seat(R, 'a', who('a'), 'A');
    slurTwice(inside.cw);
    inside.clock.t += 5 * MIN; // first restriction (1 min) is over
    expect(inside.cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');
    slurTwice(inside.cw);
    inside.clock.t += 2 * MIN; // past the first duration, inside the repeat one
    expect(inside.cw.chat.accept(R, 'a', 'hi')).toMatchObject({ refuse: { reason: 'restricted' } });
    inside.clock.t += 9 * MIN;
    expect(inside.cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');

    const outside = await setup({ limits });
    outside.cw.rooms.seat(R, 'a', who('a'), 'A');
    slurTwice(outside.cw);
    outside.clock.t += 2 * DAY; // the first restriction is outside the 1 day look-back
    slurTwice(outside.cw);
    outside.clock.t += 2 * MIN;
    expect(outside.cw.chat.accept(R, 'a', 'hi')).toHaveProperty('deliver');
  });

  it('onAutoRestrict hears second=true for the repeat, whatever the configured durations are', async () => {
    const heard: boolean[] = [];
    const { cw, clock } = await setup({
      limits: { strikes: { count: 1, firstMs: 7 * MIN, repeatMs: 3 * MIN } },
      onAutoRestrict: (_s, second) => void heard.push(second),
    });
    cw.rooms.seat(R, 'a', who('a'), 'A');
    cw.chat.accept(R, 'a', 'zorbak');
    clock.t += 8 * MIN;
    cw.chat.accept(R, 'a', 'zorbak');
    expect(heard).toEqual([false, true]);
  });

  it('reports.perDay 3: the fourth report in a day is rate with remaining 0', async () => {
    const { cw } = await setup({ limits: { reports: { perDay: 3 } } });
    seatAll(cw);
    const file = (target: string) =>
      cw.reports.submit({ roomId: R, reporterSeat: 'a', targetSeat: target, category: 'harassment' });
    expect(await file('b')).toMatchObject({ ok: true, remaining: 2 });
    expect(await file('c')).toMatchObject({ ok: true, remaining: 1 });
    expect(await file('d')).toMatchObject({ ok: true, remaining: 0 });
    expect(await file('e')).toEqual({ ok: false, refused: 'rate', remaining: 0 });
  });

  it('reports.perDay 12: the default ten is no longer the cap', async () => {
    const { cw } = await setup({ limits: { reports: { perDay: 12 } } });
    for (let i = 0; i < 12; i++) cw.rooms.seat(R, `p${i}`, who(`p${i}`), `P${i}`);
    cw.rooms.seat(R, 'rep', who('rep'), 'Rep');
    for (let i = 0; i < 11; i++) {
      const res = await cw.reports.submit({ roomId: R, reporterSeat: 'rep', targetSeat: `p${i}`, category: 'spam' });
      expect(res).toMatchObject({ ok: true });
    }
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'rep', targetSeat: 'p11', category: 'spam' })).toMatchObject({
      ok: true,
      remaining: 0,
    });
  });

  /** Bob reports `target` and a moderator dismisses it as bad faith. */
  async function badFaith(cw: Chatwarden, target: string): Promise<void> {
    const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: target, category: 'harassment' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const done = await cw.decide({
      reportId: res.reportId,
      verdict: 'bad_faith',
      actor: 'mod@example.test',
      reason: 'private',
      evidence: 'private evidence',
      actions: [],
    });
    if (!done.ok) throw new Error('decide failed');
  }

  it('reports.suspendAfter 2: two bad-faith dismissals suspend the reporter (three by default)', async () => {
    const two = await setup({ limits: { reports: { suspendAfter: 2 } } });
    seatAll(two.cw);
    await badFaith(two.cw, 'a');
    await badFaith(two.cw, 'c');
    expect(await two.cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'd', category: 'spam' })).toEqual({
      ok: false,
      refused: 'suspended',
    });

    const control = await setup();
    seatAll(control.cw);
    await badFaith(control.cw, 'a');
    await badFaith(control.cw, 'c');
    expect(await control.cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'd', category: 'spam' })).toMatchObject({
      ok: true,
    });
  });

  it('reports.suspendWindowMs: a bad-faith dismissal stops counting once it is older than the window', async () => {
    const { cw, clock } = await setup({ limits: { reports: { suspendAfter: 1, suspendWindowMs: 2 * H } } });
    seatAll(cw);
    await badFaith(cw, 'a');
    clock.t += H;
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'd', category: 'spam' })).toMatchObject({
      refused: 'suspended',
    });
    clock.t += 2 * H;
    expect(await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'd', category: 'spam' })).toMatchObject({
      ok: true,
    });
  });

  it('reporterFeedback false: an upheld decision tells the reporter nothing; true (the default) does', async () => {
    const decideUpheld = async (cw: Chatwarden): Promise<void> => {
      seatAll(cw, ['a', 'b']);
      cw.chat.accept(R, 'a', 'hello there');
      const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
      if (!res.ok) throw new Error('report refused');
      const a = cw.rooms.subjectAt(R, 'a');
      if (a === null) throw new Error('no subject');
      const done = await cw.decide({
        reportId: res.reportId,
        verdict: 'upheld',
        actor: 'mod@example.test',
        reason: 'private',
        actions: [{ subject: a, kind: 'warning', durationMs: null, rule: 2 }],
      });
      if (!done.ok) throw new Error('decide failed');
    };
    const off = await setup({ limits: { reporterFeedback: false } });
    await decideUpheld(off.cw);
    expect(off.cw.notices.pending(who('b'))).toEqual([]);
    expect(off.cw.notices.record(who('b'))).toEqual([]);
    expect(off.cw.notices.pending(who('a'))).toHaveLength(1); // the person acted on is still told

    const on = await setup();
    await decideUpheld(on.cw);
    expect(on.cw.notices.pending(who('b')).map((n) => n.kind)).toEqual(['report_outcome']);
  });

  it('the limits are readable as resolved', async () => {
    const { cw } = await setup({ limits: { chatMaxLength: 50, strikes: { count: 2 } } });
    expect(cw.limits).toEqual({ ...LIMITS_DEFAULTS, chatMaxLength: 50, strikes: { ...LIMITS_DEFAULTS.strikes, count: 2 } });
  });

  it('a bad limit throws ProfileError at creation, naming the field', async () => {
    const err = await rejection(setup({ limits: { strikes: { count: 0 } } }));
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).path).toBe('limits.strikes.count');
    expect(await rejection(setup({ limits: { chatMaxLength: 1.5 } }))).toBeInstanceOf(ProfileError);
    expect(await rejection(setup({ limits: { bogus: 1 } as never }))).toBeInstanceOf(ProfileError);
  });
});

describe('createChatwarden: retention floors', () => {
  const D = DAY;

  it('sanctionAfterEndMs under 90 days throws, naming the field and why', async () => {
    const err = await rejection(setup({ retention: { sanctionAfterEndMs: 89 * D } }));
    expect(err).toBeInstanceOf(ProfileError);
    expect(err.message).toMatch(/^retention\.sanctionAfterEndMs must be at least 90 days: /);
    expect((err as ProfileError).path).toBe('retention.sanctionAfterEndMs');
  });

  it('noticesMs under 90 days throws, naming the field and why', async () => {
    const err = await rejection(setup({ retention: { noticesMs: 30 * D } }));
    expect(err).toBeInstanceOf(ProfileError);
    expect(err.message).toBe("retention.noticesMs must be at least 90 days: players' records reach back that far");
  });

  it('badFaithMs under the suspension window throws; the window default is 30 days', async () => {
    const err = await rejection(setup({ retention: { badFaithMs: 29 * D } }));
    expect(err).toBeInstanceOf(ProfileError);
    expect(err.message).toMatch(/^retention\.badFaithMs must be at least limits\.reports\.suspendWindowMs/);
    expect(err.message).toMatch(/30 days/);
    const custom = await rejection(
      setup({ limits: { reports: { suspendWindowMs: 60 * D } }, retention: { badFaithMs: 45 * D } }),
    );
    expect(custom.message).toMatch(/limits\.reports\.suspendWindowMs/);
    expect(custom.message).toMatch(/60 days/);
  });

  it('exactly on the floor is fine; so is longer', async () => {
    await expect(setup({ retention: { sanctionAfterEndMs: 90 * D, noticesMs: 90 * D, badFaithMs: 30 * D } })).resolves.toBeDefined();
    await expect(setup({ retention: { sanctionAfterEndMs: 400 * D, noticesMs: 400 * D, badFaithMs: 400 * D } })).resolves.toBeDefined();
    await expect(
      setup({ limits: { reports: { suspendWindowMs: 60 * D } }, retention: { badFaithMs: 60 * D } }),
    ).resolves.toBeDefined();
  });

  it('other windows have no floor here (reports, strikes)', async () => {
    await expect(setup({ retention: { reportsMs: D, strikesMs: D } })).resolves.toBeDefined();
  });

  it.each([Number.NaN, 0, -1])('a non-sensical %s is refused as under the floor', async (bad) => {
    await expect(setup({ retention: { noticesMs: bad } })).rejects.toBeInstanceOf(ProfileError);
    await expect(setup({ retention: { sanctionAfterEndMs: bad } })).rejects.toBeInstanceOf(ProfileError);
    await expect(setup({ retention: { badFaithMs: bad } })).rejects.toBeInstanceOf(ProfileError);
  });

  it('a longer suspension window lifts the default bad-faith retention with it', async () => {
    // Bob's bad-faith report was actioned 45 days ago and is far past `reportsMs` (1 day here). Whether the purge
    // still keeps it depends on badFaithMs, which defaults to the suspension window (at least 30 days).
    const run = async (limits: ChatwardenOptions['limits']) => {
      const { cw, clock, store } = await setup({ limits });
      seatAll(cw);
      const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
      if (!res.ok) throw new Error('report refused');
      await cw.decide({
        reportId: res.reportId,
        verdict: 'bad_faith',
        actor: 'mod@example.test',
        reason: 'private',
        evidence: 'private evidence',
        actions: [],
      });
      clock.t += 45 * D;
      await cw.purge({ reportsMs: D });
      return store.rawReports().length;
    };
    expect(await run({ reports: { suspendWindowMs: 60 * D } })).toBe(1);
    expect(await run(undefined)).toBe(0);
  });

  it('retention: false skips the policy floors (nothing is purged on a timer)', async () => {
    await expect(setup({ retention: false })).resolves.toBeDefined();
  });

  it('the floors also guard a purge() call made later', async () => {
    const { cw } = await setup();
    const err = await rejection(cw.purge({ noticesMs: D }));
    expect(err).toBeInstanceOf(ProfileError);
    expect(err.message).toMatch(/^retention\.noticesMs must be at least 90 days/);
    await expect(cw.purge({ reportsMs: 100 * D })).resolves.toBeDefined();
    await expect(cw.purge()).resolves.toBeDefined();
  });

  it('the retention defaults themselves satisfy every floor', () => {
    expect(RETENTION_DEFAULTS.sanctionAfterEndMs).toBeGreaterThanOrEqual(90 * D);
    expect(RETENTION_DEFAULTS.noticesMs).toBeGreaterThanOrEqual(90 * D);
    expect(RETENTION_DEFAULTS.badFaithMs).toBeGreaterThanOrEqual(LIMITS_DEFAULTS.reports.suspendWindowMs);
  });
});
