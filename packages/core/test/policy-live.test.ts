import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import { outcomeLabel, suggest } from '../src/ladder.js';
import type { ActionRecord } from '../src/ladder.js';
import { PRESETS, type PolicyLayer, type ModerationProfile } from '../src/profile.js';
import type { Logger, RawWho, Store } from '../src/types.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SEC = 1000;
const REFRESH = 10 * SEC;
const WHO: RawWho = { clientKey: 'key-alice', ip: '198.51.100.1' };
const BY = { actor: 'owner_ann', reason: 'tuning the ladder' };

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

function makeClock() {
  const clock = { t: NOW, now: () => clock.t };
  return clock;
}

async function setup(over: Partial<ChatwardenOptions> = {}, store: Store = new MemoryStore(), clock = makeClock()) {
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const cw = await createChatwarden({
    store,
    secret: 'policy-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
    ...over,
  });
  return { cw, store, clock, logged };
}

/** The store with the two optional policy methods taken away, as a custom store without them would be. */
function withoutPolicy(store: MemoryStore): Store {
  return new Proxy(store, {
    get(target, key) {
      if (key === 'loadPolicyLayer' || key === 'savePolicyLayer') return undefined;
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Store;
}

const save = (cw: Awaited<ReturnType<typeof setup>>['cw'], layer: PolicyLayer, version: number) => cw.policy.save(layer, { version, ...BY });

const person = (cw: Awaited<ReturnType<typeof setup>>['cw']): string => {
  cw.rooms.seat('room', 'a', WHO, 'Alice');
  return cw.rooms.subjectAt('room', 'a') as string;
};

describe('cw.policy.get and cw.profile', () => {
  it('start with no layer: version 0, effective is the base, and cw.profile is the effective profile', async () => {
    const { cw } = await setup({ profile: 'relaxed' });
    const state = cw.policy.get();
    expect(state.version).toBe(0);
    expect(state.layer).toEqual({});
    expect(state.effective).toEqual(PRESETS.relaxed);
    expect(state.base).toEqual(PRESETS.relaxed);
    expect(state.canSave).toBe(true);
    expect(state.layerError).toBeUndefined();
    expect(cw.profile).toEqual(PRESETS.relaxed);
  });

  it('base includes the code overrides and excludes the layer', async () => {
    const { cw } = await setup({ overrides: { repeat: { notes: 4 } } });
    save(cw, { durations: [HOUR, DAY] }, 0);
    const state = cw.policy.get();
    expect(state.base.repeat.notes).toBe(4);
    expect(state.base.durations).toEqual(PRESETS.standard.durations);
    expect(state.effective.durations).toEqual([HOUR, DAY]);
    expect(state.effective.repeat.notes).toBe(4);
  });

  it('cw.profile is deep-frozen, stable between saves, and a new object after one', async () => {
    const { cw } = await setup();
    const first = cw.profile;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.ladder[2]?.high)).toBe(true);
    expect(Object.isFrozen(cw.policy.get().layer)).toBe(true);
    expect(cw.profile).toBe(first);
    expect(save(cw, { customDuration: false }, 0)).toMatchObject({ ok: true });
    expect(cw.profile).not.toBe(first);
    expect(cw.profile.customDuration).toBe(false);
    expect(first.customDuration).toBe(true);
  });

  it('is still a ModerationProfile value for code that copies or spreads the facade', async () => {
    const { cw } = await setup();
    save(cw, { durations: [HOUR] }, 0);
    const copy = { ...cw };
    expect(copy.profile.durations).toEqual([HOUR]);
    expect(JSON.parse(JSON.stringify(cw.profile)).durations).toEqual([HOUR]);
  });
});

describe('cw.policy.save', () => {
  it('stores the layer, answers the new version and the sections that changed, and applies at once', async () => {
    const { cw, store } = await setup();
    const res = save(cw, { durations: [HOUR, 6 * HOUR], repeat: { notes: 3 } }, 0);
    expect(res).toEqual({ ok: true, version: 1, changed: ['durations', 'repeat'] });
    expect(store.loadPolicyLayer?.()).toEqual({ layer: { durations: [HOUR, 6 * HOUR], repeat: { notes: 3 } }, version: 1 });
    expect(cw.policy.get().version).toBe(1);
    expect(cw.profile.durations).toEqual([HOUR, 6 * HOUR]);
  });

  it('versions climb by one per save; a save replaces the whole layer (a section left out is reset)', async () => {
    const { cw } = await setup();
    expect(save(cw, { durations: [HOUR] }, 0)).toMatchObject({ version: 1 });
    expect(save(cw, { customDuration: false }, 1)).toMatchObject({ version: 2, changed: ['durations', 'customDuration'] });
    expect(cw.policy.get().layer).toEqual({ customDuration: false });
    expect(cw.profile.durations).toEqual(PRESETS.standard.durations);
  });

  it('a stale version is a conflict, writes nothing, and leaves the live profile on the stored layer', async () => {
    const { cw, store } = await setup();
    save(cw, { durations: [HOUR] }, 0);
    const lost = save(cw, { durations: [2 * HOUR] }, 0);
    expect(lost).toEqual({ ok: false, error: 'conflict' });
    expect(store.loadPolicyLayer?.()).toEqual({ layer: { durations: [HOUR] }, version: 1 });
    expect(cw.profile.durations).toEqual([HOUR]);
    // A version from the future conflicts too.
    expect(save(cw, { durations: [3 * HOUR] }, 7)).toEqual({ ok: false, error: 'conflict' });
  });

  it('refuses an invalid layer as invalid with the layer path, and writes nothing', async () => {
    const { cw, store } = await setup();
    const write = vi.spyOn(store as MemoryStore, 'savePolicyLayer');
    expect(save(cw, { profanity: { mode: 'allow' } } as unknown as PolicyLayer, 0)).toEqual({ ok: false, error: 'invalid', path: 'layer.profanity' });
    expect(save(cw, { durations: [DAY, HOUR] }, 0)).toEqual({ ok: false, error: 'invalid', path: 'layer.durations' });
    expect(save(cw, { repeat: { outcome: 'none' } }, 0)).toEqual({ ok: false, error: 'invalid', path: 'layer.repeat.outcome' });
    expect(write).not.toHaveBeenCalled();
    expect(cw.policy.get().version).toBe(0);
  });

  it('a bad version, actor or reason is invalid with that field as the path', async () => {
    const { cw } = await setup();
    const call = (version: unknown, actor: unknown, reason: unknown) =>
      cw.policy.save({}, { version, actor, reason } as unknown as Parameters<typeof cw.policy.save>[1]);
    expect(call(-1, 'ann', 'why')).toEqual({ ok: false, error: 'invalid', path: 'version' });
    expect(call(1.5, 'ann', 'why')).toEqual({ ok: false, error: 'invalid', path: 'version' });
    expect(call('0', 'ann', 'why')).toEqual({ ok: false, error: 'invalid', path: 'version' });
    expect(call(0, 'has space', 'why')).toEqual({ ok: false, error: 'invalid', path: 'actor' });
    expect(call(0, '', 'why')).toEqual({ ok: false, error: 'invalid', path: 'actor' });
    expect(call(0, 'ann', '')).toEqual({ ok: false, error: 'invalid', path: 'reason' });
    expect(call(0, 'ann', '   ')).toEqual({ ok: false, error: 'invalid', path: 'reason' });
    expect(call(0, 'ann', 'x'.repeat(2001))).toEqual({ ok: false, error: 'invalid', path: 'reason' });
    expect(call(0, 'ann', 'x'.repeat(2000))).toMatchObject({ ok: true });
  });

  it('two writers on the same store with the same version: exactly one wins', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store);
    const ra = save(a.cw, { durations: [HOUR] }, 0);
    const rb = save(b.cw, { durations: [2 * HOUR] }, 0);
    expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
    expect(store.loadPolicyLayer()?.version).toBe(1);
  });

  it('an empty layer saves too (nothing changed, version moves)', async () => {
    const { cw } = await setup();
    expect(save(cw, {}, 0)).toEqual({ ok: true, version: 1, changed: [] });
  });
});

