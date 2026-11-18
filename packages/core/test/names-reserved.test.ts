import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryNames } from '@chatwarden/store-memory';
import { NAME_ENTRY_MAX, NAME_ENTRY_MIN, MAX_RESERVED_ENTRIES, resolveNames } from '../src/names.js';
import { ProfileError } from '../src/profile.js';
import type { BlockedNameRow, Matcher, ProfanityFilter, RawWho } from '../src/types.js';
import { world } from './reportingWorld.js';

// M6: reserved names and `kind` on `cw.names.check`. The settings (`names.reserved`, `names.reservedAllow`, `names.reservedRule`), the third reason `name_reserved` (after the slur and the profanity reasons), `skipReserved`,
// and what is and is not kept. The matcher here is a plain stand-in with its own `matchReserved`; synthetic words only (zorbak is a slur here, snerp is swearing).

const DEFAULTS = { profanity: false, keepBlocked: false, renames: false, maskInHub: true, reserved: [], reservedAllow: [], reservedRule: 2 };

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');

/** A stand-in for the matcher's reserved check: a name matches when one of its words, or the whole name, is an entry; an allowed name passes. */
function reservedStandIn(name: string, entries: readonly string[], allow: readonly string[]): boolean {
  if (allow.some((a) => norm(a) === norm(name))) return false;
  const keys = entries.map(norm);
  return keys.includes(norm(name)) || wordsOf(name).some((w) => keys.includes(w));
}

interface Spy extends Matcher {
  reservedCalls: Array<{ entries: readonly string[]; allow: readonly string[] }>;
}
function matcher(withReserved = true): Spy {
  const spy = {
    reservedCalls: [],
    match: (t: string) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null),
    matchName: (n: string) => (/zorbak/i.test(n) ? { termId: 'syn:zorbak' } : null),
  } as unknown as Spy;
  if (withReserved) {
    spy.matchReserved = (name, entries, allow) => {
      spy.reservedCalls.push({ entries, allow });
      return reservedStandIn(name, entries, allow);
    };
  }
  return spy;
}
const swearing: ProfanityFilter = { apply: (t) => ({ hit: /snerp/i.test(t), text: t }) };

async function kit(names: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  const store = withMemoryNames(new MemoryStore());
  const inserted: BlockedNameRow[] = [];
  const insert = store.insertBlockedName.bind(store);
  store.insertBlockedName = (row) => {
    inserted.push(structuredClone(row));
    insert(row);
  };
  const m = matcher(over['noReserved'] !== true);
  const w = await world({ matcher: m, profanity: swearing, overrides: { names }, ...over } as never, store);
  return { ...w, m, inserted };
}

const OWNER = { actor: 'owner_ann', reason: 'tuning names' };
const failure = (fn: () => unknown): ProfileError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError');
};

