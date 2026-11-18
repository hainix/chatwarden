import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import {
  applyPolicyLayer,
  changedSections,
  layerSections,
  MAX_AI_CONTEXT,
  MAX_GUIDELINE_OUTCOME,
  MAX_TIER_DESCRIPTION,
  MAX_TIER_EXAMPLE,
  MAX_TIER_EXAMPLES,
  MAX_TIER_TITLE,
  POLICY_SECTIONS,
  PRESETS,
  ProfileError,
  validateProfile,
} from '../src/profile.js';
import type { GuidelineTier, PolicyLayer } from '../src/profile.js';
import { defineRules, starterRules } from '../src/rules.js';
import type { Logger, RawWho } from '../src/types.js';

const BY = { actor: 'owner_ann', reason: 'writing our principles' };
const NOW = 1_800_000_000_000;

const BASE = PRESETS.relaxed;

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

const bad = (layer: unknown): ProfileError => failure(() => applyPolicyLayer(BASE, layer as PolicyLayer));
const ok = (layer: unknown) => applyPolicyLayer(BASE, layer as PolicyLayer);

const tier = (over: Partial<GuidelineTier> = {}): GuidelineTier => ({
  title: 'Everything',
  description: 'How we read all of it.',
  examples: ['ez'],
  covers: ['banter', 'rude', 'hostile', 'severe', 'repeated', 'after_warning'],
  outcome: 'A human decides.',
  ...over,
});

const six: GuidelineTier[] = [
  tier({ title: 'T1', covers: ['banter'] }),
  tier({ title: 'T2', covers: ['rude'] }),
  tier({ title: 'T3', covers: ['hostile'] }),
  tier({ title: 'T4', covers: ['severe'] }),
  tier({ title: 'T5', covers: ['repeated'] }),
  tier({ title: 'T6', covers: ['after_warning'] }),
];

