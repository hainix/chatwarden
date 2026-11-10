import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { Platform, RawWho } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

async function setup() {
  const clock = { t: NOW, now: () => clock.t };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const store = new MemoryStore();
  const cw = await createChatwarden({ store, secret: 'wk-secret', platform, clock, logger: { warn: () => undefined }, retention: false });
  return { cw, clock, store };
}

describe('cw.webhookKeys (the facade over the store, on the injected clock)', () => {
  it('reserves, completes and answers the stored result', async () => {
    const { cw } = await setup();
    expect(cw.webhookKeys.reserve('k1')).toEqual({ reserved: true });
    expect(cw.webhookKeys.reserve('k1')).toEqual({ reserved: false, state: 'pending', resultJson: null });
    expect(cw.webhookKeys.complete('k1', '{"a":1}')).toBe(true);
    expect(cw.webhookKeys.reserve('k1')).toEqual({ reserved: false, state: 'done', resultJson: '{"a":1}' });
  });

  it('release frees a pending key', async () => {
    const { cw } = await setup();
    cw.webhookKeys.reserve('k1');
    expect(cw.webhookKeys.release('k1')).toBe(true);
    expect(cw.webhookKeys.reserve('k1')).toEqual({ reserved: true });
  });

  it('a key is the first one for 24 h, then free again (the clock decides, not purge timing)', async () => {
    const { cw, clock } = await setup();
    cw.webhookKeys.reserve('k1');
    cw.webhookKeys.complete('k1', '{"a":1}');
    clock.t = NOW + DAY;
    expect(cw.webhookKeys.reserve('k1')).toMatchObject({ reserved: false, state: 'done' });
    clock.t = NOW + DAY + 1;
    expect(cw.webhookKeys.reserve('k1')).toEqual({ reserved: true });
  });

  it('cw.purge removes keys older than 24 h and reports the count', async () => {
    const { cw, clock } = await setup();
    cw.webhookKeys.reserve('old');
    clock.t = NOW + DAY + 1;
    cw.webhookKeys.reserve('new');
    const res = await cw.purge();
    expect(res.webhookKeys).toBe(1);
  });
});