describe('every consumer reads the effective profile at call time', () => {
  it('cw.suggest: a first-offense edit changes the very next suggestion', async () => {
    const { cw } = await setup();
    const p = person(cw);
    expect(cw.suggest(p, 'rude', 'uncovered').label).toBe('Warning');
    save(cw, { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } } }, 0);
    const s = cw.suggest(p, 'rude', 'uncovered');
    expect(s.label).toBe('Restrict chat 6 hours');
    expect(s.outcome).toEqual({ kind: 'chat', durationMs: 6 * HOUR });
  });

  it('cw.suggest: a ladder cell edit changes the suggestion for a person with a record', async () => {
    const { cw } = await setup();
    const p = person(cw);
    await cw.sanctions.apply({ kind: 'warning', subject: p, includeIp: false, durationMs: null, reason: 'r', actor: 'ann', source: 'moderator', automated: false, rule: 2 });
    expect(cw.suggest(p, 'rude', 2).label).toBe('Restrict chat 24 hours');
    const ladder = JSON.parse(JSON.stringify(cw.profile.ladder)) as Array<{ lowMedium: Record<string, unknown> }>;
    ladder[1]!.lowMedium = { kind: 'chat', durationMs: 6 * HOUR };
    save(cw, { ladder: ladder as unknown as PolicyLayer['ladder'] }, 0);
    expect(cw.suggest(p, 'rude', 2).label).toBe('Restrict chat 6 hours');
  });

  it('cw.suggest: areaRules and severeRules edits apply at once', async () => {
    const { cw } = await setup();
    const p = person(cw);
    expect(cw.suggest(p, 'hostile', 9).outcome).toEqual({ kind: 'chat', durationMs: DAY });
    save(cw, { areaRules: [9] }, 0);
    expect(cw.suggest(p, 'hostile', 9).outcome).toEqual({ kind: 'area', durationMs: DAY });
    save(cw, { areaRules: [9], severeRules: [9] }, 1);
    expect(cw.suggest(p, 'hostile', 9).outcome).toEqual({ kind: 'area', durationMs: 7 * DAY });
  });

  it('cw.suggest: the repeat rule edit applies at once', async () => {
    const { cw } = await setup();
    const p = person(cw);
    const note = () => cw.sanctions.apply({ kind: 'note', subject: p, includeIp: false, durationMs: null, reason: 'n', actor: 'ann', source: 'moderator', automated: false, rule: 2 });
    await note();
    // One earlier note plus this one is 2 notes: the standard repeat rule is met, and it escalates the warning to chat 24 hours.
    expect(cw.suggest(p, 'rude', 2).label).toBe('Restrict chat 24 hours');
    save(cw, { repeat: { notes: 5 } }, 0);
    const after = cw.suggest(p, 'rude', 2);
    expect(after.label).toBe('Warning');
    expect(after.why).toContain('do not yet add up');
  });

  it('cw.documents: the moderator guide, the code of conduct, the agent brief and policyJson all follow a save', async () => {
    const { cw } = await setup();
    const before = {
      guide: cw.documents.moderatorGuide({ format: 'markdown' }),
      conduct: cw.documents.codeOfConduct({ format: 'text', gameName: 'Quissel Quest' }),
      brief: cw.documents.agentBrief(),
    };
    const ladder = JSON.parse(JSON.stringify(cw.profile.ladder)) as Array<{ lowMedium: Record<string, unknown>; high: Record<string, unknown> }>;
    ladder[1]!.lowMedium = { kind: 'chat', durationMs: 6 * HOUR };
    save(
      cw,
      {
        ladder: ladder as unknown as PolicyLayer['ladder'],
        firstOffense: { rude: { kind: 'area', durationMs: 12 * HOUR } },
        guidelines: [null, { outcome: 'A short ban from public rooms.' }],
        durations: [HOUR, 12 * HOUR],
      },
      0,
    );
    const guide = cw.documents.moderatorGuide({ format: 'markdown' });
    expect(guide).not.toBe(before.guide);
    expect(guide).toContain('Restrict chat 6 hours');
    expect(guide).toContain('Ban from public rooms 12 hours');
    expect(guide).toContain('A short ban from public rooms.');
    expect(cw.documents.moderatorGuide({ format: 'markdown', omitSections: ['rules'] })).toContain('Restrict chat 6 hours');
    const conduct = cw.documents.codeOfConduct({ format: 'text', gameName: 'Quissel Quest' });
    expect(conduct).not.toBe(before.conduct);
    expect(conduct).toContain('12 hours');
    const brief = cw.documents.agentBrief();
    expect(brief).not.toBe(before.brief);
    expect(brief).toContain('Restrict chat 6 hours');
    expect(brief).toContain('A short ban from public rooms.');
    const json = cw.documents.policyJson().profile;
    expect(json.durations).toEqual([HOUR, 12 * HOUR]);
    expect(json.ladder[1]?.lowMedium.label).toBe('Restrict chat 6 hours');
  });

  it('cw.summary follows the effective profile', async () => {
    const { cw } = await setup();
    save(cw, { durations: [HOUR] }, 0);
    expect(cw.summary).toBe(cw.profile.summary);
    expect(cw.summary).toBe(PRESETS.standard.summary);
  });
});

