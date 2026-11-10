// The demo talks to the moderation kit through this interface only. It is shaped like the real `@chatwarden/core` facade
// (`cw.chat.accept`, `cw.reports.submit`, `cw.decide`, `cw.notices.*`, `cw.suggest`), and async like it, so Task 3 can bind
// the real kit behind it without reshaping the UI. Until then `FakeEngine` (./fakeEngine.ts) stands in.

/** A seat in the demo lobby. `you` is the visitor's seat. */
export interface DemoSeat {
  id: string;
  name: string;
  you: boolean;
}

export type RuleRef = number | 'uncovered';

export type RefuseReason = 'empty' | 'length' | 'rate' | 'restricted' | 'blocked';

/** The verdict on one chat line (the kit's `ChatResult`). A refusal is for the sender only. */
export type ChatResult =
  | { deliver: { lineId: string; text: string } }
  | { refuse: { reason: RefuseReason; until?: number | null; byModerator?: boolean; rule?: number } };

export type ReportCategory = 'harassment' | 'hate' | 'cheating' | 'spam' | 'disruption' | 'other';
export const REPORT_CATEGORIES: readonly ReportCategory[] = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];

export type ReportRefusal = 'off' | 'not_player' | 'self' | 'rate' | 'duplicate';

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

export type Outcome = 'none' | 'note' | 'warning' | { kind: 'chat'; durationMs: number };

/** What the preset suggests: the outcome, a short label and a plain sentence on why (the kit's `Suggestion`). */
export interface Suggestion {
  outcome: Outcome;
  label: string;
  why: string;
  rule: RuleRef;
}

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

export interface DecisionGroup {
  subject: string;
  groupId: string;
  refCode: string;
  kind: SanctionKind;
  /** The player's notice for this action; null for a note, which tells the player nothing. */
  noticeId: string | null;
}

export type DecisionResult =
  | { ok: true; groups: DecisionGroup[]; replay: boolean }
  | { ok: false; error: 'not_found' | 'already_decided' | 'invalid' };

/** What a player is shown about an action against them. No chat of anyone else's, no ids (the kit's `PlayerNotice`). */
export interface PlayerNotice {
  id: string;
  kind: 'warning' | 'chat' | 'area' | 'ban' | 'report_outcome';
  rule: RuleRef | null;
  ruleLabel: string | null;
  /** Epoch ms the sanction ends; null = no end. */
  until: number | null;
  refCode: string | null;
  /** The player's own lines only, with blocked words starred out. `day` is UTC `YYYY-MM-DD`. */
  excerpt: Array<{ text: string; day: string }>;
  createdAt: number;
  mustAcknowledge: boolean;
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
