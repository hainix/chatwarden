import { describe, expect, it } from 'vitest';
import {
  applyPolicyLayer,
  DEFAULT_DURATIONS,
  defineProfile,
  MAX_DURATION_MS,
  POLICY_SECTIONS,
  PRESETS,
  ProfileError,
  resolveProfile,
  validateProfile,
  type ModerationProfile,
  type PolicyLayer,
} from '../src/profile.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const base = (): ModerationProfile => PRESETS.standard;

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

const bad = (layer: unknown): ProfileError => failure(() => applyPolicyLayer(base(), layer as PolicyLayer));

describe('the duration fields on every preset', () => {
  it('durations default to 1h, 6h, 12h, 24h, 3d, 7d, 30d', () => {
    expect(DEFAULT_DURATIONS).toEqual([HOUR, 6 * HOUR, 12 * HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY]);
    for (const name of ['relaxed', 'standard', 'strict'] as const) {
      expect(PRESETS[name].durations).toEqual(DEFAULT_DURATIONS);
      expect(PRESETS[name].customDuration).toBe(true);
    }
  });

  it('the preset arrays are frozen and not shared with the exported default', () => {
    expect(Object.isFrozen(PRESETS.standard.durations)).toBe(true);
    expect(PRESETS.standard.durations).not.toBe(DEFAULT_DURATIONS);
    expect(() => (PRESETS.standard.durations as number[]).push(1)).toThrow();
  });

  it('resolveProfile keeps them, and overrides replace the list whole', () => {
    expect(resolveProfile('relaxed').durations).toEqual(DEFAULT_DURATIONS);
    const p = resolveProfile('relaxed', { durations: [HOUR, 2 * HOUR], customDuration: false });
    expect(p.durations).toEqual([HOUR, 2 * HOUR]);
    expect(p.customDuration).toBe(false);
  });

  it('a complete custom profile without the two fields gets the defaults (no breaking change for 0.1.1 profiles)', () => {
    const old = JSON.parse(JSON.stringify(PRESETS.strict)) as Loose;
    delete old.durations;
    delete old.customDuration;
    const p = defineProfile(old as ModerationProfile);
    expect(p.durations).toEqual(DEFAULT_DURATIONS);
    expect(p.customDuration).toBe(true);
    expect(resolveProfile(old as ModerationProfile).durations).toEqual(DEFAULT_DURATIONS);
  });

  it('validateProfile treats both fields as optional (a 0.1.1 profile has neither) and checks them when present', () => {
    const old = JSON.parse(JSON.stringify(PRESETS.strict)) as Loose;
    delete old.durations;
    delete old.customDuration;
    expect(() => validateProfile(old)).not.toThrow();
    old.durations = [2, 1];
    expect(failure(() => validateProfile(old)).path).toBe('profile.durations');
    old.durations = [1];
    old.customDuration = 'yes';
    expect(failure(() => validateProfile(old)).path).toBe('profile.customDuration');
  });
});

describe('validating durations and customDuration', () => {
  const GOOD: number[][] = [[], [1], [HOUR], [1, 2, 3], [HOUR, MAX_DURATION_MS], [MAX_DURATION_MS], Array.from({ length: 50 }, (_, i) => (i + 1) * HOUR)];
  for (const list of GOOD) {
    it(`accepts ${list.length} entries starting ${list[0] ?? 'none'}`, () => {
      expect(resolveProfile('standard', { durations: list }).durations).toEqual(list);
    });
  }

  const BAD: Array<[string, unknown]> = [
    ['not sorted', [DAY, HOUR]],
    ['duplicates', [HOUR, HOUR]],
    ['zero', [0, HOUR]],
    ['negative', [-1]],
    ['a fraction', [1.5]],
    ['NaN', [Number.NaN]],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['above the cap', [MAX_DURATION_MS + 1]],
    ['null (permanent is always offered, never listed)', [HOUR, null]],
    ['a string', ['1h']],
    ['an unsafe integer', [Number.MAX_SAFE_INTEGER + 2]],
    ['more than 50 entries', Array.from({ length: 51 }, (_, i) => (i + 1) * HOUR)],
    ['not a list', HOUR],
    ['an object', { 0: HOUR }],
  ];
  for (const [name, list] of BAD) {
    it(`refuses ${name}, naming the field`, () => {
      const e = failure(() => resolveProfile('standard', { durations: list as number[] }));
      expect(e.path.startsWith('profile.durations')).toBe(true);
      expect(e.message).not.toContain(String(HOUR));
    });
  }

  it('customDuration must be a boolean', () => {
    for (const v of ['yes', 1, 0, null, {}]) {
      expect(failure(() => resolveProfile('standard', { customDuration: v as boolean })).path).toBe('profile.customDuration');
    }
    expect(resolveProfile('standard', { customDuration: false }).customDuration).toBe(false);
  });
});

