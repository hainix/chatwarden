import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { checkSignalFeeds, pruneSignalFeeds, resolveSignals } from '../src/signals.js';
import type { SignalFeeds } from '../src/signals.js';
import { applyPolicyLayer, changedSections, layerSections, POLICY_SECTIONS, PRESETS, ProfileError, resolveProfile } from '../src/profile.js';
import type { ModerationProfile, PolicyLayer } from '../src/profile.js';
import { NOW, OWNER, world } from './reportingWorld.js';

// The `feeds` of the signals section: shape and kind checks, the window cross-checks, the layer (feeds only, replacing wholesale), and the
// start-up rule that drops one unusable feed instead of the whole stored layer.

const DAY = 86_400_000;
const KINDS = resolveSignals({
  kinds: {
    muted_by_player: { label: 'Muted by other players', polarity: 'negative' },
    blocked_by_player: { label: 'Blocked by other players', polarity: 'negative' },
    commended: { label: 'Commended by other players', polarity: 'positive' },
  },
}).kinds;
const opts = { signalsMs: 90 * DAY };

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}
const check = (feeds: unknown, o = opts) => checkSignalFeeds(feeds as SignalFeeds, KINDS, o, 'signals.feeds');
const bad = (feeds: unknown, o = opts) => failure(() => check(feeds, o)).path;

const threshold = (over: Record<string, unknown> = {}) => ({ kinds: ['muted_by_player'], minDistinct: 5, windowDays: 14, ...over });
const rule = (over: Record<string, unknown> = {}) => ({ id: 'muted-a-lot', effect: 'note' as 'note' | 'raise', ...threshold(), ...over });

describe('checkSignalFeeds: shape', () => {
  it('accepts no feeds, an empty object, and a full set', () => {
    expect(() => check({})).not.toThrow();
    expect(() =>
      check({
        record: { kinds: '*', windowDays: 14 },
        queue: threshold({ minWeight: 7.5 }),
        ladder: [rule(), rule({ id: 'blocked', kinds: ['blocked_by_player'], effect: 'raise' })],
        ai: { kinds: ['muted_by_player', 'commended'], windowDays: 30 },
      }),
    ).not.toThrow();
  });

  it('refuses feeds that are not an object, and an unknown feed', () => {
    for (const v of [5, 'x', null, [], true]) expect(bad(v)).toBe('signals.feeds');
    expect(bad({ nope: {} })).toBe('signals.feeds.nope');
    expect(bad({ record: { kinds: '*', windowDays: 14 }, other: 1 })).toBe('signals.feeds.other');
  });

  it('record and ai: kinds are a list or "*", the window is required, nothing else is allowed', () => {
    for (const feed of ['record', 'ai'] as const) {
      expect(bad({ [feed]: 5 })).toBe(`signals.feeds.${feed}`);
      expect(bad({ [feed]: { windowDays: 14 } })).toBe(`signals.feeds.${feed}.kinds`);
      expect(bad({ [feed]: { kinds: '*' } })).toBe(`signals.feeds.${feed}.windowDays`);
      expect(bad({ [feed]: { kinds: 'all', windowDays: 14 } })).toBe(`signals.feeds.${feed}.kinds`);
      expect(bad({ [feed]: { kinds: [], windowDays: 14 } })).toBe(`signals.feeds.${feed}.kinds`);
      expect(bad({ [feed]: { kinds: ['muted_by_player', 'muted_by_player'], windowDays: 14 } })).toBe(`signals.feeds.${feed}.kinds[1]`);
      expect(bad({ [feed]: { kinds: '*', windowDays: 14, nope: 1 } })).toBe(`signals.feeds.${feed}.nope`);
    }
  });

  it('a threshold needs kinds, minDistinct and windowDays and takes only minWeight besides', () => {
    expect(bad({ queue: { minDistinct: 5, windowDays: 14 } })).toBe('signals.feeds.queue.kinds');
    expect(bad({ queue: { kinds: ['muted_by_player'], windowDays: 14 } })).toBe('signals.feeds.queue.minDistinct');
    expect(bad({ queue: { kinds: ['muted_by_player'], minDistinct: 5 } })).toBe('signals.feeds.queue.windowDays');
    expect(bad({ queue: threshold({ nope: 1 }) })).toBe('signals.feeds.queue.nope');
    expect(bad({ queue: 5 })).toBe('signals.feeds.queue');
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '3', 501]) expect(bad({ queue: threshold({ minWeight: v }) }), String(v)).toBe('signals.feeds.queue.minWeight');
  });
});