describe('cw.policy.preview', () => {
  const SAMPLES = ['clean', 'oneWarning', 'chat24h', 'ban7d'] as const;
  const LEVELS = ['banter', 'rude', 'hostile', 'severe'] as const;

  it('answers the four samples for the four levels, each with a label, a kind and a duration', async () => {
    const { cw } = await setup();
    const res = cw.policy.preview({});
    if (!res.ok) throw new Error('expected ok');
    expect(Object.keys(res.samples)).toEqual([...SAMPLES]);
    for (const s of SAMPLES) {
      expect(Object.keys(res.samples[s])).toEqual([...LEVELS]);
      for (const l of LEVELS) {
        const cell = res.samples[s][l];
        expect(Object.keys(cell).sort()).toEqual(['durationMs', 'kind', 'label']);
        expect(typeof cell.label).toBe('string');
      }
    }
    expect(res.samples.clean.banter).toEqual({ label: 'No action', kind: 'none', durationMs: null });
    expect(res.samples.clean.rude).toEqual({ label: 'Warning', kind: 'warning', durationMs: null });
    expect(res.samples.clean.hostile).toEqual({ label: 'Restrict chat 24 hours', kind: 'chat', durationMs: DAY });
    expect(res.samples.ban7d.hostile).toEqual({ label: 'Full ban permanent', kind: 'ban', durationMs: null });
  });

  it('matches suggest() over the same records, under the candidate profile', async () => {
    const { cw, clock } = await setup();
    const layer: PolicyLayer = { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } }, repeat: { notes: 2, outcome: 'warning' } };
    const res = cw.policy.preview(layer);
    if (!res.ok) throw new Error('expected ok');
    const candidate = (await setup({ overrides: layer as never })).cw.profile as ModerationProfile;
    const records: Record<(typeof SAMPLES)[number], ActionRecord[]> = {
      clean: [],
      oneWarning: [{ kind: 'warning', durationMs: null, startsAt: clock.t - DAY, revoked: false, automated: false, roomId: null }],
      chat24h: [{ kind: 'chat', durationMs: DAY, startsAt: clock.t - HOUR, revoked: false, automated: false, roomId: null }],
      ban7d: [{ kind: 'ban', durationMs: 7 * DAY, startsAt: clock.t - HOUR, revoked: false, automated: false, roomId: null }],
    };
    for (const s of SAMPLES) {
      for (const l of LEVELS) {
        const want = suggest(candidate, records[s], l, 'uncovered', clock.t);
        const got = res.samples[s][l];
        expect(got.label, `${s}/${l}`).toBe(want.label);
        expect(got.kind, `${s}/${l}`).toBe(typeof want.outcome === 'string' ? want.outcome : want.outcome.kind);
        expect(got.durationMs, `${s}/${l}`).toBe(typeof want.outcome === 'string' ? null : want.outcome.durationMs);
      }
    }
    expect(res.samples.clean.rude.label).toBe('Restrict chat 6 hours');
  });

  it('is pure: nothing is written, the version and the live profile do not move, and it never reads the store', async () => {
    const { cw, store } = await setup();
    const write = vi.spyOn(store as MemoryStore, 'savePolicyLayer');
    const before = cw.policy.get();
    cw.policy.preview({ durations: [HOUR], firstOffense: { hostile: 'warning' } });
    expect(write).not.toHaveBeenCalled();
    expect(cw.policy.get()).toEqual(before);
    expect(cw.profile).toBe(before.effective);
  });

  it('an edit to a rule list shows with the rule parameter (default is no rule)', async () => {
    const { cw } = await setup();
    const withRule = cw.policy.preview({ areaRules: [7] }, 7);
    if (!withRule.ok) throw new Error('expected ok');
    expect(withRule.samples.clean.hostile.kind).toBe('area');
    const noRule = cw.policy.preview({ areaRules: [7] });
    if (!noRule.ok) throw new Error('expected ok');
    expect(noRule.samples.clean.hostile.kind).toBe('chat');
  });

  it('an invalid candidate is invalid with the layer path, not a throw', async () => {
    const { cw } = await setup();
    expect(cw.policy.preview({ profanity: {} } as unknown as PolicyLayer)).toEqual({ ok: false, error: 'invalid', path: 'layer.profanity' });
    expect(cw.policy.preview({ durations: [2, 1] })).toEqual({ ok: false, error: 'invalid', path: 'layer.durations' });
  });

  it('describes the candidate layer over the base, as a save would store it, not on top of the saved layer', async () => {
    const { cw } = await setup();
    save(cw, { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } } }, 0);
    const empty = cw.policy.preview({});
    if (!empty.ok) throw new Error('expected ok');
    expect(empty.samples.clean.rude.label).toBe('Warning');
    const same = cw.policy.preview(cw.policy.get().layer);
    if (!same.ok) throw new Error('expected ok');
    expect(same.samples.clean.rude.label).toBe('Restrict chat 6 hours');
  });

  it('works on a store that cannot save', async () => {
    const { cw } = await setup({}, withoutPolicy(new MemoryStore()));
    expect(cw.policy.preview({ durations: [HOUR] }).ok).toBe(true);
  });

  it('labels agree with outcomeLabel', async () => {
    const { cw } = await setup();
    const res = cw.policy.preview({});
    if (!res.ok) throw new Error('expected ok');
    expect(res.samples.chat24h.rude.label).toBe(outcomeLabel({ kind: 'chat', durationMs: 7 * DAY }));
  });
});

