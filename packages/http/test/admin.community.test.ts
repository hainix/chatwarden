import { describe, expect, it } from 'vitest';
import { COMMUNITY_ACTOR, COMMUNITY_WORDS, VERSION, communityWorld } from './communityWorld.js';
import { world } from './world.js';

// The community routes of design 8.5: status, refresh and apply. Invented words only. No term may appear in any body.

const text = (v: unknown): string => JSON.stringify(v);
const noWords = (v: unknown): void => {
  for (const word of [...COMMUNITY_WORDS, 'zorbak', 'vlemmo', 'snerp']) expect(text(v), word).not.toContain(word);
};

describe('GET /community', () => {
  it('shape: the state, versions, a pending count, the error as a code and a stage, languages, licence and counts, and no term anywhere', async () => {
    const w = await communityWorld();
    const res = await w.call('GET', '/community');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      state: 'ready',
      applied: null,
      available: VERSION,
      lastCheckedAt: 1_800_000_000_000,
      pending: { added: 3, deactivated: 0, reactivated: 0, changed: 0, keptYours: 0, skipped: 0 },
      lastError: null,
      languages: ['en', 'es'],
      license: { spdx: 'CC-BY-4.0', attribution: 'Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.' },
      sharing: true,
      counts: { terms: { en: 3, es: 0 }, exceptions: { en: 1, es: 0 }, status: { accepted: 2, provisional: 1, disputed: 0, withdrawn: 0 } },
    });
    noWords(res.body);
    expect(w.audit().filter((r) => r.role !== null)).toEqual([]);
  });

  it('an error is a code and a stage only (never the time, a message or a url); a status with nothing verified has null counts', async () => {
    const w = await communityWorld({ status: { state: 'failed', available: null, pending: null, lastError: { code: 'bad_signature', stage: 'verify', at: 5 } } });
    w.loader.release = () => null;
    const res = await w.call('GET', '/community');
    expect(res.body).toMatchObject({ state: 'failed', lastError: { code: 'bad_signature', stage: 'verify' }, pending: null, languages: [], license: null, counts: null });
    expect(Object.keys((res.body as { lastError: object }).lastError).sort()).toEqual(['code', 'stage']);
  });

  it('sharing is true only with a share object', async () => {
    expect(((await (await communityWorld({ share: false })).call('GET', '/community')).body as { sharing: boolean }).sharing).toBe(false);
    expect(((await (await communityWorld()).call('GET', '/community')).body as { sharing: boolean }).sharing).toBe(true);
  });

  it('404 when community is not wired, with every community route', async () => {
    const w = await world();
    for (const [method, path] of [['GET', '/community'], ['POST', '/community/refresh'], ['POST', '/community/apply']] as const) {
      expect((await w.call(method, path, { role: 'owner' })).status, `${method} ${path}`).toBe(404);
    }
    expect(Object.keys(w.routes).filter((k) => /community/.test(k))).toEqual([]);
  });

  it('needs terms.read, can be raised, and 401s without a caller', async () => {
    const w = await communityWorld({ permissions: { 'terms.read': 'senior' } });
    expect((await w.call('GET', '/community', { role: 'moderator' })).status).toBe(403);
    expect((await w.call('GET', '/community', { role: 'senior' })).status).toBe(200);
    expect((await w.call('GET', '/community', { role: null })).status).toBe(401);
  });

  it('an object with a missing or hostile release is still a fixed answer (no throw, no leak)', async () => {
    const w = await communityWorld();
    w.loader.release = () => {
      throw new Error('boom on glarn');
    };
    const res = await w.call('GET', '/community');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ languages: [], license: null, counts: null });
    noWords(res.body);
    w.loader.release = () => ({ version: VERSION, manifest: { languages: 'en', license: 7, counts: { terms: { en: 'many' } } } });
    expect((await w.call('GET', '/community')).body).toMatchObject({ languages: [], license: null, counts: null });
  });
});

describe('POST /community/refresh', () => {
  it('needs terms.write, runs the loader once and answers what GET answers', async () => {
    const w = await communityWorld({ permissions: { 'terms.write': 'senior' } });
    expect((await w.call('POST', '/community/refresh', { role: 'moderator' })).status).toBe(403);
    expect(w.loader.refresh).not.toHaveBeenCalled();
    w.loader.onRefresh = () => {
      w.loader.current = { ...w.loader.current, state: 'offline', lastError: { code: 'offline', stage: 'index', at: 9 } };
    };
    const res = await w.call('POST', '/community/refresh', { role: 'senior' });
    expect(res.status).toBe(200);
    expect(w.loader.refresh).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual((await w.call('GET', '/community', { role: 'senior' })).body);
    expect(res.body).toMatchObject({ state: 'offline', lastError: { code: 'offline', stage: 'index' } });
    noWords(res.body);
  });

  it('a loader that throws is a fixed 500, class only in the log', async () => {
    const w = await communityWorld();
    w.loader.refresh.mockRejectedValueOnce(new Error('refresh exploded on glarn'));
    const res = await w.call('POST', '/community/refresh');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(text(w.logged)).not.toContain('glarn');
  });
});

