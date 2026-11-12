import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemorySignals } from '@chatwarden/store-memory';
import type { PolicyLayer } from '../src/profile.js';
import type { Store } from '../src/types.js';
import { NOW, OWNER, world as plainWorld } from './reportingWorld.js';

// The stale-feed rule (review FB, I1): a stored feed that can no longer be used is dropped at load. What the owner (and the hub) reads as
// the layer is the layer in force, with those feeds taken out, and `dropped` says what went and why, so a save that sends the layer
// back is never refused for a feed the owner cannot see. Save stays strict for what the caller submits.

const DAY = 86_400_000;
const world = (over: Parameters<typeof plainWorld>[0] = {}, store: Store = withMemorySignals(new MemoryStore())) => plainWorld(over, store);

const kindsInCode = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
  commended: { label: 'Commended by other players', polarity: 'positive' as const },
};
const overrides = { signals: { kinds: kindsInCode } };
const ladderEdit = { firstOffense: { rude: { kind: 'chat' as const, durationMs: 3_600_000 } } };
const GOOD = { record: { kinds: '*', windowDays: 14 } };

/** A kit whose store already holds `layer` (as an earlier process saved it). */
async function stored(layer: unknown, over: Parameters<typeof plainWorld>[0] = {}) {
  const store = withMemorySignals(new MemoryStore());
  store.savePolicyLayer?.(layer as PolicyLayer, 0);
  const w = await world({ overrides, ...over }, store);
  return { ...w, store };
}