describe('cw.policy.reset', () => {
  const FULL: PolicyLayer = { durations: [HOUR, 6 * HOUR], customDuration: false, repeat: { notes: 3 }, areaRules: [3] };

  it('one section: that section goes back to the base, the others stay, the version moves', async () => {
    const { cw } = await setup();
    save(cw, FULL, 0);
    const res = cw.policy.reset('durations');
    expect(res).toEqual({ ok: true, version: 2, changed: ['durations'] });
    expect(cw.policy.get().layer).toEqual({ customDuration: false, repeat: { notes: 3 }, areaRules: [3] });
    expect(cw.profile.durations).toEqual(PRESETS.standard.durations);
    expect(cw.profile.customDuration).toBe(false);
    expect(cw.profile.repeat.notes).toBe(3);
  });

  it('every section can be reset on its own', async () => {
    const { cw } = await setup();
    const layer: PolicyLayer = {
      durations: [HOUR],
      customDuration: false,
      ladder: JSON.parse(JSON.stringify(PRESETS.standard.ladder)) as PolicyLayer['ladder'],
      firstOffense: { rude: 'note' },
      repeat: { notes: 3 },
      areaRules: [3],
      severeRules: [2],
      guidelines: [{ outcome: 'Changed.' }],
    };
    expect(save(cw, layer, 0)).toMatchObject({ ok: true, version: 1 });
    let expected = 1;
    for (const section of Object.keys(layer)) {
      expected += 1;
      const res = cw.policy.reset(section as never);
      expect(res, section).toEqual({ ok: true, version: expected, changed: [section] });
      expect(Object.keys(cw.policy.get().layer)).not.toContain(section);
    }
    expect(cw.policy.get().layer).toEqual({});
    expect(cw.profile).toEqual(PRESETS.standard);
  });

  it('everything: an empty layer is stored, so other processes see the reset', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    save(a.cw, FULL, 0);
    a.clock.t += REFRESH;
    expect(b.cw.profile.customDuration).toBe(false);
    const res = a.cw.policy.reset();
    expect(res).toEqual({ ok: true, version: 2, changed: ['durations', 'customDuration', 'repeat', 'areaRules'] });
    expect(store.loadPolicyLayer()).toEqual({ layer: {}, version: 2 });
    a.clock.t += REFRESH;
    expect(b.cw.profile).toEqual(PRESETS.standard);
  });

  it('a section that is not in the layer is a no-op: no write, no version bump', async () => {
    const { cw, store } = await setup();
    save(cw, { durations: [HOUR] }, 0);
    const write = vi.spyOn(store as MemoryStore, 'savePolicyLayer');
    expect(cw.policy.reset('ladder')).toEqual({ ok: true, version: 1, changed: [] });
    expect(write).not.toHaveBeenCalled();
    const fresh = await setup();
    expect(fresh.cw.policy.reset()).toEqual({ ok: true, version: 0, changed: [] });
  });

  it('an unknown section is invalid with the path section', async () => {
    const { cw } = await setup();
    for (const s of ['profanity', 'nope', '']) expect(cw.policy.reset(s as never)).toEqual({ ok: false, error: 'invalid', path: 'section' });
  });

  it('works from the latest stored version, even when this process has not looked yet', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    save(a.cw, { durations: [HOUR] }, 0);
    // b has not refreshed (no 10 s passed), but reset reads the store first.
    expect(b.cw.policy.reset('durations')).toEqual({ ok: true, version: 2, changed: ['durations'] });
  });

  it('with an explicit version that is stale it is a conflict', async () => {
    const { cw } = await setup();
    save(cw, { durations: [HOUR] }, 0);
    expect(cw.policy.reset('durations', { version: 0 })).toEqual({ ok: false, error: 'conflict' });
    expect(cw.profile.durations).toEqual([HOUR]);
  });
});

