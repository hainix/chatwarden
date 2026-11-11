// The demo talks to the moderation kit through this interface only. It is shaped like the real `@chatwarden/core` facade
// (`cw.chat.accept`, `cw.reports.submit`, `cw.notices.*`). `KitEngine` (./kitEngine.ts) binds the real kit behind it. The
// moderator side is not here: the real hub (`@chatwarden/hub-react`) reads and decides through the kit's staff routes, built over
// the `world()` below. Where the kit's own type is the right shape it is re-exported here (a type-only import, erased at build),
// so a change in the kit breaks the demo's type check instead of drifting silently.
import type { Chatwarden, ChatResult, PlayerNotice, RefuseReason, ReportDetailInput, ReportCategory, ReportDetailResult, ReportRefusal, ReportResult } from '@chatwarden/core';
import type { TermsAdmin } from '@chatwarden/http/admin';

export type { ChatResult, PlayerNotice, RefuseReason, ReportDetailInput, ReportDetailResult, ReportRefusal, ReportResult };

/** A seat in the demo lobby. `you` is the visitor's seat. */
export interface DemoSeat {
  id: string;
  name: string;
  you: boolean;
}

export type RuleRef = number | 'uncovered';

/** The kit running behind the demo, with the term list the staff routes edit. A new one is built on every reset. */
export interface DemoWorld {
  cw: Chatwarden;
  terms: TermsAdmin;
}

/** What the game side files. A one-tap report names no reason; `reason` is an id from the reporting settings. */
export interface ReportInput {
  reporterSeat: string;
  /** The seat reported. Ignored when `lineId` names a line still in the evidence buffer. */
  targetSeat: string;
  reason?: string;
  /** The 0.1.1 category, for the old report dialog. The demo's dialog sends `reason`, or nothing. */
  category?: ReportCategory;
  note?: string;
  lineId?: string;
}

export interface SeatState {
  id: string;
  name: string;
  you: boolean;
  /** Epoch ms a chat timeout ends, or null when the seat can chat. */
  restrictedUntil: number | null;
}

export interface DemoEngine {
  /** One honest line shown under the demo about what is running it. */
  readonly note: string;
  /** The demo's own settings that a visitor would not otherwise know about. Short; shown beside the note. */
  readonly noteDetails?: string;
  readonly seats: readonly DemoSeat[];
  /** Clears every line, report, decision and notice: a brand new kit. */
  reset(): Promise<void>;
  /** The kit as it is now, for the staff routes. After a `reset()` it is a different one. */
  world(): Promise<DemoWorld>;
  rules: { label(ref: RuleRef): string };
  rooms: { seats(): Promise<SeatState[]> };
  chat: { accept(seat: string, text: string): Promise<ChatResult> };
  reports: {
    submit(input: ReportInput): Promise<ReportResult>;
    addDetail(reportId: string, reporterSeat: string, detail: ReportDetailInput): Promise<ReportDetailResult>;
  };
  notices: {
    pending(seat: string): Promise<PlayerNotice[]>;
    ack(seat: string, id: string): Promise<boolean>;
    record(seat: string): Promise<PlayerNotice[]>;
  };
}

/** Longest line the demo composer accepts (the kit's default line length is the game's choice; the demo uses 200). */
export const LINE_MAX = 200;
