// Privacy requests (0.2.0): the one place that says what each kind of stored row does when a person asks for their data (`export`) or for it to be erased
// (`erase`). The registry is data: the stores read the same list of categories, the hub shows it, `cw.privacy.statement()` prints it, and a SQLite test lists
// every `kit_` table and fails until each one is either in a category here or in `NO_PERSON_TABLES` with a reason. Nothing in this file touches a store.

import type { SubjectId } from './types.js';

/**
 * The kinds of place a person can be found. A category groups the tables that follow the same rule. The list only ever grows at the end.
 */
export const PRIVACY_CATEGORIES = [
  'subjects',
  'identifiers',
  'sanctions',
  'notices',
  'reports_filed',
  'reports_about',
  'report_lines',
  'strikes',
  'mutes',
  'blocked_names',
  'appeals',
  'signals',
  'ai',
  'workflow',
  'audit',
  'holds',
  'pace',
] as const;
export type PrivacyCategory = (typeof PRIVACY_CATEGORIES)[number];

/** What an erase keeps. `safety` (the default) keeps the minimal remainder that lets a ban in force still apply and a hold still hold; `none` keeps only held reports. */
export type EraseMode = 'safety' | 'none';

/**
 * The retention clock a category lives on (a `RetentionPolicy` field), or null when it has none (it lives until someone deletes it).
 * Kept as a name, not a number, so the statement reads the LIVE policy.
 */
export type PrivacyClock =
  | 'reportsMs'
  | 'welfareReportsMs'
  | 'sanctionAfterEndMs'
  | 'strikesMs'
  | 'noticesMs'
  | 'auditMs'
  | 'aiOutcomesMs'
  | 'signalsMs'
  | 'appealsMs'
  | 'blockedNamesMs'
  | 'subjectsMs'
  | null;

/**
 * One line of the registry. `export`, `eraseSafety` and `eraseNone` are plain words (no jargon) for the hub and the adopter's own policy text.
 */
export interface PrivacyRule {
  category: PrivacyCategory;
  /** The `kit_` tables this category covers (the completeness test reads this). */
  tables: readonly string[];
  /** What `export` returns for it. */
  export: string;
  /** What `erase` does with `keep: 'safety'`. */
  eraseSafety: string;
  /** What `erase` does with `keep: 'none'`. */
  eraseNone: string;
  /** The clock the rows live on when nobody erases them. */
  retention: PrivacyClock;
  /**
   * A shorter clock for the rows of a report filed under the `welfare` reason (someone who may be at risk): the statement says both, so an owner who republishes it
   * does not overstate how long the most sensitive reports stay. Only the report categories have one.
   */
  welfareClock?: 'welfareReportsMs';
  /**
   * One plain sentence that qualifies the clock, for the statement: used where a clock alone would overstate what is deleted (an identity row goes only when no other record
   * names the person). Optional.
   */
  retentionNote?: string;
  /**
   * The columns that hold a person INSIDE a JSON value (an id, a handle, a line, a sanction group), as `table.column`. A table can be claimed above and still hide a
   * person in such a column (a decision's result names every player it sanctioned), so the completeness test lists every `_json` column of the database and fails
   * for one that is neither here nor in {@link NO_PERSON_JSON_COLUMNS}; the erase rewrites each one named here.
   */
  jsonColumns: readonly string[];
  /**
   * The plain columns that hold a subject id (a person), as `table.column`: what the identity age-out reads. A person with a value of their own id in any of them has a
   * record and keeps their subject and identifier rows. Optional on the type (0.2.2 added it to a published shape); every rule here sets it, `[]` for a category that holds
   * none (the index itself, or rows that hang off a report or a sanction group, which name the person through those). The completeness tests fail for a column of a
   * `kit_` table that looks like a person and is in neither this list nor {@link NO_SUBJECT_COLUMNS}.
   */
  subjectColumns?: readonly string[];
  /** The JSON columns that carry a subject id among their values, as `table.column`: scanned by the identity age-out. Optional on the type; every rule here sets it. */
  subjectJsonColumns?: readonly string[];
}

