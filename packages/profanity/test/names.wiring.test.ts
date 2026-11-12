import { describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { ChatwardenOptions } from '@chatwarden/core';
import { buildMatcher } from '@chatwarden/matcher';
import { openStore } from '@chatwarden/store-sqlite';
import * as profanityPackage from '../src/index.js';

// cw.names.check with the REAL matcher and the REAL profanity filter behind it: the profanity pass, look-alikes, hidden characters, and
// kept evidence in SQLite. The profanity word is the synthetic `snerp` (added through the profile); the slur term is `zorbak`.

const NOW = 1_800_000_000_000;

async function kit(names: Record<string, unknown>, over: Partial<ChatwardenOptions> = {}) {
  const store = openStore({ path: ':memory:' });
  const cw = await createChatwarden({
    store,
    secret: 'names-wiring-secret',
    platform: { identify: (ctx: unknown) => ctx as { clientKey: string } },
    clock: { now: () => NOW },
    logger: { warn() {} },
    retention: false,
    profanityPackage,
    matcher: buildMatcher([{ id: 'syn:zorbak', term: 'zorbak', language: 'en', active: true }], []),
    overrides: { profanity: { mode: 'allow', add: ['snerp'], only: ['snerp'] }, names },
    ...over,
  });
  return { cw, store };
}

describe('names.check over the real matcher and the real profanity filter', () => {
  it('profanity off: a profane name passes, a slur name is blocked', async () => {
    const { cw } = await kit({});
    expect(cw.names.check('snerp')).toEqual({ ok: true });
    expect(cw.names.check('Zorbak_99')).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
  });

  it('profanity on, with a profile that allows swearing in chat: handle forms, look-alikes and hidden characters are caught; ordinary names pass', async () => {
    const { cw } = await kit({ profanity: true });
    for (const n of ['snerp', 'Snerp_99', 'big_snerp', 'xX_snerp_Xx', 'SNERP', 's\u200bnerp', 'sn\u200derp', 'snerp\u2060', 's n e r p'.replace(/ /g, '\u200b')]) {
      expect(cw.names.check(n), JSON.stringify(n)).toEqual({ ok: false, reason: 'name_profane', rule: 1 });
    }
    for (const n of ['Alice', 'quill_42', 'tarvo', 'fenrisk_7', 'glarn', '', ' ', 'snerpish'.slice(0, 3)]) expect(cw.names.check(n), JSON.stringify(n)).toEqual({ ok: true });
  });

  it('the matcher wins when a name is both; a long hostile name answers', async () => {
    const { cw } = await kit({ profanity: true });
    expect(cw.names.check('zorbak_snerp')).toEqual({ ok: false, reason: 'name_not_allowed', rule: 1 });
    expect(cw.names.check(`${'a'.repeat(100_000)}_snerp`)).toEqual({ ok: false, reason: 'name_profane', rule: 1 });
    expect(cw.names.check('\ud800snerp\udc00')).toEqual({ ok: false, reason: 'name_profane', rule: 1 });
  });

  it('keepBlocked over SQLite: a blocked name is kept with its term id and reason; an allowed one is not', async () => {
    const { cw, store } = await kit({ profanity: true, keepBlocked: true });
    cw.names.check('Zorbak_99');
    cw.names.check('snerp');
    cw.names.check('Alice');
    const rows = store.listBlockedNames?.(0, 10) ?? [];
    expect(rows.map((r) => [r.name, r.termId, r.reason, r.subject]).sort()).toEqual([
      ['Zorbak_99', 'syn:zorbak', 'name_not_allowed', null],
      ['snerp', null, 'name_profane', null],
    ]);
  });
});