describe('a store that cannot save', () => {
  it('save and reset answer unsupported; get, preview and profile still work from code', async () => {
    const { cw } = await setup({ overrides: { repeat: { notes: 4 } } }, withoutPolicy(new MemoryStore()));
    expect(save(cw, { durations: [HOUR] }, 0)).toEqual({ ok: false, error: 'unsupported' });
    expect(cw.policy.reset()).toEqual({ ok: false, error: 'unsupported' });
    expect(cw.policy.reset('durations')).toEqual({ ok: false, error: 'unsupported' });
    const state = cw.policy.get();
    expect(state.canSave).toBe(false);
    expect(state.version).toBe(0);
    expect(state.layer).toEqual({});
    expect(state.effective.repeat.notes).toBe(4);
    expect(cw.profile.repeat.notes).toBe(4);
    expect(() => cw.policy.refresh()).not.toThrow();
  });

  it('only one of the two methods is not enough to save', async () => {
    const store = new MemoryStore();
    const half = new Proxy(store, {
      get(target, key) {
        if (key === 'savePolicyLayer') return undefined;
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Store;
    const { cw } = await setup({}, half);
    expect(cw.policy.get().canSave).toBe(false);
    expect(save(cw, {}, 0)).toEqual({ ok: false, error: 'unsupported' });
  });

  it('an unsupported save is checked before the layer: it never says invalid', async () => {
    const { cw } = await setup({}, withoutPolicy(new MemoryStore()));
    expect(save(cw, { profanity: {} } as unknown as PolicyLayer, 0)).toEqual({ ok: false, error: 'unsupported' });
  });
});

describe('another process on the same store (the 10 second refresh)', () => {
  it('sees a change after 10 seconds, not before', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    save(a.cw, { customDuration: false }, 0);
    a.clock.t += REFRESH - 1;
    expect(b.cw.profile.customDuration).toBe(true);
    a.clock.t += 1;
    expect(b.cw.profile.customDuration).toBe(false);
    expect(b.cw.policy.get().version).toBe(1);
  });

  it('checks the store at most once every 10 seconds, however often it is read', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await setup({}, store);
    const load = vi.spyOn(store, 'loadPolicyLayer');
    for (let i = 0; i < 50; i += 1) void cw.profile;
    expect(load).toHaveBeenCalledTimes(0); // the startup read counts as the last check
    clock.t += REFRESH;
    for (let i = 0; i < 50; i += 1) {
      void cw.profile;
      void cw.policy.get();
      cw.suggest(person(cw), 'rude', 'uncovered');
      cw.documents.agentBrief();
    }
    expect(load).toHaveBeenCalledTimes(1);
    clock.t += REFRESH - 1;
    void cw.profile;
    expect(load).toHaveBeenCalledTimes(1);
    clock.t += 1;
    void cw.profile;
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('every consumer in the other process sees the change after the interval', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    const p = person(b.cw);
    save(a.cw, { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } } }, 0);
    expect(b.cw.suggest(p, 'rude', 'uncovered').label).toBe('Warning');
    a.clock.t += REFRESH;
    expect(b.cw.suggest(p, 'rude', 'uncovered').label).toBe('Restrict chat 6 hours');
    expect(b.cw.documents.agentBrief()).toBe(a.cw.documents.agentBrief());
    expect(b.cw.documents.moderatorGuide({ format: 'markdown' })).toContain('Restrict chat 6 hours');
  });

  it('refresh() looks now, whatever the interval', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    save(a.cw, { durations: [HOUR] }, 0);
    expect(b.cw.profile.durations).toEqual(PRESETS.standard.durations);
    b.cw.policy.refresh();
    expect(b.cw.profile.durations).toEqual([HOUR]);
  });

  it('a change made before this process started is loaded at startup', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    save(a.cw, { durations: [HOUR, DAY] }, 0);
    const b = await setup({}, store, a.clock);
    expect(b.cw.profile.durations).toEqual([HOUR, DAY]);
    expect(b.cw.policy.get().version).toBe(1);
  });

  it('a save from a process that has not refreshed is a conflict, and it then sees the stored layer', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    save(a.cw, { durations: [HOUR] }, 0);
    expect(save(b.cw, { durations: [2 * HOUR] }, 0)).toEqual({ ok: false, error: 'conflict' });
    expect(b.cw.profile.durations).toEqual([HOUR]);
    expect(save(b.cw, { durations: [2 * HOUR] }, 1)).toMatchObject({ ok: true, version: 2 });
  });

  it('a clock that goes backwards checks again rather than waiting', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    a.clock.t += 5 * REFRESH;
    void b.cw.profile;
    save(a.cw, { durations: [HOUR] }, 0);
    a.clock.t -= 3 * REFRESH;
    expect(b.cw.profile.durations).toEqual([HOUR]);
  });

  it('a store that fails on a refresh keeps the last good profile, logs the class only, and recovers', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    save(a.cw, { durations: [HOUR] }, 0);
    let fail = true;
    const real = store.loadPolicyLayer.bind(store);
    vi.spyOn(store, 'loadPolicyLayer').mockImplementation(() => {
      if (fail) throw new TypeError('disk on fire: secret detail');
      return real();
    });
    a.clock.t += REFRESH;
    expect(a.cw.profile.durations).toEqual([HOUR]);
    const failed = a.logged.filter(([e]) => e === 'chatwarden.policy_refresh_failed');
    expect(failed).toEqual([['chatwarden.policy_refresh_failed', { error: 'TypeError' }]]);
    expect(JSON.stringify(a.logged)).not.toContain('secret detail');
    fail = false;
    a.clock.t += REFRESH;
    expect(a.cw.profile.durations).toEqual([HOUR]);
  });
});

