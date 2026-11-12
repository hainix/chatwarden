import { describe, expect, it } from 'vitest';
import type { PolicyLayer } from '@chatwarden/core';
import { errorOf, world } from './world.js';

// A stored signal feed that went stale (the code stopped declaring its kind): GET /policy/profile shows the layer in force, with the feed
// taken out, plus `dropped` (a feed name and a reason code); a PUT that sends that layer back is accepted and repairs the stored row.

const kinds = { muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const } };
const stale = { signals: { feeds: { record: { kinds: '*', windowDays: 14 }, queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } } as PolicyLayer;
const PUT = (body: unknown) => ({ role: 'owner' as const, actor: 'owner_ann', body });

interface ProfileBody {
  layer: PolicyLayer;
  version: number;
  dropped?: Array<{ feed: string; reason: string }>;
}

async function staleWorld() {
  const w = await world({ overrides: { signals: { kinds } } });
  w.store.savePolicyLayer?.(stale, 0);
  return w;
}

describe('a dropped signal feed over /policy/profile', () => {
  it('GET shows the pruned layer and dropped, and the body names no kind id', async () => {
    const { call } = await staleWorld();
    const res = await call('GET', '/policy/profile');
    const body = res.body as ProfileBody;
    expect(res.status).toBe(200);
    expect(body.layer).toEqual({ signals: { feeds: { record: { kinds: '*', windowDays: 14 } } } });
    expect(body.dropped).toEqual([{ feed: 'queue', reason: 'unknown_kind' }]);
    expect(body.version).toBe(1);
    expect(JSON.stringify(body.dropped)).not.toContain('removed_kind');
  });

  it('the stuck save: PUT of the layer GET returned, plus an unrelated edit, is 200 and the answer has no dropped', async () => {
    const { call, store } = await staleWorld();
    const read = (await call('GET', '/policy/profile')).body as ProfileBody;
    const res = await call('PUT', '/policy/profile', PUT({ layer: { ...read.layer, pace: { slowModeMs: 2000 } }, version: read.version, reason: 'a quiet room' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: 2, changed: ['pace', 'signals'] });
    expect('dropped' in (res.body as object)).toBe(false);
    expect(JSON.stringify(store.loadPolicyLayer?.()?.layer)).not.toContain('removed_kind');
    expect('dropped' in ((await call('GET', '/policy/profile')).body as object)).toBe(false);
  });

  it('a PUT that still names the stale feed is 400 invalid_profile with its layer path', async () => {
    const { call } = await staleWorld();
    const res = await call('PUT', '/policy/profile', PUT({ layer: stale, version: 1, reason: 'by hand' }));
    expect([res.status, errorOf(res), (res.body as { path: string }).path]).toEqual([400, 'invalid_profile', 'layer.signals.feeds.queue.kinds[0]']);
  });

  it('with nothing dropped GET has no dropped field', async () => {
    const { call } = await world({ overrides: { signals: { kinds } } });
    expect('dropped' in ((await call('GET', '/policy/profile')).body as object)).toBe(false);
  });
});
