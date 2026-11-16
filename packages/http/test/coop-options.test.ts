import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../src/coop/options.js';
import { API_KEY, COOP_URL, ITEM_TYPES, sharedPair } from './coop-world.js';

// K5 C1: the options are checked once, at construction; every error is a RangeError that names the option and never holds a value.

const base = () => ({
  baseUrl: COOP_URL,
  apiKey: API_KEY,
  webhookPublicKey: sharedPair().publicPem,
  itemTypes: { ...ITEM_TYPES },
  evidence: 'excerpt' as const,
  actions: { 'action-warn': { verdict: 'upheld', kind: 'warning' } } as Record<string, unknown>,
  rules: { 'policy-harass': 2 } as Record<string, unknown>,
});

const bad = (over: Record<string, unknown>, match: RegExp): void => {
  let err: unknown;
  try {
    resolveOptions({ ...base(), ...over });
  } catch (e) {
    err = e;
  }
  expect(err, JSON.stringify(Object.keys(over))).toBeInstanceOf(RangeError);
  expect((err as Error).message).toMatch(match);
};

describe('options', () => {
  it('a full set of options resolves, with the defaults filled in', () => {
    const o = resolveOptions(base());
    expect(o.evidence).toBe('excerpt');
    expect(o.includeNote).toBe(false);
    expect(o.handles).toBe('hidden');
    expect(o.role).toBe('moderator');
    expect(o.catchUpMs).toBe(24 * 3_600_000);
    expect(o.signal).toBeNull();
    expect(o.callbackAuth).toBeNull();
  });

  it('evidence is required and must be none or excerpt (RangeError naming the option)', () => {
    const without: Record<string, unknown> = { ...base() };
    delete without['evidence'];
    expect(() => resolveOptions(without)).toThrow(RangeError);
    expect(() => resolveOptions(without)).toThrow(/evidence/);
    for (const v of ['all', '', 'EXCERPT', 1, null, true, {}]) bad({ evidence: v }, /evidence/);
    expect(resolveOptions({ ...base(), evidence: 'none' }).evidence).toBe('none');
  });

  it('includeNote and handles are checked', () => {
    bad({ includeNote: 'yes' }, /includeNote/);
    bad({ handles: 'maybe' }, /handles/);
    const o = resolveOptions({ ...base(), includeNote: true, handles: 'shown' });
    expect([o.includeNote, o.handles]).toEqual([true, 'shown']);
  });

  it('options must be an object', () => {
    for (const v of [undefined, null, 'x', 4, []]) expect(() => resolveOptions(v)).toThrow(RangeError);
  });

  it('baseUrl must be https, or http on localhost and 127.0.0.1, with no credentials, query or fragment', () => {
    for (const url of ['http://coop.example.test', 'http://10.0.0.5:3000', 'ftp://coop.example.test', 'coop.example.test', '', 'https://user:pass@coop.example.test', 'https://user@coop.example.test', 'https://coop.example.test/?k=1', 'https://coop.example.test/#x', 5, null]) {
      bad({ baseUrl: url }, /baseUrl/);
    }
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:8080', 'https://coop.example.test', 'https://coop.example.test/']) {
      expect(() => resolveOptions({ ...base(), baseUrl: url }), url).not.toThrow();
    }
  });

  it('baseUrl loses its trailing slash and keeps a path prefix', () => {
    expect(resolveOptions({ ...base(), baseUrl: 'https://coop.example.test/' }).baseUrl).toBe('https://coop.example.test');
    expect(resolveOptions({ ...base(), baseUrl: 'https://coop.example.test/tarvo/' }).baseUrl).toBe('https://coop.example.test/tarvo');
  });

  it('apiKey and the PEM are checked once: type, length, shape, kind of key', () => {
    for (const k of ['', 'short', 'has a space in it 1234', 'new\nline-in-key-1234', 'tab\tin-key-123456', 'x'.repeat(513), 7, undefined, null]) bad({ apiKey: k }, /apiKey/);
    for (const pem of ['', 'not a pem', 42, undefined, '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----']) bad({ webhookPublicKey: pem }, /webhookPublicKey/);
    // A private key is refused: only the public half belongs in a config.
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    bad({ webhookPublicKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }, /webhookPublicKey/);
    // Not an RSA key.
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    bad({ webhookPublicKey: ec.publicKey.export({ type: 'spki', format: 'pem' }) as string }, /webhookPublicKey/);
  });

  it('itemTypes needs the three ids', () => {
    bad({ itemTypes: undefined }, /itemTypes/);
    bad({ itemTypes: { user: 'a', line: 'b' } }, /itemTypes/);
    bad({ itemTypes: { ...ITEM_TYPES, line: '' } }, /itemTypes/);
    bad({ itemTypes: { ...ITEM_TYPES, user: 'has space' } }, /itemTypes/);
    bad({ itemTypes: { ...ITEM_TYPES, report: 5 } }, /itemTypes/);
  });

  it('actions values must be one of the CoopDecision shapes', () => {
    const ok: unknown[] = [
      { verdict: 'upheld', kind: 'warning' },
      { verdict: 'upheld', kind: 'chat', durationMs: 86_400_000 },
      { verdict: 'upheld', kind: 'area', durationMs: 3_600_000 },
      { verdict: 'upheld', kind: 'ban', durationMs: 7 * 86_400_000 },
      { verdict: 'upheld', kind: 'ban' },
      { verdict: 'noted' },
      { verdict: 'no_action' },
      { verdict: 'bad_faith' },
    ];
    for (const d of ok) expect(() => resolveOptions({ ...base(), actions: { a1: d } }), JSON.stringify(d)).not.toThrow();
    const notOk: unknown[] = [
      null,
      'ban',
      [],
      {},
      { verdict: 'dance' },
      { verdict: 'upheld' },
      { verdict: 'upheld', kind: 'note' },
      { verdict: 'upheld', kind: 'kick' },
      { verdict: 'upheld', kind: 'warning', durationMs: 1000 },
      { verdict: 'upheld', kind: 'chat', durationMs: 0 },
      { verdict: 'upheld', kind: 'chat', durationMs: -5 },
      { verdict: 'upheld', kind: 'chat', durationMs: 1.5 },
      { verdict: 'upheld', kind: 'chat', durationMs: '5' },
      { verdict: 'upheld', kind: 'chat', durationMs: Number.POSITIVE_INFINITY },
      { verdict: 'noted', kind: 'warning' },
      { verdict: 'no_action', durationMs: 5 },
      { verdict: 'bad_faith', extra: 1 },
    ];
    for (const d of notOk) bad({ actions: { a1: d } }, /actions/);
    bad({ actions: undefined }, /actions/);
    bad({ actions: [] }, /actions/);
    bad({ actions: { '': { verdict: 'no_action' } } }, /actions/);
  });

  it('rules values must be positive whole numbers', () => {
    for (const v of [0, -1, 1.5, '2', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, 2 ** 53]) bad({ rules: { p1: v } }, /rules/);
    expect(() => resolveOptions({ ...base(), rules: {} })).not.toThrow();
    expect(() => resolveOptions({ ...base(), rules: undefined })).not.toThrow();
    bad({ rules: [] }, /rules/);
  });

  it('policies: byReason and byRule map to policy id strings; byRule keys are rule numbers', () => {
    const o = resolveOptions({ ...base(), policies: { byReason: { harassment: 'p-h' }, byRule: { '2': 'p-2' } } });
    expect(o.policyByReason.get('harassment')).toBe('p-h');
    expect(o.policyByRule.get(2)).toBe('p-2');
    bad({ policies: { byReason: { harassment: 5 } } }, /policies/);
    bad({ policies: { byRule: { two: 'p' } } }, /policies/);
    bad({ policies: { byRule: { '0': 'p' } } }, /policies/);
    bad({ policies: { byRule: { '2': '' } } }, /policies/);
    bad({ policies: { other: {} } }, /policies/);
    bad({ policies: 'x' }, /policies/);
  });

  it('role, permissions, catchUpMs, callbackAuth', () => {
    bad({ role: 'admin' }, /role/);
    bad({ permissions: { 'reports.decide': 'nobody' } }, /permissions/);
    for (const v of [0, -1, 1.5, 31 * 86_400_000, '5']) bad({ catchUpMs: v }, /catchUpMs/);
    expect(resolveOptions({ ...base(), catchUpMs: 60_000, role: 'senior' }).role).toBe('senior');
    for (const v of [{}, { header: 'x-key' }, { header: 'bad header', value: 'abcdefgh' }, { header: 'x-key', value: '' }, { header: 'coop-signature', value: 'abcdefgh' }, 'x']) bad({ callbackAuth: v }, /callbackAuth/);
    const ok = resolveOptions({ ...base(), callbackAuth: { header: 'X-Callback-Key', value: 'snerp-callback-value' } });
    expect(ok.callbackAuth).toEqual({ header: 'x-callback-key', value: 'snerp-callback-value' });
  });

  it('signal needs a 32 character secret and a read function', () => {
    const read = () => 5;
    bad({ signal: { secret: 'short', read } }, /signal/);
    bad({ signal: { secret: 's'.repeat(32), read: 'no' } }, /signal/);
    bad({ signal: { secret: 's'.repeat(32), read, rateLimit: { max: 0, windowMs: 1 } } }, /signal/);
    bad({ signal: 'x' }, /signal/);
    expect(resolveOptions({ ...base(), signal: { secret: 's'.repeat(32), read } }).signal?.rateLimit).toEqual({ max: 60, windowMs: 60_000 });
  });

  it('fetch, clock, logger, random, aiSeverity and schedule are checked when given', () => {
    bad({ fetch: 'x' }, /fetch/);
    bad({ clock: {} }, /clock/);
    bad({ logger: {} }, /logger/);
    bad({ random: 1 }, /random/);
    bad({ aiSeverity: 1 }, /aiSeverity/);
    bad({ schedule: 1 }, /schedule/);
  });

  it('errors never contain a value', () => {
    const secrets = { apiKey: 'quissel-secret-key-THIS-SHOULD-NOT-APPEAR', baseUrl: 'http://fenrisk-host.example.test/path?token=glarn-secret' };
    for (const [name, value] of Object.entries(secrets)) {
      try {
        resolveOptions({ ...base(), [name]: value });
      } catch (e) {
        expect((e as Error).message).not.toMatch(/quissel|fenrisk|glarn|THIS-SHOULD/);
      }
    }
    try {
      resolveOptions({ ...base(), actions: { 'zorbak-action-id': { verdict: 'dance', kind: 'vlemmo-kind' } }, rules: { 'tarvo-policy': 'snerp-bad' } });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/zorbak|vlemmo|tarvo|snerp/);
    }
    try {
      resolveOptions({ ...base(), webhookPublicKey: 'drakkuun-not-a-pem' });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/drakkuun/);
    }
  });

  it('the object is copied: a later change to the input or to the result changes nothing', () => {
    const input = base();
    const o = resolveOptions(input);
    input.actions['action-warn'] = { verdict: 'bad_faith' };
    input.rules['policy-harass'] = 9;
    (input.itemTypes as Record<string, string>)['user'] = 'changed';
    expect(o.actions.get('action-warn')).toEqual({ verdict: 'upheld', kind: 'warning' });
    expect(o.rules.get('policy-harass')).toBe(2);
    expect(o.itemTypes.user).toBe(ITEM_TYPES.user);
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o.itemTypes)).toBe(true);
  });

  it('a __proto__ key in a map is a plain id, not a prototype change', () => {
    const actions = JSON.parse('{"__proto__": {"verdict": "no_action"}, "a1": {"verdict": "no_action"}}') as Record<string, unknown>;
    const o = resolveOptions({ ...base(), actions });
    expect(o.actions.get('__proto__')).toEqual({ verdict: 'no_action' });
    expect(({} as Record<string, unknown>)['verdict']).toBeUndefined();
  });
});