describe('the whole form of guidelines', () => {
  it('replaces the tiers: 1 tier covering all six, 2 tiers, 6 tiers of one cover each', () => {
    const one = [tier({ covers: ['banter', 'rude', 'hostile', 'severe', 'repeated', 'after_warning'] })];
    const two = [tier({ title: 'Light', covers: ['banter', 'rude'] }), tier({ title: 'Heavy', covers: ['hostile', 'severe', 'repeated', 'after_warning'] })];
    for (const tiers of [one, two, six]) {
      const p = ok({ guidelines: { tiers } });
      expect(p.guidelines).toEqual(tiers);
      expect(p.guidelines).not.toBe(tiers);
      expect({ ...p, guidelines: [] }).toEqual({ ...BASE, guidelines: [] });
      expect(() => validateProfile(p)).not.toThrow();
    }
  });

  it('the result is deep-frozen and shares nothing with the layer', () => {
    const tiers = [tier()];
    const p = ok({ guidelines: { tiers } });
    expect(Object.isFrozen(p.guidelines[0])).toBe(true);
    expect(Object.isFrozen(p.guidelines[0]?.examples)).toBe(true);
    tiers[0]!.title = 'changed';
    expect(p.guidelines[0]?.title).toBe('Everything');
  });

  it('the old positional shape is unchanged', () => {
    const p = ok({ guidelines: [null, { outcome: 'x' }] });
    expect(p.guidelines[1]?.outcome).toBe('x');
    expect(p.guidelines[0]).toEqual(BASE.guidelines[0]);
    expect(p.guidelines).toHaveLength(BASE.guidelines.length);
  });

  it('a 0.2.1 layer fixture still applies', () => {
    const layer = {
      guidelines: [null, { outcome: 'A friendly warning.' }],
      ladder: PRESETS.relaxed.ladder.map((r) => ({ step: r.step, lowMedium: { kind: r.lowMedium.kind, durationMs: r.lowMedium.durationMs }, high: { kind: r.high.kind, durationMs: r.high.durationMs } })),
    };
    const p = ok(layer);
    expect(p.guidelines[1]?.outcome).toBe('A friendly warning.');
    expect(p.ladder).toHaveLength(6);
  });

  describe('the invariants, each with its path', () => {
    it('a cover in two tiers', () => {
      const tiers = [tier({ covers: ['banter', 'rude', 'hostile', 'severe'] }), tier({ title: 'Two', covers: ['repeated', 'banter'] })];
      expect(bad({ guidelines: { tiers } }).path).toBe('layer.guidelines[1].covers[1]');
      const dup = [tier({ covers: ['banter', 'rude', 'hostile', 'severe'] }), tier({ title: 'Two', covers: ['severe'] })];
      expect(bad({ guidelines: { tiers: dup } }).path).toBe('layer.guidelines[1].covers[0]');
    });

    it('empty covers', () => {
      expect(bad({ guidelines: { tiers: [tier(), tier({ covers: [] })] } }).path).toBe('layer.guidelines[1].covers');
      expect(bad({ guidelines: { tiers: [tier({ covers: [] })] } }).path).toBe('layer.guidelines[0].covers');
    });

    it('a conduct level uncovered', () => {
      expect(bad({ guidelines: { tiers: [tier({ covers: ['banter', 'rude', 'hostile'] })] } }).path).toBe('layer.guidelines');
      expect(bad({ guidelines: { tiers: [] } }).path).toBe('layer.guidelines');
    });

    it('an unknown cover value', () => {
      expect(bad({ guidelines: { tiers: [tier({ covers: ['banter', 'nope' as never] })] } }).path).toBe('layer.guidelines[0].covers[1]');
    });

    it('empty title', () => {
      expect(bad({ guidelines: { tiers: [tier({ title: '' })] } }).path).toBe('layer.guidelines[0].title');
      expect(bad({ guidelines: { tiers: [tier({ title: '   ' })] } }).path).toBe('layer.guidelines[0].title');
    });

    it('empty description, a blank example and an empty outcome', () => {
      expect(bad({ guidelines: { tiers: [tier({ description: '' })] } }).path).toBe('layer.guidelines[0].description');
      expect(bad({ guidelines: { tiers: [tier({ examples: ['ok', ' '] })] } }).path).toBe('layer.guidelines[0].examples[1]');
      expect(bad({ guidelines: { tiers: [tier({ outcome: '' })] } }).path).toBe('layer.guidelines[0].outcome');
    });

    it('{ tiers, other: 1 } names the extra key, {} the missing one', () => {
      expect(bad({ guidelines: { tiers: [tier()], other: 1 } }).path).toBe('layer.guidelines.other');
      expect(bad({ guidelines: {} }).path).toBe('layer.guidelines.tiers');
    });

    it('{ tiers: "x" }, null and 7 and a string are refused at layer.guidelines', () => {
      expect(bad({ guidelines: { tiers: 'x' } }).path).toBe('layer.guidelines');
      expect(bad({ guidelines: { tiers: null } }).path).toBe('layer.guidelines');
      expect(bad({ guidelines: null }).path).toBe('layer.guidelines');
      expect(bad({ guidelines: 7 }).path).toBe('layer.guidelines');
      expect(bad({ guidelines: 'x' }).path).toBe('layer.guidelines');
    });

    it('an unknown key on a tier, and a non-object tier', () => {
      expect(bad({ guidelines: { tiers: [{ ...tier(), colour: 'red' }] } }).path).toBe('layer.guidelines[0].colour');
      expect(bad({ guidelines: { tiers: [3] } }).path).toBe('layer.guidelines[0]');
      expect(bad({ guidelines: { tiers: [tier({ title: 7 as never })] } }).path).toBe('layer.guidelines[0].title');
      expect(bad({ guidelines: { tiers: [tier({ examples: 'x' as never })] } }).path).toBe('layer.guidelines[0].examples');
    });
  });

  describe('the caps, at the edge', () => {
    it('exports the caps', () => {
      expect([MAX_TIER_TITLE, MAX_TIER_DESCRIPTION, MAX_TIER_EXAMPLES, MAX_TIER_EXAMPLE, MAX_GUIDELINE_OUTCOME, MAX_AI_CONTEXT]).toEqual([80, 600, 8, 120, 1000, 2000]);
    });

    const edge = (field: string, make: (n: number) => Partial<GuidelineTier>, cap: number, path: string): void => {
      it(`${field}: ${cap} is ok, ${cap + 1} is refused at ${path}`, () => {
        expect(() => ok({ guidelines: { tiers: [tier(make(cap))] } })).not.toThrow();
        const e = bad({ guidelines: { tiers: [tier(make(cap + 1))] } });
        expect(e.path).toBe(path);
        expect(e.reason).toContain(String(cap));
        expect(e.message).not.toContain('xxxx');
      });
    };
    edge('title', (n) => ({ title: 'x'.repeat(n) }), 80, 'layer.guidelines[0].title');
    edge('description', (n) => ({ description: 'x'.repeat(n) }), 600, 'layer.guidelines[0].description');
    edge('examples count', (n) => ({ examples: Array.from({ length: n }, (_, i) => `e${i}`) }), 8, 'layer.guidelines[0].examples');
    edge('example', (n) => ({ examples: ['ok', 'x'.repeat(n)] }), 120, 'layer.guidelines[0].examples[1]');
    edge('outcome', (n) => ({ outcome: 'x'.repeat(n) }), 1000, 'layer.guidelines[0].outcome');

    it('astral characters count once', () => {
      const smile = '\u{1F600}';
      expect(() => ok({ guidelines: { tiers: [tier({ title: smile.repeat(80), description: smile.repeat(600), examples: [smile.repeat(120)], outcome: smile.repeat(1000) })] } })).not.toThrow();
      expect(bad({ guidelines: { tiers: [tier({ title: smile.repeat(81) })] } }).path).toBe('layer.guidelines[0].title');
      expect(bad({ guidelines: { tiers: [tier({ examples: [smile.repeat(121)] })] } }).path).toBe('layer.guidelines[0].examples[0]');
    });

    it('the caps apply to the whole form only: a preset tier longer than a cap stays valid in code', () => {
      expect(() => applyPolicyLayer({ ...BASE, guidelines: [{ ...BASE.guidelines[0]!, title: 'x'.repeat(200) }, ...BASE.guidelines.slice(1)] }, {})).not.toThrow();
    });

    it('aiContext: 2000 is ok, 2001 is refused at layer.aiContext', () => {
      expect(ok({ aiContext: 'x'.repeat(2000) }).aiContext).toHaveLength(2000);
      expect(bad({ aiContext: 'x'.repeat(2001) }).path).toBe('layer.aiContext');
      expect(ok({ aiContext: '\u{1F600}'.repeat(2000) }).aiContext).toHaveLength(4000);
    });
  });
});

