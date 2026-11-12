import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Matcher } from '@chatwarden/core';
import { scenario018 } from './bodies018.scenario.js';
import { world } from './world.js';

// Byte identity with 0.1.8, against real bodies: `fixtures/bodies-0.1.8.json` holds the responses (status, headers, body, key order) that the
// 0.1.8 code (origin/main at 2bf9eb8) gave for the fixed run in `bodies018.scenario.ts`: GET /me, GET /changes, GET /people/:ref/history, the
// reports and the sanctions and blocked lists. With appeals and the name features off (or only their handle masks off) this branch must send the
// same bytes. The one deliberate difference is the two new permission keys in `can` (`appeals.read`, `appeals.decide`), which are set aside.

const FROZEN = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/bodies-0.1.8.json', import.meta.url)), 'utf8')) as Record<string, unknown>;

/**
 * Random ids and reference codes are different on every run, and so are the subject ids that key `history` and `ownLineIds` (the kit hashes with
 * a per-run salt); everything else (keys, order, text, times) must match exactly.
 */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'string' && /^([A-Za-z0-9_-]{16,}|[A-Z]-[A-Z0-9]{5})$/.test(x) ? '<id>' : x)).replace(/"s_[A-Za-z0-9_-]{22}":/g, '"<subject>":');

/** The live bodies with the two new permission keys taken out of `can`, the only change 0.1.9 makes to these bodies by design. */
function withoutNewPermissions(bodies: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(bodies) as Record<string, { body?: { can?: Record<string, unknown> } }>;
  for (const key of ['me.moderator', 'me.senior', 'me.owner']) {
    const can = copy[key]?.body?.can;
    if (can !== undefined) {
      delete can['appeals.read'];
      delete can['appeals.decide'];
    }
  }
  return copy;
}

const flagsZorbak: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };

const CONFIGS: Array<[string, Parameters<typeof world>[0]]> = [
  ['the defaults', {}],
  ['appeals and the name settings explicitly false', { overrides: { appeals: { enabled: false }, names: { profanity: false, keepBlocked: false, renames: false } } }],
  ['a matcher that flags a handle, with maskInHub off', { matcher: flagsZorbak, overrides: { names: { maskInHub: false } } }],
  ['a matcher that flags a handle, appeals false, every name setting false, maskInHub off', { matcher: flagsZorbak, overrides: { appeals: { enabled: false }, names: { profanity: false, keepBlocked: false, renames: false, maskInHub: false } } }],
];

describe('the staff bodies with appeals and names off are the 0.1.8 bodies', () => {
  for (const [label, config] of CONFIGS) {
    it(`${label}: every frozen response is identical, key for key and in order`, async () => {
      const live = withoutNewPermissions(await scenario018(await world(config)));
      expect(Object.keys(live)).toEqual(Object.keys(FROZEN));
      for (const key of Object.keys(FROZEN)) expect(stable(live[key]), key).toBe(stable(FROZEN[key]));
    });
  }

  it('the fixture is real 0.1.8 output, not this branch: no appeals or names keys anywhere, and /me has the 19 permission keys 0.1.8 had', () => {
    const text = JSON.stringify(FROZEN);
    for (const k of ['"features"', '"appeals"', '"renames"', '"handleFlagged"', '"statementFlagged"', '"appeals.read"', '"appeals.decide"', 'Flagged"']) expect(text, k).not.toContain(k);
    const can = ((FROZEN['me.owner'] as { body: { can: Record<string, boolean> } }).body.can);
    expect(Object.keys(can)).toHaveLength(19);
    expect(Object.keys(FROZEN)).toHaveLength(11);
  });

  it('control: the comparison can fail. With appeals on, GET /me and GET /changes differ; with a flagging matcher and masking on, the reports carry handle flags', async () => {
    const on = withoutNewPermissions(await scenario018(await world({ overrides: { appeals: { enabled: true } } })));
    expect(stable(on['me.moderator'])).not.toBe(stable(FROZEN['me.moderator']));
    const masked = withoutNewPermissions(await scenario018(await world({ matcher: flagsZorbak })));
    expect(stable(masked['reports'])).not.toBe(stable(FROZEN['reports']));
    expect(stable(masked['report'])).not.toBe(stable(FROZEN['report']));
  });
});