/**
 * Every category and what it does. Test-pinned (`privacy-registry.test.ts`): a category with a blank rule fails, and the SQLite completeness test fails
 * when a table is in none of these lists.
 */
export const PRIVACY_REGISTRY: readonly PrivacyRule[] = [
  {
    category: 'subjects',
    tables: ['kit_subjects'],
    export: 'The time the person was first seen and how many accounts and browsers the kit has merged into one person.',
    eraseSafety: 'Kept only while a sanction is in force on the person; deleted otherwise.',
    eraseNone: 'Deleted.',
    retention: 'subjectsMs',
    retentionNote:
      "A person's rows are deleted once they were last seen longer ago than this clock and no other record names them (a sanction of any age, a report, a mute or block, a legal hold, an appeal, a strike, a signal, a staff audit row, ...); a person who plays again before then is kept. The window is a setting (retention.subjectsMs, at least 90 days).",
    jsonColumns: [],
    subjectColumns: [],
    subjectJsonColumns: [],
  },
  {
    category: 'identifiers',
    tables: ['kit_subject_ids'],
    export: 'The account ids as the game gave them, and counts with first and last seen of keys and addresses. A hash never leaves the store.',
    eraseSafety: 'Kept (hashes and account ids) only while a sanction is in force on the person, so a ban still applies at the door; deleted otherwise.',
    eraseNone: 'Deleted.',
    retention: 'subjectsMs',
    retentionNote:
      "A person's rows are deleted once they were last seen longer ago than this clock and no other record names them (a sanction of any age, a report, a mute or block, a legal hold, an appeal, a strike, a signal, a staff audit row, ...); a person who plays again before then is kept. The window is a setting (retention.subjectsMs, at least 90 days).",
    jsonColumns: [],
    subjectColumns: [],
    subjectJsonColumns: [],
  },
  {
    category: 'sanctions',
    tables: ['kit_sanctions', 'kit_webhook_keys'],
    export: 'Kind, rule, reason, times, reference code, source and whether it was revoked. Never which staff member.',
    eraseSafety: 'A sanction in force is kept as stored; an ended or revoked one is deleted, with its address rows and the stored answer of a webhook that applied it.',
    eraseNone: 'Deleted, a sanction in force included: a ban the person is under stops applying. The stored answer of a webhook that applied it is blanked.',
    retention: 'sanctionAfterEndMs',
    jsonColumns: ['kit_webhook_keys.result_json'],
    subjectColumns: ['kit_sanctions.target_value'],
    subjectJsonColumns: [],
  },
  {
    category: 'notices',
    tables: ['kit_notices'],
    export: 'Kind, rule, times and the own lines of the person quoted in the notice.',
    eraseSafety: 'The notice of a sanction in force is kept with its quoted lines cleared; the others are deleted.',
    eraseNone: 'Deleted.',
    retention: 'noticesMs',
    jsonColumns: ['kit_notices.excerpt_json'],
    subjectColumns: ['kit_notices.subject_id'],
    subjectJsonColumns: [],
  },
  {
    category: 'reports_filed',
    tables: ['kit_reports'],
    export: 'Reports the person filed: reason, note, time and room tags.',
    eraseSafety: 'The person is removed from the report (who, seat, name, note and the clan, guild or team it names); the report stays for the player it is about.',
    eraseNone: 'The person is removed from the report (who, seat, name, note and the clan, guild or team it names); the report stays for the player it is about.',
    retention: 'reportsMs',
    welfareClock: 'welfareReportsMs',
    jsonColumns: [],
    subjectColumns: ['kit_reports.reporter_subject'],
    subjectJsonColumns: [],
  },
  {
    category: 'reports_about',
    tables: ['kit_reports', 'kit_decisions'],
    export: 'Reports about the person: category, reason, time, status, outcome, and only the lines the person wrote.',
    eraseSafety: 'Deleted, with their decisions, AI reads, outcomes and links, except a report held for legal reasons. Where the decision of a report that stays names the person, that entry is removed.',
    eraseNone: 'Deleted, with their decisions, AI reads, outcomes and links, except a report held for legal reasons. Where the decision of a report that stays names the person, that entry is removed.',
    retention: 'reportsMs',
    welfareClock: 'welfareReportsMs',
    jsonColumns: ['kit_decisions.result_json'],
    subjectColumns: ['kit_reports.target_subject'],
    subjectJsonColumns: ['kit_decisions.result_json'],
  },
  {
    category: 'report_lines',
    tables: ['kit_reports'],
    export: 'Nothing beyond the reports above.',
    eraseSafety: 'Lines of the person inside the reports of other players are replaced by a marker.',
    eraseNone: 'Lines of the person inside the reports of other players are replaced by a marker.',
    retention: 'reportsMs',
    welfareClock: 'welfareReportsMs',
    jsonColumns: ['kit_reports.people_json', 'kit_reports.excerpt_json'],
    subjectColumns: [],
    subjectJsonColumns: ['kit_reports.people_json'],
  },
  {
    category: 'strikes',
    tables: ['kit_strikes'],
    export: 'The blocked lines the person typed, with time and room.',
    eraseSafety: 'Deleted.',
    eraseNone: 'Deleted.',
    retention: 'strikesMs',
    jsonColumns: [],
    subjectColumns: ['kit_strikes.subject_id'],
    subjectJsonColumns: [],
  },
  {
    category: 'mutes',
    tables: ['kit_mutes'],
    export: 'How many players the person muted or blocked and how many muted them, never who. A block placed on them is not counted: nobody is told they were blocked.',
    eraseSafety: 'Deleted, in both directions.',
    eraseNone: 'Deleted, in both directions.',
    retention: null,
    jsonColumns: [],
    subjectColumns: ['kit_mutes.viewer_id', 'kit_mutes.target_id'],
    subjectJsonColumns: [],
  },
  {
    category: 'blocked_names',
    tables: ['kit_blocked_names'],
    export: 'Names the filter refused for the person, with the reason and time.',
    eraseSafety: 'Deleted.',
    eraseNone: 'Deleted.',
    retention: 'blockedNamesMs',
    jsonColumns: [],
    subjectColumns: ['kit_blocked_names.subject_id'],
    subjectJsonColumns: [],
  },
  {
    category: 'appeals',
    tables: ['kit_appeals', 'kit_overturns'],
    export: 'The appeals the person filed: statement, status and times, and when a decision was overturned on appeal.',
    eraseSafety: 'Deleted, except an appeal on a sanction group held for legal reasons; the overturn record of the person goes with them.',
    eraseNone: 'Deleted, except an appeal on a sanction group held for legal reasons; the overturn record of the person goes with them.',
    retention: 'appealsMs',
    jsonColumns: [],
    subjectColumns: ['kit_appeals.subject_id', 'kit_overturns.subject_id'],
    subjectJsonColumns: [],
  },
  {
    category: 'signals',
    tables: ['kit_signals'],
    export: 'What the game recorded about the person: kind and time, never the source.',
    eraseSafety: 'Deleted, the rows about the person and the rows the person caused.',
    eraseNone: 'Deleted, the rows about the person and the rows the person caused.',
    retention: 'signalsMs',
    jsonColumns: [],
    subjectColumns: ['kit_signals.subject_id', 'kit_signals.by_subject'],
    subjectJsonColumns: [],
  },
  {
    category: 'ai',
    tables: ['kit_ai_reads', 'kit_ai_outcomes', 'kit_ai_actions', 'kit_ai_noauto'],
    export: 'Whether the person is marked "do not automate" (the code only), how many AI reads were made about their reports and the outcome codes.',
    eraseSafety: 'Deleted with the reports they belong to, and the reads of a report the person filed; the mark is deleted.',
    eraseNone: 'Deleted with the reports they belong to, and the reads of a report the person filed; the mark is deleted.',
    retention: 'aiOutcomesMs',
    jsonColumns: ['kit_ai_outcomes.example_json'],
    subjectColumns: ['kit_ai_noauto.subject_id'],
    subjectJsonColumns: [],
  },
  {
    category: 'workflow',
    tables: ['kit_claims', 'kit_discord_threads', 'kit_links', 'kit_report_comments'],
    export: 'Only how many free-text staff comments sit on reports that name the person, never the text or the staff member. The other staff workflow rows are not exported.',
    eraseSafety: 'Deleted: a claim on the case, the Discord thread map entry, the staff comments on a deleted report, the links to deleted reports and the EOS link of a deleted sanction. The text of a staff comment on a report that stays, where the person is the reporter or wrote a line, is replaced by a marker. An EOS report link is only a hash of the report and stays until it ages out.',
    eraseNone: 'Deleted: a claim on the case, the Discord thread map entry, the staff comments on a deleted report, the links to deleted reports and the EOS link of a deleted sanction. The text of a staff comment on a report that stays, where the person is the reporter or wrote a line, is replaced by a marker. An EOS report link is only a hash of the report and stays until it ages out.',
    retention: null,
    jsonColumns: [],
    subjectColumns: ['kit_claims.person', 'kit_discord_threads.subject'],
    subjectJsonColumns: [],
  },
  {
    category: 'audit',
    tables: ['kit_audit'],
    export: 'The actions staff took about the person: what and when, never who.',
    eraseSafety: 'Kept (ids and codes only). The reference to the person is replaced by the receipt id once nothing keeps the person.',
    eraseNone: 'Kept (ids and codes only). The reference to the person is replaced by the receipt id.',
    retention: 'auditMs',
    jsonColumns: [],
    subjectColumns: ['kit_audit.subject_ref'],
    subjectJsonColumns: [],
  },
  {
    category: 'holds',
    tables: ['kit_legal_holds'],
    export: 'Only how many reports about or by the person are held, never why.',
    eraseSafety: 'Kept whole: a hold the kit does not weigh.',
    eraseNone: 'Kept whole: a hold the kit does not weigh.',
    retention: null,
    jsonColumns: [],
    subjectColumns: [],
    subjectJsonColumns: [],
  },
  {
    category: 'pace',
    tables: ['kit_pace'],
    export: 'Only in how many rooms the pacer holds timing state for the person (when their last lines were and a short fingerprint of each, never the text). It is swept after an hour; the export says how many rooms, nothing else.',
    eraseSafety: 'Deleted.',
    eraseNone: 'Deleted.',
    retention: null,
    jsonColumns: [],
    subjectColumns: ['kit_pace.who'],
    subjectJsonColumns: [],
  },
];

