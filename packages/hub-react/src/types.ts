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
  AiActingState as KitAiActingState,
  AiActionView as KitAiActionView,
  AiGatesView as KitAiGatesView,
  AiReadView,
  AiStatsView,
  AiStatus,
  AuditAction,
  AuditItem,
  AutomationCode as KitAutomationCode,
  Chatwarden,
  CommunityRule,
  ConductLevel,
  DecisionAction,
  EvidenceBundle,
  GapRow,
  GuideSection,
  InsightsResult,
  PersonLinks,
  RoomMode,
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
import type { ErasePreview, ErasureReceipt, FilterCheckResult, FilterKeyCounts, FilterTestResult, HoldCode, PrivacyExport, PrivacyStatement } from '@chatwarden/core';
import type { AiReadAgainBody, ExceptionListRow, Me, PermissionKey, ReporterAccuracySummary, ReportSummary, Role, TermListRow } from '@chatwarden/http/admin';

export type { PolicyLayer, PolicySection };

/**
 * What the filters did over a window: per counter key the counts by action, and for a phrase key the rule's name as it is now (absent when the rule is gone). No person,
 * room or text. `GET /filters/stats`.
 * @experimental
 */
export interface FilterStatsView {
  days: 7 | 30;
  keys: Record<string, FilterKeyCounts & { label?: string }>;
}
/** `POST /filters/test`: the verdict for one line, with ranges, and the line as it would be sent (`null` when it would not be). @experimental */
export type FilterTestView = FilterTestResult;
/** `POST /filters/check`: a candidate over recent lines. @experimental */
export type FilterCheckView = FilterCheckResult;

/** `GET /people/:ref/privacy/export`: everything the kit holds about one person, as the file the owner downloads. @experimental */
export type PrivacyExportView = PrivacyExport;
/** `GET /privacy/statement`: what the kit keeps and for how long, category by category. @experimental */
export type PrivacyStatementView = PrivacyStatement;
/** `POST /people/:ref/privacy/erase` with `dryRun`: what an erase would remove and keep. Nothing was written. @experimental */
export type ErasePreviewView = ErasePreview;
/** `POST /people/:ref/privacy/erase`: the receipt (counts and words, no person). @experimental */
export type ErasureReceiptView = ErasureReceipt;
/** `GET /reports/:id/bundle`: a report's evidence bundle, signed when the kit has a `bundleSecret` (the owner saves it as a file). @experimental */
export type EvidenceBundleView = EvidenceBundle;
/** The reasons a report can be held for: a closed list, no free text. @experimental */
export type HoldCodeView = HoldCode;
/** What `report.hold` carries on a held report: the code and when, never who. @experimental */
export interface HoldView {
  code: HoldCode;
  at: number;
}

/**
 * The editable settings as the hub reads them: what is in force, what is saved, and what the kit left out. `limits` is the kit's chat rate and
 * signals retention, read only; a server older than 0.1.8 does not send it, so the hub falls back to the kit's defaults.
 * @experimental
 */
export type PolicyState = Omit<KitPolicyState, 'limits'> & { limits?: PolicyLimits };
export type { ActionRecord, AuditAction, AuditItem, CommunityRule, ConductLevel, DecisionAction, GapRow, GuideSection, ReporterRecord, ReportCategory, SanctionGroupView, SanctionKind, StaffReport, Suggestion };
/** `GET /insights`: the team's numbers over 7, 30 or 90 days: counts and times only, no person and no staff member. @experimental */
export type InsightsView = InsightsResult;
/**
 * One room context the profile declares (`GET /policy/contexts`): its name, the label on the case chip, and the chat-time sections it overrides (names only, never a value).
 * @experimental
 */
export interface ContextRow {
  name: string;
  label: string;
  overrides: string[];
}

/** One room `GET /rooms` lists: its id, the game's tags, how many players are seated and its mode now (`until`: when a mode other than normal ends). No seat id, no handle. @experimental */
export interface RoomRow {
  roomId: string;
  tags: Record<string, string>;
  seated: number;
  mode: RoomMode;
  until: number | null;
}
/** `GET /people/:ref/links`: counts only, never an id, a key or an address. @experimental */
export type PersonLinksView = PersonLinks;
export type { RoomMode };
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
 * `GET /ai/gates` (AI levels 3 and 4, release 1): every rule and conduct level the profile could ever act on, with each gate's number against its need, the reach
 * and any cooling date. Computed on the server from the store and the clock; the hub shows it as sent and computes no gate. Read-only: nothing in this release lets the AI act.
 * @experimental
 */
export type AiGatesView = KitAiGatesView;

