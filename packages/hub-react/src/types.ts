// The staff API's request and response shapes, as the hub uses them. Type-only imports: nothing here runs, and the shapes
// come from the kit itself so a change in `@chatwarden/http` or core shows up as a compile error here.
import type {
  ActionRecord,
  AuditAction,
  AuditItem,
  Chatwarden,
  CommunityRule,
  ConductLevel,
  DecisionAction,
  GapRow,
  ReporterRecord,
  ReportCategory,
  SanctionGroupView,
  SanctionKind,
  StaffReport,
  Suggestion,
} from '@chatwarden/core';
import type { ExceptionListRow, Me, PermissionKey, ReportSummary, Role, TermListRow } from '@chatwarden/http/admin';

export type { ActionRecord, AuditAction, AuditItem, CommunityRule, ConductLevel, DecisionAction, GapRow, ReporterRecord, ReportCategory, SanctionGroupView, SanctionKind, StaffReport, Suggestion };
export type { Me, PermissionKey, ReportSummary, Role };

/** One page of a list that pages with a cursor. `next` is null on the last page. */
export interface Page<T> {
  items: T[];
  next: string | null;
}

/** The statuses the staff queue filters on. The hub's "All" leaves the filter out. */
export type ReportStatus = 'open' | 'actioned' | 'dismissed';

export interface ListReportsQuery {
  status?: ReportStatus;
  cursor?: string;
  limit?: number;
}

/** Who holds a case, since when, and until when (a claim lapses at `until` unless its holder keeps working: a heartbeat). */
export interface Claim {
  by: string;
  since: number;
  until: number;
}

/** `GET /reports/:id`: the report with each named person's counted history and the ladder's suggestion for the reported person. */
export interface ReportDetail {
  report: StaffReport;
  history: Record<string, ActionRecord[]>;
  suggest: Suggestion;
  /** The Community Rule the category maps to, or `"uncovered"`. */
  rule: number | 'uncovered';
  /** Who holds the reported person's case, or null. A claim never blocks a read. */
  claim: Claim | null;
}

/** `POST /cases/:ref/claim`. `tookOverFrom` is the previous holder when a senior moved a live claim, else null. */
export interface ClaimResult {
  claim: Claim;
  tookOverFrom: string | null;
}

/** The case `POST /cases/next` handed out: the person, the report to open (their newest open one) and the claim now held. */
export interface NextCase {
  person: string;
  reportId: string;
  claim: Claim;
}

/** `GET /changes`: the opaque token for the queue and claims, and whether it differs from `since`. */
export interface Changes {
  token: string;
  changed: boolean;
}

/** A saved reason a moderator can put into a decision. */
export interface Reason {
  id: string;
  label: string;
  text: string;
  active: boolean;
}

export interface SuggestInput {
  level: ConductLevel;
  rule?: number;
  /** A person the report names (default: the reported person). */
  person?: string;
}

export interface DecideInput {
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
  reason: string;
  actions: DecisionAction[];
  evidence?: string;
  /** A senior or owner moving another moderator's live claim to themselves (audited by the server). */
  takeOver?: boolean;
}

/** `POST /reports/:id/decide`. `replay` is true when the same decision had already been made and nothing was applied again. */
export interface DecideResult {
  ok: true;
  replay: boolean;
  groups: Array<{ refCode: string; kind: SanctionKind }>;
}

export interface PersonHistory {
  history: ActionRecord[];
  reports: Array<{ id: string; createdAt: number; category: ReportCategory }>;
  sanctions: SanctionGroupView[];
  asReporter: ReporterRecord;
}

/** A sanction group with the person it is on (`GET /sanctions`). */
export type SanctionRow = SanctionGroupView & { person: string };

export type SanctionSource = 'moderator' | 'auto_filter' | 'coop' | 'api' | 'ai';

export interface ListSanctionsQuery {
  cursor?: string;
  limit?: number;
  source?: SanctionSource;
}

export interface SanctionInput {
  subject: string;
  kind: SanctionKind;
  /** Milliseconds up to 365 days, or null for permanent. Required: a missing value is never "permanent". */
  durationMs: number | null;
  /** A Community Rule number, or `'uncovered'` with a `gapNote`. */
  rule: number | 'uncovered';
  reason?: string;
  gapNote?: string;
  includeIp?: boolean;
  takeOver?: boolean;
}

export interface CloseGapInput {
  status: 'ruled' | 'not_a_rule';
  /** The number of the active rule that now covers it (required for `ruled`). */
  ref?: number | null;
}

/** A term as `GET /terms` lists it: the kit's row with its metadata always present (null when unknown). Derived, so the kit changing a field is a compile error here. */
export type TermRow = Required<TermListRow>;

/** An exception as `GET /terms` lists it. */
export type ExceptionRow = Required<ExceptionListRow>;

/** `GET /terms`. `blocks30d` has an entry for every listed term. */
export interface TermsList {
  terms: TermRow[];
  exceptions: ExceptionRow[];
  blocks30d: Record<string, number>;
}

export interface TermInput {
  term: string;
  language: string;
  note?: string;
}

export interface ExceptionInput {
  phrase: string;
  language: string;
  note?: string;
}

export type TermPatch = Partial<TermInput>;
export type ExceptionPatch = Partial<ExceptionInput>;

export type TextVerdict = 'blocked' | 'clean' | 'too_long';

export type BlockedDays = 1 | 7 | 30;

/** One chat line the term filter refused. `term` and `language` are null when the caller may not read terms. */
export interface BlockedLine {
  id: string;
  at: number;
  roomId: string;
  termId: string;
  term: string | null;
  language: string | null;
  person: string;
  text: string;
}

export type PolicyFormat = 'markdown' | 'html' | 'text';

/** `GET /policy`: the profile and rules in force and the generated documents. */
export interface PolicyDocs {
  profile: Chatwarden['profile'];
  rules: CommunityRule[];
  summary: Chatwarden['summary'];
  documents: { codeOfConduct: string; moderatorGuide: string; agentBrief: string };
}

export interface ListAuditQuery {
  cursor?: string;
  limit?: number;
  actor?: string;
  action?: AuditAction;
}