/**
 * Every column the registry names as holding a subject id, de-duplicated and in registry order: `plain` (read by `col IN (ids)`) and `json` (scanned for the ids among their
 * values). The identity age-out keeps a person with a value of their own in any of them. A store reads this list instead of keeping its own, so a new person-keyed table that
 * a rule lists is covered by the age-out with no change to it (and the contract suite fails until a record in it is proven to keep the person).
 */
export function registrySubjectColumns(): { plain: string[]; json: string[] } {
  const plain = new Set<string>();
  const json = new Set<string>();
  for (const rule of PRIVACY_REGISTRY) {
    for (const c of rule.subjectColumns ?? []) plain.add(c);
    for (const c of rule.subjectJsonColumns ?? []) json.add(c);
  }
  return { plain: [...plain], json: [...json] };
}

/**
 * Columns whose name says they may hold a person, and that the identity age-out does not read, with the reason. The counterpart of a rule's `subjectColumns`: the SQLite
 * completeness test lists every column of every `kit_` table whose name contains `subject`, `person`, `who`, `viewer`, `reporter` or `target` and fails for one that is in
 * neither.
 */
export const NO_SUBJECT_COLUMNS: Readonly<Record<string, string>> = {
  'kit_subject_ids.subject_id': 'The identity index itself: the rows the age-out deletes, so they cannot be what keeps the person.',
  'kit_audit.subject_type': 'The kind of thing an audit row is about (person, report, ...), never an id.',
  'kit_sanctions.target_type': 'Whether a sanction row targets a subject or an address, never an id.',
  'kit_reports.reporter_seat': 'The seat the reporter had in the room (p1, p2): not an id. The reporter is `reporter_subject`, which is read.',
  'kit_reports.reporter_handle': 'The name the reporter showed in the room: not an id. The reporter is `reporter_subject`, which is read.',
  'kit_reports.target_seat': 'The seat of the player reported: not an id. The player is `target_subject`, which is read.',
  'kit_reports.target_handle': 'The name the player reported showed in the room: not an id. The player is `target_subject`, which is read.',
  'kit_erasures.pending_subject': 'The receipt of an erase that kept a remainder: it is kept only while a sanction in force names the person, which keeps them, and the retention pass finishes erases before it ages anyone out.',
};

