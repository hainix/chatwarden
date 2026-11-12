import { MemoryStore, withMemorySignals } from '@chatwarden/store-memory';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { SignalFeeds, SignalGuards, SignalKindSpec } from '../src/signals.js';
import type { RawWho, SignalRow, Store, SubjectId } from '../src/types.js';
import { world } from './reportingWorld.js';

// A kit with signal kinds declared, for the signal service, flood and feed tests: people are seated by key and found again by key.

export const DAY = 86_400_000;
export const MIN = 60_000;

export const KINDS: Record<string, SignalKindSpec> = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' },
  blocked_by_player: { label: 'Blocked by other players', polarity: 'negative' },
  kicked_from_room: { label: 'Kicked from a room', polarity: 'negative', weight: 2 },
  left_mid_game: { label: 'Left mid-game', polarity: 'negative', weight: 0.5 },
  commended: { label: 'Commended by other players', polarity: 'positive' },
};

export interface SignalWorldOptions extends Partial<ChatwardenOptions> {
  kinds?: Record<string, SignalKindSpec>;
  guards?: SignalGuards;
  feeds?: SignalFeeds;
}

/** The rows an in-memory store with `withMemorySignals` holds, for tests that look at what was written (not part of the Store contract). */
export const signalRowsOf = (store: Store): SignalRow[] => [...((store as unknown as { sig?: { rows: Map<string, SignalRow> } }).sig?.rows.values() ?? [])];

export async function sworld(opts: SignalWorldOptions = {}, store: Store = withMemorySignals(new MemoryStore())) {
  const { kinds = KINDS, guards, feeds, overrides, ...rest } = opts;
  const w = await world(
    {
      ...rest,
      overrides: { ...(overrides ?? {}), signals: { kinds, ...(guards === undefined ? {} : { guards }), ...(feeds === undefined ? {} : { feeds }) } },
    },
    store,
  );
  let n = 0;
  const seated = new Map<string, SubjectId>();
  /** Seat a person by key (once) and return their canonical subject id. */
  const person = (key: string = `key-${++n}`, extra: RawWho = {}): SubjectId => {
    const room = `seat-room-${key}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: key, ...extra }, `H-${key}`);
    const subject = w.cw.rooms.subjectAt(room, 'p1') as SubjectId;
    seated.set(key, subject);
    return subject;
  };
  const who = (key: string, extra: RawWho = {}): RawWho => ({ clientKey: key, ...extra });
  return { ...w, person, who };
}

export type SignalWorld = Awaited<ReturnType<typeof sworld>>;
