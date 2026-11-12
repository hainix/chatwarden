// The staff API's request and response shapes, as the hub uses them. Type-only imports: nothing here runs, and the shapes
// come from the kit itself so a change in `@chatwarden/http` or core shows up as a compile error here.
import type {
  ActionRecord,
  AiBrief,
  AppealDetail as KitAppealDetail,
  AppealOutcome as KitAppealOutcome,
  AppealRuleStats as KitAppealRuleStats,
  AppealStats as KitAppealStats,
  AppealStatus as KitAppealStatus,
  AppealSummary as KitAppealSummary,
  AiReadView,
  AiStatsView,
  AiStatus,
  AuditAction,
  AuditItem,
  Chatwarden,
  CommunityRule,
  ConductLevel,
  DecisionAction,
  GapRow,
  GuideSection,
  PolicyLayer,
  PolicyPreview,
  PolicyLimits,
  PolicySection,
  PolicyState as KitPolicyState,
  ReporterRecord,
  SignalCount,
  ReportCategory,
  SanctionGroupView,
  SanctionKind,
  StaffReport,
  Suggestion,
} from '@chatwarden/core';
import type { AiReadAgainBody, ExceptionListRow, Me, PermissionKey, ReporterAccuracySummary, ReportSummary, Role, TermListRow } from '@chatwarden/http/admin';

export type { PolicyLayer, PolicySection };

/**
 * The editable settings as the hub reads them: what is in force, what is saved, and what the kit left out. `limits` is the kit's chat rate and
 * signals retention, read only; a server older than 0.1.8 does not send it, so the hub falls back to the kit's defaults.
 * @experimental
 */
export type PolicyState = Omit<KitPolicyState, 'limits'> & { limits?: PolicyLimits };
export type { ActionRecord, AuditAction, AuditItem, CommunityRule, ConductLevel, DecisionAction, GapRow, GuideSection, ReporterRecord, ReportCategory, SanctionGroupView, SanctionKind, StaffReport, Suggestion };
export type { Me, PermissionKey, ReporterAccuracySummary, ReportSummary, Role };

/**
 * Which of the optional features are on, from `GET /me` (`Me.features`): `appeals` (appeals are on) and `renames` (a moderator may ask for a new name, and the store can
 * keep one) and `keepBlocked` (blocked names are kept as evidence, so Blocked offers the Names list). `Me` has none with all off, as 0.1.7 sent it.
 * @experimental
 */
export type MeFeatures = NonNullable<Me['features']>;

/**
 * Where an appeal stands: `open`, then `upheld`, `reduced` or `revoked` once decided, or `moot` when the sanction was revoked by someone else first.
 * @experimental
 */
export type AppealStatus = KitAppealStatus;
/** What a moderator rules on an appeal: keep the decision (`uphold`), make it lighter (`reduce`) or remove it (`revoke`). @experimental */
export type AppealOutcome = KitAppealOutcome;
/**
 * One appeal as staff see it in a list: who, the sanction (kind, rule, times, who gave it) and whether the statement trips the term filter. No statement.
 * @experimental
 */
export type AppealSummary = KitAppealSummary;
/** One appeal in full: the summary, the player's statement (staff only), the decision once made, the report and the lines the player was shown. @experimental */
export type AppealDetail = KitAppealDetail;
/** The appeal counts of one rule over a window: sanctions, appealed, revoked (`granted`), made lighter (`lightened`, never in the rate), the rate and its band. @experimental */
export type AppealRuleStats = KitAppealRuleStats;
/** `GET /appeals/stats`: the per-rule counts and the totals. @experimental */
export type AppealStats = KitAppealStats;

/**
 * What the AI read of a report, as the queue shows it (`ReportSummary.ai`): the level, how sure, the rule, and two marks. No summary and no line ids.
 * @experimental
 */
export type { AiBrief };

/**
 * A read as the case page shows it (`ReportDetail.ai`): the summary, the lines it cited and, at level 2, a recommendation. Advice, never a decision.
 * @experimental
 */
export type { AiReadView };

/**
 * `GET /ai/status`: where the AI stands (state, today's reads and spend against the ceilings), the learning switch and the casebook counts of the last 30 days.
 * @experimental
 */