/**
 * Tables that hold no person, with the reason. A new `kit_` table must be in a rule's `tables` or here; the completeness test fails otherwise.
 */
export const NO_PERSON_TABLES: Readonly<Record<string, string>> = {
  kit_meta: 'Counters, the schema version and the first-run setup flag; no person.',
  kit_terms: 'The own word list of the adopter.',
  kit_term_exceptions: 'The own word exceptions of the adopter.',
  kit_policy_layer: 'The settings of the adopter.',
  kit_reasons: 'Saved decision reasons; staff wording.',
  kit_filter_hits: 'Chat-filter counters by day, rule and action; never keyed by person, room or text.',
  kit_ai_acting: 'One row: the AI acting mode.',
  kit_ai_spend: 'Money ledger of AI calls; no person.',
  kit_erasures: 'Erasure receipts: counts only; the pending subject is cleared when an erase finishes.',
  kit_chat_days: 'Daily counts of lines delivered and refused (desk.insights): a date and two numbers; never a person, a room or text.',
};

/**
 * The `_json` columns that hold no person, with the reason: the counterpart of a rule's `jsonColumns`. The completeness test lists every `_json` column of every
 * `kit_` table and fails for one that is in neither, and the data test checks that none of these holds a seeded person.
 */
export const NO_PERSON_JSON_COLUMNS: Readonly<Record<string, string>> = {
  'kit_pace.stamps_json': 'The times of the player\'s last few lines in one room: whole numbers of milliseconds, no person, no text.',
  'kit_pace.recent_json': 'Short fingerprints (16 hex characters) of the player\'s last lines in one room, with the time of each: never the text, never a person. The row\'s own `who` column is the person, and it is erased with the person.',
  'kit_reports.tags_json': 'The room tags the game gave (mode, region): never a person.',
  'kit_reports.entity_json': 'The clan, guild or team a report names (kind, the id the game gave it, label): no subject id. A label may be a name a player chose, so it is cleared when the reporter is erased and goes with the report when its target is.',
  'kit_audit.before_json': 'The earlier value of a changed setting: settings only.',
  'kit_audit.after_json': 'The new value of a changed setting: settings only.',
  'kit_audit.detail_json': 'The sections and the reason of a settings change: settings only, never a person.',
  'kit_policy_layer.layer_json': 'The settings of the adopter.',
  'kit_ai_reads.evidence_json': 'Line numbers of the lines the AI cited: no person.',
  'kit_ai_reads.rec_json': 'The AI verdict, severity, rule and line numbers: no person.',
  'kit_ai_reads.signals_json': 'Counts the AI was shown (label, polarity, distinct and window): no person.',
  'kit_ai_outcomes.detail_json': 'Booleans and counts of how a decision compared with the AI read: no person.',
  'kit_erasures.counts_json': 'Counts per category of one erase: no person.',
};

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