describe('the layer: what may be edited', () => {
  it('has exactly the eleven editable sections', () => {
    expect([...POLICY_SECTIONS]).toEqual(['durations', 'customDuration', 'ladder', 'firstOffense', 'repeat', 'areaRules', 'severeRules', 'guidelines', 'reporting', 'ai', 'pace']);
  });

  it('an empty layer changes nothing but is a fresh frozen copy', () => {
    const p = applyPolicyLayer(base(), {});
    expect(p).toEqual(base());
    expect(p).not.toBe(base());
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.ladder[0])).toBe(true);
  });

  const FORBIDDEN = ['profanity', 'id', 'name', 'summary', 'aiContext', 'aiAutoAct', 'rules', 'levels', 'nonsense', '__proto__'];
  for (const key of FORBIDDEN) {
    it(`refuses a layer that touches ${key}, with the path`, () => {
      const layer = JSON.parse(`{"${key}": {"mode": "allow"}}`) as unknown;
      const e = bad(layer);
      expect(e.path).toBe(`layer.${key}`);
    });
  }

  it('profanity inside an otherwise good layer is refused whole (nothing partial)', () => {
    expect(bad({ durations: [HOUR], profanity: { mode: 'allow' } }).path).toBe('layer.profanity');
  });

  it('a layer that is not a plain object is refused', () => {
    for (const v of [null, undefined, 'x', 3, [], [{}]]) expect(bad(v).path).toBe('layer');
  });

  it('a layer is not changed by applying it, and the result shares nothing with it', () => {
    const layer = { durations: [HOUR, DAY], repeat: { notes: 3 } };
    const snapshot = JSON.stringify(layer);
    const p = applyPolicyLayer(base(), layer);
    expect(JSON.stringify(layer)).toBe(snapshot);
    layer.durations.push(2 * DAY);
    expect(p.durations).toEqual([HOUR, DAY]);
  });
});