describe('a stored layer this kit cannot use', () => {
  const POISON = { profanity: { mode: 'allow' } } as unknown as PolicyLayer;

  it('is ignored with the base kept, logged once, and reported in get() as layerError', async () => {
    const store = new MemoryStore();
    const { cw, clock, logged } = await setup({}, store);
    expect(store.savePolicyLayer(POISON, 0)).toBe(1);
    clock.t += REFRESH;
    expect(cw.profile).toEqual(PRESETS.standard);
    const state = cw.policy.get();
    expect(state.layerError).toEqual({ path: 'layer.profanity', kind: 'invalid' });
    expect(state.version).toBe(1);
    expect(state.layer).toEqual(POISON);
    expect(state.effective).toEqual(PRESETS.standard);
    for (let i = 0; i < 5; i += 1) {
      clock.t += REFRESH;
      void cw.profile;
      cw.policy.refresh();
    }
    expect(logged.filter(([e]) => e === 'chatwarden.policy_layer_invalid')).toEqual([['chatwarden.policy_layer_invalid', { version: 1, path: 'layer.profanity' }]]);
  });

  it('is handled at startup too: creation does not throw, and the base is in force', async () => {
    const store = new MemoryStore();
    store.savePolicyLayer({ durations: [3, 2] }, 0);
    const { cw, logged } = await setup({}, store);
    expect(cw.profile).toEqual(PRESETS.standard);
    expect(cw.policy.get().layerError).toEqual({ path: 'layer.durations', kind: 'invalid' });
    expect(logged.filter(([e]) => e === 'chatwarden.policy_layer_invalid')).toHaveLength(1);
  });

  it('a field from a newer kit is the same case', async () => {
    const store = new MemoryStore();
    store.savePolicyLayer({ slowMode: { seconds: 5 } } as unknown as PolicyLayer, 0);
    const { cw } = await setup({}, store);
    expect(cw.policy.get().layerError).toEqual({ path: 'layer.slowMode', kind: 'invalid' });
  });

  it('a saved fix clears the error, here and in the other process', async () => {
    const store = new MemoryStore();
    const a = await setup({}, store);
    const b = await setup({}, store, a.clock);
    store.savePolicyLayer(POISON, 0);
    a.clock.t += REFRESH;
    expect(a.cw.policy.get().layerError).toBeDefined();
    expect(save(a.cw, { durations: [HOUR] }, 1)).toMatchObject({ ok: true, version: 2 });
    expect(a.cw.policy.get().layerError).toBeUndefined();
    expect(a.cw.profile.durations).toEqual([HOUR]);
    a.clock.t += REFRESH;
    expect(b.cw.policy.get().layerError).toBeUndefined();
    expect(b.cw.profile.durations).toEqual([HOUR]);
  });

  it('a reset also clears it', async () => {
    const store = new MemoryStore();
    store.savePolicyLayer(POISON, 0);
    const { cw } = await setup({}, store);
    expect(cw.policy.reset()).toMatchObject({ ok: true, version: 2 });
    expect(cw.policy.get().layerError).toBeUndefined();
  });

  it('a stored layer that is not even an object is ignored the same way', async () => {
    const store = new MemoryStore();
    store.savePolicyLayer('nope' as unknown as PolicyLayer, 0);
    const { cw } = await setup({}, store);
    expect(cw.policy.get().layerError).toEqual({ path: 'layer', kind: 'unreadable' });
    expect(cw.profile).toEqual(PRESETS.standard);
  });
});