describe('settings', () => {
  it('defaults are [] [] and rule 2, in the resolved names and in a profile with no names at all', async () => {
    expect(resolveNames(undefined)).toEqual(DEFAULTS);
    expect(resolveNames({})).toEqual(DEFAULTS);
    const k = await kit();
    expect(k.cw.profile.names).toEqual(DEFAULTS);
  });

  it('entries of 2 and 32 characters are accepted, 1 and 33 are refused with the path', () => {
    expect(NAME_ENTRY_MIN).toBe(2);
    expect(NAME_ENTRY_MAX).toBe(32);
    expect(resolveNames({ reserved: ['ab', 'x'.repeat(32)] }).reserved).toEqual(['ab', 'x'.repeat(32)]);
    expect(failure(() => resolveNames({ reserved: ['a'] })).path).toBe('names.reserved[0]');
    expect(failure(() => resolveNames({ reserved: ['ok', 'x'.repeat(33)] })).path).toBe('names.reserved[1]');
    expect(failure(() => resolveNames({ reserved: ['  a  '] })).path).toBe('names.reserved[0]');
    expect(failure(() => resolveNames({ reserved: [''] })).path).toBe('names.reserved[0]');
  });

  it('200 entries are accepted and 201 are refused; the same for the allowed names', () => {
    expect(MAX_RESERVED_ENTRIES).toBe(200);
    const many = (n: number, prefix = 'ent'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    expect(resolveNames({ reserved: many(200) }).reserved).toHaveLength(200);
    expect(failure(() => resolveNames({ reserved: many(201) })).path).toBe('names.reserved');
    expect(resolveNames({ reservedAllow: many(200, 'al') }).reservedAllow).toHaveLength(200);
    expect(failure(() => resolveNames({ reservedAllow: many(201, 'al') })).path).toBe('names.reservedAllow');
  });

  it('allowed names are 1 to 64 characters', () => {
    expect(resolveNames({ reservedAllow: ['a', 'x'.repeat(64)] }).reservedAllow).toEqual(['a', 'x'.repeat(64)]);
    expect(failure(() => resolveNames({ reservedAllow: [''] })).path).toBe('names.reservedAllow[0]');
    expect(failure(() => resolveNames({ reservedAllow: ['x'.repeat(65)] })).path).toBe('names.reservedAllow[0]');
  });

  it('a non-string entry, a non-list and a control character are refused with the path, never echoing the value', () => {
    for (const bad of [5, null, {}, ['x'], true]) {
      expect(failure(() => resolveNames({ reserved: [bad] } as never)).path).toBe('names.reserved[0]');
    }
    for (const bad of ['admin', 5, null, {}, true]) expect(failure(() => resolveNames({ reserved: bad } as never)).path).toBe('names.reserved');
    for (const bad of ['admin', 5, null, {}]) expect(failure(() => resolveNames({ reservedAllow: bad } as never)).path).toBe('names.reservedAllow');
    expect(failure(() => resolveNames({ reserved: ['ad\u0000min'] })).path).toBe('names.reserved[0]');
    const secret = failure(() => resolveNames({ reserved: ['PRIVATE-STAFF-NAME\u0007'] }));
    expect(secret.message).not.toContain('PRIVATE');
    expect(JSON.stringify(secret)).not.toContain('PRIVATE');
  });

  it('reservedRule is a whole number of 1 or more', () => {
    expect(resolveNames({ reservedRule: 5 }).reservedRule).toBe(5);
    for (const bad of [0, -1, 1.5, '2', null, NaN]) expect(failure(() => resolveNames({ reservedRule: bad } as never)).path, String(bad)).toBe('names.reservedRule');
  });

  it('entries are normalised once: trimmed, and an exact repeat is dropped, in order; the resolved lists are frozen copies', () => {
    const input = { reserved: [' Admin ', 'admin', 'Game Master', 'Admin'], reservedAllow: ['Real Mod ', 'Real Mod'] };
    const r = resolveNames(input);
    expect(r.reserved).toEqual(['Admin', 'admin', 'Game Master']);
    expect(r.reservedAllow).toEqual(['Real Mod']);
    expect(Object.isFrozen(r.reserved)).toBe(true);
    expect(Object.isFrozen(r.reservedAllow)).toBe(true);
    input.reserved.push('later');
    expect(r.reserved).not.toContain('later');
  });

  it('the settings of a kit read back the same array object until they change (the matcher compiles each list once)', async () => {
    const k = await kit({ reserved: ['admin'] });
    expect(k.cw.profile.names.reserved).toBe(k.cw.profile.names.reserved);
    k.cw.names.check('Anna');
    k.cw.names.check('Bo');
    // (the one probe for entries that protect nothing uses the same entries array and no allow list)
    const calls = k.m.reservedCalls.filter((c) => c.allow === k.cw.profile.names.reservedAllow);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.entries).toBe(calls[1]?.entries);
    expect(calls[0]?.entries).toBe(k.cw.profile.names.reserved);
    expect(k.m.reservedCalls.filter((c) => c.allow !== k.cw.profile.names.reservedAllow).every((c) => c.entries === calls[0]?.entries)).toBe(true);
  });

  it('an inactive reservedRule is refused at creation with the path, and a layer that names one is refused at save and at preview', async () => {
    await expect(kit({ reserved: ['admin'], reservedRule: 99 })).rejects.toMatchObject({ path: 'profile.names.reservedRule' });
    const k = await kit({ reserved: ['admin'] });
    const saved = k.cw.policy.save({ names: { reservedRule: 99 } }, { version: 0, ...OWNER });
    expect(saved).toMatchObject({ ok: false, error: 'invalid', path: 'layer.names.reservedRule' });
    expect(k.cw.policy.preview({ names: { reservedRule: 99 } })).toMatchObject({ ok: false, error: 'invalid', path: 'layer.names.reservedRule' });
    expect(k.cw.policy.save({ names: { reservedRule: 4 } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(k.cw.profile.names.reservedRule).toBe(4);
  });

  it('a layer saves the lists and they apply at once; a layer entry over 32 characters is refused with its layer path', async () => {
    const k = await kit();
    expect(k.cw.names.check('Mod_Anna')).toEqual({ ok: true });
    expect(k.cw.policy.save({ names: { reserved: ['mod'] } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(k.cw.names.check('Mod_Anna')).toMatchObject({ ok: false, reason: 'name_reserved' });
    expect(k.cw.policy.save({ names: { reserved: ['x'.repeat(33)] } }, { version: 1, ...OWNER })).toMatchObject({ ok: false, error: 'invalid', path: 'layer.names.reserved[0]' });
  });
});

describe('check', () => {
  it('a reserved name answers name_reserved with the reservedRule and no text', async () => {
    const k = await kit({ reserved: ['admin'], reservedRule: 2 });
    const out = k.cw.names.check('Admin_Anna');
    expect(out).toEqual({ ok: false, reason: 'name_reserved', rule: 2 });
    expect(JSON.stringify(out)).not.toMatch(/admin/i);
  });

  it('cites its own rule, not the slur rule, and a custom reservedRule is the one cited', async () => {
    const k = await kit({ reserved: ['admin'], reservedRule: 7 });
    expect(k.cw.names.check('Admin')).toEqual({ ok: false, reason: 'name_reserved', rule: 7 });
    expect(k.cw.names.check('Zorbak')).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
  });

  it('the slur and profanity reasons keep their order: slur first, then swearing, then reserved', async () => {
    const k = await kit({ reserved: ['admin', 'zorbak', 'snerp'], profanity: true });
    expect(k.cw.names.check('Admin Zorbak')).toMatchObject({ reason: 'name_not_allowed' });
    expect(k.cw.names.check('Admin snerp')).toMatchObject({ reason: 'name_profane' });
    expect(k.cw.names.check('Admin Anna')).toMatchObject({ reason: 'name_reserved' });
    const off = await kit({ reserved: ['admin', 'snerp'] });
    expect(off.cw.names.check('Admin snerp')).toMatchObject({ reason: 'name_reserved' });
  });

  it('skipReserved passes a reserved name, and does not skip the slur or the swearing', async () => {
    const k = await kit({ reserved: ['admin'], profanity: true });
    expect(k.cw.names.check('Admin', { skipReserved: true })).toEqual({ ok: true });
    expect(k.cw.names.check('Admin zorbak', { skipReserved: true })).toMatchObject({ reason: 'name_not_allowed' });
    expect(k.cw.names.check('Admin snerp', { skipReserved: true })).toMatchObject({ reason: 'name_profane' });
    expect(k.m.reservedCalls).toHaveLength(0);
  });

  it('a clean name is ok, and so is every name when nothing is reserved (the matcher is not even asked)', async () => {
    const k = await kit({ reserved: ['admin'] });
    expect(k.cw.names.check('Anna')).toEqual({ ok: true });
    const none = await kit({});
    expect(none.cw.names.check('Admin')).toEqual({ ok: true });
    expect(none.m.reservedCalls).toHaveLength(0);
  });

  it('the allow list lets a real player through, whole names only', async () => {
    const k = await kit({ reserved: ['mod'], reservedAllow: ['Mod'] });
    expect(k.cw.names.check('Mod')).toEqual({ ok: true });
    expect(k.cw.names.check('Mod_Anna')).toMatchObject({ reason: 'name_reserved' });
  });

  it('kind entity runs the same checks: a clan named after a slur is name_not_allowed, a reserved one is name_reserved', async () => {
    const k = await kit({ reserved: ['admin'], profanity: true });
    expect(k.cw.names.check('Zorbak Clan', { kind: 'entity' })).toMatchObject({ ok: false, reason: 'name_not_allowed' });
    expect(k.cw.names.check('Admin Guild', { kind: 'entity' })).toMatchObject({ ok: false, reason: 'name_reserved' });
    expect(k.cw.names.check('snerp Team', { kind: 'entity' })).toMatchObject({ reason: 'name_profane' });
    expect(k.cw.names.check('Blue Wolves', { kind: 'entity' })).toEqual({ ok: true });
    expect(k.cw.names.check('Blue Wolves', { kind: 'player' })).toEqual({ ok: true });
  });

  it('an unknown kind is a TypeError and a non-string name still is', async () => {
    const k = await kit({ reserved: ['admin'] });
    expect(() => k.cw.names.check('Anna', { kind: 'clan' } as never)).toThrow(TypeError);
    expect(() => k.cw.names.check('Anna', { skipReserved: 'yes' } as never)).toThrow(TypeError);
    expect(() => k.cw.names.check(5 as never)).toThrow(TypeError);
  });

  it('a matcher with no matchReserved never reserves, and the kit says so once, naming nothing', async () => {
    const k = await kit({ reserved: ['admin'] }, { noReserved: true });
    expect(k.cw.names.check('Admin')).toEqual({ ok: true });
    expect(k.cw.names.check('Admin')).toEqual({ ok: true });
    const warned = k.logged.filter(([e]) => e === 'chatwarden.names_reserved_unsupported');
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned)).not.toMatch(/admin/i);
  });

  it('a matcher whose matchReserved throws lets the name through, logged by class only, and the slur check is untouched', async () => {
    const k = await kit({ reserved: ['admin'] });
    k.m.matchReserved = () => {
      throw new Error('secret admin text');
    };
    expect(k.cw.names.check('Admin')).toEqual({ ok: true });
    expect(k.cw.names.check('Zorbak')).toMatchObject({ reason: 'name_not_allowed' });
    const failed = k.logged.filter(([e]) => e === 'chatwarden.names_reserved_failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed)).not.toContain('secret');
  });

  it('flagged (the hub mask) is the slur matcher only: a reserved name is not flagged', async () => {
    const k = await kit({ reserved: ['admin'] });
    expect(k.cw.names.flagged('Admin')).toBe(false);
    expect(k.cw.names.flagged('Zorbak')).toBe(true);
  });
});

describe('what is kept', () => {
  const who: RawWho = { clientKey: 'key-reserved-1' };

  it('nothing is stored for a reserved name, whatever keepBlocked and who say', async () => {
    const k = await kit({ reserved: ['admin'], keepBlocked: true });
    expect(k.cw.names.check('Admin', { who })).toMatchObject({ reason: 'name_reserved' });
    expect(k.cw.names.check('Admin', { who, kind: 'entity' })).toMatchObject({ reason: 'name_reserved' });
    expect(k.inserted).toEqual([]);
  });

  it('nothing is stored unless keepBlocked and who are given; then a blocked entity name is kept the same way as a player name', async () => {
    const off = await kit({ reserved: ['admin'] });
    off.cw.names.check('Zorbak Clan', { kind: 'entity', who });
    expect(off.inserted).toEqual([]);
    const k = await kit({ keepBlocked: true });
    k.cw.names.check('Zorbak Clan', { kind: 'entity' });
    expect(k.inserted).toEqual([]);
    k.cw.names.check('Zorbak Clan', { kind: 'entity', who });
    k.cw.names.check('Zorbak', { who });
    expect(k.inserted.map((r) => r.reason)).toEqual(['name_not_allowed', 'name_not_allowed']);
    expect(k.inserted.map((r) => r.name)).toEqual(['Zorbak Clan', 'Zorbak']);
  });
});

describe('privacy', () => {
  it('a spy logger never sees a name, a label or an entry', async () => {
    const k = await kit({ reserved: ['STAFFNAME-ENTRY'], reservedAllow: ['ALLOWED-PERSON'], keepBlocked: true });
    k.cw.names.check('STAFFNAME-ENTRY_Anna', { who: { clientKey: 'k-priv' } });
    k.cw.names.check('ALLOWED-PERSON');
    k.cw.names.check('Zorbak PRIVATE-CLAN', { kind: 'entity', who: { clientKey: 'k-priv' } });
    k.m.matchReserved = () => {
      throw new Error('PRIVATE-CLAN STAFFNAME-ENTRY');
    };
    k.cw.names.check('STAFFNAME-ENTRY_Anna');
    const text = JSON.stringify(k.logged);
    for (const leak of ['STAFFNAME', 'ALLOWED-PERSON', 'PRIVATE-CLAN']) expect(text).not.toContain(leak);
  });

  it('the answer of a refused name carries only the reason and the rule', async () => {
    const k = await kit({ reserved: ['admin'] });
    expect(Object.keys(k.cw.names.check('Admin') as object).sort()).toEqual(['ok', 'reason', 'rule']);
  });
});

describe('an entry that protects nothing is said once (review m9)', () => {
  // The real matcher keys an entry by its Latin skeleton: an entry with none (a Han entry) matches no name. This stand-in does the same.
  const HAN = String.fromCodePoint(0x7ba1, 0x7406, 0x5458);
  const strict = (name: string, entries: readonly string[], allow: readonly string[]): boolean => {
    if (allow.some((a) => norm(a) === norm(name))) return false;
    const keys = entries.map(norm).filter((k) => k !== '');
    return keys.includes(norm(name)) || wordsOf(name).some((w) => keys.includes(w));
  };
  const inert = (k: { logged: Array<[string, Record<string, unknown> | undefined]> }) => k.logged.filter(([e]) => e === 'chatwarden.names_reserved_inert');

  async function strictKit(names: Record<string, unknown>) {
    const k = await kit(names);
    k.m.matchReserved = strict;
    return k;
  }

  it('one warning names the count and the first position, never an entry; later checks stay quiet', async () => {
    const k = await strictKit({ reserved: ['mod', HAN, 'staff', `${HAN}x`.replace('x', '!')] });
    k.cw.names.check('Anna');
    k.cw.names.check('Mod Anna');
    k.cw.names.check('Bert');
    expect(inert(k)).toHaveLength(1);
    expect(inert(k)[0]?.[1]).toEqual({ count: 2, first: 1 });
    expect(JSON.stringify(k.logged)).not.toContain(HAN);
    // and the working entries still work
    expect(k.cw.names.check('Mod_Anna')).toMatchObject({ ok: false, reason: 'name_reserved' });
  });

  it('a list of working entries, no list, and a list with only allow names are quiet', async () => {
    for (const names of [{ reserved: ['mod', 'staff'] }, {}, { reservedAllow: ['mod'] }]) {
      const k = await strictKit(names);
      k.cw.names.check('Anna');
      expect(inert(k), JSON.stringify(names)).toEqual([]);
    }
  });

  it('a matcher without matchReserved, and one that throws, add no inert warning (they have their own)', async () => {
    const none = await kit({ reserved: [HAN] }, { noReserved: true });
    none.cw.names.check('Anna');
    expect(inert(none)).toEqual([]);
    const boom = await kit({ reserved: [HAN] });
    boom.m.matchReserved = () => {
      throw new Error('boom');
    };
    expect(() => boom.cw.names.check('Anna')).not.toThrow();
    expect(inert(boom)).toEqual([]);
  });

  it('the check never changes a verdict: a name is refused or passed exactly as before', async () => {
    const k = await strictKit({ reserved: [HAN, 'mod'] });
    expect(k.cw.names.check(HAN)).toMatchObject({ ok: true });
    expect(k.cw.names.check('Mod')).toMatchObject({ ok: false, reason: 'name_reserved' });
  });
});
