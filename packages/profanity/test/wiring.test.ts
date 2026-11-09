import { describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { ChatwardenOptions } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import * as profanityPackage from '../src/index.js';

// The package end to end behind the facade: the profile decides allow, star or refuse, and `profanityPackage`
// builds the filter from the resolved profile. Ordinary swearing is allowed in this package's tests only.

const NOW = 1_800_000_000_000;
const platform = { identify: (ctx: unknown) => ctx as { clientKey: string; ip: string } };

async function chat(over: Partial<ChatwardenOptions> = {}) {
  const store = openStore({ path: ':memory:' });
  const cw = await createChatwarden({
    store,
    secret: 'wiring-secret',
    platform,
    clock: { now: () => NOW },
    logger: { warn() {} },
    retention: false,
    profanityPackage,
    ...over,
  });
  cw.rooms.seat('room', 'a', { clientKey: 'key-a', ip: '198.51.100.1' }, 'Alice');
  return { cw, store, say: (text: string) => cw.chat.accept('room', 'a', text) };
}

describe('@chatwarden/profanity behind createChatwarden', () => {
  it('the standard profile stars with the default style', async () => {
    const { say } = await chat();
    expect(say('you absolute turd')).toMatchObject({ deliver: { text: 'you absolute ****' } });
  });

  it('the profile style, add and remove reach the filter', async () => {
    const { say } = await chat({
      overrides: { profanity: { style: 'keepFirst', add: ['snerp'], remove: ['turd'] } },
    });
    expect(say('turd and snerp')).toMatchObject({ deliver: { text: 'turd and s****' } });
  });

  it('the strict profile refuses with the profanity reason, whatever the evasion, and records nothing against the player', async () => {
    const { cw, store, say } = await chat({ profile: 'strict' });
    expect(say('you turd')).toEqual({ refuse: { reason: 'profanity' } });
    expect(cw.chat.accept('room', 'a', 't​u​rd')).toEqual({ refuse: { reason: 'profanity' } });
    expect(store.loadStrikes(0)).toEqual([]);
    expect(store.loadSanctions(NOW)).toEqual([]);
  });

  it('mode allow leaves swearing alone', async () => {
    const { say } = await chat({ overrides: { profanity: { mode: 'allow' } } });
    expect(say('you turd')).toMatchObject({ deliver: { text: 'you turd' } });
  });

  it('a profile with an unknown language fails creation', async () => {
    await expect(chat({ overrides: { profanity: { languages: ['xx'] } } })).rejects.toThrow(/languages/);
  });

  it('a profile with an add word that is not plain letters fails creation', async () => {
    await expect(chat({ overrides: { profanity: { add: ['sn3rp'] } } })).rejects.toThrow(/profanity\.add/);
  });
});
