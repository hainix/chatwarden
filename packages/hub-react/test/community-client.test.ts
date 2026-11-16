import { describe, expect, it } from 'vitest';
import { OWN_WORD } from './communityWorld.js';
import { hubWorld } from './world.js';

// The client has one method for each community route (design 8.5), and the word travels in a body, never in an address.

describe('the client has one method for each community route', () => {
  it('community, refreshCommunity, applyCommunity, getTerm, lookupTerm, shareTerm and shareStatus hit exactly the new routes, with a word only in a body', async () => {
    const plain = await hubWorld({ role: 'owner' });
    const w = await hubWorld({ role: 'owner', community: { seed: false } });
    const added = Object.keys(w.routes)
      .filter((k) => !(k in plain.routes))
      .map((k) => k.replace('~ref', ''))
      .sort();
    expect(added).toEqual(['GET /community', 'GET /terms/:id', 'GET /terms/:id/share', 'POST /community/apply', 'POST /community/refresh', 'POST /terms/:id/share', 'POST /terms/lookup']);
    const own = (await w.direct.addTerm({ term: OWN_WORD, language: 'en' })).id;
    w.sent.length = 0;
    const c = w.client;
    expect(await c.community()).toMatchObject({ state: 'ready', sharing: true, available: '2026.12.0' });
    expect(await c.refreshCommunity()).toMatchObject({ state: 'ready' });
    expect(await c.getTerm(own)).toMatchObject({ id: own, term: OWN_WORD, community: false });
    expect(await c.lookupTerm(OWN_WORD)).toMatchObject({ id: own });
    // Never shared: null, not an error.
    expect(await c.shareStatus(own)).toBeNull();
    expect(await c.shareTerm(own, { category: 'other' })).toEqual({ status: 'received' });
    expect(await c.shareStatus(own)).toEqual({ status: 'in_review' });
    expect(await c.applyCommunity()).toMatchObject({ ok: true, version: '2026.12.0' });
    expect(w.sent.map((r) => `${r.method} ${r.path.replace(own, ':id')}`)).toEqual([
      'GET /community',
      'POST /community/refresh',
      'GET /terms/:id',
      'POST /terms/lookup',
      'GET /terms/:id/share',
      'POST /terms/:id/share',
      'GET /terms/:id/share',
      'POST /community/apply',
    ]);
    expect(w.sent[3]?.body).toEqual({ word: OWN_WORD });
    for (const r of w.sent) expect(`${r.path}${JSON.stringify(r.query ?? {})}`).not.toContain(OWN_WORD);
    // Errors come back as the hub's own error, by code.
    expect(await c.getTerm('nope').catch((e: unknown) => e)).toMatchObject({ status: 404, code: 'not_found' });
    expect(await c.lookupTerm('nothingatall').catch((e: unknown) => e)).toMatchObject({ status: 404 });
    expect(await c.shareStatus('nope').catch((e: unknown) => e)).toMatchObject({ status: 404 });
  });

  it('without community each of them fails with a not found or a method error, which the hub reads as "not set up"', async () => {
    const w = await hubWorld({ role: 'owner' });
    for (const call of [() => w.client.community(), () => w.client.refreshCommunity(), () => w.client.applyCommunity(), () => w.client.lookupTerm('zorbak'), () => w.client.shareTerm('syn:zorbak', { category: 'other' })]) {
      expect(await call().catch((e: unknown) => e)).toMatchObject({ code: expect.stringMatching(/^(not_found|method_not_allowed)$/) });
    }
  });
});
