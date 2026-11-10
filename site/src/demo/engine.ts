// The demo talks to the moderation kit through this interface only. It is shaped like the real `@chatwarden/core` facade
// (`cw.chat.accept`, `cw.reports.submit`, `cw.decide`, `cw.notices.*`, `cw.suggest`). `KitEngine` (./kitEngine.ts) binds the
// real kit behind it. Where the kit's own type is the right shape it is re-exported here (a type-only import, erased at build),
// so a change in the kit breaks the demo's type check instead of drifting silently.
import type { ChatResult, DecisionGroup, DecisionResult, PlayerNotice, RefuseReason, ReportRefusal } from '@chatwarden/core';

export type { ChatResult, DecisionGroup, DecisionResult, PlayerNotice, RefuseReason, ReportRefusal };

/** A seat in the demo lobby. `you` is the visitor's seat. */
export interface DemoSeat {
  id: string;
  name: string;
  you: boolean;
}

export type RuleRef = number | 'uncovered';

export type ReportCategory = 'harassment' | 'hate' | 'cheating' | 'spam' | 'disruption' | 'other';
export const REPORT_CATEGORIES: readonly ReportCategory[] = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];

export interface ReportInput {
  reporterSeat: string;
  /** The seat reported. Ignored when `lineId` names a line still in the evidence buffer. */
  targetSeat: string;
  category: ReportCategory;
  note?: string;
  lineId?: string;
}

export type ReportResult =
  | { ok: true; reportId: string; remaining: number }
  | { ok: false; refused: ReportRefusal; remaining?: number };

/** One chat line inside a report's evidence. Staff see blocked lines too (`delivered` is null for them). */
export interface EvidenceLine {
  lineId: string;
  ts: number;
  seatId: string;
  handle: string;
  raw: string;
  delivered: string | null;
  blocked: boolean;
}

export interface StaffReport {
  id: string;
  createdAt: number;
  category: ReportCategory;
  note: string | null;
  reporterHandle: string;
  targetHandle: string;
  /** The reported line. */
  lineId: string | null;
  excerpt: EvidenceLine[];
  status: 'open' | 'actioned' | 'dismissed';
  /** Staff ref of the reported person. Staff surfaces only; never shown to a player. */
  targetPerson: string;
  /** For each person, the ids of the excerpt lines they wrote themselves. Offer these in the "line to show" picker. */
  ownLineIds: Record<string, string[]>;
}

export interface ReportPage {
  items: StaffReport[];
  next: string | null;
}

export type Outcome = 'none' | 'note' | 'warning' | { kind: 'chat' | 'area' | 'ban'; durationMs: number | null };

/** What the preset suggests: the outcome, a short label and a plain sentence on why (the kit's `Suggestion`). */
export interface Suggestion {
  outcome: Outcome;
  label: string;
  why: string;
  rule: RuleRef;
}

/** What the demo's decide buttons send. The kit also has `area` and `ban`; the demo never sends them. */
export type SanctionKind = 'chat' | 'warning' | 'note';

export interface DecisionAction {
  subject: string;
  kind: SanctionKind;
  durationMs: number | null;
  rule: RuleRef;
  gapNote?: string;
  /** Up to five of THIS person's own lines in the report, shown to them in the notice. */
  lineIds?: string[];
}

export interface DecisionInput {
  reportId: string;
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
  evidence?: string;
  actions: DecisionAction[];
  /** Private; required, at most 500 characters. Never shown to a player. */
  reason: string;
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
  readonly seats: readonly DemoSeat[];
  /** Clears every line, report, decision and notice. */
  reset(): Promise<void>;
  rules: { label(ref: RuleRef): string };
  rooms: { seats(): Promise<SeatState[]> };
  chat: { accept(seat: string, text: string): Promise<ChatResult> };
  reports: {
    submit(input: ReportInput): Promise<ReportResult>;
    list(query?: { status?: StaffReport['status'] }): Promise<ReportPage>;
    get(id: string): Promise<StaffReport | null>;
  };
  suggest(reportId: string): Promise<Suggestion | null>;
  decide(input: DecisionInput): Promise<DecisionResult>;
  notices: {
    pending(seat: string): Promise<PlayerNotice[]>;
    ack(seat: string, id: string): Promise<boolean>;
    record(seat: string): Promise<PlayerNotice[]>;
  };
}

/** Longest line the demo composer accepts (the kit's default line length is the game's choice; the demo uses 200). */
export const LINE_MAX = 200;
