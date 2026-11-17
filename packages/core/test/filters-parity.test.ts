import { MemoryStore } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { Chatwarden, ChatwardenOptions } from '../src/chatwarden.js';
import type { Logger, Matcher, RawWho } from '../src/types.js';
import { setup, who } from './filtersChatWorld.js';

// Off means identical: with `filters` unset, every ChatResult, buffered line, write and log equals what the same script gives without the
// filter module. The script is the one the pacing parity test runs, with links, numbers and shouting added: lines that a filter WOULD act on.

const SCRIPT: Array<[number, string, string]> = [
  [0, 'p1', 'hello'],
  [0, 'p1', 'hello'],
  [1, 'p1', 'gg'],
  [1, 'p1', 'gg'],
  [0, 'p1', 'one more'],
  [10, 'p2', 'hi there'],
  [0, 'p2', ''],
  [0, 'p2', '   '],
  [1, 'p2', 'x'.repeat(201)],
  [1, 'p2', 'x'.repeat(200)],
  [0, 'p3', 'a guest line'],
  [0, 'p3', 'a guest line'],
  [6, 'p3', 'see vlemmo.com now'],
  [6, 'p1', 'this is snerp talking'],
  [1, 'p1', 'zorbak'],
  [6, 'p1', 'zorbak'],
  [6, 'p1', 'fine words'],
  [6, 'p1', 'ZORBAK again'],
  [6, 'p1', 'after three strikes'],
  [10, 'p2', 'call 555-010-9999 or mail a@b.com'],
  [10, 'p2', 'AAAAAAAAAAAAAAAAAAAA nooooooooooo'],
  [10, 'p2', 'discord.gg/zorbakfan join'],
  [10, 'p2', 'buy gold at vlemmo.com'],
  [10, 'p2', 'snerp vlemmo.com'],
  [1, 'p2', '?!'],
];

/** Subject and notice ids are random per run: replace each distinct one with a stable label, in order of first appearance. */
function stable(value: unknown): unknown {
  const seen = new Map<string, string>();
  const label = (id: string): string => {
    if (!seen.has(id)) seen.set(id, `id${seen.size + 1}`);
    return seen.get(id)!;
  };
  const json = JSON.stringify(value)
    .replace(/s_[A-Za-z0-9_-]{22}/g, label)
    .replace(/("noticeId":")([A-Za-z0-9_-]{22})(")/g, (_m, a: string, id: string, c: string) => `${a}${label(id)}${c}`);
  return JSON.parse(json);
}

function run(opts: Parameters<typeof setup>[0]) {
  const t = setup(opts);
  t.sit('p1', who('k1'));
  t.sit('p2', who('k2'));
  t.sit('p3', null);
  const results: unknown[] = [];
  for (const [gap, seat, text] of SCRIPT) {
    t.clock.t += gap * 1000;
    results.push(t.say(seat, text));
  }
  return {
    results: stable(results) as unknown[],
    buffer: stable(t.buffer.snapshot('R1')),
    logs: t.logs,
    strikes: t.writes.strikes.mock.calls.length,
    notices: t.writes.notices.mock.calls.length,
    sanctions: t.writes.sanctions.mock.calls.length,
    counted: t.calls.counted.length,
    flags: t.calls.flags.length,
    profanity: t.calls.profanityInputs,
    matcher: t.calls.matcherInputs,
  };
}

describe('off means identical (the chat service)', () => {
  it('filters unset, and filters with every block off, give the same results as no filter module at all', () => {
    const without = run({ noFiltersDep: true });
    for (const filters of [{}, { links: null, personalInfo: null, ratio: null, phrases: [], ignore: [] }]) {
      const withOff = run({ filters });
      expect(withOff.results).toEqual(without.results);
      expect(withOff.buffer).toEqual(without.buffer);
      expect(withOff.logs).toEqual(without.logs);
      expect(withOff.profanity).toEqual(without.profanity);
      expect(withOff.matcher).toEqual(without.matcher);
      expect([withOff.strikes, withOff.notices, withOff.sanctions]).toEqual([without.strikes, without.notices, without.sanctions]);
      expect(withOff.counted).toBe(0);
      expect(withOff.flags).toBe(0);
    }
    // The control: the script does contain lines the filters would act on, so the comparison above is not vacuous.
    const on = run({ filters: { links: { action: 'refuse' }, personalInfo: { action: 'mask' }, ratio: { action: 'mask' } } });
    expect(on.results).not.toEqual(without.results);
    expect(on.counted).toBeGreaterThan(0);
  });

  it('a blocked line and its strikes are the same on and off', () => {
    const without = run({ noFiltersDep: true });
    expect(without.strikes).toBeGreaterThan(0);
    expect(run({ filters: {} }).strikes).toBe(without.strikes);
  });

  it('with the filters on, a matcher block is still the same (the filters never see a blocked line)', () => {
    const on = run({ filters: { links: { action: 'count' }, phrases: [{ id: 'a', action: 'count', phrases: ['zorbakfan join'] }] } });
    const without = run({ noFiltersDep: true });
    const at = without.results.findIndex((r) => JSON.stringify(r).includes('"blocked"'));
    expect(at).toBeGreaterThan(-1);
    expect(on.results[at]).toEqual(without.results[at]);
    expect(on.counted).toBeGreaterThan(0);
  });
});

describe('off means identical (the facade)', () => {
  const matcher: Matcher = { match: (t) => (/\bzorbak\b/i.test(t) ? { termId: 'syn:zorbak' } : null), spans: () => [] };
  async function facade(over: Partial<ChatwardenOptions> = {}) {
    const clock = { t: 1_800_000_000_000, now: () => clock.t };
    const logs: Array<[string, unknown]> = [];
    const logger: Logger = { warn: (e, d) => void logs.push([e, d]) };
    const cw: Chatwarden = await createChatwarden({ store: new MemoryStore(), secret: 'filters-parity-secret', platform: { identify: (ctx) => ctx as RawWho }, clock, logger, retention: false, matcher, ...over });
    cw.rooms.seat('R1', 'p1', { clientKey: 'k1' }, 'One');
    cw.rooms.seat('R1', 'p2', { clientKey: 'k2' }, 'Two');
    const results: unknown[] = [];
    for (const [gap, seat, text] of SCRIPT) {
      clock.t += gap * 1000;
      if (seat !== 'p3') results.push(cw.chat.accept('R1', seat, text));
    }
    return { cw, results: stable(results) as unknown[], logs };
  }

  it('a kit without filters and a kit with an explicit empty filters section give identical results', async () => {
    const a = await facade();
    const b = await facade({ overrides: { filters: { links: null, personalInfo: null, ratio: null, phrases: [] } } });
    expect(b.results).toEqual(a.results);
    expect(b.logs).toEqual(a.logs);
    expect(a.cw.profile.filters).toEqual(b.cw.profile.filters);
    const on = await facade({ overrides: { filters: { links: { action: 'refuse' } } } });
    expect(on.results).not.toEqual(a.results);
    await a.cw.close();
    await b.cw.close();
    await on.cw.close();
  });
});