/**
 * What the owner asked a store to erase: the person's whole alias set (the canonical subject and every subject merged into it).
 */
export interface ErasePlan {
  /** The canonical subject and every alias. A store expands it to every subject merged into any of these. */
  subjects: readonly SubjectId[];
  mode: EraseMode;
  /** Reports held for legal reasons: no row of one is touched, and neither is anything a hold protects (its decisions, its sanction groups, their notices and appeals, its AI rows). */
  heldReportIds: ReadonlySet<string>;
  /** The receipt's id (`e_...`): replaces the person's reference in the audit trail once nothing keeps the person. */
  receiptId: string;
  /** Epoch ms of the request: a sanction is "in force" if it is unrevoked and has not ended by this time. */
  at: number;
  /** Count what would happen and write nothing. */
  dryRun?: boolean;
}

/** Rows removed per category. A category with nothing removed is absent. */
export type ErasureRemoved = Partial<Record<PrivacyCategory, number>>;

/**
 * What `eraseSubjects` did, or with `dryRun` would do. `kept.identifiers` is true while the subject and identifier rows are kept for a sanction in
 * force; `pending` is the canonical subject that remainder belongs to (null when nothing is kept). It never reaches a receipt.
 */
export interface ErasureCounts {
  removed: ErasureRemoved;
  kept: { identifiers: boolean; sanctions: number; heldReports: number };
  pending: SubjectId | null;
  /** False when no subject of the plan exists (nothing was done). */
  found: boolean;
  /**
   * The whole set the store worked on: the subjects of the plan and every subject merged into any of them, sorted (empty when nothing was found). The store's own
   * view can be larger than a caller's (another process may have merged an alias in), so the facade forgets and sweeps this set, not the one it asked with. It never
   * reaches a receipt.
   */
  closure: SubjectId[];
}

