import { describe, expect, it } from 'vitest';
import { eos } from '../src/eos/index.js';
import { resolveOptions } from '../src/eos/options.js';
import { CLIENT_ID, CLIENT_SECRET, DEPLOYMENT } from './eos-world.js';

// K5 E1: the options are checked once, at construction. Every error is a RangeError that names the option and never holds a value.

const sanctions = () => ({ productUserIdsOf: () => [] as string[], actions: { chat: 'chatwarden-chat', area: 'chatwarden-area', ban: 'chatwarden-ban' } });
const reports = () => ({ seatOf: () => null, players: () => [] as string[] });
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ deploymentId: DEPLOYMENT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, sanctions: sanctions(), reports: reports(), ...over });
const bad = (over: Record<string, unknown>) => () => resolveOptions(base(over));
const fakeKit = { links: { supported: true }, on: () => () => undefined, people: {}, sanctions: {}, reports: {} } as never;

describe('options: required strings', () => {
  it('deploymentId, clientId and clientSecret are required strings, each with its own error', () => {
    for (const key of ['deploymentId', 'clientId', 'clientSecret']) {
      for (const value of [undefined, null, '', 5, true, {}, [], 'has space', 'x'.repeat(600)]) {
        expect(bad({ [key]: value }), `${key} ${String(value).slice(0, 8)}`).toThrow(new RegExp(`^eos: ${key}\\b`));
        expect(bad({ [key]: value })).toThrow(RangeError);
      }
    }
  });

  it('a client id with a colon is refused (it would break the Basic header); a secret may hold one', () => {
    expect(bad({ clientId: 'abc:def' })).toThrow(/clientId/);
    expect(() => resolveOptions(base({ clientSecret: 'abc:def:ghi-0123' }))).not.toThrow();
  });

  it('options that are not an object are refused', () => {
    for (const v of [undefined, null, 'x', 5, []]) expect(() => resolveOptions(v)).toThrow(/^eos: options are required/);
  });
});

describe('options: baseUrl', () => {
  it('defaults to https://api.epicgames.dev', () => {
    expect(resolveOptions(base()).baseUrl).toBe('https://api.epicgames.dev');
  });

  it('must be https; http only on localhost and 127.0.0.1 (for tests); no credentials, query or fragment; a trailing slash is dropped', () => {
    expect(resolveOptions(base({ baseUrl: 'https://eos.example.test/' })).baseUrl).toBe('https://eos.example.test');
    expect(resolveOptions(base({ baseUrl: 'http://localhost:8080' })).baseUrl).toBe('http://localhost:8080');
    expect(resolveOptions(base({ baseUrl: 'http://127.0.0.1:9' })).baseUrl).toBe('http://127.0.0.1:9');
    for (const v of ['http://eos.example.test', 'ftp://eos.example.test', 'https://user:pw@eos.example.test', 'https://eos.example.test/?a=1', 'https://eos.example.test/#x', 'not a url', '', 5, null, 'x'.repeat(600)]) {
      expect(bad({ baseUrl: v }), String(v).slice(0, 20)).toThrow(/^eos: baseUrl/);
    }
  });
});