describe('aiContext and teamNotes in a layer', () => {
  it('aiContext in a layer replaces the AI standard', () => {
    const p = ok({ aiContext: 'We read banter kindly.' });
    expect(p.aiContext).toBe('We read banter kindly.');
    expect(BASE.aiContext).not.toBe('We read banter kindly.');
    expect(p.summary).toBe(BASE.summary);
  });

  it('empty, whitespace and non-string aiContext are refused at layer.aiContext', () => {
    for (const v of ['', '   ', '\n', 7, null, {}, ['x']]) expect(bad({ aiContext: v }).path).toBe('layer.aiContext');
  });

  it('teamNotes in a layer reach the effective profile', () => {
    const p = ok({ teamNotes: [{ text: 'weigh distinct tables', rule: 2 }, { text: 'second' }] });
    expect(p.teamNotes).toEqual([{ text: 'weigh distinct tables', rule: 2 }, { text: 'second' }]);
    expect(Object.isFrozen(p.teamNotes)).toBe(true);
  });

  it('a bad note is refused at layer.teamNotes[0].text', () => {
    expect(bad({ teamNotes: [{ text: '' }] }).path).toBe('layer.teamNotes[0].text');
    expect(bad({ teamNotes: [{ text: 'x'.repeat(501) }] }).path).toBe('layer.teamNotes[0].text');
    expect(bad({ teamNotes: 'x' }).path).toBe('layer.teamNotes');
  });

  it('profanity, levels and the other code-only keys stay refused', () => {
    for (const key of ['profanity', 'levels', 'aiAutoAct', 'rules', 'id']) expect(bad({ [key]: 1 }).path).toBe(`layer.${key}`);
  });
});

