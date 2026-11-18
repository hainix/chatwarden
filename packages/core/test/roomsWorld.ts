import { MemoryStore } from '@chatwarden/store-memory';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { KitEvent } from '../src/events.js';
import type { Store } from '../src/types.js';
import { world } from './reportingWorld.js';

// A kit for the room-mode tests: a synthetic matcher (blocks the word zorbak), an account-age table the tests edit, and the room.mode events collected.

export const SEC = 1000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export { DAY, NOW } from './reportingWorld.js';

export async function roomsWorld(over: Partial<ChatwardenOptions> = {}, store: Store = new MemoryStore()) {
  /** Account id to age in days; an id not in the table is unknown. */
  const ages = new Map<string, number>();
  const asked: string[][] = [];
  const w = await world(
    {
      matcher: { match: (text: string) => (/\bzorbak\b/i.test(text) ? { termId: 'syn:zorbak' } : null), spans: () => [] },
      signals: {
        accountAgeDays: (ids: readonly string[]) => {
          asked.push([...ids]);
          for (const id of ids) {
            const age = ages.get(id);
            if (age !== undefined) return age;
          }
          return undefined;
        },
      },
      ...over,
    },
    store,
  );
  const events: KitEvent[] = [];
  w.cw.on('room.mode', (e) => void events.push(e));
  let n = 0;
  /** Seat a player (their own account id and key) and return the seat id. */
  const player = (room: string, opts: { seat?: string; account?: string | null; ageDays?: number; handle?: string } = {}): string => {
    n += 1;
    const seat = opts.seat ?? `s${n}`;
    const account = opts.account === undefined ? `acct-${n}-aaaaaaaa` : opts.account;
    if (account !== null && opts.ageDays !== undefined) ages.set(account, opts.ageDays);
    w.cw.rooms.seat(room, seat, { clientKey: `key-${n}-bbbbbbbbbbbb`, ...(account === null ? {} : { accountId: account }) }, opts.handle ?? `Player${n}`);
    return seat;
  };
  return { ...w, ages, asked, events, player };
}

export type RoomsWorld = Awaited<ReturnType<typeof roomsWorld>>;
