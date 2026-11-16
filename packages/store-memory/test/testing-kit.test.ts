import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/index.js';
import { createTestKit, wordFilter, wordMatcher } from '../src/testing/index.js';

describe('createTestKit', () => {
  it('defaults are the standard profile, retention off, no matcher', async () => {
    const kit = await createTestKit();
    expect(kit.cw.profile.id).toBe('standard');
    expect(kit.clock.now()).toBe(1_800_000_000_000);
    expect(kit.store).toBeInstanceOf(MemoryStore);
    const room = kit.room();
    // No matcher: nothing is blocked, whatever the word.
    expect(room.say('tarvo', 'zorbak').label).toBe('delivered');
    // The kit says once, at start, that it has no matcher and no profanity filter; that is all it logs, and advancing a week (retention is off) adds nothing.
    const noted = ['chatwarden.no_matcher', 'chatwarden.no_profanity_filter'];
    expect(kit.logged.map((entry) => entry.event)).toEqual(noted);
    kit.clock.advance('7d');
    room.say('fenrisk', 'still fine');
    expect(kit.logged.map((entry) => entry.event)).toEqual(noted);
    await kit.close();
  });

  it('start sets the clock and the profile and limits pass through to the kit', async () => {
    const kit = await createTestKit({ start: 1_000_000, profile: 'strict', limits: { chatMaxLength: 20 } });
    expect(kit.clock.now()).toBe(1_000_000);
    expect(kit.cw.profile.id).toBe('strict');
    expect(kit.cw.limits.chatMaxLength).toBe(20);
    expect(kit.room().say('tarvo', 'x'.repeat(21)).label).toBe('refused:length');
    await kit.close();
  });

  it('blocked and swears are shorthands: a word list is a matcher and a filter', async () => {
    const kit = await createTestKit({ blocked: ['zorbak'], swears: ['snerp'] });
    const room = kit.room();
    expect(room.say('tarvo', 'you zorbak').label).toBe('refused:blocked');
    expect(room.say('fenrisk', 'what a snerp').result).toMatchObject({ deliver: { text: expect.stringContaining('*****') } });
    expect(room.say('glarn', 'zorbakian is fine').label).toBe('delivered');
    await kit.close();
  });

  it('blocked and swears lose to matcher, profanity and profanityPackage', async () => {
    const matcherWins = await createTestKit({ blocked: ['zorbak'], matcher: wordMatcher(['vlemmo']) });
    expect(matcherWins.room().say('a', 'zorbak').label).toBe('delivered');
    expect(matcherWins.room().say('b', 'vlemmo').label).toBe('refused:blocked');

    const filterWins = await createTestKit({ swears: ['snerp'], profanity: wordFilter(['glarn']) });
    expect(filterWins.room().say('a', 'snerp').result).toMatchObject({ deliver: { text: 'snerp' } });
    expect(filterWins.room().say('b', 'glarn').result).toMatchObject({ deliver: { text: '*****' } });

    const packageWins = await createTestKit({ swears: ['snerp'], profanityPackage: { createProfanityFilter: () => wordFilter(['quissel']) } });
    expect(packageWins.room().say('a', 'snerp').result).toMatchObject({ deliver: { text: 'snerp' } });
    expect(packageWins.room().say('b', 'quissel').result).toMatchObject({ deliver: { text: '*******' } });
  });

  it('a failing store subclass passes through (a store error is the test\'s to see, not swallowed)', async () => {
    class DownStore extends MemoryStore {
      override loadSubjectActions(...args: Parameters<MemoryStore['loadSubjectActions']>): ReturnType<MemoryStore['loadSubjectActions']> {
        if (this.failing) throw new Error('store down');
        return super.loadSubjectActions(...args);
      }
      failing = false;
    }
    const store = new DownStore();
    const kit = await createTestKit({ store });
    expect(kit.store).toBe(store);
    const room = kit.room();
    room.join('tarvo');
    store.failing = true;
    expect(() => kit.suggest('tarvo', 'rude')).toThrow('store down');
    await kit.close();
  });

  it('two kits share nothing: clocks, stores, events, strikes', async () => {
    const a = await createTestKit({ blocked: ['zorbak'] });
    const b = await createTestKit({ blocked: ['zorbak'] });
    expect(a.store).not.toBe(b.store);
    a.clock.advance('1d');
    expect(b.clock.now()).toBe(1_800_000_000_000);
    const strikes = a.cw.limits.strikes.count;
    for (let i = 0; i < strikes; i += 1) {
      a.clock.advance('10s');
      a.room().say('tarvo', 'zorbak');
    }
    expect(a.room().say('tarvo', 'hello').label).toBe('refused:restricted');
    expect(b.room().say('tarvo', 'hello').label).toBe('delivered');
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events).toEqual([]);
  });

  it('close stops the kit and is safe to call twice', async () => {
    const kit = await createTestKit();
    await kit.close();
    await kit.close();
  });

  it('logged and events record in order', async () => {
    const kit = await createTestKit({ blocked: ['zorbak'] });
    const room = kit.room();
    const strikes = kit.cw.limits.strikes.count;
    const types = (): string[] => kit.events.map((e) => e.type);
    expect(types()).toEqual([]);
    for (let i = 0; i < strikes; i += 1) {
      kit.clock.advance('10s');
      room.say('fenrisk', 'zorbak');
    }
    const seen = types();
    expect(seen).toContain('auto.restricted');
    expect(seen.indexOf('auto.restricted')).toBe(seen.length - 1 - [...seen].reverse().indexOf('auto.restricted'));
    const before = kit.events.length;
    room.say('tarvo', 'hello');
    expect(kit.events.length).toBeGreaterThanOrEqual(before);
    // The kit's own warnings are collected, with an event name and detail only.
    const noisy = await createTestKit({
      matcher: {
        match: () => {
          throw new Error('matcher is down with a secret detail');
        },
      },
    });
    noisy.room().say('tarvo', 'hello');
    expect(noisy.logged.length).toBeGreaterThan(0);
    for (const entry of noisy.logged) {
      expect(typeof entry.event).toBe('string');
      expect(JSON.stringify(entry)).not.toContain('secret detail');
    }
  });

  it('a player is seated on first use with a key made from the name, and the seat id is the name', async () => {
    const kit = await createTestKit();
    const room = kit.room('arena');
    room.say('tarvo', 'hello');
    expect(kit.cw.rooms.subjectAt('arena', 'tarvo')).not.toBeNull();
    expect(kit.cw.rooms.subjectAt('arena', 'snerp')).toBeNull();
    room.join('snerp');
    room.join('snerp');
    expect(kit.cw.rooms.subjectAt('arena', 'snerp')).not.toBeNull();
    expect(kit.cw.rooms.subjectAt('arena', 'snerp')).not.toBe(kit.cw.rooms.subjectAt('arena', 'tarvo'));
    room.leave('snerp');
    expect(kit.cw.rooms.subjectAt('arena', 'snerp')).toBeNull();
    // The same name in two rooms is the same person (the key is the name).
    kit.room('other').join('tarvo');
    expect(kit.cw.rooms.subjectAt('other', 'tarvo')).toBe(kit.cw.rooms.subjectAt('arena', 'tarvo'));
  });

  it('room() returns the same room for the same id, and the default room is lobby', async () => {
    const kit = await createTestKit();
    expect(kit.room()).toBe(kit.room('lobby'));
    expect(kit.room().id).toBe('lobby');
    expect(kit.room('a')).not.toBe(kit.room('b'));
  });
});