describe('the layer the owner reads is the layer in force', () => {
  it('a stored feed naming a kind the code stopped declaring is gone from get().layer, and dropped says so', async () => {
    const { cw } = await stored({ ...ladderEdit, signals: { feeds: { ...GOOD, queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } });
    const state = cw.policy.get();
    expect(state.layer.signals).toEqual({ feeds: GOOD });
    expect(state.layer.firstOffense).toEqual(ladderEdit.firstOffense);
    expect(state.dropped).toEqual([{ feed: 'queue', reason: 'unknown_kind' }]);
    expect(state.layerError).toBeUndefined();
    expect(Object.keys(state.effective.signals.feeds)).toEqual(['record']);
  });

  it('the version stays the stored one, and the stored row itself is not rewritten at load', async () => {
    const { cw, store } = await stored({ signals: { feeds: { queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } });
    expect(cw.policy.get().version).toBe(1);
    expect(JSON.stringify(store.loadPolicyLayer?.()?.layer)).toContain('removed_kind');
  });

  it.each([
    ['unknown_kind', 'queue', { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 }],
    ['positive_kind', 'queue', { kinds: ['commended'], minDistinct: 3, windowDays: 7 }],
    ['window', 'record', { kinds: '*', windowDays: 60 }],
    ['invalid', 'queue', { kinds: ['muted_by_player'], minDistinct: 'many', windowDays: 7 }],
  ])('reason %s: feed %s is dropped with that code', async (reason, feed, value) => {
    const { cw } = await stored({ signals: { feeds: { [feed]: value } } }, { retention: { signalsMs: 14 * DAY } });
    expect(cw.policy.get().dropped).toEqual([{ feed, reason }]);
    expect(cw.policy.get().layer.signals).toEqual({ feeds: {} });
  });

  it('a feed name the kit does not have is dropped as "unknown", and the stored name is never echoed', async () => {
    const { cw } = await stored({ signals: { feeds: { ...GOOD, zorbak_feed: { kinds: '*', windowDays: 7 } } } });
    const state = cw.policy.get();
    expect(state.dropped).toEqual([{ feed: 'unknown', reason: 'unknown_feed' }]);
    expect(JSON.stringify(state.layer)).not.toContain('zorbak_feed');
    expect(JSON.stringify(state.dropped)).not.toContain('zorbak_feed');
  });

  it('a ladder rule that went stale is dropped alone: the feed stays with the good rule, and "ladder" is named once', async () => {
    const good = { id: 'good', effect: 'note', kinds: ['muted_by_player'], minDistinct: 3, windowDays: 14 };
    const stale = { id: 'stale', effect: 'raise', kinds: ['commended'], minDistinct: 3, windowDays: 14 };
    const stale2 = { id: 'stale2', effect: 'note', kinds: ['removed_kind'], minDistinct: 3, windowDays: 14 };
    const { cw } = await stored({ signals: { feeds: { ladder: [good, stale, stale2] } } });
    const state = cw.policy.get();
    expect(state.layer.signals?.feeds?.ladder).toEqual([good]);
    expect(state.dropped).toEqual([{ feed: 'ladder', reason: 'positive_kind' }]);
  });

  it('dropped holds a feed name and a reason code only: no kind id, label, window or id of a rule', async () => {
    const { cw } = await stored({ signals: { feeds: { queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 }, ladder: [{ id: 'my-private-rule', effect: 'note', kinds: ['gone_kind'], minDistinct: 2, windowDays: 7 }] } } });
    const dropped = cw.policy.get().dropped ?? [];
    expect(dropped.length).toBe(2);
    for (const d of dropped) expect(Object.keys(d).sort()).toEqual(['feed', 'reason']);
    const text = JSON.stringify(dropped);
    for (const secret of ['removed_kind', 'gone_kind', 'my-private-rule']) expect(text).not.toContain(secret);
  });

  it('nothing dropped: there is no dropped field at all, and the layer is what was stored', async () => {
    const { cw } = await stored({ signals: { feeds: GOOD } });
    const state = cw.policy.get();
    expect('dropped' in state).toBe(false);
    expect(state.layer).toEqual({ signals: { feeds: GOOD } });
  });

  it('with no stored layer, or a layer without signals, there is no dropped field', async () => {
    const a = await world({ overrides });
    expect('dropped' in a.cw.policy.get()).toBe(false);
    const b = await stored({ ...ladderEdit });
    expect('dropped' in b.cw.policy.get()).toBe(false);
    expect(b.cw.policy.get().layer).toEqual(ladderEdit);
  });

  it('the exposed layer and dropped are frozen copies: changing what get() returned changes nothing', async () => {
    const { cw } = await stored({ signals: { feeds: { queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } });
    const state = cw.policy.get();
    expect(Object.isFrozen(state.layer)).toBe(true);
    expect(() => (state.dropped as unknown as Array<unknown>).push({ feed: 'x' })).toThrow();
    expect(cw.policy.get().dropped).toEqual([{ feed: 'queue', reason: 'unknown_kind' }]);
  });

  it('a layer that is bad in some other way is still ignored whole: layerError, no dropped', async () => {
    const { cw } = await stored({ ...ladderEdit, signals: { kinds: { x_kind: {} } } });
    const state = cw.policy.get();
    expect(state.layerError?.path).toBe('layer.signals.kinds');
    expect('dropped' in state).toBe(false);
  });
});

describe('the stuck-save scenario', () => {
  const staleLayer = { ...ladderEdit, signals: { feeds: { ...GOOD, queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } };

  it('an unrelated edit made from get().layer is saved: the hub sends back what it read', async () => {
    const { cw, store } = await stored(staleLayer);
    const read = cw.policy.get();
    const next: PolicyLayer = { ...read.layer, pace: { slowModeMs: 2000 } };
    const res = cw.policy.save(next, { version: read.version, ...OWNER });
    expect(res).toEqual({ ok: true, version: 2, changed: ['pace'] });
    // The stored row is repaired by that save, and nothing is left to drop.
    expect(JSON.stringify(store.loadPolicyLayer?.()?.layer)).not.toContain('removed_kind');
    const after = cw.policy.get();
    expect('dropped' in after).toBe(false);
    expect(after.layer.signals).toEqual({ feeds: GOOD });
    expect(after.effective.pace.slowModeMs).toBe(2000);
    expect(after.effective.firstOffense.rude).toEqual(ladderEdit.firstOffense.rude);
  });

  it('saving the very layer that was read (no edit) succeeds, and repairs the row', async () => {
    const { cw, store } = await stored(staleLayer);
    const read = cw.policy.get();
    expect(cw.policy.save(read.layer, { version: read.version, ...OWNER })).toMatchObject({ ok: true });
    expect(JSON.stringify(store.loadPolicyLayer?.()?.layer)).not.toContain('removed_kind');
  });

  it('the same holds for a window that a lowered retention made too long, and for the ladder section edit', async () => {
    const { cw } = await stored({ ...ladderEdit, signals: { feeds: { record: { kinds: '*', windowDays: 60 } } } }, { retention: { signalsMs: 14 * DAY } });
    const read = cw.policy.get();
    expect(read.dropped).toEqual([{ feed: 'record', reason: 'window' }]);
    const res = cw.policy.save({ ...read.layer, firstOffense: { rude: { kind: 'chat', durationMs: 7_200_000 } } }, { version: read.version, ...OWNER });
    expect(res).toMatchObject({ ok: true, changed: ['firstOffense'] });
  });

  it('save stays strict for what is submitted: the stale feed sent back by hand is refused with its layer path, nothing written', async () => {
    const { cw } = await stored(staleLayer);
    const res = cw.policy.save(staleLayer as PolicyLayer, { version: 1, ...OWNER });
    expect(res).toEqual({ ok: false, error: 'invalid', path: 'layer.signals.feeds.queue.kinds[0]' });
    expect(cw.policy.get().version).toBe(1);
  });

  it('a conflict (stale version) is still a conflict, not hidden by the pruned layer', async () => {
    const { cw } = await stored(staleLayer);
    expect(cw.policy.save(cw.policy.get().layer, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'conflict' });
  });

  it('reset("signals") with a dropped feed in the stored row clears it', async () => {
    const { cw, store } = await stored(staleLayer);
    expect(cw.policy.reset('signals')).toMatchObject({ ok: true });
    expect(JSON.stringify(store.loadPolicyLayer?.()?.layer)).not.toContain('removed_kind');
    expect('dropped' in cw.policy.get()).toBe(false);
  });

  it('another process saving a repaired layer replaces dropped on the next read', async () => {
    const a = await stored(staleLayer);
    const b = await world({ overrides }, a.store);
    expect(b.cw.policy.save(b.cw.policy.get().layer, { version: 1, ...OWNER })).toMatchObject({ ok: true });
    a.clock.t += 11_000;
    expect('dropped' in a.cw.policy.get()).toBe(false);
    void NOW;
  });

  it('preview of the layer read from get() is accepted too (the hub previews before it saves)', async () => {
    const { cw } = await stored(staleLayer);
    expect(cw.policy.preview(cw.policy.get().layer).ok).toBe(true);
  });
});
