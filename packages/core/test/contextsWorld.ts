import type { ChatResult } from '../src/chat.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { ContextSettings } from '../src/contexts.js';
import type { ProfileOverrides } from '../src/profile.js';
import { world } from './reportingWorld.js';

// A kit for the room-context tests: a synthetic matcher (blocks the word zorbak), a profanity filter that stars the word snerp, an account-age
// table the tests edit (a value of 'throw' makes the hook throw) and a seat helper. Synthetic words only.

export { DAY, NOW } from './reportingWorld.js';
export const SEC = 1000;

export const delivered = (r: ChatResult): r is { deliver: { lineId: string; text: string } } => 'deliver' in r;
export const reasonOf = (r: ChatResult): string | undefined => ('refuse' in r ? r.refuse.reason : undefined);
/** A comparable verdict: the delivered text, or the refusal reason. */
export const verdictOf = (r: ChatResult): string => ('deliver' in r ? `deliver:${r.deliver.text}` : `refuse:${r.refuse.reason}`);

export async function contextsWorld(contexts: Record<string, ContextSettings> = {}, over: Partial<ChatwardenOptions> = {}, overrides: ProfileOverrides = {}) {
  const ages = new Map<string, number | 'throw'>();
  const w = await world({
    matcher: { match: (text: string) => (/\bzorbak\b/i.test(text) ? { termId: 'syn:zorbak' } : null), spans: () => [] },
    profanity: { apply: (t: string) => ({ hit: /\bsnerp\b/i.test(t), text: t.replace(/\bsnerp\b/gi, '*****') }) },
    signals: {
      accountAgeDays: (ids: readonly string[]) => {
        for (const id of ids) {
          const age = ages.get(id);
          if (age === 'throw') throw new Error('age hook down');
          if (age !== undefined) return age;
        }
        return undefined;
      },
    },
    overrides: { contexts, ...overrides } as ProfileOverrides,
    ...over,
  });
  let n = 0;
  /** Seat a player in `room` and return the seat id. `account: null` seats a guest (a client key only). */
  const player = (room: string, o: { seat?: string; account?: string | null; ageDays?: number | 'throw'; tags?: Record<string, string> } = {}): string => {
    n += 1;
    const seat = o.seat ?? `s${n}`;
    const account = o.account === undefined ? `acct-${n}-aaaaaaaa` : o.account;
    if (account !== null && o.ageDays !== undefined) ages.set(account, o.ageDays);
    w.cw.rooms.seat(room, seat, { clientKey: `key-${n}-bbbbbbbbbbbb`, ...(account === null ? {} : { accountId: account }) }, `Player${n}`, o.tags);
    return seat;
  };
  return { ...w, ages, player };
}

export type ContextsWorld = Awaited<ReturnType<typeof contextsWorld>>;