export type AiStatusView = AiStatus & { learn: boolean; stats: AiStatsView };

/**
 * `POST /reports/:id/ai/read`: the read when nothing changed (`ready`, no call made), or `pending` when a read was queued.
 * @experimental
 */
export type AiReadAgainResult = AiReadAgainBody;

/**
 * One page of a list that pages with a cursor. `next` is null on the last page.
 * @experimental
 */
export interface Page<T> {
  items: T[];
  next: string | null;
}

/**
 * The statuses the staff queue filters on. The hub's "All" leaves the filter out.
 * @experimental
 */
export type ReportStatus = 'open' | 'actioned' | 'dismissed';

/** @experimental */
export interface ListReportsQuery {
  status?: ReportStatus;
  /** Only reports that gave this reason (an id; the old `disruption` finds `griefing`), or `null` for the ones that gave none. */
  reason?: string | null;
  cursor?: string;
  limit?: number;
}

/**
 * Who holds a case, since when, and until when (a claim lapses at `until` unless its holder keeps working: a heartbeat).
 * @experimental
 */
export interface Claim {
  by: string;
  since: number;
  until: number;
}

/**
 * A report as the hub reads it: the kit's, plus the label of the reason given and the server's word on which handles are flagged (`names.maskInHub`).
 * A flag is `true` or absent, and an older server sends none: every name then reads as typed.
 * @experimental
 */
export type FlaggedReport = Omit<StaffReport, 'excerpt'> & {
  reportedReasonLabel?: string | null;
  targetHandleFlagged?: boolean;
  reporterHandleFlagged?: boolean;
  excerpt: Array<StaffReport['excerpt'][number] & { handleFlagged?: boolean }>;
};

/**
 * `GET /reports/:id`: the report with each named person's counted history and the ladder's suggestion for the reported person.
 * @experimental
 */
export interface ReportDetail {
  /** The report, with the label of the reason the reporter gave as it is now (`null`: none given, or an older server). */
  report: FlaggedReport;
  history: Record<string, ActionRecord[]>;
  suggest: Suggestion;
  /** The Community Rule the category maps to, or `"uncovered"`. */
  rule: number | 'uncovered';
  /** Who holds the reported person's case, or null. A claim never blocks a read. */
  claim: Claim | null;
  /** What the AI read of the report, or null (the AI is off, or no read yet). An older server sends none. */
  ai?: AiReadView | null;
  /**
   * Whether a read is on its way now (the server's word, not the policy level): true only with the AI on, an adapter configured, the breaker
   * closed, both daily limits open and the report's read not ended without an answer. The case waits for a read only when this is true;
   * absent (the AI is off, or an older server) or false, it renders exactly as with the AI off.
   */
  aiExpected?: boolean;
}

/**
 * `POST /cases/:ref/claim`. `tookOverFrom` is the previous holder when a senior moved a live claim, else null.
 * @experimental
 */
export interface ClaimResult {
  claim: Claim;
  tookOverFrom: string | null;
}

/**
 * The case `POST /cases/next` handed out: the person, the report to open (their newest open one) and the claim now held.
 * @experimental
 */
export interface NextCase {
  person: string;
  reportId: string;
  claim: Claim;
}

/**
 * `GET /changes`: the opaque token for the queue and claims, and whether it differs from `since`.
 * @experimental
 */
export interface Changes {
  token: string;
  changed: boolean;
  /**
   * The appeals waiting, only for a caller who may read appeals while appeals are on. Absent from an older server and for everyone else.
   * @experimental
   */
  appeals?: number;
}

/**
 * A saved reason a moderator can put into a decision.
 * @experimental
 */
export interface Reason {
  id: string;
  label: string;
  text: string;
  active: boolean;
}

/** @experimental */
export interface SuggestInput {
  /** The conduct level; absent or null asks for the default. */
  level?: ConductLevel | null;
  rule?: number;
  /** A person the report names (default: the reported person). */
  person?: string;
}