describe('a save that meets another process holding the database lock', () => {
  const busy = () => Object.assign(new Error('database is locked'), { errcode: 5 });

  it('is tried again, up to 3 times in all, and then succeeds', async () => {
    const store = new MemoryStore();
    const { cw } = await setup({}, store);
    const real = store.savePolicyLayer.bind(store);
    let calls = 0;
    vi.spyOn(store, 'savePolicyLayer').mockImplementation((layer, v) => {
      calls += 1;
      if (calls < 3) throw busy();
      return real(layer, v);
    });
    expect(save(cw, { durations: [HOUR] }, 0)).toMatchObject({ ok: true, version: 1 });
    expect(calls).toBe(3);
  });

  it('gives up after 3 tries with the store error, writing nothing', async () => {
    const store = new MemoryStore();
    const { cw } = await setup({}, store);
    let calls = 0;
    vi.spyOn(store, 'savePolicyLayer').mockImplementation(() => {
      calls += 1;
      throw busy();
    });
    expect(() => save(cw, { durations: [HOUR] }, 0)).toThrow('database is locked');
    expect(calls).toBe(3);
    expect(cw.policy.get().version).toBe(0);
  });

  it('does not retry another error, and does not retry a version conflict', async () => {
    const store = new MemoryStore();
    const { cw } = await setup({}, store);
    let calls = 0;
    const spy = vi.spyOn(store, 'savePolicyLayer').mockImplementation(() => {
      calls += 1;
      throw new TypeError('disk full');
    });
    expect(() => save(cw, {}, 0)).toThrow('disk full');
    expect(calls).toBe(1);
    spy.mockImplementation(() => {
      calls += 1;
      return null;
    });
    calls = 0;
    expect(save(cw, {}, 0)).toEqual({ ok: false, error: 'conflict' });
    expect(calls).toBe(1);
  });
});