describe('the sections', () => {
  it('POLICY_SECTIONS ends with rooms, teamNotes, aiContext', () => {
    expect([...POLICY_SECTIONS].slice(-3)).toEqual(['rooms', 'teamNotes', 'aiContext']);
  });

  it('layerSections and changedSections see teamNotes, aiContext, and a guidelines change from old shape to whole form', () => {
    expect(layerSections({ aiContext: 'x', teamNotes: [], durations: [1] })).toEqual(['durations', 'teamNotes', 'aiContext']);
    expect(changedSections({}, { teamNotes: [{ text: 'a' }], aiContext: 'x' })).toEqual(['teamNotes', 'aiContext']);
    expect(changedSections({ aiContext: 'x' }, { aiContext: 'x' })).toEqual([]);
    expect(changedSections({ aiContext: 'x' }, { aiContext: 'y' })).toEqual(['aiContext']);
    expect(changedSections({ teamNotes: [{ text: 'a' }] }, { teamNotes: [{ text: 'a', rule: 1 }] })).toEqual(['teamNotes']);
    expect(changedSections({ guidelines: [null, { outcome: 'x' }] }, { guidelines: { tiers: [tier()] } })).toEqual(['guidelines']);
    expect(changedSections({ guidelines: { tiers: [tier()] } }, { guidelines: { tiers: [tier()] } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The live service

type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

async function kit(over: Partial<ChatwardenOptions> = {}, store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const cw = await createChatwarden({
    store,
    secret: 'principles-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
    profile: 'relaxed',
    ...over,
  });
  return { cw, store, clock, logged };
}

const guide = (cw: Awaited<ReturnType<typeof kit>>['cw']): string => cw.documents.moderatorGuide({ format: 'text' });

describe('cw.policy with the whole form, notes and the AI standard', () => {
  it('save of the whole form answers changed [guidelines] and the next moderatorGuide shows the new title', async () => {
    const { cw } = await kit();
    expect(guide(cw)).not.toContain('Our own tier');
    const res = cw.policy.save({ guidelines: { tiers: [tier({ title: 'Our own tier' })] } }, { version: 0, ...BY });
    expect(res).toEqual({ ok: true, version: 1, changed: ['guidelines'] });
    expect(guide(cw)).toContain('Our own tier');
    expect(cw.policy.get().effective.guidelines).toHaveLength(1);
  });

  it("reset('guidelines') drops it and restores the preset", async () => {
    const { cw } = await kit();
    cw.policy.save({ guidelines: { tiers: [tier({ title: 'Our own tier' })] }, teamNotes: [{ text: 'keep me' }] }, { version: 0, ...BY });
    expect(cw.policy.reset('guidelines')).toEqual({ ok: true, version: 2, changed: ['guidelines'] });
    expect(cw.policy.get().effective.guidelines).toEqual(PRESETS.relaxed.guidelines);
    expect(guide(cw)).not.toContain('Our own tier');
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'keep me' }]);
  });

  it("reset('teamNotes') leaves guidelines alone", async () => {
    const { cw } = await kit();
    cw.policy.save({ guidelines: { tiers: [tier({ title: 'Our own tier' })] }, teamNotes: [{ text: 'drop me' }], aiContext: 'Our standard.' }, { version: 0, ...BY });
    expect(cw.policy.reset('teamNotes')).toMatchObject({ ok: true, changed: ['teamNotes'] });
    const s = cw.policy.get();
    expect(s.effective.teamNotes).toEqual([]);
    expect(s.effective.guidelines[0]?.title).toBe('Our own tier');
    expect(s.effective.aiContext).toBe('Our standard.');
    expect(cw.policy.reset('aiContext')).toMatchObject({ ok: true, changed: ['aiContext'] });
    expect(cw.policy.get().effective.aiContext).toBe(PRESETS.relaxed.aiContext);
  });

  it('an old-shape layer written straight into the store with store.savePolicyLayer is read, shown in the guide and reset per section', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await kit({}, store);
    expect(store.savePolicyLayer({ guidelines: [null, { outcome: 'Old shape outcome text.' }], durations: [3_600_000] }, 0)).toBe(1);
    clock.t += 10_000;
    expect(cw.policy.get().layerError).toBeUndefined();
    expect(guide(cw)).toContain('Old shape outcome text.');
    expect(cw.policy.reset('guidelines')).toMatchObject({ ok: true, changed: ['guidelines'] });
    expect(guide(cw)).not.toContain('Old shape outcome text.');
    expect(cw.policy.get().effective.durations).toEqual([3_600_000]);
  });

  it('a note citing rule 99 is refused and nothing is written', async () => {
    const { cw, store } = await kit();
    const res = cw.policy.save({ teamNotes: [{ text: 'cites nothing real', rule: 99 }] }, { version: 0, ...BY });
    expect(res).toEqual({ ok: false, error: 'invalid', path: 'layer.teamNotes[0].rule' });
    expect(store.loadPolicyLayer?.()).toBeNull();
    expect(cw.policy.get().version).toBe(0);
  });

  it('preview refuses it the same way', async () => {
    const { cw } = await kit();
    expect(cw.policy.preview({ teamNotes: [{ text: 'x', rule: 99 }] })).toEqual({ ok: false, error: 'invalid', path: 'layer.teamNotes[0].rule' });
    expect(cw.policy.preview({ teamNotes: [{ text: 'x', rule: 2 }] })).toMatchObject({ ok: true });
  });

  it('a note citing a retired rule is accepted', async () => {
    const rules = defineRules(starterRules('relaxed').map((r) => (r.number === 3 ? { ...r, retired: true } : r)));
    const { cw } = await kit({ rules });
    expect(cw.policy.save({ teamNotes: [{ text: 'about the old rule', rule: 3 }] }, { version: 0, ...BY })).toMatchObject({ ok: true, changed: ['teamNotes'] });
    expect(cw.policy.get().effective.teamNotes).toEqual([{ text: 'about the old rule', rule: 3 }]);
  });

  it('a stored layer with an invalid note sets layerError and keeps the base', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await kit({}, store);
    store.savePolicyLayer({ teamNotes: [{ text: '' }] }, 0);
    clock.t += 10_000;
    const s = cw.policy.get();
    expect(s.layerError).toEqual({ path: 'layer.teamNotes[0].text', kind: 'invalid' });
    expect(s.effective).toEqual(s.base);
  });

  it('a stored note citing a missing rule is NOT failed on read (only saves check it)', async () => {
    const store = new MemoryStore();
    const { cw, clock } = await kit({}, store);
    store.savePolicyLayer({ teamNotes: [{ text: 'cites 99', rule: 99 }] }, 0);
    clock.t += 10_000;
    const s = cw.policy.get();
    expect(s.layerError).toBeUndefined();
    expect(s.effective.teamNotes).toEqual([{ text: 'cites 99', rule: 99 }]);
  });

  it('createChatwarden with a code profile note citing a missing rule throws ProfileError', async () => {
    const err = await kit({ overrides: { teamNotes: [{ text: 'bad', rule: 99 }] } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).path).toBe('profile.teamNotes[0].rule');
    const fine = await kit({ overrides: { teamNotes: [{ text: 'fine', rule: 2 }] } });
    expect(fine.cw.profile.teamNotes).toEqual([{ text: 'fine', rule: 2 }]);
  });

  it('saving the layer a get() hands out round-trips (whole form, notes, aiContext)', async () => {
    const { cw } = await kit();
    cw.policy.save({ guidelines: { tiers: [tier()] }, teamNotes: [{ text: 'n', rule: 1 }], aiContext: 'Ours.' }, { version: 0, ...BY });
    const read = cw.policy.get();
    expect(cw.policy.save(read.layer, { version: read.version, ...BY })).toMatchObject({ ok: true, changed: [] });
  });
});