describe('options: sanctions', () => {
  it('action names must match [A-Za-z0-9_-]{1,64}; only chat, area, ban and warning are kinds; at least one is named', () => {
    for (const name of ['', 'has space', 'a/b', 'x'.repeat(65), 'caf\u00e9', 5, null, undefined]) {
      expect(bad({ sanctions: { ...sanctions(), actions: { chat: name } } }), String(name)).toThrow(/^eos: sanctions\.actions/);
    }
    expect(() => resolveOptions(base({ sanctions: { ...sanctions(), actions: { chat: 'x'.repeat(64) } } }))).not.toThrow();
    expect(() => resolveOptions(base({ sanctions: { ...sanctions(), actions: { warning: 'chatwarden-warning', chat: 'a' } } }))).not.toThrow();
    expect(bad({ sanctions: { ...sanctions(), actions: {} } })).toThrow(/sanctions\.actions/);
    expect(bad({ sanctions: { ...sanctions(), actions: { note: 'chatwarden-note' } } })).toThrow(/sanctions\.actions/);
    expect(bad({ sanctions: { ...sanctions(), actions: JSON.parse('{"__proto__":"x","chat":"a"}') } })).toThrow(/sanctions\.actions/);
    expect(bad({ sanctions: { ...sanctions(), actions: 'chat' } })).toThrow(/sanctions\.actions/);
    expect(bad({ sanctions: { ...sanctions(), actions: undefined } })).toThrow(/sanctions\.actions/);
  });

  it('productUserIdsOf must be a function; justification is ref or reason; includeAutomatic is a boolean and needs a chat action; unknown keys are refused', () => {
    expect(bad({ sanctions: { ...sanctions(), productUserIdsOf: 'x' } })).toThrow(/sanctions\.productUserIdsOf/);
    expect(bad({ sanctions: { actions: sanctions().actions } })).toThrow(/sanctions\.productUserIdsOf/);
    expect(bad({ sanctions: { ...sanctions(), justification: 'text' } })).toThrow(/sanctions\.justification/);
    expect(resolveOptions(base()).sanctions?.justification).toBe('ref');
    expect(resolveOptions(base({ sanctions: { ...sanctions(), justification: 'reason' } })).sanctions?.justification).toBe('reason');
    expect(bad({ sanctions: { ...sanctions(), includeAutomatic: 'yes' } })).toThrow(/sanctions\.includeAutomatic/);
    expect(bad({ sanctions: { productUserIdsOf: () => [], actions: { ban: 'b' }, includeAutomatic: true } })).toThrow(/sanctions\.includeAutomatic/);
    expect(resolveOptions(base({ sanctions: { ...sanctions(), includeAutomatic: true } })).sanctions?.includeAutomatic).toBe(true);
    expect(resolveOptions(base()).sanctions?.includeAutomatic).toBe(false);
    expect(bad({ sanctions: { ...sanctions(), justifcation: 'ref' } })).toThrow(/sanctions/);
    expect(bad({ sanctions: 'on' })).toThrow(/sanctions/);
  });
});

describe('options: reports', () => {
  it('seatOf and players must be functions; unknown keys are refused', () => {
    expect(bad({ reports: { players: () => [] } })).toThrow(/reports\.seatOf/);
    expect(bad({ reports: { seatOf: () => null } })).toThrow(/reports\.players/);
    expect(bad({ reports: { ...reports(), pollMsec: 5 } })).toThrow(/reports/);
    expect(bad({ reports: 'on' })).toThrow(/reports/);
  });

  it('reasons keys must be 1..7 and values kit reason ids (or null for no reason); the defaults fill the rest', () => {
    for (const key of ['0', '8', 'x', '1.5', '-1', '01', '']) {
      expect(bad({ reports: { ...reports(), reasons: { [key]: 'other' } } }), key).toThrow(/^eos: reports\.reasons/);
    }
    for (const value of ['', 'Has Caps', 'none', 'x'.repeat(40), 5, undefined, 'a b']) {
      expect(bad({ reports: { ...reports(), reasons: { 1: value } } }), String(value)).toThrow(/^eos: reports\.reasons/);
    }
    const r = resolveOptions(base({ reports: { ...reports(), reasons: { 4: 'hate', 7: null } } })).reports;
    expect(r?.reasons.get(4)).toBe('hate');
    expect(r?.reasons.get(7)).toBeNull();
    expect(r?.reasons.get(1)).toBe('cheating');
    expect(r?.reasons.get(5)).toBe('spam');
    expect(resolveOptions(base()).reports?.reasons.size).toBe(7);
    expect(bad({ reports: { ...reports(), reasons: 'x' } })).toThrow(/reports\.reasons/);
  });

  it('pollMs, batch and maxPerPoll are whole numbers within bounds, with defaults 60000, 20 and 100', () => {
    const d = resolveOptions(base()).reports;
    expect([d?.pollMs, d?.batch, d?.maxPerPoll]).toEqual([60_000, 20, 100]);
    for (const [key, values] of [
      ['pollMs', [0, 999, 1.5, -1, 86_400_001, '60000', Number.NaN, Infinity]],
      ['batch', [0, 101, 1.5, -1, '20', Number.NaN]],
      ['maxPerPoll', [0, 1001, 1.5, -1, '5', Number.NaN]],
    ] as const) {
      for (const v of values) expect(bad({ reports: { ...reports(), [key]: v } }), `${key} ${String(v)}`).toThrow(new RegExp(`^eos: reports\\.${key}`));
    }
    expect(resolveOptions(base({ reports: { ...reports(), pollMs: 1000, batch: 100, maxPerPoll: 1000 } })).reports?.batch).toBe(100);
  });
});