describe('the layer: merge order and each section', () => {
  it('order is base, then code overrides, then the layer', () => {
    const code = resolveProfile('standard', { repeat: { notes: 5, windowDays: 10 }, durations: [HOUR, DAY] });
    const p = applyPolicyLayer(code, { repeat: { notes: 3 } });
    expect(p.repeat.notes).toBe(3); // the layer wins
    expect(p.repeat.windowDays).toBe(10); // a code override the layer does not touch survives
    expect(p.durations).toEqual([HOUR, DAY]);
    expect(p.repeat.distinctGames).toBe(false); // the preset's own value survives under both
  });

  it('objects merge key by key, arrays replace whole, null is a value', () => {
    const p = applyPolicyLayer(base(), { firstOffense: { rude: { kind: 'chat', durationMs: 6 * HOUR } }, areaRules: [], severeRules: [1, 2] });
    expect(p.firstOffense.rude).toEqual({ kind: 'chat', durationMs: 6 * HOUR });
    expect(p.firstOffense.hostile).toEqual(base().firstOffense.hostile);
    expect(p.areaRules).toEqual([]);
    expect(p.severeRules).toEqual([1, 2]);
    const perm = applyPolicyLayer(base(), { firstOffense: { severe: { kind: 'ban', durationMs: null } } });
    expect(perm.firstOffense.severe).toEqual({ kind: 'ban', durationMs: null });
  });

  it('durations and customDuration', () => {
    const p = applyPolicyLayer(base(), { durations: [HOUR, 6 * HOUR, 12 * HOUR], customDuration: false });
    expect(p.durations).toEqual([HOUR, 6 * HOUR, 12 * HOUR]);
    expect(p.customDuration).toBe(false);
  });

  it('repeat: a partial layer keeps the siblings; the outcome must still escalate', () => {
    const p = applyPolicyLayer(base(), { repeat: { distinctGames: true, outcome: 'warning' } });
    expect(p.repeat).toEqual({ ...base().repeat, distinctGames: true, outcome: 'warning' });
    expect(bad({ repeat: { outcome: 'none' } }).path).toBe('layer.repeat.outcome');
    expect(bad({ repeat: { outcome: 'note' } }).path).toBe('layer.repeat.outcome');
    expect(bad({ repeat: { windowDays: 91 } }).path).toBe('layer.repeat.windowDays');
    expect(bad({ repeat: { notes: 0 } }).path).toBe('layer.repeat.notes');
    expect(bad({ repeat: { colour: 'red' } }).path).toBe('layer.repeat.colour');
  });

  it('firstOffense: banter stays none and severe must act', () => {
    expect(bad({ firstOffense: { banter: 'warning' } }).path).toBe('layer.firstOffense.banter');
    expect(bad({ firstOffense: { severe: 'none' } }).path).toBe('layer.firstOffense.severe');
    expect(bad({ firstOffense: { severe: 'note' } }).path).toBe('layer.firstOffense.severe');
    expect(bad({ firstOffense: { rude: { kind: 'chat', durationMs: 0 } } }).path).toBe('layer.firstOffense.rude.durationMs');
    expect(bad({ firstOffense: { rude: { kind: 'chat', durationMs: MAX_DURATION_MS + 1 } } }).path).toBe('layer.firstOffense.rude.durationMs');
    expect(bad({ firstOffense: { rude: { kind: 'mute', durationMs: 1000 } } }).path).toBe('layer.firstOffense.rude.kind');
    expect(bad({ firstOffense: { loud: 'warning' } }).path).toBe('layer.firstOffense.loud');
  });

  it('areaRules and severeRules: whole rule numbers, duplicates removed', () => {
    expect(applyPolicyLayer(base(), { areaRules: [3, 3, 4] }).areaRules).toEqual([3, 4]);
    expect(bad({ areaRules: [0] }).path).toBe('layer.areaRules[0]');
    expect(bad({ severeRules: [1, 1.5] }).path).toBe('layer.severeRules[1]');
    expect(bad({ severeRules: 'all' }).path).toBe('layer.severeRules');
  });

  it('every path in an error starts with layer, never profile', () => {
    const layers: unknown[] = [{ durations: [2, 1] }, { customDuration: 3 }, { repeat: { notes: -1 } }, { ladder: [] }, { guidelines: [{ outcome: '' }] }];
    for (const l of layers) expect(bad(l).path.startsWith('layer')).toBe(true);
  });
});