/** @experimental */
export interface DecideInput {
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
  /**
   * Why. Required for every verdict except `no_action` with no actions: leave it out there and the kit stores its standard reason
   * (an older server answers 400, see the peer floors).
   */
  reason?: string;
  actions: DecisionAction[];
  evidence?: string;
  /** A senior or owner moving another moderator's live claim to themselves (audited by the server). */
  takeOver?: boolean;
  /**
   * The AI read the moderator was shown, and whether the decision is that read's pre-fill as it stood. The server checks it against the decision:
   * it can never make a decision, only describe it. Send it whenever a read was shown.
   */
  ai?: { readId: string; accepted: boolean; severity?: ConductLevel };
}

/**
 * `POST /reports/dismiss-open`: close every open report about one person (their case), or every open report from one reporter, as
 * "nothing wrong here". The server decides on the live set; `dryRun` only counts. A sweep never takes a reason.
 * @experimental
 */
export interface DismissOpenInput {
  scope: 'person' | 'reporter';
  /** The staff ref of the reported person (`person`) or of the reporter (`reporter`). */
  ref: string;
  /** Person scope only: a senior or owner moving another moderator's live claim to themselves. */
  takeOver?: boolean;
  /** Count and check only: nothing is closed, written or taken over. */
  dryRun?: boolean;
}

/**
 * What a sweep answers: counts only, never a report id. `skipped.claimed` stayed open because another moderator holds the case (reporter
 * scope); `more` is true when the sweep stopped at the kit's maximum and can be run again.
 * @experimental
 */
export interface DismissOpenResult {
  ok: true;
  dryRun: boolean;
  open: number;
  dismissed: number;
  replayed: number;
  skipped: { claimed: number; decided: number };
  more: boolean;
}

/**
 * `POST /reports/:id/decide`. `replay` is true when the same decision had already been made and nothing was applied again.
 * @experimental
 */
export interface DecideResult {
  ok: true;
  replay: boolean;
  groups: Array<{ refCode: string; kind: SanctionKind }>;
}

/** @experimental */
export interface PersonHistory {
  history: ActionRecord[];
  /**
   * The signal counts the record feed (`feeds.record`) chose, one per kind with a counted source: present only when the feed is on, `[]` when no
   * count qualifies. Absent from an older server. Staff only.
   * @experimental
   */
  signals?: SignalCountView[];
  reports: Array<{ id: string; createdAt: number; category: ReportCategory }>;
  sanctions: SanctionGroupView[];
  asReporter: ReporterRecord;
  /** Their handle on the newest report filed against them, or null: the name to show for the person. */
  handle: string | null;
  /** True when the server flags that handle (`names.maskInHub`): the hub hides it until shown. Absent otherwise, and from an older server. */
  handleFlagged?: boolean;
  /**
   * Their appeals, newest first, without the statement. Present only for a caller who may read appeals, while appeals are on or there are some.
   * @experimental
   */
  appeals?: KitAppealSummary[];
  /**
   * The times a moderator asked them for a new name, newest first. Present while renames are on or there are some.
   * @experimental
   */
  renames?: Array<{ at: number; pending: boolean }>;
}

/**
 * One signal count about a person (`GET /people/:ref/history`): a declared kind, how many different players, over how many days, and when the first
 * and the last of them said it. No player, room or row.
 * @experimental
 */
export type SignalCountView = SignalCount;

/**
 * A sanction group with the person it is on and the name to show for them (`GET /sanctions`). `handle` is null when no report recorded one.
 * @experimental
 */
export type SanctionRow = SanctionGroupView & { person: string; handle: string | null; handleFlagged?: boolean };

/** @experimental */
export type SanctionSource = 'moderator' | 'auto_filter' | 'coop' | 'api' | 'ai';

/** @experimental */
export interface ListSanctionsQuery {
  cursor?: string;
  limit?: number;
  source?: SanctionSource;
}

/** @experimental */
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

/** @experimental */
export interface CloseGapInput {
  status: 'ruled' | 'not_a_rule';
  /** The number of the active rule that now covers it (required for `ruled`). */
  ref?: number | null;
}

/**
 * A term as `GET /terms` lists it: the kit's row with its metadata always present (null when unknown). Derived, so the kit changing a field is a compile error here.
 * @experimental
 */
export type TermRow = Required<TermListRow>;

/**
 * An exception as `GET /terms` lists it.
 * @experimental
 */
