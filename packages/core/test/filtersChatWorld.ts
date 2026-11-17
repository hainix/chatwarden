// A ChatService wired like the facade wires it, with the filters, for the chat-filter tests: synthetic terms only, the matcher blocks
// 'zorbak', the profanity filter stars 'snerp'.
import { vi } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { ChatService } from '../src/chat.js';
import type { ChatResult } from '../src/chat.js';
import { EvidenceBuffer, RoomRoster } from '../src/evidence.js';
import { resolveFilters, type FilterSettings, type ResolvedFilters } from '../src/filters.js';
import type { FilterHit } from '../src/filters/engine.js';
import { MuteService } from '../src/mutes.js';
import type { ResolvedPace } from '../src/pace.js';
import { SanctionIndex } from '../src/sanctions.js';
import { StrikeService } from '../src/strikes.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, Logger, Matcher, ProfanityFilter, SubjectId } from '../src/types.js';

export const NOW = 1_800_000_000_000;
export const ROOM = 'R1';
export const who = (clientKey: string | null): Identifiers => ({ clientKey, accountId: null, ipHash: null });
export const F = (f: FilterSettings): ResolvedFilters => resolveFilters(f);

export interface Opts {
  filters?: FilterSettings;
  settings?: (roomId: string) => ResolvedFilters;
  accountIsNew?: (subject: SubjectId | null, days: number) => boolean;
  noFiltersDep?: boolean;
  /** Filters wired, but no `onFilterFlag` hook. */
  noFlagHook?: boolean;
  pace?: ResolvedPace;
  profanityMode?: 'allow' | 'star' | 'refuse';
  count?: (hit: FilterHit) => void;
  onFlag?: (info: { roomId: string; seatId: string; subject: SubjectId; lineId: string; hit: FilterHit }) => void;
}

/** Synthetic terms only: the matcher blocks 'zorbak', the profanity filter stars 'snerp'. */
export function setup(opts: Opts = {}) {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logs: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const quiet: Logger = { warn() {} };
  const subjects = new SubjectIndex(store, clock, { logger: quiet });
  const roster = new RoomRoster();
  const buffer = new EvidenceBuffer({ clock });
  const sanctions = new SanctionIndex({ enabled: () => true, subjects });
  const strikes = new StrikeService(store, clock, subjects, { logger: quiet });
  const mutes = new MuteService(store, clock, subjects, { logger: quiet });
  const calls: { profanityInputs: string[]; matcherInputs: string[]; settings: string[]; counted: FilterHit[]; flags: Array<{ lineId: string; hit: FilterHit; inBuffer: boolean }> } = {
    profanityInputs: [],
    matcherInputs: [],
    settings: [],
    counted: [],
    flags: [],
  };
  const matcher: Matcher = {
    match(text) {
      calls.matcherInputs.push(text);
      return /\bzorbak\b/i.test(text) ? { termId: 'syn:zorbak' } : null;
    },
    spans: () => [],
  };
  const profanity: ProfanityFilter = {
    apply: (t) => {
      calls.profanityInputs.push(t);
      return { hit: /\bsnerp\b/i.test(t), text: t.replace(/\bsnerp\b/gi, '*****') };
    },
  };
  const writes = { strikes: vi.spyOn(store, 'insertStrike'), notices: vi.spyOn(store, 'insertNotice'), sanctions: vi.spyOn(store, 'insertSanctionGroup') };
  const live = F(opts.filters ?? {});
  const chat = new ChatService({
    roster,
    buffer,
    subjects,
    sanctions,
    store,
    strikes,
    mutes,
    clock,
    matcher,
    profanity,
    profanityMode: opts.profanityMode ?? 'star',
    logger,
    limits: { maxLength: 200, rate: { count: 3, windowMs: 5000 } },
    ...(opts.pace === undefined ? {} : { pace: { settings: () => opts.pace!, canonical: (s: SubjectId) => subjects.canonical(s) } }),
    ...(opts.noFiltersDep === true
      ? {}
      : {
          filters: {
            settings: (roomId: string) => {
              calls.settings.push(roomId);
              return opts.settings === undefined ? live : opts.settings(roomId);
            },
            ...(opts.accountIsNew === undefined ? {} : { accountIsNew: opts.accountIsNew }),
            count: (hit: FilterHit) => {
              calls.counted.push(hit);
              opts.count?.(hit);
            },
          },
          ...(opts.noFlagHook === true
            ? {}
            : {
                onFilterFlag: (info: { roomId: string; seatId: string; subject: SubjectId; lineId: string; hit: FilterHit }) => {
                  calls.flags.push({ lineId: info.lineId, hit: info.hit, inBuffer: buffer.get(info.roomId, info.lineId) !== undefined });
                  return opts.onFlag?.(info);
                },
              }),
        }),
  });
  const sit = (seat: string, ids: Identifiers | null, room = ROOM): SubjectId | null => {
    const subject = ids === null ? null : subjects.resolve(ids);
    roster.seat(room, seat, subject, `H-${seat}`);
    return subject;
  };
  const say = (seat: string, text: string, room = ROOM): ChatResult => chat.accept(room, seat, text);
  return { store, clock, logs, buffer, calls, chat, sit, say, writes };
}

export const refusal = (r: ChatResult) => {
  if (!('refuse' in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.refuse;
};
export const delivered = (r: ChatResult): string => {
  if (!('deliver' in r)) throw new Error(`expected a delivery, got ${JSON.stringify(r)}`);
  return r.deliver.text;
};