/**
 * The receipt row a store keeps. `counts` is what the receipt shows (no subject, no text). `pendingSubject` is set only while a remainder is kept, and is
 * cleared when the erase finishes.
 */
export interface ErasureRow {
  id: string;
  at: number;
  mode: EraseMode;
  actor: string;
  removed: ErasureRemoved;
  kept: { identifiers: boolean; sanctions: number; heldReports: number };
  pendingSubject: SubjectId | null;
}

/** What `erase` with `dryRun` returns. */
export interface ErasePreview {
  dryRun: true;
  mode: EraseMode;
  removed: ErasureRemoved;
  kept: { identifiers: boolean; sanctions: number; heldReports: number };
}

/**
 * What an erase hands back: counts per category, what was kept, and nothing about the person. `auditFailed` is set when the audit row written after the
 * commit failed (the erase stands).
 */
export interface ErasureReceipt {
  id: string;
  at: number;
  mode: EraseMode;
  removed: ErasureRemoved;
  kept: { identifiers: boolean; sanctions: number; heldReports: number };
  auditFailed?: true;
}

/** A section of an export holds at most this many rows. */
export const EXPORT_SECTION_MAX = 5000;

/**
 * One person's data as a store reads it, before the facade adds the reference and the registry's notes. No hash, no other player's id or line, no
 * reporter identity and no staff ref. `truncated` names the sections cut at {@link EXPORT_SECTION_MAX}.
 */