describe('POST /community/apply', () => {
  it('needs settings (owner); a moderator and a senior are 403 and nothing is applied', async () => {
    const w = await communityWorld();
    for (const role of ['moderator', 'senior'] as const) expect((await w.call('POST', '/community/apply', { role })).status).toBe(403);
    expect(w.loader.applyTo).not.toHaveBeenCalled();
    expect((await w.call('POST', '/community/apply', { role: null })).status).toBe(401);
  });

  it('applies the verified pack with NO staff actor, writes a community.apply audit row with target release:<version>, and returns the summary', async () => {
    const w = await communityWorld({ seedCorpus: false });
    const res = await w.call('POST', '/community/apply', { role: 'owner', actor: 'olivia' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: VERSION, summary: { added: 4, deactivated: 0, reactivated: 0, changed: 0, keptYours: 0, skipped: 0 } });
    // The loader was called with the live list and no actor: rows are the corpus's, never the moderator's.
    expect(w.loader.applyTo).toHaveBeenCalledTimes(1);
    expect(w.loader.applyTo.mock.calls[0]).toHaveLength(1);
    const added = w.live.records?.().terms.filter((t) => (COMMUNITY_WORDS as readonly string[]).includes(t.term)) ?? [];
    expect(added).toHaveLength(3);
    for (const row of added) expect(row).toMatchObject({ addedBy: COMMUNITY_ACTOR, updatedBy: null });
    expect(text(w.store.listTerms())).not.toContain('olivia');
    const rows = w.routeAudit().filter((r) => r.action === 'community.apply');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'olivia', role: 'owner', action: 'community.apply', target: { type: 'release', ref: VERSION } });
    noWords(res.body);
    noWords(rows);
  });

  it('with nothing verified it is 409 nothing_to_apply and writes no audit row; a refused apply is 409 apply_refused and writes none', async () => {
    const w = await communityWorld({ seedCorpus: false });
    w.loader.pack = null;
    const none = await w.call('POST', '/community/apply', { role: 'owner' });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: 'nothing_to_apply' });
    // A pack the live list will not take (not a pack at all) is refused by the live list itself.
    const w2 = await communityWorld({ seedCorpus: false });
    w2.loader.pack = { ...(w2.loader.pack as object), terms: 'nope' } as never;
    const refused = await w2.call('POST', '/community/apply', { role: 'owner' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'apply_refused' });
    expect(Object.keys(refused.body as object).sort()).toEqual(['error', 'message']);
    expect(w.routeAudit()).toEqual([]);
    expect(w2.routeAudit()).toEqual([]);
    noWords(refused.body);
  });

  it('a loader that throws is a fixed 500 with nothing in the audit trail and no word in the log', async () => {
    const w = await communityWorld({ seedCorpus: false });
    w.loader.throwOnApply = true;
    const res = await w.call('POST', '/community/apply', { role: 'owner' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
    expect(w.routeAudit()).toEqual([]);
    expect(text(w.logged)).not.toContain('glarn');
  });

  it('a second apply of the same release changes nothing (all zeros) and is audited again', async () => {
    const w = await communityWorld({ seedCorpus: false });
    await w.call('POST', '/community/apply', { role: 'owner' });
    const again = await w.call('POST', '/community/apply', { role: 'owner' });
    expect(again.body).toMatchObject({ ok: true, summary: { added: 0, changed: 0, keptYours: 0 } });
    expect(w.routeAudit().filter((r) => r.action === 'community.apply')).toHaveLength(2);
  });

  it('settings can be lowered, and the audit row still names the staff member', async () => {
    const w = await communityWorld({ seedCorpus: false, permissions: { settings: 'senior' } });
    expect((await w.call('POST', '/community/apply', { role: 'senior', actor: 'sam' })).status).toBe(200);
    expect(w.routeAudit()[0]).toMatchObject({ actor: 'sam', role: 'senior' });
  });
});

describe('responses carry no store header surprises and no identifier', () => {
  it('every community route answers with cache-control no-store and a body of fixed keys', async () => {
    const w = await communityWorld();
    for (const [method, path, role] of [['GET', '/community', 'moderator'], ['POST', '/community/refresh', 'moderator'], ['POST', '/community/apply', 'owner']] as const) {
      const res = await w.call(method, path, { role });
      expect(res.headers?.['cache-control'], path).toBe('no-store');
      noWords(res.body);
    }
  });
});

describe('GET /me says whether the community list is wired', () => {
  type Features = { appeals: boolean; renames: boolean; keepBlocked: boolean; community?: boolean };
  const meOf = async (w: { call: (m: string, p: string) => Promise<{ body: unknown }> }) => (await w.call('GET', '/me')).body as { features?: Features };

  it('with community: features.community is true, whatever else is on, and nothing about it is a term', async () => {
    const w = await communityWorld();
    const me = await meOf(w);
    expect(me.features).toEqual({ appeals: false, renames: false, keepBlocked: false, community: true });
    noWords(me);
  });

  it('without community the body is what it was: no features unless another is on, and never a community key', async () => {
    const plain = await world();
    expect((await meOf(plain)).features).toBeUndefined();
    const keep = await world({ overrides: { names: { keepBlocked: true } } });
    const features = (await meOf(keep)).features;
    expect(features).toBeDefined();
    expect(Object.hasOwn(features as object, 'community')).toBe(false);
  });

  it('is there for every signed-in role (it needs no permission), and a caller who is nobody is still a 401', async () => {
    const w = await communityWorld({ permissions: { 'terms.read': 'owner' } });
    expect(((await w.call('GET', '/me', { role: 'moderator' })).body as { features?: Features }).features?.community).toBe(true);
    expect((await w.call('GET', '/me', { role: null })).status).toBe(401);
  });
});