describe('checkSignalFeeds: kinds and polarity', () => {
  it('a feed naming an undeclared kind is refused at its index', () => {
    expect(bad({ queue: threshold({ kinds: ['nope_kind'] }) })).toBe('signals.feeds.queue.kinds[0]');
    expect(bad({ queue: threshold({ kinds: ['muted_by_player', 'nope_kind'] }) })).toBe('signals.feeds.queue.kinds[1]');
    expect(bad({ record: { kinds: ['nope_kind'], windowDays: 7 } })).toBe('signals.feeds.record.kinds[0]');
    expect(bad({ ai: { kinds: ['muted_by_player', 'x_kind'], windowDays: 7 } })).toBe('signals.feeds.ai.kinds[1]');
    expect(bad({ ladder: [rule({ kinds: ['x_kind'] })] })).toBe('signals.feeds.ladder[0].kinds[0]');
  });

  it('kinds that exist only on the prototype are undeclared', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(bad({ queue: threshold({ kinds: [id] }) }), id).toBe('signals.feeds.queue.kinds[0]');
    }
  });

  it('a kind that is not a string is refused', () => {
    for (const v of [5, null, {}, ['x']]) expect(bad({ queue: threshold({ kinds: [v] }) })).toBe('signals.feeds.queue.kinds[0]');
    expect(bad({ queue: threshold({ kinds: 'muted_by_player' }) })).toBe('signals.feeds.queue.kinds');
  });

  it('queue and raise reject a positive kind; note accepts one; record and ai accept both', () => {
    expect(bad({ queue: threshold({ kinds: ['commended'] }) })).toBe('signals.feeds.queue.kinds[0]');
    expect(bad({ queue: threshold({ kinds: ['muted_by_player', 'commended'] }) })).toBe('signals.feeds.queue.kinds[1]');
    expect(bad({ ladder: [rule({ effect: 'raise', kinds: ['commended'] })] })).toBe('signals.feeds.ladder[0].kinds[0]');
    expect(bad({ ladder: [rule({ effect: 'raise', kinds: ['muted_by_player', 'commended'] })] })).toBe('signals.feeds.ladder[0].kinds[1]');
    expect(() => check({ ladder: [rule({ effect: 'note', kinds: ['commended'] })] })).not.toThrow();
    expect(() => check({ record: { kinds: ['commended', 'muted_by_player'], windowDays: 14 } })).not.toThrow();
    expect(() => check({ ai: { kinds: ['commended'], windowDays: 14 } })).not.toThrow();
    expect(() => check({ record: { kinds: '*', windowDays: 14 } })).not.toThrow();
  });
});