describe('what the layer cannot reach', () => {
  it('profanity stays code-only: the chat filter mode is the one given in code, whatever is stored', async () => {
    const { cw } = await setup({ overrides: { profanity: { mode: 'allow' } } });
    expect(save(cw, { durations: [HOUR] }, 0)).toMatchObject({ ok: true });
    expect(cw.profile.profanity.mode).toBe('allow');
  });
});

describe('cw.profile and cw.summary are getters (a captured copy would be a bug)', () => {
  it('are accessor properties on the facade, not data properties', async () => {
    const { cw } = await setup();
    for (const key of ['profile', 'summary'] as const) {
      const d = Object.getOwnPropertyDescriptor(cw, key);
      expect(typeof d?.get, key).toBe('function');
      expect(d?.value, key).toBeUndefined();
    }
  });
});

describe('refresh only moves forward', () => {
  it('a store that reports an older version than the one in force does not regress the profile', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await setup({}, store);
    save(cw, { durations: [HOUR] }, 0);
    save(cw, { durations: [HOUR, 2 * HOUR] }, 1);
    vi.spyOn(store, 'loadPolicyLayer').mockReturnValue({ layer: { durations: [3 * HOUR] }, version: 1 });
    clock.t += REFRESH;
    expect(cw.profile.durations).toEqual([HOUR, 2 * HOUR]);
    expect(cw.policy.get().version).toBe(2);
  });

  it('a store with the layer gone (version back to 0) does not regress it either', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await setup({}, store);
    save(cw, { durations: [HOUR] }, 0);
    vi.spyOn(store, 'loadPolicyLayer').mockReturnValue(null);
    clock.t += REFRESH;
    expect(cw.profile.durations).toEqual([HOUR]);
  });

  it('a strictly newer version is still adopted', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await setup({}, store);
    store.savePolicyLayer({ durations: [HOUR] }, 0);
    clock.t += REFRESH;
    expect(cw.profile.durations).toEqual([HOUR]);
  });
});

describe('a stored layer that is null (a corrupted row)', () => {
  it('is a layerError with the base live and an empty layer to show, never a crash', async () => {
    const store = new MemoryStore();
    store.savePolicyLayer(null as unknown as PolicyLayer, 0);
    const { cw, logged } = await setup({}, store);
    expect(cw.profile).toEqual(PRESETS.standard);
    const state = cw.policy.get();
    expect(state.layerError).toEqual({ path: 'layer', kind: 'unreadable' });
    expect(state.layer).toEqual({});
    expect(state.version).toBe(1);
    expect(logged.filter(([e]) => e === 'chatwarden.policy_layer_invalid')).toHaveLength(1);
    expect(save(cw, { durations: [HOUR] }, 1)).toMatchObject({ ok: true, version: 2 });
    expect(cw.policy.get().layerError).toBeUndefined();
  });
});