/** One cell of {@link AiGatesView}: a rule at a conduct level. @experimental */
export type AiGateCell = AiGatesView['cells'][number];

/**
 * `GET /ai/acting` (AI levels 3 and 4, release 2): where acting stands, in numbers the server counted: the mode (`off`, `shadow` or `on`), whether it is paused, since when, the days
 * of shadow done and how many reports shadow recorded as "would have acted". In this release no mode applies a step to a player.
 * @experimental
 */
export type AiActingState = KitAiActingState;

/** One row of `GET /ai/actions`: a step the AI would have applied (release 2: always `shadow`). Staff only: it carries a person ref. @experimental */
export type AiActionView = KitAiActionView;

/** A page of {@link AiActionView}, newest first; `next` is the cursor for the page after, or null. @experimental */
export interface AiActionsPage {
  items: AiActionView[];
  next: string | null;
}

/** The acting steps: the owner's `shadow`, `start` (shadow to on), `resume` and `off`, and a senior's `pause`. The hub's screen offers no `start`: in this release nothing acting leads to is applied. @experimental */
export type AiActingStep = 'shadow' | 'start' | 'pause' | 'resume' | 'off';

/** What an acting step is sent: the word `ACT` and a reason for `shadow` from `off` and for `start`, a reason for the rest. @experimental */
export interface AiActingInput {
  confirm?: 'ACT';
  reason: string;
}

/** The closed reasons a person can be marked "do not automate" for. @experimental */
export type AutomationCode = KitAutomationCode;

/**
 * What `PUT /people/:id/automation` takes: `allowed: false` with one of the closed reason codes (mark the person), or `allowed: true` (clear the mark).
 * @experimental
 */
export type AutomationInput = { allowed: false; code: AutomationCode } | { allowed: true };

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
  /**
   * Only the open urgent reports, found at any age (`GET /reports?urgent=1`): the urgent queue. It means open reports, so it needs `status` to be `open` or absent (the server refuses
   * another). Absent or false: every report.
   * @experimental
   */
  urgent?: boolean;
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
  /** The context the report's room had (its `context` tag, as written), or null; absent from an older server. The case chip shows its label. */
  context?: string | null;
  /** Who marked the case as passed to the game's safety team and when (the first mark only), or null. Staff ids, never a player's. @experimental */
  handoff?: { at: number; by: string | null } | null;
  /** With `desk.workflow` on: the staff thread, oldest first. Absent with it off. @experimental */
  comments?: ReportComment[];
  /** With `desk.workflow` on: the second look asked of a senior or the owner, or null. Absent with it off. @experimental */
  escalation?: ReportEscalation | null;
  reportedReasonLabel?: string | null;
  targetHandleFlagged?: boolean;
  reporterHandleFlagged?: boolean;
  /** Present only while the report is held for legal reasons (`legal.hold`): the code and the time, never who. */
  hold?: HoldView;
  /** For a report a chat filter filed, the name of its phrase rule as it is now (a link, personal-info or ratio report has none, nor does a retired rule). */
  originLabel?: string;
  /**
   * `noticeText` is on each line some person wrote themselves: the text the player's notice shows for it (delivered, or starred where a term was
   * blocked, never raw). Absent from an older server and from a line nobody wrote.
   */
  excerpt: Array<StaffReport['excerpt'][number] & { handleFlagged?: boolean; noticeText?: string; removable?: boolean }>;
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
  /**
   * How many open reports are urgent, for the queue's one chip. Absent from an older server.
   * @experimental
   */
  urgent?: number;
  /**
   * With `desk.workflow` on: how many open reports were asked of a senior or the owner for a second look. Absent with it off and from an older server.
   * @experimental
   */
  asked?: number;
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
   * Also ask the reported person to choose a new name, citing this numbered rule (an `upheld` verdict, actions only on the reported person, `sanctions.apply`, renames on).
   * The server writes the decision first and then asks, in the same request; the rename is not part of the decision's identity.
   * @experimental
   */
  rename?: { rule: number };
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
  /** `urgent`: urgent reports a sweep never closes (they stay open). Absent from an older server. */
  skipped: { claimed: number; decided: number; urgent?: number };
  more: boolean;
}

/**
 * The answer of `setUrgent` and `handoff`: nothing but `ok`.
 * @experimental
 */
export interface ReportMarkResult {
  ok: true;
}

/**
 * One entry of a report's staff thread (`ReportDetail.comments`, with `desk.workflow` on): `kind` is `comment`, `ask` (a senior was asked), `escalate` (the owner was asked) or `clear` ("looked at").
 * `author` is a staff ref; `text` is null for an entry with no note.
 * @experimental
 */
