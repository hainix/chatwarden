import type { LiveTerms, TermPack } from '@chatwarden/matcher';
import { vi } from 'vitest';
import { world, type WorldOptions } from './world.js';

// A world with the shared term list wired in (K7 task 10): a fake loader that hands the real `LiveTerms` a synthetic release, and a fake
// share object that records what it was given. Invented words only. Nothing here touches a network or a disk.

export const VERSION = '2026.12.0';
/** The adopter's own word in these tests (not in the synthetic pack, not a community word). */
export const OWN_WORD = 'fenriskz';
export const COMMUNITY_ACTOR = `corpus:${VERSION}`;

/** The words the corpus adds in these tests: none is in the synthetic pack the world starts from. */
export const COMMUNITY_WORDS = ['glarn', 'tarvox', 'quisselo'] as const;

export const communityPack = (version = VERSION, over: { active?: Record<string, boolean> } = {}): TermPack => ({
  id: 'chatwarden-corpus',
  version,
  terms: COMMUNITY_WORDS.map((term, i) => ({
    id: `CWT-2026-0000${i + 1}`,
    term,
    language: 'en',
    active: over.active?.[term] ?? true,
    positive: [`you ${term}`],
    negative: [],
  })),
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

export interface FakeLoader {
  /** What `status()` answers; a test changes it. */
  current: FakeStatus;
  status: () => FakeStatus;
  /** What a refresh does to the status. */
  onRefresh: () => void;
  refresh: ReturnType<typeof vi.fn>;
  applyTo: ReturnType<typeof vi.fn>;
  /** The verified release, or null. Carries invented rows on purpose, so a leak into a response would show. */
  release: () => unknown;
  /** The pack `applyTo` hands to the live list; null means nothing is verified. */
  pack: TermPack | null;
  /** Make the next `applyTo` throw. */
  throwOnApply: boolean;
}

export function fakeLoader(live: LiveTerms, over: Partial<FakeStatus> = {}): FakeLoader {
  const f: FakeLoader = {
    status: () => ({ ...f.current }),
    current: {
      state: 'ready',
      applied: null,
      available: VERSION,
      lastCheckedAt: 1_800_000_000_000,
      lastError: null,
      pending: { added: 3, deactivated: 0, reactivated: 0, changed: 0, keptYours: 0, skipped: 0 },
      ...over,
    },
    onRefresh: () => undefined,
    refresh: vi.fn(),
    applyTo: vi.fn(),
    release: () => ({
      version: VERSION,
      manifest: {
        languages: ['en', 'es'],
        license: { spdx: 'CC-BY-4.0', attribution: 'Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.' },
        counts: { terms: { en: 3, es: 0 }, exceptions: { en: 1, es: 0 }, status: { accepted: 2, provisional: 1, disputed: 0, withdrawn: 0 } },
      },
      // Not part of what the route may read: a response that carries any of it is a leak.
      terms: COMMUNITY_WORDS.map((term) => ({ term })),
    }),
    pack: communityPack(),
    throwOnApply: false,
  };
  f.refresh.mockImplementation(async () => {
    f.onRefresh();
    return { status: { ...f.current }, changed: true };
  });
  f.applyTo.mockImplementation((terms: LiveTerms, actor?: string) => {
    if (f.throwOnApply) throw new Error(`apply exploded on ${COMMUNITY_WORDS[0]}`);
    if (f.pack === null) return null;
    const r = terms.syncPack(f.pack, { actor: actor ?? `corpus:${f.pack.version}` });
    if (r.ok) f.current = { ...f.current, applied: f.pack.version, available: null, pending: null };
    return r;
  });
  return f;
}

export type ShareCall = { term: string; language: string; category: string; target?: string; note?: string | null };

export interface FakeShare {
  calls: ShareCall[];
  statusCalls: string[];
  result: unknown;
  statusResult: unknown;
  throws: boolean;
  share: (input: ShareCall) => Promise<unknown>;
  status: (id: string) => Promise<unknown>;
}

export function fakeShare(): FakeShare {
  const f: FakeShare = {
    calls: [],
    statusCalls: [],
    result: { ok: true, status: 'received', id: 'sub_abc123' },
    statusResult: { status: 'in_review' },
    throws: false,
    share: async (input) => {
      f.calls.push(structuredClone(input));
      if (f.throws) throw new Error(`share exploded on ${input.term}`);
      return f.result;
    },
    status: async (id) => {
      f.statusCalls.push(id);
      if (f.throws) throw new Error(`status exploded on ${id}`);
      return f.statusResult;
    },
  };
  return f;
}

export interface CommunityOptions extends Omit<WorldOptions, 'community'> {
  /** Give the community a share object (default true). */
  share?: boolean;
  exposeCommunityRows?: boolean;
  /** Put the corpus rows in the live list before the first request (default true). */
  seedCorpus?: boolean;
  status?: Partial<FakeStatus>;
}

/** The staff world with `community` wired. Returns the pieces the tests poke at. */
export async function communityWorld(over: CommunityOptions = {}) {
  let loader!: FakeLoader;
  const share = fakeShare();
  const w = await world({
    ...over,
    community: (live) => {
      loader = fakeLoader(live, over.status);
      return {
        loader: loader as never,
        live,
        ...(over.share === false ? {} : { share: share as never }),
        ...(over.exposeCommunityRows === undefined ? {} : { exposeCommunityRows: over.exposeCommunityRows }),
      };
    },
  });
  if (over.seedCorpus !== false) {
    const r = w.live.syncPack(communityPack(), { actor: COMMUNITY_ACTOR });
    if (!r.ok) throw new Error(`seed refused: ${r.code}`);
    w.logged.length = 0;
  }
  const rowByWord = (word: string) => w.live.records?.().terms.find((t) => t.term === word);
  // One row of the adopter's own, with an id that is not the word, so an audit row or a log line that held the word could be told apart.
  const made = w.live.changeSync('seed-admin', (e) => e.addTerm({ term: OWN_WORD, language: 'en' }));
  if (!made.ok) throw new Error('own row refused');
  w.logged.length = 0;
  const own = { id: made.value, term: OWN_WORD };
  return { ...w, loader, share, rowByWord, own };
}