describe('the layer: the ladder and generated labels', () => {
  const rows = (over: (r: Loose[]) => void): PolicyLayer => {
    const r = JSON.parse(JSON.stringify(base().ladder)) as Loose[];
    over(r);
    return { ladder: r };
  };

  it('a complete ladder replaces the base ladder', () => {
    const p = applyPolicyLayer(base(), rows((r) => (r[1].lowMedium = { kind: 'chat', durationMs: 6 * HOUR, label: 'Cool-off' })));
    expect(p.ladder[1]?.lowMedium).toEqual({ kind: 'chat', durationMs: 6 * HOUR, label: 'Cool-off' });
    expect(p.ladder[2]).toEqual(base().ladder[2]);
  });

  const GENERATED: Array<[string, { kind: string; durationMs: number | null }, string]> = [
    ['chat 6 hours', { kind: 'chat', durationMs: 6 * HOUR }, 'Restrict chat 6 hours'],
    ['chat 1 hour', { kind: 'chat', durationMs: HOUR }, 'Restrict chat 1 hour'],
    ['chat 24 hours', { kind: 'chat', durationMs: DAY }, 'Restrict chat 24 hours'],
    ['area 12 hours', { kind: 'area', durationMs: 12 * HOUR }, 'Ban from public rooms 12 hours'],
    ['ban 3 days', { kind: 'ban', durationMs: 3 * DAY }, 'Full ban 3 days'],
    ['ban permanent', { kind: 'ban', durationMs: null }, 'Full ban permanent'],
    ['chat permanent', { kind: 'chat', durationMs: null }, 'Restrict chat permanent'],
    ['warning', { kind: 'warning', durationMs: null }, 'Warning'],
    ['chat 90 minutes', { kind: 'chat', durationMs: 90 * 60_000 }, 'Restrict chat 90 minutes'],
  ];
  for (const [name, cell, label] of GENERATED) {
    it(`generates "${label}" for ${name} when the cell has no label`, () => {
      const p = applyPolicyLayer(base(), rows((r) => (r[3].high = { ...cell })));
      expect(p.ladder[3]?.high.label).toBe(label);
      expect(p.ladder[3]?.high.kind).toBe(cell.kind);
      expect(p.ladder[3]?.high.durationMs).toBe(cell.durationMs);
    });
  }

  it('a label the editor gave is kept as given', () => {
    const p = applyPolicyLayer(base(), rows((r) => (r[0].high = { kind: 'ban', durationMs: DAY, label: 'Time out (house)' })));
    expect(p.ladder[0]?.high.label).toBe('Time out (house)');
  });

  it('a blank label is refused, not replaced', () => {
    expect(bad(rows((r) => (r[0].high = { kind: 'ban', durationMs: DAY, label: '  ' }))).path).toBe('layer.ladder[0].high.label');
  });

  it('a base ladder sent back without labels reads exactly as the base labels (the table is self-consistent)', () => {
    const stripped = JSON.parse(JSON.stringify(base().ladder)) as Loose[];
    for (const row of stripped) {
      delete row.lowMedium.label;
      delete row.high.label;
    }
    expect(applyPolicyLayer(base(), { ladder: stripped }).ladder).toEqual(base().ladder);
  });

  const BAD_LADDERS: Array<[string, (r: Loose[]) => void, string]> = [
    ['five rows', (r) => r.pop(), 'layer.ladder'],
    ['seven rows', (r) => r.push(JSON.parse(JSON.stringify(r[5]))), 'layer.ladder'],
    ['rows out of order', (r) => r.reverse(), 'layer.ladder[0].step'],
    ['a warning with a duration', (r) => (r[0].lowMedium = { kind: 'warning', durationMs: HOUR }), 'layer.ladder[0].lowMedium.durationMs'],
    ['a note cell', (r) => (r[0].lowMedium = { kind: 'note', durationMs: null }), 'layer.ladder[0].lowMedium.kind'],
    ['a zero duration', (r) => (r[2].high = { kind: 'ban', durationMs: 0 }), 'layer.ladder[2].high.durationMs'],
    ['a duration over the cap', (r) => (r[2].high = { kind: 'ban', durationMs: MAX_DURATION_MS + 1 }), 'layer.ladder[2].high.durationMs'],
    ['a missing duration', (r) => (r[2].high = { kind: 'ban' }), 'layer.ladder[2].high.durationMs'],
    ['an unknown cell key', (r) => (r[2].high = { kind: 'ban', durationMs: null, colour: 'red' }), 'layer.ladder[2].high.colour'],
    ['an unknown kind', (r) => (r[4].lowMedium = { kind: 'kick', durationMs: HOUR }), 'layer.ladder[4].lowMedium.kind'],
    ['a missing column', (r) => delete r[1].high, 'layer.ladder[1].high'],
  ];
  for (const [name, mutate, path] of BAD_LADDERS) {
    it(`refuses ${name}`, () => {
      expect(bad(rows(mutate)).path).toBe(path);
    });
  }

  it('a ladder that is not a list is refused', () => {
    expect(bad({ ladder: 'steep' }).path).toBe('layer.ladder');
    expect(bad({ ladder: null }).path).toBe('layer.ladder');
  });

  it('ladder cells need not be in the durations list (it is only the offered list)', () => {
    const p = applyPolicyLayer(base(), { durations: [HOUR], ...rows((r) => (r[1].lowMedium = { kind: 'chat', durationMs: 5 * DAY })) });
    expect(p.ladder[1]?.lowMedium.durationMs).toBe(5 * DAY);
  });
});