export type ExceptionRow = Required<ExceptionListRow>;

/**
 * `GET /terms`. `blocks30d` has an entry for every listed term.
 * @experimental
 */
export interface TermsList {
  terms: TermRow[];
  exceptions: ExceptionRow[];
  blocks30d: Record<string, number>;
}

/** @experimental */
export interface TermInput {
  term: string;
  language: string;
  note?: string;
}

/** @experimental */
export interface ExceptionInput {
  phrase: string;
  language: string;
  note?: string;
}

/**
 * A change to a row: any of its fields. A `null` note clears it.
 * @experimental
 */
export type TermPatch = Partial<Omit<TermInput, 'note'>> & { note?: string | null };
/** @experimental */
export type ExceptionPatch = Partial<Omit<ExceptionInput, 'note'>> & { note?: string | null };

/** @experimental */
export type TextVerdict = 'blocked' | 'clean' | 'too_long';

/** @experimental */
export type BlockedDays = 1 | 7 | 30;

/**
 * One chat line the term filter refused. `term` and `language` are null when the caller may not read terms.
 * @experimental
 */
export interface BlockedLine {
  id: string;
  at: number;
  roomId: string;
  termId: string;
  term: string | null;
  language: string | null;
  person: string;
  /** The name to show for the person (the newest non-blank handle on a report against them), or null. */
  handle: string | null;
  /** True when the server flags that handle: hidden until shown. */
  handleFlagged?: boolean;
  text: string;
}

/**
 * One blocked name kept as evidence (`GET /blocked?source=name`, with `names.keepBlocked`): `text` is the name as it was typed (staff only), `person` is null for a
 * player the kit did not hold, and `term` and `language` are null for a swear word the profanity pass caught or without `terms.read`.
 * @experimental
 */
export interface BlockedName {
  id: string;
  at: number;
  roomId: null;
  termId: string | null;
  term: string | null;
  language: string | null;
  person: string | null;
  handle: string | null;
  handleFlagged?: boolean;
  /** The name as typed. */
  text: string;
  reason: 'name_not_allowed' | 'name_profane';
}

/**
 * An appeal in the inbox (`GET /appeals`): the kit's summary and the name to show for the person (null without `history.read`, or when no report recorded
 * one). No statement is in a list.
 * @experimental
 */
export type AppealRow = KitAppealSummary & { handle: string | null; handleFlagged?: boolean };

/** @experimental */
export interface ListAppealsQuery {
  /** Default `open`. */
  status?: 'open' | 'decided' | 'all';
  cursor?: string;
  limit?: number;
}

/**
 * A ruling on an appeal. `to` is the lighter outcome and goes with `reduce` only: a kind below the original, or the same kind and shorter (a warning has no length).
 * @experimental
 */
export interface AppealDecisionInput {
  outcome: AppealOutcome;
  /** Private: 1 to 500 characters, never shown to the player. */
  reason: string;
  to?: { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null };
}

/**
 * `POST /appeals/:id/decide`.
 * @experimental
 */
export interface AppealDecided {
  status: 'upheld' | 'reduced' | 'revoked';
  replacementGroupId?: string;
}

/**
 * What `POST /policy/profile/preview` answers: for each sample record and each conduct level, what would be suggested.
 * @experimental
 */
export type PolicySamples = Extract<PolicyPreview, { ok: true }>['samples'];

/**
 * The answer to a save or a reset: the new version and the sections that changed. A newer kit also answers with the state now in force.
 * @experimental
 */
export type PolicySaved = { ok: true; version: number; changed: PolicySection[] } & Partial<PolicyState>;

/** @experimental */
export type PolicyFormat = 'markdown' | 'html' | 'text';

/**
 * `GET /policy`: the profile and rules in force and the generated documents.
 * @experimental
 */
export interface PolicyDocs {
  profile: Chatwarden['profile'];
  rules: CommunityRule[];
  summary: Chatwarden['summary'];
  documents: { codeOfConduct: string; moderatorGuide: string; agentBrief: string };
}

/** @experimental */
export interface ListAuditQuery {
  cursor?: string;
  limit?: number;
  actor?: string;
  action?: AuditAction;
}
