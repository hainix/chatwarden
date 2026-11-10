// KitEngine: the demo's engine. It runs the REAL Chatwarden kit in the browser: `@chatwarden/core` with
// `@chatwarden/store-memory`, and `@chatwarden/matcher` loaded with its synthetic fixtures pack (invented words only).
// Every verdict a visitor sees (refused, rate-limited, timed out, the suggestion, the player's notice) is computed by the
// code adopters install. What lives here is the glue the DemoEngine interface needs: one fixed room, three seats with
// fixed demo identities, a seat-to-RawWho map, and a small demo heuristic that tells the kit how rude a reported line was.
//
// The kit decides on a server you control in a real game. Running it in a visitor's browser is only for this demo.

import { CATEGORY_TO_RULE, createChatwarden, defineRules, starterRules } from '@chatwarden/core';
import type { Chatwarden, Clock, Platform, RawWho, ConductLevel } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { MemoryTermStore, syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { MemoryStore } from '@chatwarden/store-memory';
import type {
  ChatResult,
  DecisionInput,
  DecisionResult,
  DemoEngine,
  DemoSeat,
  PlayerNotice,
  ReportInput,
  ReportPage,
  ReportResult,
  RuleRef,
  SeatState,
  StaffReport,
  Suggestion,
} from './engine';

export const ROOM = 'lobby';

/** The three seats. Fixed ids, fixed handles. */
export const SEATS: readonly DemoSeat[] = [
  { id: 'you', name: 'You', you: true },
  { id: 'ada', name: 'Ada', you: false },
  { id: 'bo', name: 'Bo', you: false },
];

/** Who is behind each seat, as the platform reports it. Made-up client keys: nothing real, nothing secret. */
const WHO: Readonly<Record<string, RawWho>> = {
  you: { clientKey: 'demo-you' },
  ada: { clientKey: 'demo-ada' },
  bo: { clientKey: 'demo-bo' },
};

/** The staff name on every decision the demo makes. */
export const DEMO_ACTOR = 'demo-moderator';

// DEMO ONLY. This secret keys the hashes of the three made-up client keys above, inside the visitor's own browser tab.
// It protects nothing and is published with the page; a real game keeps its secret server-side and out of source control.
const DEMO_SECRET = 'chatwarden-landing-demo-secret-0000-not-a-real-secret';

/** The standard preset's starter Community Rules. Passed to the kit and read for labels, so both always agree. */
const RULES = defineRules(starterRules('standard'));

export const KIT_NOTE = 'This is the real Chatwarden kit running in your browser, with a made-up word list.';

/** What the demo sets or judges itself, so nothing about the verdicts is hidden. */
export const KIT_NOTE_DETAILS =
  "Swearing filter: allowed (no profanity word list ships). Reporter feedback: off, so the tour stays on Bo's screen. " +
  "Tone check for the suggestion: a keyword heuristic. Everything else is the kit's defaults.";

// ---------- the demo heuristic ----------

/**
 * DEMO HEURISTIC, not part of the kit. The kit never reads a line for tone: it asks the caller for a `ConductLevel`
 * (in a real game a moderator, or the AI read, supplies it). So that the "Suggested" line has something to go on, the demo
 * calls a reported line `rude` when it contains one of these words. Everything after that (the ladder, the rule, the
 * duration) is the kit's.
 */
const RUDE = /\b(uninstall|hopeless|worthless|pathetic|garbage|loser|shut up)\b/i;

/** How rude the demo reads a report: the reported line, or the target's own lines when no line was named. */
export function conductLevel(report: Pick<StaffReport, 'category' | 'lineId' | 'excerpt' | 'targetPerson' | 'ownLineIds'>): ConductLevel {
  // Hate is never banter. (The kit would act on Community Rule 1 at once anyway: it is a severe rule.)
  if (report.category === 'hate') return 'hostile';
  const own = new Set(report.ownLineIds[report.targetPerson] ?? []);
  const read = report.lineId !== null ? report.excerpt.filter((l) => l.lineId === report.lineId) : report.excerpt.filter((l) => own.has(l.lineId));
  // A line the slur filter refused is not banter either.
  if (read.some((l) => l.blocked)) return 'hostile';
  return read.some((l) => RUDE.test(l.raw)) ? 'rude' : 'banter';
}

// ---------- the engine ----------

export interface KitEngineOptions {
  /** The kit's clock. Tests pass their own; the page uses the system clock. */
  clock?: Clock;
}

export class KitEngine implements DemoEngine {
  readonly note = KIT_NOTE;
  readonly noteDetails = KIT_NOTE_DETAILS;
  readonly seats = SEATS;
  private readonly clock: Clock;
  private cw: Promise<Chatwarden> | null = null;

  constructor(opts: KitEngineOptions = {}) {
    this.clock = opts.clock ?? { now: () => Date.now() };
  }

  /** The kit, built on first use. Public for tests that want to look at the real thing. */
  kit(): Promise<Chatwarden> {
    this.cw ??= this.build();
    return this.cw;
  }

  private async build(): Promise<Chatwarden> {
    const { clock } = this;
    // The synthetic pack, loaded synchronously: the matcher is ready before the kit is.
    const terms = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock });
    terms.loadSync();
    // identify() is for adopters who seat from a connection; the demo seats by RawWho, so it is never asked.
    // notify() is how the kit tells a live connection that a notice is waiting. The demo's UI reads `notices.pending`
    // after every action instead, so there is nobody to tell.
    const platform: Platform = { identify: (ctx) => ctx as RawWho, notify: () => {} };
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: DEMO_SECRET,
      platform,
      matcher: terms,
      clock,
      profile: 'standard',
      rules: RULES,
      // The standard preset stars ordinary swearing, which needs a word list of real swearing (@chatwarden/profanity). The
      // demo ships none: only the made-up pack below. So this one setting is turned off; slurs (the pack) are untouched.
      overrides: { profanity: { mode: 'allow' } },
      // The reporter gets no "action taken" notice: the tour follows Bo's screen, and You would otherwise get a stray frame.
      // This is the one limit the demo changes. Rates, lengths, strikes and report limits are the kit's real defaults.
      limits: { reporterFeedback: false },
      // No 6-hourly purge timer in a visitor's tab: the state lives until Reset or reload.
      retention: false,
    });
    for (const seat of SEATS) cw.rooms.seat(ROOM, seat.id, WHO[seat.id] as RawWho, seat.name);
    return cw;
  }

  /** Throws away every line, report, sanction and notice: a brand new kit, everyone seated again. */
  async reset(): Promise<void> {
    const previous = this.cw;
    // Build the next kit first, so a failure leaves the old one in place and calls in flight still have a kit.
    const next = this.build();
    this.cw = next;
    await next;
    if (previous !== null) {
      try {
        await (await previous).close();
      } catch {
        // the old kit was already unusable; the new one is what counts
      }
    }
  }

  private who(seat: string): RawWho | null {
    return WHO[seat] ?? null;
  }

  // The rules registry is plain data, so a label needs no kit.
  rules = { label: (ref: RuleRef): string => RULES.label(ref) };

  rooms = {
    seats: async (): Promise<SeatState[]> => {
      const cw = await this.kit();
      return SEATS.map((s) => {
        const answer = cw.chat.restricted(WHO[s.id] as RawWho, { roomId: ROOM, seatId: s.id });
        // A restriction with no end (a ban) cannot happen here: the demo's decide never sends one.
        return { ...s, restrictedUntil: answer.restricted ? (answer.until ?? null) : null };
      });
    },
  };

  chat = {
    accept: async (seat: string, text: string): Promise<ChatResult> => {
      const cw = await this.kit();
      // An unknown seat gets the kit's own answer for a seat nobody sits in.
      return cw.chat.accept(ROOM, seat, text);
    },
  };

  reports = {
    submit: async (input: ReportInput): Promise<ReportResult> => {
      const cw = await this.kit();
      return cw.reports.submit({ roomId: ROOM, ...input });
    },
    list: async (query: { status?: StaffReport['status'] } = {}): Promise<ReportPage> => {
      const cw = await this.kit();
      return cw.reports.list(query);
    },
    get: async (id: string): Promise<StaffReport | null> => {
      const cw = await this.kit();
      return cw.reports.get(id);
    },
  };

  suggest = async (reportId: string): Promise<Suggestion | null> => {
    const cw = await this.kit();
    const report = cw.reports.get(reportId);
    if (report === null) return null;
    const rule = CATEGORY_TO_RULE[report.category];
    const suggestion = cw.suggest(report.targetPerson, conductLevel(report), rule, { roomId: report.roomId });
    return { ...suggestion, rule };
  };

  decide = async (input: DecisionInput): Promise<DecisionResult> => {
    const cw = await this.kit();
    // A store failure REJECTS here (the kit's contract). The UI catches it and says so.
    return cw.decide({ ...input, actor: DEMO_ACTOR, source: 'moderator' });
  };

  notices = {
    pending: async (seat: string): Promise<PlayerNotice[]> => {
      const cw = await this.kit();
      const who = this.who(seat);
      return who === null ? [] : cw.notices.pending(who);
    },
    ack: async (seat: string, id: string): Promise<boolean> => {
      const cw = await this.kit();
      const who = this.who(seat);
      return who === null ? false : cw.notices.ack(who, id);
    },
    record: async (seat: string): Promise<PlayerNotice[]> => {
      const cw = await this.kit();
      const who = this.who(seat);
      return who === null ? [] : cw.notices.record(who);
    },
  };
}
