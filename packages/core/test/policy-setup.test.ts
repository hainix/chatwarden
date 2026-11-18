import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import { POLICY_REFRESH_MS } from '../src/policy.js';
import { applyPolicyLayer, POLICY_SECTIONS, PRESETS } from '../src/profile.js';
import type { PolicyLayer } from '../src/profile.js';
import { CREATOR_TEAM_NOTE, GAME_KINDS, recommendFor } from '../src/recommend.js';
import type { GameKind } from '../src/recommend.js';
import type { Logger, RawWho, SetupState, Store } from '../src/types.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const BY = { actor: 'owner_ann', reason: 'first-run setup' };

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;
type Kit = Awaited<ReturnType<typeof kit>>['cw'];

async function kit(over: Partial<ChatwardenOptions> = {}, store: Store = new MemoryStore(), clock = { t: NOW, now: () => clock.t }) {
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const cw = await createChatwarden({
    store,
    secret: 'setup-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
    ...over,
  });
  return { cw, store, clock, logged };
}

/** The store with the named optional methods taken away, as a custom store without them would be. */
function without(store: MemoryStore, ...names: string[]): Store {
  return new Proxy(store, {
    get(target, key) {
      if (typeof key === 'string' && names.includes(key)) return undefined;
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
}

/** The store with the setup methods replaced. */
function withSetup(store: MemoryStore, get: () => SetupState | null, save: (s: SetupState) => void): Store {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'getSetupState') return get;
      if (key === 'saveSetupState') return save;
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
}

const version = (cw: Kit): number => cw.policy.get().version;
const ctxOf = (cw: Kit) => ({ version: version(cw), ...BY });

describe('cw.policy.setup and dismissSetup', () => {
  it('a fresh kit shows the setup, persists true, dismissedAt null', async () => {
    const { cw } = await kit();
    expect(cw.policy.setup()).toEqual({ show: true, dismissedAt: null, persists: true });
  });

  it('dismiss hides it, sets dismissedAt to the clock, and a second kit over the same store still hides it', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await kit({}, store);
    expect(cw.policy.dismissSetup()).toEqual({ show: false, dismissedAt: NOW, persists: true });
    expect(cw.policy.setup()).toEqual({ show: false, dismissedAt: NOW, persists: true });
    expect(store.getSetupState()).toEqual({ dismissedAt: NOW });
    const second = await kit({}, store, clock);
    expect(second.cw.policy.setup()).toEqual({ show: false, dismissedAt: NOW, persists: true });
  });

  it('a second dismiss keeps the first dismissedAt and writes nothing', async () => {
    const store = new MemoryStore();
    const save = vi.spyOn(store, 'saveSetupState');
    const { cw, clock } = await kit({}, store);
    cw.policy.dismissSetup();
    clock.t += 5 * MIN;
    expect(cw.policy.dismissSetup()).toEqual({ show: false, dismissedAt: NOW, persists: true });
    expect(save).toHaveBeenCalledTimes(1);
    // a different kit over the same store does not rewrite it either
    const other = await kit({}, store, clock);
    expect(other.cw.policy.dismissSetup().dismissedAt).toBe(NOW);
    expect(save).toHaveBeenCalledTimes(1);
  });

  describe('any saved layer hides it', () => {
    it('a save of customDuration', async () => {
      const { cw } = await kit();
      expect(cw.policy.save({ customDuration: false }, { version: 0, ...BY })).toMatchObject({ ok: true });
      expect(cw.policy.setup()).toEqual({ show: false, dismissedAt: null, persists: true });
    });

    it('a save then reset() of everything (version above 0)', async () => {
      const { cw } = await kit();
      cw.policy.save({ customDuration: false }, { version: 0, ...BY });
      expect(cw.policy.reset()).toMatchObject({ ok: true, changed: ['customDuration'] });
      expect(version(cw)).toBe(2);
      expect(cw.policy.get().layer).toEqual({});
      expect(cw.policy.setup().show).toBe(false);
    });

    it('an unreadable stored layer (layerError)', async () => {
      const store = new MemoryStore();
      store.savePolicyLayer({ profanity: { mode: 'allow' } } as unknown as PolicyLayer, 0);
      const { cw } = await kit({}, store);
      expect(cw.policy.get().layerError).toBeDefined();
      expect(cw.policy.setup().show).toBe(false);
    });

    it('a layer saved by another process hides it within the refresh interval', async () => {
      const store = new MemoryStore();
      const { cw, clock } = await kit({}, store);
      expect(cw.policy.setup().show).toBe(true);
      const other = await kit({}, store, clock);
      other.cw.policy.save({ customDuration: false }, { version: 0, ...BY });
      clock.t += POLICY_REFRESH_MS;
      expect(cw.policy.setup().show).toBe(false);
    });
  });

  it('a store without the pair: persists false, the dismissal lasts for this kit only and a new kit over the same store shows it again', async () => {
    const mem = new MemoryStore();
    const store = without(mem, 'getSetupState', 'saveSetupState');
    const { cw, clock } = await kit({}, store);
    expect(cw.policy.setup()).toEqual({ show: true, dismissedAt: null, persists: false });
    expect(cw.policy.dismissSetup()).toEqual({ show: false, dismissedAt: NOW, persists: false });
    expect(cw.policy.setup()).toEqual({ show: false, dismissedAt: NOW, persists: false });
    const again = await kit({}, store, clock);
    expect(again.cw.policy.setup()).toEqual({ show: true, dismissedAt: null, persists: false });
  });

  it('a store with only one of the pair counts as without it', async () => {
    const { cw } = await kit({}, without(new MemoryStore(), 'saveSetupState'));
    expect(cw.policy.setup().persists).toBe(false);
    const other = await kit({}, without(new MemoryStore(), 'getSetupState'));
    expect(other.cw.policy.setup().persists).toBe(false);
  });

  it('a store with no policy methods (canSave false) never shows it', async () => {
    const { cw } = await kit({}, without(new MemoryStore(), 'loadPolicyLayer', 'savePolicyLayer'));
    expect(cw.policy.get().canSave).toBe(false);
    expect(cw.policy.setup().show).toBe(false);
    expect(cw.policy.dismissSetup().show).toBe(false);
  });

  it('a store whose getSetupState throws reads as not dismissed; neither throws; the log line names the class only', async () => {
    const mem = new MemoryStore();
    const store = withSetup(mem, () => { throw new TypeError('zorbak store text'); }, () => undefined);
    const { cw, clock, logged } = await kit({}, store);
    expect(cw.policy.setup()).toEqual({ show: true, dismissedAt: null, persists: true });
    expect(logged.filter(([e]) => e === 'chatwarden.setup_state_failed')).toEqual([['chatwarden.setup_state_failed', { error: 'TypeError' }]]);
    // throttled: many calls inside a minute add no line
    for (let i = 0; i < 5; i += 1) cw.policy.setup();
    expect(logged.filter(([e]) => e === 'chatwarden.setup_state_failed')).toHaveLength(1);
    clock.t += 61_000;
    cw.policy.setup();
    const lines = logged.filter(([e]) => e === 'chatwarden.setup_state_failed');
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain('zorbak');
  });

  it('a throwing saveSetupState falls back to the session; it does not throw and logs the class only', async () => {
    const mem = new MemoryStore();
    const store = withSetup(mem, () => null, () => { throw new RangeError('zorbak disk text'); });
    const { cw, clock, logged } = await kit({}, store);
    expect(() => cw.policy.dismissSetup()).not.toThrow();
    expect(cw.policy.setup()).toEqual({ show: false, dismissedAt: NOW, persists: true });
    expect(logged.filter(([e]) => e === 'chatwarden.setup_state_failed')).toEqual([['chatwarden.setup_state_failed', { error: 'RangeError' }]]);
    expect(JSON.stringify(logged)).not.toContain('zorbak');
    // a second kit over the same store did not get the dismissal (it was only kept in the first)
    const again = await kit({}, store, clock);
    expect(again.cw.policy.setup().show).toBe(true);
  });

  it('an unreadable value from the store reads as not dismissed', async () => {
    const mem = new MemoryStore();
    for (const bad of [{ dismissedAt: 'a' }, 'x', 5, [], { dismissedAt: Number.NaN }]) {
      const store = withSetup(mem, () => bad as unknown as SetupState, () => undefined);
      const { cw } = await kit({}, store);
      expect(cw.policy.setup().show, JSON.stringify(bad)).toBe(true);
      expect(cw.policy.setup().dismissedAt).toBeNull();
    }
  });
});

describe('cw.policy.applyRecommendation', () => {
  const differing = (game: GameKind): string[] => {
    const layer = recommendFor(game).layer as Record<string, unknown>;
    const base = PRESETS.standard as unknown as Record<string, unknown>;
    return POLICY_SECTIONS.filter((s) => Object.hasOwn(layer, s) && JSON.stringify(layer[s]) !== JSON.stringify(base[s]));
  };

  it("applyRecommendation('kids', ctx) bumps the version once and answers ok with only the sections that differ from the base, in POLICY_SECTIONS order", async () => {
    const { cw } = await kit();
    const res = cw.policy.applyRecommendation('kids', ctxOf(cw));
    // the ladder is shared by the three presets: it is stored, but it equals the base, so it is not listed
    expect(res).toEqual({ ok: true, version: 1, changed: ['firstOffense', 'repeat', 'guidelines', 'aiContext'] });
    expect(version(cw)).toBe(1);
    expect(differing('kids')).not.toContain('ladder');
    expect((res as { changed: string[] }).changed).toEqual(differing('kids'));
  });

  it('changed lists exactly the sections whose value differs from the base, for every game over every base', async () => {
    for (const game of GAME_KINDS) {
      for (const profile of ['relaxed', 'standard', 'strict'] as const) {
        const { cw } = await kit({ profile });
        const res = cw.policy.applyRecommendation(game, ctxOf(cw));
        const base = PRESETS[profile] as unknown as Record<string, unknown>;
        const eff = cw.policy.get().effective as unknown as Record<string, unknown>;
        const want = POLICY_SECTIONS.filter((s) => JSON.stringify(eff[s]) !== JSON.stringify(base[s]));
        expect((res as { changed: string[] }).changed, `${game} over ${profile}`).toEqual(want);
      }
    }
  });

  it('applying the recommendation that equals the base lists nothing (kids over strict, social over standard) yet stores it and bumps the version', async () => {
    const strict = await kit({ profile: 'strict' });
    expect(strict.cw.policy.applyRecommendation('kids', ctxOf(strict.cw))).toEqual({ ok: true, version: 1, changed: [] });
    expect(strict.cw.policy.setup().show).toBe(false);
    expect(Object.keys(strict.cw.policy.get().layer).sort()).toEqual(['aiContext', 'firstOffense', 'guidelines', 'ladder', 'repeat']);
    const standard = await kit();
    expect(standard.cw.policy.applyRecommendation('social', ctxOf(standard.cw))).toEqual({ ok: true, version: 1, changed: [] });
  });

  it('creator lists teamNotes (the base has none) and a second apply lists nothing', async () => {
    const { cw } = await kit();
    expect(cw.policy.applyRecommendation('creator', ctxOf(cw))).toEqual({ ok: true, version: 1, changed: ['teamNotes'] });
    expect(cw.policy.applyRecommendation('creator', ctxOf(cw))).toEqual({ ok: true, version: 2, changed: [] });
  });

  it('a section the owner had changed and the recommendation sets back to the base is not listed; a section the apply leaves alone is not either', async () => {
    const { cw } = await kit();
    cw.policy.save({ pace: { slowModeMs: 2000 }, ladder: recommendFor('kids').layer.ladder }, { version: 0, ...BY });
    const res = cw.policy.applyRecommendation('kids', ctxOf(cw));
    expect(res).toMatchObject({ ok: true });
    expect((res as { changed: string[] }).changed).not.toContain('pace');
    expect((res as { changed: string[] }).changed).not.toContain('ladder');
  });

  it("afterwards the guide's first-offence table and ladder table are the strict preset's and cw.policy.setup().show is false", async () => {
    const { cw } = await kit();
    const before = cw.documents.moderatorGuide({ format: 'text' });
    cw.policy.applyRecommendation('kids', ctxOf(cw));
    const eff = cw.policy.get().effective;
    expect(eff.firstOffense).toEqual(PRESETS.strict.firstOffense);
    expect(eff.ladder).toEqual(PRESETS.strict.ladder);
    expect(eff.repeat).toEqual(PRESETS.strict.repeat);
    expect(eff.guidelines).toEqual(PRESETS.strict.guidelines);
    expect(eff.aiContext).toBe(PRESETS.strict.aiContext);
    const guide = cw.documents.moderatorGuide({ format: 'text' });
    expect(guide).not.toBe(before);
    for (const row of PRESETS.strict.ladder) {
      expect(guide).toContain(row.lowMedium.label);
      expect(guide).toContain(row.high.label);
    }
    expect(guide).toContain(PRESETS.strict.guidelines[0]!.title);
    expect(cw.policy.setup().show).toBe(false);
  });

  it('every game applies: the effective principles, rules and ladder follow the recommended preset, over any base', async () => {
    for (const game of GAME_KINDS) {
      for (const profile of ['relaxed', 'standard', 'strict'] as const) {
        const { cw } = await kit({ profile });
        expect(cw.policy.applyRecommendation(game, ctxOf(cw))).toMatchObject({ ok: true, version: 1 });
        const eff = cw.policy.get().effective;
        const want = PRESETS[recommendFor(game).preset];
        expect(eff.ladder, `${game} over ${profile}`).toEqual(want.ladder);
        expect(eff.firstOffense, `${game} over ${profile}`).toEqual(want.firstOffense);
        expect(eff.guidelines, `${game} over ${profile}`).toEqual(want.guidelines);
        expect(eff.aiContext, `${game} over ${profile}`).toBe(want.aiContext);
        expect(eff).toEqual(applyPolicyLayer(PRESETS[profile], recommendFor(game).layer));
      }
    }
  });

  it('recommending what the base already is still stores the recommendation (social over standard)', async () => {
    const { cw } = await kit();
    const res = cw.policy.applyRecommendation('social', ctxOf(cw));
    expect(res).toMatchObject({ ok: true, version: 1 });
    expect(Object.keys(cw.policy.get().layer).sort()).toEqual(['aiContext', 'firstOffense', 'guidelines', 'ladder', 'repeat']);
    expect(cw.policy.setup().show).toBe(false);
  });

  it('a stale ctx.version is conflict and writes nothing', async () => {
    const store = new MemoryStore();
    const { cw } = await kit({}, store);
    cw.policy.save({ customDuration: false }, { version: 0, ...BY });
    expect(cw.policy.applyRecommendation('kids', { version: 0, ...BY })).toEqual({ ok: false, error: 'conflict' });
    expect(store.loadPolicyLayer()).toEqual({ layer: { customDuration: false }, version: 1 });
  });

  it("an unknown game is invalid at path 'game'", async () => {
    const store = new MemoryStore();
    const { cw } = await kit({}, store);
    for (const game of ['nope', '', 'Kids', null, 3, undefined]) {
      expect(cw.policy.applyRecommendation(game as GameKind, ctxOf(cw)), String(game)).toEqual({ ok: false, error: 'invalid', path: 'game' });
    }
    expect(store.loadPolicyLayer()).toBeNull();
  });

  it('an invalid actor or empty reason is refused as for save', async () => {
    const store = new MemoryStore();
    const { cw } = await kit({}, store);
    expect(cw.policy.applyRecommendation('kids', { version: 0, actor: 'has space', reason: 'x' })).toEqual({ ok: false, error: 'invalid', path: 'actor' });
    expect(cw.policy.applyRecommendation('kids', { version: 0, actor: 'owner_ann', reason: '  ' })).toEqual({ ok: false, error: 'invalid', path: 'reason' });
    expect(cw.policy.applyRecommendation('kids', { version: -1, actor: 'owner_ann', reason: 'x' })).toEqual({ ok: false, error: 'invalid', path: 'version' });
    expect(store.loadPolicyLayer()).toBeNull();
  });

  it('other sections of an existing layer (reporting, pace) survive', async () => {
    const { cw } = await kit();
    cw.policy.save({ pace: { slowModeMs: 2000 }, customDuration: false, ladder: recommendFor('social').layer.ladder }, { version: 0, ...BY });
    expect(cw.policy.applyRecommendation('kids', ctxOf(cw))).toMatchObject({ ok: true, version: 2 });
    const s = cw.policy.get();
    expect(s.layer.pace).toEqual({ slowModeMs: 2000 });
    expect(s.layer.customDuration).toBe(false);
    expect(s.effective.pace.slowModeMs).toBe(2000);
    expect(s.effective.ladder).toEqual(PRESETS.strict.ladder);
  });

  it('creator appends the note to existing notes and does not duplicate it on a second apply', async () => {
    const { cw } = await kit();
    cw.policy.save({ teamNotes: [{ text: 'an existing note', rule: 2 }] }, { version: 0, ...BY });
    expect(cw.policy.applyRecommendation('creator', ctxOf(cw))).toMatchObject({ ok: true, version: 2 });
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'an existing note', rule: 2 }, { text: CREATOR_TEAM_NOTE }]);
    expect(cw.policy.applyRecommendation('creator', ctxOf(cw))).toMatchObject({ ok: true, version: 3 });
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'an existing note', rule: 2 }, { text: CREATOR_TEAM_NOTE }]);
  });

  it('creator on a fresh kit stores just the note', async () => {
    const { cw } = await kit();
    cw.policy.applyRecommendation('creator', ctxOf(cw));
    expect(cw.policy.get().layer.teamNotes).toEqual([{ text: CREATOR_TEAM_NOTE }]);
  });

  it('kids, social and competitive leave an existing teamNotes untouched (and add none when there were none)', async () => {
    for (const game of ['kids', 'social', 'competitive'] as const) {
      const { cw } = await kit();
      cw.policy.save({ teamNotes: [{ text: 'keep me' }] }, { version: 0, ...BY });
      cw.policy.applyRecommendation(game, ctxOf(cw));
      expect(cw.policy.get().layer.teamNotes, game).toEqual([{ text: 'keep me' }]);
      const fresh = await kit();
      fresh.cw.policy.applyRecommendation(game, ctxOf(fresh.cw));
      expect(Object.hasOwn(fresh.cw.policy.get().layer, 'teamNotes'), game).toBe(false);
    }
  });

  it('creator over a full list of 30 notes is refused as an invalid layer and writes nothing', async () => {
    const store = new MemoryStore();
    const { cw } = await kit({}, store);
    cw.policy.save({ teamNotes: Array.from({ length: 30 }, (_, i) => ({ text: `note ${i}` })) }, { version: 0, ...BY });
    expect(cw.policy.applyRecommendation('creator', ctxOf(cw))).toEqual({ ok: false, error: 'invalid', path: 'layer.teamNotes' });
    expect(store.loadPolicyLayer()?.version).toBe(1);
  });

  it('starts from the latest stored layer, so another process\'s edit is not lost', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await kit({}, store);
    const other = await kit({}, store, clock);
    other.cw.policy.save({ pace: { slowModeMs: 3000 } }, { version: 0, ...BY });
    // this kit has not looked yet (inside the refresh interval); apply looks at the store first
    expect(cw.policy.applyRecommendation('kids', { version: 1, ...BY })).toMatchObject({ ok: true, version: 2 });
    expect(cw.policy.get().layer.pace).toEqual({ slowModeMs: 3000 });
  });

  it('apply over a store without settings support is unsupported', async () => {
    const { cw } = await kit({}, without(new MemoryStore(), 'loadPolicyLayer', 'savePolicyLayer'));
    expect(cw.policy.applyRecommendation('kids', { version: 0, ...BY })).toEqual({ ok: false, error: 'unsupported' });
  });

  it('a store failure while looking at the store throws, as reset does', async () => {
    const mem = new MemoryStore();
    const { cw } = await kit({}, mem);
    vi.spyOn(mem, 'loadPolicyLayer').mockImplementation(() => {
      throw new Error('disk gone');
    });
    expect(() => cw.policy.applyRecommendation('kids', { version: 0, ...BY })).toThrow('disk gone');
  });
});