export interface ReportComment {
  id: string;
  at: number;
  author: string;
  role: 'moderator' | 'senior' | 'owner';
  kind: 'comment' | 'ask' | 'escalate' | 'clear';
  text: string | null;
}

/** The second look asked of a senior or the owner: the role asked, who asked and when. @experimental */
export interface ReportEscalation {
  to: 'senior' | 'owner';
  by: string;
  at: number;
}

/**
 * `POST /reports/:id/decide`. `replay` is true when the same decision had already been made and nothing was applied again.
 * @experimental
 */
export interface DecideResult {
  ok: true;
  replay: boolean;
  groups: Array<{ refCode: string; kind: SanctionKind }>;
  /**
   * Present when the body asked for a rename: `asked`, `already` (a request is waiting, or was asked since the decision), or `failed` (the decision stands; `error` says why when the core refused).
   * @experimental
   */
  rename?: { status: 'asked' | 'already' | 'failed'; error?: 'off' | 'not_found' | 'invalid' };
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
  /**
   * The "do not automate" mark (AI levels 3 and 4): the closed reason code and when it was set (null when the server could not read the time). Present only
   * while the person is marked, and never says who set it. Absent from an older server. @experimental
   */
  automation?: { code: AutomationCode; at: number | null };
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
  /** With the shared term list wired: how many untouched community rows the list left out. The hub never shows it. */
  community?: { hidden: number };
}

/**
 * What the shared term list changes or changed, counted over terms and exceptions together (`GET /community`, `POST /community/apply`).
 * @experimental
 */
export interface CommunitySummary {
  added: number;
  deactivated: number;
  reactivated: number;
  changed: number;
  keptYours: number;
  skipped: number;
}

/**
 * `GET /community` and `POST /community/refresh`: the loader's state, the release's languages, licence and counts, and whether sharing is on. No term.
 * @experimental
 */
export interface CommunityStatus {
  state: 'none' | 'ready' | 'stale' | 'offline' | 'failed';
  /** The version in the live list. */
  applied: string | null;
  /** The newest verified version waiting to be applied. */
  available: string | null;
  lastCheckedAt: number | null;
  pending: CommunitySummary | null;
  lastError: { code: string; stage: string } | null;
  languages: string[];
  license: { spdx: string; attribution: string } | null;
  counts: {
    terms: Record<string, number>;
    exceptions: Record<string, number>;
    status: { accepted: number; provisional: number; disputed: number; withdrawn: number };
  } | null;
  sharing: boolean;
  /** The server can send a report of a community term (the share object has `report`). */
  reporting: boolean;
}

/**
 * `POST /community/apply`.
 * @experimental
 */
export interface CommunityApplied {
  ok: true;
  version: string;
  summary: CommunitySummary;
}

/**
 * `GET /terms/:id` and `POST /terms/lookup`: one term row, a hidden community row too. `community` is true for a row the shared list added.
 * @experimental
 */
export interface TermDetail extends TermRow {
  community: boolean;
  blocks30d: number;
}

/** @experimental */
export type ShareCategory = 'slur' | 'abuse' | 'sexual' | 'other';

/** Who a slur is aimed at. @experimental */
export type ShareTarget = 'ethnicity' | 'religion' | 'gender' | 'sexuality' | 'disability' | 'nationality' | 'other';

/** `POST /terms/:id/share`: what the person chose. The word and its language are the row's own, never sent by the hub. @experimental */
export interface ShareInput {
  category: ShareCategory;
  target?: ShareTarget;
  note?: string | null;
}

/** `POST /terms/:id/report`: why a person reports a community term. A closed list; there is no free text. @experimental */
export type ReportKind = 'innocent_sense' | 'wrong_category' | 'removal';

/** `POST /terms/:id/report`. The term is the row's id; the word is never sent. @experimental */
export interface ReportInput {
  kind: ReportKind;
}

/** Why a share was not added: a closed list. @experimental */
export type ShareReason = 'known_innocent' | 'not_a_term' | 'duplicate' | 'needs_context' | 'other';

/** `GET /terms/:id/share`: where a shared term stands. `known` and `duplicate` are the answers of the send itself. @experimental */
export interface ShareState {
  status: 'received' | 'known' | 'duplicate' | 'in_review' | 'accepted' | 'declined' | 'merged';
  reason?: ShareReason;
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
  /** Whether an upheld decision thanks the reporter (`limits.reporterFeedback`). Absent from an older server. */
  notices?: { reporterFeedback: boolean };
  documents: { codeOfConduct: string; moderatorGuide: string; agentBrief: string };
}

/** @experimental */
export interface ListAuditQuery {
  cursor?: string;
  limit?: number;
  actor?: string;
  action?: AuditAction;
}
