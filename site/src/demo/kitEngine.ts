// KitEngine: the demo's engine. It runs the REAL Chatwarden kit in the browser: `@chatwarden/core` with
// `@chatwarden/store-memory`, and `@chatwarden/matcher` loaded with its synthetic fixtures pack (invented words only).
// Every verdict a visitor sees (refused, rate-limited, timed out, the suggestion, the player's notice) is computed by the
// code adopters install. What lives here is the glue the DemoEngine interface needs: one fixed room, three seats with
// fixed demo identities and a seat-to-RawWho map. The moderator side is the real hub, over the kit's staff routes (see
// HubPane.tsx); `world()` hands it the kit and the term list.
//
// The kit decides on a server you control in a real game. Running it in a visitor's browser is only for this demo.

import { createChatwarden, defineRules, starterRules } from '@chatwarden/core';
import type { Chatwarden, Clock, Platform, RawWho } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { MemoryTermStore, syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { MemoryStore } from '@chatwarden/store-memory';
import type { ChatResult, DemoEngine, DemoSeat, DemoWorld, PlayerNotice, ReportDetailInput, ReportDetailResult, ReportInput, ReportResult, RuleRef, SeatState } from './engine';

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

/** The staff name on every decision the demo makes (the hub's staff routes are signed in as this made-up owner). */
export const DEMO_ACTOR = 'demo-mod';

// DEMO ONLY. This secret keys the hashes of the three made-up client keys above, inside the visitor's own browser tab.
// It protects nothing and is published with the page; a real game keeps its secret server-side and out of source control.
const DEMO_SECRET = 'chatwarden-landing-demo-secret-0000-not-a-real-secret';

/** The standard preset's starter Community Rules. Passed to the kit and read for labels, so both always agree. */
const RULES = defineRules(starterRules('standard'));

export const KIT_NOTE = 'This is the real Chatwarden kit running in your browser, with a made-up word list.';

/** What the demo sets itself, so nothing about the verdicts is hidden. */
export const KIT_NOTE_DETAILS =
  "Swearing filter: allowed (no profanity word list ships). Reporter feedback: off, so the tour stays on Bo's screen. " +
  "The moderator is the real hub, signed in as an owner so every screen opens. Everything else is the kit's defaults.";

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
  private current: Promise<DemoWorld> | null = null;

  constructor(opts: KitEngineOptions = {}) {
    this.clock = opts.clock ?? { now: () => Date.now() };
  }

  /** The kit and its term list, built on first use. The hub's staff routes are built over this; a reset makes a new one. */
  world(): Promise<DemoWorld> {
    this.current ??= this.build();
    return this.current;
  }

  /** The kit, built on first use. Public for tests that want to look at the real thing. */
  async kit(): Promise<Chatwarden> {
    return (await this.world()).cw;
  }

  private async build(): Promise<DemoWorld> {
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
    return { cw, terms };
  }

  /** Throws away every line, report, sanction and notice: a brand new kit, everyone seated again. */
  async reset(): Promise<void> {
    const previous = this.current;
    // Build the next kit first, so a failure leaves the old one in place and calls in flight still have a kit.
    const next = this.build();
    this.current = next;
    await next;
    if (previous !== null) {
      try {
        await (await previous).cw.close();
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
        // A restriction with no end (a ban) can only be made by the moderator in the hub; the seat then shows no end.
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
    addDetail: async (reportId: string, reporterSeat: string, detail: ReportDetailInput): Promise<ReportDetailResult> => {
      const cw = await this.kit();
      return cw.reports.addDetail(reportId, reporterSeat, detail);
    },
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