export interface SubjectExport {
  /** False when no subject of the request exists. */
  found: boolean;
  createdAt: number | null;
  /** How many subjects are merged into this person (the person included). */
  aliases: number;
  /** Account ids as the game gave them. */
  accounts: string[];
  identifiers: { keys: number; addresses: number; firstSeen: number | null; lastSeen: number | null };
  sanctions: Array<{
    kind: string;
    rule: string | null;
    reason: string;
    startsAt: number;
    endsAt: number | null;
    refCode: string;
    source: string;
    revoked: boolean;
    byStaff: true;
  }>;
  notices: Array<{ kind: string; rule: string | null; until: number | null; createdAt: number; excerpt: Array<{ text: string; day: string }> }>;
  reportsFiled: Array<{ createdAt: number; reason: string | null; category: string; note: string | null; tags: Record<string, string> }>;
  reportsAbout: Array<{
    createdAt: number;
    category: string;
    reason: string | null;
    status: string;
    outcome: string | null;
    origin: string | null;
    lines: Array<{ ts: number; text: string }>;
  }>;
  strikes: Array<{ at: number; roomId: string; line: string }>;
  blockedNames: Array<{ at: number; name: string; reason: string }>;
  /**
   * `overturnedAt` is when a granted appeal overturned the decision (null when none did); `reasonCode` the fixed reason the decision gave (null when it gave none or
   * is not decided). Both are optional (0.2.1 added them to a published 0.2.0 contract): a store that omits a key means none, and the kit's own stores always emit both.
   * The moderator's free text is never exported.
   */
  appeals: Array<{
    createdAt: number;
    kind: string;
    rule: string | null;
    status: string;
    statement: string | null;
    decidedAt: number | null;
    overturnedAt?: number | null;
    reasonCode?: string | null;
  }>;
  signals: Array<{ at: number; kind: string }>;
  mutes: { placed: number; received: number };
  ai: { noAutomation: string | null; reads: number; outcomes: Array<{ verdict: string; agreement: string }> };
  audit: Array<{ at: number; action: string }>;
  /** How many reports about or by the person are held. Only that something is held: never the reason (the code), the report or the time. */
  holds: { reports: number };
  /** How many free-text staff comments sit on reports that name the person (as the player reported, the reporter or a speaker in the lines). Only the count: never the text, the report or the staff member. */
  workflow: { comments: number };
  /** In how many rooms the shared pacer holds timing state for the person (the rows of `kit_pace` for them and every alias). Only the number: never a time or a digest. */
  pace: { rooms: number };
  truncated: string[];
}

/**
 * A person's export as `cw.privacy.export` returns it (a JSON-safe object).
 */
export interface PrivacyExport {
  format: 'chatwarden.privacy-export';
  version: 1;
  generatedAt: number;
  person: { ref: string; createdAt: number | null; aliases: number };
  accounts: string[];
  identifiers: SubjectExport['identifiers'];
  sections: {
    sanctions: SubjectExport['sanctions'];
    notices: SubjectExport['notices'];
    reportsFiled: SubjectExport['reportsFiled'];
    reportsAbout: SubjectExport['reportsAbout'];
    strikes: SubjectExport['strikes'];
    blockedNames: SubjectExport['blockedNames'];
    appeals: SubjectExport['appeals'];
    signals: SubjectExport['signals'];
    mutes: SubjectExport['mutes'];
    ai: SubjectExport['ai'];
    audit: SubjectExport['audit'];
    holds: SubjectExport['holds'];
    workflow: SubjectExport['workflow'];
    pace: SubjectExport['pace'];
  };
  truncated: string[];
  /** What the kit does not put in an export, and why (from the registry). */
  notes: string[];
}

/** The marker that stands in for an erased person's line inside another player's report. */
export const ERASED_LINE = '[erased]';

/** What replaces an erased reporter's subject in a report that stays: `erased:<report id>`. Never a subject id, never repeats. */
export function erasedReporter(reportId: string): string {
  return `erased:${reportId}`;
}

/** True for a reporter value that is not a person: a filter report's `filter:<id>` or an erased reporter's `erased:<id>`. */
export function isNonPersonReporter(value: string): boolean {
  return value.startsWith('filter:') || value.startsWith('erased:');
}

/** True for a sanction kind that restricts the person (so a ban in force keeps the safety remainder); a warning and a note restrict nothing. */
export function isRestrictingKind(kind: string): boolean {
  return kind === 'chat' || kind === 'area' || kind === 'ban';
}