describe('options: shape of the whole', () => {
  it('sanctions and reports are each optional, and at least one is needed', () => {
    expect(resolveOptions(base({ reports: undefined })).reports).toBeNull();
    expect(resolveOptions(base({ sanctions: undefined })).sanctions).toBeNull();
    expect(bad({ sanctions: undefined, reports: undefined })).toThrow(/^eos: configure sanctions, reports or both/);
  });

  it('the object is copied and frozen: changing the adopter object afterwards changes nothing', () => {
    const acts = { chat: 'chatwarden-chat' } as Record<string, string>;
    const reasons = { 4: 'hate' } as Record<number, string | null>;
    const input = base({ sanctions: { productUserIdsOf: () => [], actions: acts }, reports: { ...reports(), reasons } });
    const out = resolveOptions(input);
    acts['chat'] = 'changed';
    acts['ban'] = 'added';
    reasons[4] = 'spam';
    (input['sanctions'] as { includeAutomatic?: boolean }).includeAutomatic = true;
    expect(out.sanctions?.actions.get('chat')).toBe('chatwarden-chat');
    expect(out.sanctions?.actions.has('ban')).toBe(false);
    expect(out.reports?.reasons.get(4)).toBe('hate');
    expect(out.sanctions?.includeAutomatic).toBe(false);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('every option is read once', () => {
    let reads = 0;
    const input = base();
    for (const key of ['deploymentId', 'clientId', 'clientSecret', 'baseUrl', 'fetch', 'clock', 'random', 'logger']) {
      const value = input[key];
      Object.defineProperty(input, key, {
        enumerable: true,
        get() {
          reads++;
          return value;
        },
      });
    }
    resolveOptions(input);
    expect(reads).toBe(8);
  });

  it('errors never contain a value: seeded secrets and ids are not in any message', () => {
    const seeds = ['snerp-secret-VALUE-1', 'glarn-client-VALUE-2', 'tarvo deployment VALUE 3'];
    const tries: Array<Record<string, unknown>> = [
      { clientSecret: `${seeds[0]} ${'x'.repeat(600)}` },
      { clientId: `${seeds[1]}:colon` },
      { deploymentId: seeds[2] },
      { baseUrl: `http://${seeds[0]}.example.test` },
      { baseUrl: `https://u:${seeds[0]}@h.example.test` },
      { sanctions: { ...sanctions(), actions: { chat: `${seeds[1]} bad` } } },
      { reports: { ...reports(), reasons: { [seeds[1] as string]: 'other' } } },
      { sanctions: { ...sanctions(), justifcation: seeds[0] } },
      { reports: { ...reports(), [seeds[2] as string]: 1 } },
      { fetch: seeds[0] },
      { clock: { now: seeds[1] } },
      { logger: { warn: seeds[2] } },
    ];
    for (const over of tries) {
      let message = '';
      try {
        resolveOptions(base(over));
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(over))).not.toBe('');
      for (const seed of seeds) expect(message).not.toContain(seed);
      for (const bit of ['VALUE', 'x'.repeat(30)]) expect(message).not.toContain(bit);
    }
  });

  it('fetch, clock, random and logger are checked', () => {
    expect(bad({ fetch: 'x' })).toThrow(/^eos: fetch/);
    expect(bad({ clock: {} })).toThrow(/^eos: clock/);
    expect(bad({ random: 5 })).toThrow(/^eos: random/);
    expect(bad({ logger: {} })).toThrow(/^eos: logger/);
    const r = resolveOptions(base());
    expect(typeof r.clock.now()).toBe('number');
    expect(typeof r.random()).toBe('number');
  });
});

describe('eos(): construction', () => {
  it('a store without links is refused with a RangeError, before anything is subscribed', () => {
    let subscribed = 0;
    const kit = { links: { supported: false }, on: () => (subscribed++, () => undefined) } as never;
    expect(() => eos(kit, base() as never)).toThrow(/^eos: the store does not support links/);
    expect(subscribed).toBe(0);
  });

  it('a bad option is a RangeError and nothing is subscribed', () => {
    let subscribed = 0;
    const kit = { links: { supported: true }, on: () => (subscribed++, () => undefined) } as never;
    expect(() => eos(kit, base({ clientSecret: 5 }) as never)).toThrow(RangeError);
    expect(subscribed).toBe(0);
  });

  it('a valid adapter has the documented shape and makes no request and sets no timer by itself', () => {
    let requests = 0;
    const adapter = eos(fakeKit, base({ fetch: () => (requests++, Promise.reject(new Error('no network in tests'))) }) as never);
    expect(Object.keys(adapter).sort()).toEqual(['dispose', 'pollReports', 'start', 'stop']);
    expect(requests).toBe(0);
    adapter.dispose();
    adapter.dispose();
  });
});
