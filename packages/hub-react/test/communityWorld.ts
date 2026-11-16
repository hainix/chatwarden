import type { LiveTerms, TermPack } from '@chatwarden/matcher';

// The shared term list for the hub's tests: a fake loader that hands the REAL `LiveTerms` a synthetic release, and a fake share object that
// records what it was given. The routes the hub talks to are the real ones (`adminRoutes` with `community`). Invented words only.

export const COMMUNITY_VERSION = '2026.12.0';
export const COMMUNITY_ACTOR = `corpus:${COMMUNITY_VERSION}`;
/** The words the corpus adds in these tests: none is in the synthetic pack the world starts from. */
export const COMMUNITY_WORDS = ['glarn', 'tarvox', 'quisselo'] as const;
/** The adopter's own word, added by the tests that need one to share. */
export const OWN_WORD = 'fenriskz';

export const communityPack = (version = COMMUNITY_VERSION): TermPack => ({
  id: 'chatwarden-corpus',
  version,
  terms: COMMUNITY_WORDS.map((term, i) => ({ id: `CWT-2026-0000${i + 1}`, term, language: 'en', active: true, positive: [`you ${term}`], negative: [] })),
  exceptions: [{ id: 'CWX-2026-00001', phrase: 'glarn lake', language: 'en', active: true }],
  negativeCorpus: [],
  knownLosses: [],
});

export interface FakeStatus {
  state: string;
  applied: string | null;
  available: string | null;
  lastCheckedAt: number | null;
  lastError: { code: string; stage: string; at: number } | null;
  pending: { added: number; deactivated: number; reactivated: number; changed: number; keptYours: number; skipped: number } | null;
}

export interface CommunityRig {
  /** What `status()` answers; a test changes it. */
  current: FakeStatus;
  /** What a refresh does to the status. */
  onRefresh: () => void;
  refreshes: number;
  applies: Array<string | undefined>;
  /** The pack `applyTo` hands to the live list; null means nothing is verified. */
  pack: TermPack | null;
  /** The release the status page reads its languages, licence and counts from. */
  release: () => unknown;
  shareCalls: Array<Record<string, unknown>>;
  statusCalls: string[];
  /** What the next `share` answers; a function can wait or throw. */
  shareResult: unknown | (() => Promise<unknown>);
  statusResult: unknown;
}

export interface CommunityOptions {
  /** Give the community a share object (default true). */
  share?: boolean;
  exposeCommunityRows?: boolean;
  /** Put the corpus rows in the live list before the first request (default true). */
  seed?: boolean;
  status?: Partial<FakeStatus>;
}

export function makeCommunity(live: LiveTerms, options: CommunityOptions = {}) {
  const rig: CommunityRig = {
    current: {
      state: 'ready',
      applied: null,
      available: COMMUNITY_VERSION,
      lastCheckedAt: 1_800_000_000_000 - 60_000,
      lastError: null,
      pending: { added: 3, deactivated: 0, reactivated: 0, changed: 0, keptYours: 0, skipped: 0 },
      ...options.status,
    },
    onRefresh: () => undefined,
    refreshes: 0,
    applies: [],
    pack: communityPack(),
    release: () => ({
      version: COMMUNITY_VERSION,
      manifest: {
        languages: ['en', 'es'],
        license: { spdx: 'CC-BY-4.0', attribution: 'Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.' },
        counts: { terms: { en: 3, es: 2 }, exceptions: { en: 1, es: 0 }, status: { accepted: 4, provisional: 1, disputed: 0, withdrawn: 0 } },
      },
      // Not part of what the routes may read: a page that shows any of it is a leak.
      terms: COMMUNITY_WORDS.map((term) => ({ term })),
    }),
    shareCalls: [],
    statusCalls: [],
    shareResult: { ok: true, status: 'received', id: 'sub_abc123' },
    statusResult: { status: 'in_review' },
  };
  const loader = {
    refresh: async () => {
      rig.refreshes += 1;
      rig.onRefresh();
      return { status: { ...rig.current }, changed: true };
    },
    status: () => ({ ...rig.current }),
    release: () => rig.release(),
    applyTo: (terms: LiveTerms, actor?: string) => {
      rig.applies.push(actor);
      if (rig.pack === null) return null;
      const r = terms.syncPack(rig.pack, { actor: actor ?? `corpus:${rig.pack.version}` });
      if (r.ok) rig.current = { ...rig.current, applied: rig.pack.version, available: null, pending: null };
      return r;
    },
  };
  const share = {
    share: async (input: Record<string, unknown>) => {
      rig.shareCalls.push(structuredClone(input));
      return typeof rig.shareResult === 'function' ? (rig.shareResult as () => Promise<unknown>)() : rig.shareResult;
    },
    status: async (id: string) => {
      rig.statusCalls.push(id);
      return rig.statusResult;
    },
  };
  if (options.seed !== false) {
    const r = live.syncPack(communityPack(), { actor: COMMUNITY_ACTOR });
    if (!r.ok) throw new Error(`seed refused: ${r.code}`);
    rig.current = { ...rig.current, applied: COMMUNITY_VERSION, available: null, pending: null };
  }
  return {
    rig,
    admin: {
      loader: loader as never,
      live,
      ...(options.share === false ? {} : { share: share as never }),
      ...(options.exposeCommunityRows === undefined ? {} : { exposeCommunityRows: options.exposeCommunityRows }),
    },
  };
}
