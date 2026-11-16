import { createCommunityShare, createCorpusLoader, type CommunityShare, type CorpusLoader } from '@chatwarden/matcher/corpus';
import { describe, expect, it } from 'vitest';
import type { CommunityLoader, CommunityShareClient } from '../src/admin/community.js';
import { communityWorld } from './communityWorld.js';
import { world } from './world.js';

// This package imports no matcher code: it describes the loader and the share client by small structural types. These checks make the
// compiler (`npm run typecheck`) prove that the matcher's own objects still fit them, so a later change in the matcher cannot break the
// fit unseen. The run-time half hands real objects to the real routes.

// Compile-time: each line fails the build if the matcher's type stops fitting.
const asLoader = (x: CorpusLoader): CommunityLoader => x;
const asShare = (x: CommunityShare): CommunityShareClient => x;
void asLoader;
void asShare;

const cache = { read: async () => null, write: async () => undefined, remove: async () => undefined };

describe('the matcher\'s own loader and share client fit what the community routes ask for', () => {
  it('real objects (a loader with no trusted keys, a share client with a fake signer) serve GET /community, refresh and the share routes', async () => {
    const loader = createCorpusLoader({ select: { languages: ['en'] }, cache, clock: { now: () => 1_800_000_000_000 }, follow: 'stable', keys: [], kit: '0.1.11', logger: { warn: () => undefined } });
    const share = createCommunityShare({
      sign: async () => 'c2ln',
      publicKey: 'A'.repeat(43),
      clock: { now: () => 1_800_000_000_000 },
      fetch: async () => new Response(JSON.stringify({ status: 'received', id: 'sub_abc123' }), { status: 202 }),
      stampBits: 0,
      logger: { warn: () => undefined },
    });
    const w = await world({ community: (live) => ({ loader, live, share }) });
    const status = await w.call('GET', '/community');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: 'none', applied: null, sharing: true, reporting: true, lastError: null });
    const refreshed = await w.call('POST', '/community/refresh');
    expect(refreshed.status).toBe(200);
    // With no trusted keys the loader says so by a code, and nothing is applied.
    expect(refreshed.body).toMatchObject({ lastError: { code: 'no_trusted_keys', stage: 'verify' } });
    expect((await w.call('POST', '/community/apply', { role: 'owner' })).status).toBe(409);
    expect(Object.keys(w.routes).filter((k) => /share|report/.test(k) && /terms/.test(k)).sort()).toEqual(['GET /terms/:id~ref/share', 'POST /terms/:id~ref/report', 'POST /terms/:id~ref/share']);
  });

  it('the fake used by the other tests has the same shape as the real share client', async () => {
    const real = createCommunityShare({ sign: async () => 'c2ln', publicKey: 'A'.repeat(43), clock: { now: () => 0 } });
    const w = await communityWorld();
    expect(Object.keys(w.share).filter((k) => typeof (w.share as unknown as Record<string, unknown>)[k] === 'function').sort()).toEqual(expect.arrayContaining(Object.keys(real).sort()));
  });
});