describe('the layer: guideline outcome text', () => {
  it('replaces the outcome of the tiers it names and leaves the rest', () => {
    const p = applyPolicyLayer(base(), { guidelines: [null, { outcome: 'A friendly warning.' }] });
    expect(p.guidelines[1]?.outcome).toBe('A friendly warning.');
    expect(p.guidelines[1]?.title).toBe(base().guidelines[1]?.title);
    expect(p.guidelines[0]).toEqual(base().guidelines[0]);
    expect(p.guidelines).toHaveLength(base().guidelines.length);
  });

  it('refuses more entries than there are tiers', () => {
    const many = Array.from({ length: base().guidelines.length + 1 }, () => ({ outcome: 'x' }));
    expect(bad({ guidelines: many }).path).toBe('layer.guidelines');
  });

  it('refuses anything but the outcome, a blank or an over-long outcome', () => {
    expect(bad({ guidelines: [{ outcome: 'ok', title: 'New title' }] }).path).toBe('layer.guidelines[0].title');
    expect(bad({ guidelines: [{ title: 'New title' }] }).path).toBe('layer.guidelines[0].outcome');
    expect(bad({ guidelines: [{ outcome: ' ' }] }).path).toBe('layer.guidelines[0].outcome');
    expect(bad({ guidelines: [{ outcome: 'x'.repeat(1001) }] }).path).toBe('layer.guidelines[0].outcome');
    expect(applyPolicyLayer(base(), { guidelines: [{ outcome: 'x'.repeat(1000) }] }).guidelines[0]?.outcome).toHaveLength(1000);
    expect(bad({ guidelines: [3] }).path).toBe('layer.guidelines[0]');
    expect(bad({ guidelines: 'x' }).path).toBe('layer.guidelines');
    expect(bad({ guidelines: [{ outcome: 7 }] }).path).toBe('layer.guidelines[0].outcome');
  });

  it('the layer cannot change who a tier covers (the profile stays valid)', () => {
    const p = applyPolicyLayer(base(), { guidelines: [{ outcome: 'Nothing happens.' }] });
    expect(() => validateProfile(p)).not.toThrow();
  });
});

describe('rule lists are capped', () => {
  const many = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

  it('accepts 100 rule numbers in each list', () => {
    expect(applyPolicyLayer(base(), { areaRules: many(100) }).areaRules).toHaveLength(100);
    expect(applyPolicyLayer(base(), { severeRules: many(100) }).severeRules).toHaveLength(100);
  });

  it('refuses 101, naming the field', () => {
    expect(bad({ areaRules: many(101) }).path).toBe('layer.areaRules');
    expect(bad({ severeRules: many(101) }).path).toBe('layer.severeRules');
  });

  it('counts before removing duplicates, so a long list of one number is refused fast', () => {
    expect(bad({ areaRules: Array.from({ length: 101 }, () => 5) }).path).toBe('layer.areaRules');
    expect(bad({ severeRules: Array.from({ length: 5000 }, () => 1) }).path).toBe('layer.severeRules');
  });

  it('validateProfile itself refuses a list over the cap (a profile that never went through defineProfile)', () => {
    const p = JSON.parse(JSON.stringify(PRESETS.standard)) as Loose;
    p.areaRules = many(101);
    expect(failure(() => validateProfile(p)).path).toBe('profile.areaRules');
    p.areaRules = many(100);
    expect(() => validateProfile(p)).not.toThrow();
  });

  it('applies to a profile given in code too', () => {
    expect(() => resolveProfile('standard', { areaRules: many(101) })).toThrow(ProfileError);
  });
});

describe('an outcome in a layer is whole', () => {
  it('a chat, area or ban outcome needs both kind and durationMs (no half merged onto the base)', () => {
    expect(bad({ firstOffense: { rude: { kind: 'ban' } } }).path).toBe('layer.firstOffense.rude.durationMs');
    expect(bad({ firstOffense: { hostile: { durationMs: HOUR } } }).path).toBe('layer.firstOffense.hostile.kind');
    expect(bad({ repeat: { outcome: { kind: 'chat' } } }).path).toBe('layer.repeat.outcome.durationMs');
    expect(bad({ repeat: { outcome: { durationMs: HOUR } } }).path).toBe('layer.repeat.outcome.kind');
  });

  it('a whole outcome, a word outcome and an explicit null duration are accepted', () => {
    expect(applyPolicyLayer(base(), { firstOffense: { rude: { kind: 'ban', durationMs: null } } }).firstOffense.rude).toEqual({ kind: 'ban', durationMs: null });
    expect(applyPolicyLayer(base(), { firstOffense: { rude: 'note' } }).firstOffense.rude).toBe('note');
    expect(applyPolicyLayer(base(), { repeat: { outcome: { kind: 'chat', durationMs: HOUR } } }).repeat.outcome).toEqual({ kind: 'chat', durationMs: HOUR });
  });
});