describe('checkSignalFeeds: numbers', () => {
  it('minDistinct 0 and 51, windowDays 0 and 91, kinds [] and 9, a duplicate rule id: each refused', () => {
    expect(bad({ queue: threshold({ minDistinct: 0 }) })).toBe('signals.feeds.queue.minDistinct');
    expect(bad({ queue: threshold({ minDistinct: 51 }) })).toBe('signals.feeds.queue.minDistinct');
    expect(bad({ queue: threshold({ windowDays: 0 }) })).toBe('signals.feeds.queue.windowDays');
    expect(bad({ queue: threshold({ windowDays: 91 }) })).toBe('signals.feeds.queue.windowDays');
    expect(bad({ queue: threshold({ kinds: [] }) })).toBe('signals.feeds.queue.kinds');
    expect(bad({ queue: threshold({ kinds: Array.from({ length: 9 }, () => 'muted_by_player') }) })).toMatch(/^signals\.feeds\.queue\.kinds/);
    expect(bad({ ladder: [rule(), rule({ kinds: ['blocked_by_player'] })] })).toBe('signals.feeds.ladder[1].id');
  });

  it('accepts the edges: minDistinct 1 and 50, windowDays 1 and 90, 8 kinds', () => {
    expect(() => check({ queue: threshold({ minDistinct: 1, windowDays: 1 }) })).not.toThrow();
    expect(() => check({ queue: threshold({ minDistinct: 50, windowDays: 90 }) })).not.toThrow();
    const eight = resolveSignals({ kinds: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k_${i}`, { label: 'K', polarity: 'negative' }])) });
    expect(() => checkSignalFeeds({ queue: threshold({ kinds: Object.keys(eight.kinds).slice(0, 8) }) } as SignalFeeds, eight.kinds, opts, 'f')).not.toThrow();
    const nine = Object.keys(eight.kinds);
    nine.push('flood_triggered');
    expect(failure(() => checkSignalFeeds({ queue: threshold({ kinds: nine }) } as SignalFeeds, eight.kinds, opts, 'f')).path).toBe('f.queue.kinds');
  });

  it('whole numbers only: a fraction, NaN, Infinity, a string', () => {
    for (const v of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, true]) {
      expect(bad({ queue: threshold({ minDistinct: v }) }), String(v)).toBe('signals.feeds.queue.minDistinct');
      expect(bad({ queue: threshold({ windowDays: v }) }), String(v)).toBe('signals.feeds.queue.windowDays');
      expect(bad({ record: { kinds: '*', windowDays: v } }), String(v)).toBe('signals.feeds.record.windowDays');
    }
  });

  it('a window above signalsMs is refused with its path; a window above 90 is refused', () => {
    const short = { signalsMs: 14 * DAY };
    expect(bad({ queue: threshold({ windowDays: 15 }) }, short)).toBe('signals.feeds.queue.windowDays');
    expect(bad({ ladder: [rule({ windowDays: 30 })] }, short)).toBe('signals.feeds.ladder[0].windowDays');
    expect(bad({ record: { kinds: '*', windowDays: 20 } }, short)).toBe('signals.feeds.record.windowDays');
    expect(bad({ ai: { kinds: '*', windowDays: 20 } }, short)).toBe('signals.feeds.ai.windowDays');
    expect(() => check({ queue: threshold({ windowDays: 14 }) }, short)).not.toThrow();
    expect(bad({ queue: threshold({ windowDays: 91 }) }, { signalsMs: 400 * DAY })).toBe('signals.feeds.queue.windowDays');
    expect(failure(() => check({ queue: threshold({ windowDays: 20 }) }, short)).message).toContain('signalsMs');
  });
});

describe('checkSignalFeeds: the ladder rules', () => {
  it('needs a list of rules with an id and an effect', () => {
    expect(bad({ ladder: 5 })).toBe('signals.feeds.ladder');
    expect(bad({ ladder: {} })).toBe('signals.feeds.ladder');
    expect(bad({ ladder: [5] })).toBe('signals.feeds.ladder[0]');
    expect(bad({ ladder: [{ ...threshold(), effect: 'note' }] })).toBe('signals.feeds.ladder[0].id');
    expect(bad({ ladder: [rule({ id: '' })] })).toBe('signals.feeds.ladder[0].id');
    expect(bad({ ladder: [rule({ id: 'Has Space' })] })).toBe('signals.feeds.ladder[0].id');
    expect(bad({ ladder: [rule({ id: 'x'.repeat(41) })] })).toBe('signals.feeds.ladder[0].id');
    expect(bad({ ladder: [rule({ effect: 'ban' })] })).toBe('signals.feeds.ladder[0].effect');
    expect(bad({ ladder: [{ id: 'a', ...threshold() }] })).toBe('signals.feeds.ladder[0].effect');
    expect(bad({ ladder: [rule({ nope: 1 })] })).toBe('signals.feeds.ladder[0].nope');
  });

  it('an empty list is the same as no ladder, and a very long list is refused', () => {
    expect(() => check({ ladder: [] })).not.toThrow();
    const many = Array.from({ length: 21 }, (_, i) => rule({ id: `rule-${i}` }));
    expect(bad({ ladder: many })).toBe('signals.feeds.ladder');
    expect(() => check({ ladder: many.slice(0, 20) })).not.toThrow();
  });
});

describe('the layer', () => {
  const baseWith = (feeds?: SignalFeeds): ModerationProfile =>
    resolveProfile('standard', {
      signals: {
        kinds: {
          muted_by_player: { label: 'Muted by other players', polarity: 'negative' },
          blocked_by_player: { label: 'Blocked by other players', polarity: 'negative' },
          commended: { label: 'Commended by other players', polarity: 'positive' },
        },
        ...(feeds === undefined ? {} : { feeds }),
      },
    });
  const layerBad = (base: ModerationProfile, layer: unknown) => failure(() => applyPolicyLayer(base, layer as PolicyLayer)).path;

  it('a layer feed naming an undeclared kind is refused at layer.signals.feeds.queue.kinds[0]', () => {
    expect(layerBad(baseWith(), { signals: { feeds: { queue: threshold({ kinds: ['nope_kind'] }) } } })).toBe('layer.signals.feeds.queue.kinds[0]');
    expect(layerBad(PRESETS.standard, { signals: { feeds: { record: { kinds: ['muted_by_player'], windowDays: 14 } } } })).toBe('layer.signals.feeds.record.kinds[0]');
  });

  it('a layer feed of a positive kind for queue or raise is refused', () => {
    expect(layerBad(baseWith(), { signals: { feeds: { queue: threshold({ kinds: ['commended'] }) } } })).toBe('layer.signals.feeds.queue.kinds[0]');
    expect(layerBad(baseWith(), { signals: { feeds: { ladder: [rule({ effect: 'raise', kinds: ['commended'] })] } } })).toBe('layer.signals.feeds.ladder[0].kinds[0]');
  });

  it('a layer holding only feeds is applied; feeds out of range are refused with their layer path', () => {
    const p = applyPolicyLayer(baseWith(), { signals: { feeds: { queue: threshold() } } });
    expect(p.signals.feeds.queue).toEqual(threshold());
    expect(layerBad(baseWith(), { signals: { feeds: { queue: threshold({ minDistinct: 0 }) } } })).toBe('layer.signals.feeds.queue.minDistinct');
    expect(layerBad(baseWith(), { signals: { feeds: { queue: threshold({ windowDays: 91 }) } } })).toBe('layer.signals.feeds.queue.windowDays');
    expect(layerBad(baseWith(), { signals: { feeds: 5 } })).toBe('layer.signals.feeds');
    expect(layerBad(baseWith(), { signals: 5 })).toBe('layer.signals');
  });

  it("a layer's feeds replace the base's feeds wholesale (a feed left out is off)", () => {
    const base = baseWith({ record: { kinds: '*', windowDays: 14 }, queue: threshold(), ladder: [rule()] });
    expect(Object.keys(base.signals?.feeds ?? {}).sort()).toEqual(['ladder', 'queue', 'record']);
    const p = applyPolicyLayer(base, { signals: { feeds: { ai: { kinds: ['muted_by_player'], windowDays: 7 } } } });
    expect(Object.keys(p.signals.feeds)).toEqual(['ai']);
    // A layer holding signals with no feeds turns every feed off; no signals section leaves the base's feeds alone.
    expect(applyPolicyLayer(base, { signals: {} }).signals.feeds).toEqual({});
    expect(applyPolicyLayer(base, { signals: { feeds: {} } }).signals.feeds).toEqual({});
    expect(Object.keys(applyPolicyLayer(base, {}).signals.feeds).sort()).toEqual(['ladder', 'queue', 'record']);
    // The kinds are the base's, untouched.
    expect(Object.keys(p.signals.kinds).sort()).toEqual(['blocked_by_player', 'commended', 'flood_triggered', 'muted_by_player']);
  });

  it('a ladder rule list in a layer replaces the base list, it is not appended', () => {
    const base = baseWith({ ladder: [rule(), rule({ id: 'second', kinds: ['blocked_by_player'] })] });
    const p = applyPolicyLayer(base, { signals: { feeds: { ladder: [rule({ id: 'only' })] } } });
    expect(p.signals.feeds.ladder?.map((r) => r.id)).toEqual(['only']);
  });

  it('the base profile is not changed by applying a layer', () => {
    const base = baseWith({ queue: threshold() });
    const before = JSON.stringify(base);
    applyPolicyLayer(base, { signals: { feeds: {} } });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('signals is the last editable section; changedSections and layerSections list it in order', () => {
    expect([...POLICY_SECTIONS].slice(-3)).toEqual(['ai', 'pace', 'signals']);
    expect(changedSections({}, { signals: { feeds: {} } })).toEqual(['signals']);
    expect(changedSections({ signals: { feeds: {} } }, { signals: { feeds: {} } })).toEqual([]);
    expect(changedSections({}, { signals: { feeds: {} }, pace: { slowModeMs: 2000 }, durations: [3_600_000] })).toEqual(['durations', 'pace', 'signals']);
    expect(layerSections({ signals: {}, ai: { level: 1 } })).toEqual(['ai', 'signals']);
  });
});

describe('cw.policy and the signals section', () => {
  const kinds = {
    muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
    blocked_by_player: { label: 'Blocked by other players', polarity: 'negative' as const },
  };
  const feeds = { queue: { kinds: ['muted_by_player'], minDistinct: 5, windowDays: 14 } };

  it('a saved layer applies at once; reset("signals") restores the base', async () => {
    const { cw } = await world({ overrides: { signals: { kinds, feeds: { record: { kinds: '*', windowDays: 7 } } } } });
    expect(Object.keys(cw.profile.signals.feeds)).toEqual(['record']);
    expect(cw.policy.save({ signals: { feeds } }, { version: 0, ...OWNER })).toEqual({ ok: true, version: 1, changed: ['signals'] });
    expect(Object.keys(cw.profile.signals.feeds)).toEqual(['queue']);
    expect(cw.policy.get().base.signals.feeds).toEqual({ record: { kinds: '*', windowDays: 7 } });
    expect(cw.policy.reset('signals')).toMatchObject({ ok: true, changed: ['signals'] });
    expect(Object.keys(cw.profile.signals.feeds)).toEqual(['record']);
  });

  it('save refuses a layer naming a kind, a guard, or an undeclared kind in a feed, with the layer path, and writes nothing', async () => {
    const { cw } = await world({ overrides: { signals: { kinds } } });
    const refuse = (layer: unknown) => cw.policy.save(layer as PolicyLayer, { version: 0, ...OWNER });
    expect(refuse({ signals: { kinds: { x_kind: { label: 'X', polarity: 'negative' } } } })).toEqual({ ok: false, error: 'invalid', path: 'layer.signals.kinds' });
    expect(refuse({ signals: { guards: {} } })).toEqual({ ok: false, error: 'invalid', path: 'layer.signals.guards' });
    expect(refuse({ signals: { feeds: { queue: { kinds: ['nope_kind'], minDistinct: 3, windowDays: 7 } } } })).toEqual({
      ok: false,
      error: 'invalid',
      path: 'layer.signals.feeds.queue.kinds[0]',
    });
    expect(cw.policy.get().version).toBe(0);
  });

  it('save refuses a window above signalsMs, with its layer path', async () => {
    const { cw } = await world({ retention: { signalsMs: 14 * DAY }, overrides: { signals: { kinds } } });
    expect(cw.policy.save({ signals: { feeds: { queue: { ...feeds.queue, windowDays: 30 } } } }, { version: 0, ...OWNER })).toEqual({
      ok: false,
      error: 'invalid',
      path: 'layer.signals.feeds.queue.windowDays',
    });
    expect(cw.policy.save({ signals: { feeds: { queue: { ...feeds.queue, windowDays: 14 } } } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
  });

  it('creation refuses a code feed whose window is above signalsMs, naming the profile path', async () => {
    await expect(world({ retention: { signalsMs: 14 * DAY }, overrides: { signals: { kinds, feeds: { ladder: [{ id: 'r', kinds: ['muted_by_player'], minDistinct: 3, windowDays: 30, effect: 'note' }] } } } })).rejects.toMatchObject({
      name: 'ProfileError',
      path: 'profile.signals.feeds.ladder[0].windowDays',
    });
    await expect(world({ overrides: { signals: { kinds, feeds: { ladder: [{ id: 'r', kinds: ['muted_by_player'], minDistinct: 3, windowDays: 30, effect: 'note' }] } } } })).resolves.toBeDefined();
  });
});

describe('pruneSignalFeeds (a stored layer made invalid later)', () => {
  const dropped = (feeds: unknown, o = opts): { out: SignalFeeds; gone: string[] } => {
    const gone: string[] = [];
    const out = pruneSignalFeeds(feeds, KINDS, { ...o, onDrop: (feed) => gone.push(feed) });
    return { out, gone };
  };

  it('keeps everything that is usable, and returns a copy', () => {
    const feeds = { record: { kinds: '*', windowDays: 14 }, queue: threshold(), ladder: [rule()], ai: { kinds: ['muted_by_player'], windowDays: 7 } };
    const { out, gone } = dropped(feeds);
    expect(out).toEqual(feeds);
    expect(gone).toEqual([]);
    expect(out).not.toBe(feeds);
  });

  it('a stored feed naming a removed kind is dropped alone', () => {
    const { out, gone } = dropped({ record: { kinds: '*', windowDays: 14 }, queue: threshold({ kinds: ['removed_kind'] }), ai: { kinds: ['muted_by_player'], windowDays: 7 } });
    expect(Object.keys(out).sort()).toEqual(['ai', 'record']);
    expect(gone).toEqual(['queue']);
  });

  it('a window above a lowered signalsMs is dropped alone', () => {
    const { out, gone } = dropped({ record: { kinds: '*', windowDays: 30 }, queue: threshold({ windowDays: 7 }) }, { signalsMs: 14 * DAY });
    expect(Object.keys(out)).toEqual(['queue']);
    expect(gone).toEqual(['record']);
  });

  it('a ladder rule is dropped alone; the rest of the ladder stays, and an emptied ladder goes', () => {
    const { out, gone } = dropped({ ladder: [rule({ id: 'ok' }), rule({ id: 'broken', kinds: ['removed_kind'] })] });
    expect(out.ladder?.map((r) => r.id)).toEqual(['ok']);
    expect(gone).toEqual(['ladder']);
    const none = dropped({ ladder: [rule({ id: 'broken', kinds: ['removed_kind'] })] });
    expect(none.out).toEqual({});
  });

  it('a raise rule whose kind is now positive is dropped', () => {
    const { out } = dropped({ ladder: [rule({ effect: 'raise', kinds: ['commended'] })], queue: threshold({ kinds: ['commended'] }) });
    expect(out).toEqual({});
  });

  it('garbage in gives garbage out of the result, never a throw', () => {
    for (const v of [undefined, null, 5, 'x', [], true]) expect(pruneSignalFeeds(v, KINDS, opts)).toEqual({});
    const { out, gone } = dropped({ nope: {}, record: 5, queue: { kinds: 'x' }, ladder: 'x', ai: null });
    expect(out).toEqual({});
    expect(gone.sort()).toEqual(['ai', 'ladder', 'nope', 'queue', 'record']);
  });

  it('the result always passes checkSignalFeeds', () => {
    const feeds = { record: { kinds: ['removed'], windowDays: 14 }, queue: threshold({ windowDays: 80 }), ladder: [rule(), rule({ id: 'bad', windowDays: 200 })] };
    const out = pruneSignalFeeds(feeds, KINDS, { signalsMs: 30 * DAY });
    expect(() => checkSignalFeeds(out, KINDS, { signalsMs: 30 * DAY }, 'f')).not.toThrow();
    expect(out.ladder?.map((r) => r.id)).toEqual(['muted-a-lot']);
  });

  describe('at start-up, through the stored layer', () => {
    const kindsInCode = { muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const } };
    const ladderEdit = { firstOffense: { rude: { kind: 'chat' as const, durationMs: 3_600_000 } } };

    it('a stored feed naming a kind the code no longer declares is dropped alone: the ladder edit stays in force', async () => {
      const store = new MemoryStore();
      store.savePolicyLayer?.(
        { ...ladderEdit, signals: { feeds: { record: { kinds: '*', windowDays: 14 }, queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } },
        0,
      );
      const { cw, logged } = await world({ overrides: { signals: { kinds: kindsInCode } } }, store);
      expect(cw.profile.firstOffense.rude).toEqual({ kind: 'chat', durationMs: 3_600_000 });
      expect(Object.keys(cw.profile.signals.feeds)).toEqual(['record']);
      expect(cw.policy.get().layerError).toBeUndefined();
      expect(logged.filter(([e]) => e === 'chatwarden.signal_feed_dropped')).toEqual([['chatwarden.signal_feed_dropped', { feed: 'queue' }]]);
      expect(logged.some(([e]) => e === 'chatwarden.policy_layer_invalid')).toBe(false);
      expect(JSON.stringify(logged)).not.toContain('removed_kind');
    });

    it('a window above a lowered signalsMs is dropped alone; the other feeds and the ladder section survive', async () => {
      const store = new MemoryStore();
      store.savePolicyLayer?.(
        { ...ladderEdit, signals: { feeds: { record: { kinds: '*', windowDays: 60 }, ai: { kinds: ['muted_by_player'], windowDays: 14 } } } },
        0,
      );
      const { cw, logged } = await world({ retention: { signalsMs: 14 * DAY }, overrides: { signals: { kinds: kindsInCode } } }, store);
      expect(cw.profile.firstOffense.rude).toEqual({ kind: 'chat', durationMs: 3_600_000 });
      expect(Object.keys(cw.profile.signals.feeds)).toEqual(['ai']);
      expect(logged.filter(([e]) => e === 'chatwarden.signal_feed_dropped')).toHaveLength(1);
    });

    it('a layer that is bad in some other way is still ignored whole, as before', async () => {
      const store = new MemoryStore();
      store.savePolicyLayer?.({ ...ladderEdit, signals: { kinds: { x_kind: {} } } } as never, 0);
      const { cw, logged } = await world({ overrides: { signals: { kinds: kindsInCode } } }, store);
      expect(cw.policy.get().layerError?.path).toBe('layer.signals.kinds');
      expect(logged.some(([e]) => e === 'chatwarden.policy_layer_invalid')).toBe(true);
    });

    it('nothing is logged and nothing is dropped when every stored feed is usable', async () => {
      const store = new MemoryStore();
      store.savePolicyLayer?.({ signals: { feeds: { record: { kinds: '*', windowDays: 14 } } } }, 0);
      const { cw, logged } = await world({ overrides: { signals: { kinds: kindsInCode } } }, store);
      expect(Object.keys(cw.profile.signals.feeds)).toEqual(['record']);
      expect(logged.filter(([e]) => e.startsWith('chatwarden.signal') || e.startsWith('chatwarden.policy'))).toEqual([]);
    });

    it('a second process reading a layer saved by this one (same store) sees the same feeds', async () => {
      const { cw, store } = await world({ overrides: { signals: { kinds: kindsInCode } } });
      cw.policy.save({ signals: { feeds: { record: { kinds: '*', windowDays: 14 } } } }, { version: 0, ...OWNER });
      const { cw: other } = await world({ overrides: { signals: { kinds: kindsInCode } } }, store);
      expect(Object.keys(other.profile.signals.feeds)).toEqual(['record']);
      void NOW;
    });
  });
});
