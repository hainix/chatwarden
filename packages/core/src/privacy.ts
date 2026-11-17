// Privacy requests (0.2.0): the one place that says what each kind of stored row does when a person asks for their data (`export`) or for it to be erased
// (`erase`). The registry is data: the stores read the same list of categories, the hub shows it, `cw.privacy.statement()` prints it, and a SQLite test lists
// every `kit_` table and fails until each one is either in a category here or in `NO_PERSON_TABLES` with a reason. Nothing in this file touches a store.

import type { SubjectId } from './types.js';

/**
 * The kinds of place a person can be found. A category groups the tables that follow the same rule. The list only ever grows at the end.
 * @experimental
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
] as const;
export type PrivacyCategory = (typeof PRIVACY_CATEGORIES)[number];

/** What an erase keeps. `safety` (the default) keeps the minimal remainder that lets a ban in force still apply and a hold still hold; `none` keeps only held reports. @experimental */
export type EraseMode = 'safety' | 'none';

/**
 * The retention clock a category lives on (a `RetentionPolicy` field), or null when it has none (it lives until someone deletes it).
 * Kept as a name, not a number, so the statement reads the LIVE policy.
 */
export type PrivacyClock =
  | 'reportsMs'
  | 'sanctionAfterEndMs'
  | 'strikesMs'
  | 'noticesMs'
  | 'auditMs'
  | 'aiOutcomesMs'
  | 'signalsMs'
  | 'appealsMs'
  | 'blockedNamesMs'
  | null;

/**
 * One line of the registry. `export`, `eraseSafety` and `eraseNone` are plain words (no jargon) for the hub and the adopter's own policy text.
 * @experimental
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
}

/**
 * Every category and what it does. Test-pinned (`privacy-registry.test.ts`): a category with a blank rule fails, and the SQLite completeness test fails
 * when a table is in none of these lists.
 * @experimental
 */
export const PRIVACY_REGISTRY: readonly PrivacyRule[] = [
  {
    category: 'subjects',
    tables: ['kit_subjects'],
    export: 'The time the person was first seen and how many accounts and browsers the kit has merged into one person.',
    eraseSafety: 'Kept only while a sanction is in force on the person; deleted otherwise.',
    eraseNone: 'Deleted.',
    retention: null,
  },
  {
    category: 'identifiers',
    tables: ['kit_subject_ids'],
    export: 'The account ids as the game gave them, and counts with first and last seen of keys and addresses. A hash never leaves the store.',
    eraseSafety: 'Kept (hashes and account ids) only while a sanction is in force on the person, so a ban still applies at the door; deleted otherwise.',
    eraseNone: 'Deleted.',
    retention: null,
  },
  {
    category: 'sanctions',
    tables: ['kit_sanctions'],
    export: 'Kind, rule, reason, times, reference code, source and whether it was revoked. Never which staff member.',
    eraseSafety: 'A sanction in force is kept as stored; an ended or revoked one is deleted, with its address rows.',
    eraseNone: 'Deleted, a sanction in force included: a ban the person is under stops applying.',
    retention: 'sanctionAfterEndMs',
  },
  {
    category: 'notices',
    tables: ['kit_notices'],
    export: 'Kind, rule, times and the own lines of the person quoted in the notice.',
    eraseSafety: 'The notice of a sanction in force is kept with its quoted lines cleared; the others are deleted.',
    eraseNone: 'Deleted.',
    retention: 'noticesMs',
  },
  {
    category: 'reports_filed',
    tables: ['kit_reports'],
    export: 'Reports the person filed: reason, note, time and room tags.',
    eraseSafety: 'The person is removed from the report (who, seat, name and note); the report stays for the player it is about.',
    eraseNone: 'The person is removed from the report; the report stays for the player it is about.',
    retention: 'reportsMs',
  },
  {
    category: 'reports_about',
    tables: ['kit_reports', 'kit_decisions'],
    export: 'Reports about the person: category, reason, time, status, outcome, and only the lines the person wrote.',
    eraseSafety: 'Deleted, with their decisions, AI reads, outcomes and links, except a report held for legal reasons.',
    eraseNone: 'Deleted, with their decisions, AI reads, outcomes and links, except a report held for legal reasons.',
    retention: 'reportsMs',
  },
  {
    category: 'report_lines',
    tables: ['kit_reports'],
    export: 'Nothing beyond the reports above.',
    eraseSafety: 'Lines of the person inside the reports of other players are replaced by a marker.',
    eraseNone: 'Lines of the person inside the reports of other players are replaced by a marker.',
    retention: 'reportsMs',
  },
  {
    category: 'strikes',
    tables: ['kit_strikes'],
    export: 'The blocked lines the person typed, with time and room.',
    eraseSafety: 'Deleted.',
    eraseNone: 'Deleted.',
    retention: 'strikesMs',
  },
  {
    category: 'mutes',
    tables: ['kit_mutes'],
    export: 'How many players the person muted and how many muted them, never who.',
    eraseSafety: 'Deleted, in both directions.',
    eraseNone: 'Deleted, in both directions.',
    retention: null,
  },
  {
    category: 'blocked_names',
    tables: ['kit_blocked_names'],
    export: 'Names the filter refused for the person, with the reason and time.',
    eraseSafety: 'Deleted.',
    eraseNone: 'Deleted.',
    retention: 'blockedNamesMs',
  },
  {
    category: 'appeals',
    tables: ['kit_appeals'],
    export: 'The appeals the person filed: statement, status and times.',
    eraseSafety: 'Deleted, except an appeal on a sanction group held for legal reasons.',
    eraseNone: 'Deleted, except an appeal on a sanction group held for legal reasons.',
    retention: 'appealsMs',
  },
  {
    category: 'signals',
    tables: ['kit_signals'],
    export: 'What the game recorded about the person: kind and time, never the source.',
    eraseSafety: 'Deleted, the rows about the person and the rows the person caused.',
    eraseNone: 'Deleted, the rows about the person and the rows the person caused.',
    retention: 'signalsMs',
  },
  {
    category: 'ai',
    tables: ['kit_ai_reads', 'kit_ai_outcomes', 'kit_ai_actions', 'kit_ai_noauto'],
    export: 'Whether the person is marked "do not automate" (the code only), how many AI reads were made about their reports and the outcome codes.',
    eraseSafety: 'Deleted with the reports they belong to; the mark is deleted.',
    eraseNone: 'Deleted with the reports they belong to; the mark is deleted.',
    retention: 'aiOutcomesMs',
  },
  {
    category: 'workflow',
    tables: ['kit_claims', 'kit_discord_threads', 'kit_links'],
    export: 'Not exported: these are staff workflow rows.',
    eraseSafety: 'Deleted: a claim on the case, the Discord thread map entry and the links to deleted reports.',
    eraseNone: 'Deleted: a claim on the case, the Discord thread map entry and the links to deleted reports.',
    retention: null,
  },
  {
    category: 'audit',
    tables: ['kit_audit'],
    export: 'The actions staff took about the person: what and when, never who.',
    eraseSafety: 'Kept (ids and codes only). The reference to the person is replaced by the receipt id once nothing keeps the person.',
    eraseNone: 'Kept (ids and codes only). The reference to the person is replaced by the receipt id.',
    retention: 'auditMs',
  },
  {
    category: 'holds',
    tables: ['kit_legal_holds'],
    export: 'Reports about or by the person that are held for legal reasons: id, time and code.',
    eraseSafety: 'Kept whole: a hold is a legal duty the kit cannot weigh.',
    eraseNone: 'Kept whole: a hold is a legal duty the kit cannot weigh.',
    retention: null,
  },
];

/**
 * Tables that hold no person, with the reason. A new `kit_` table must be in a rule's `tables` or here; the completeness test fails otherwise.
 * @experimental
 */
export const NO_PERSON_TABLES: Readonly<Record<string, string>> = {
  kit_meta: 'Counters and the schema version; no person.',
  kit_terms: 'The own word list of the adopter.',
  kit_term_exceptions: 'The own word exceptions of the adopter.',
  kit_policy_layer: 'The settings of the adopter.',
  kit_reasons: 'Saved decision reasons; staff wording.',
  kit_webhook_keys: 'Idempotency keys of incoming webhooks; a key and a result code, removed after a day.',
  kit_filter_hits: 'Chat-filter counters by day, rule and action; never keyed by person, room or text.',
  kit_ai_acting: 'One row: the AI acting mode.',
  kit_ai_spend: 'Money ledger of AI calls; no person.',
  kit_erasures: 'Erasure receipts: counts only; the pending subject is cleared when an erase finishes.',
};

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

/**
 * What the owner asked a store to erase: the person's whole alias set (the canonical subject and every subject merged into it).
 * @experimental
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

/** Rows removed per category. A category with nothing removed is absent. @experimental */
export type ErasureRemoved = Partial<Record<PrivacyCategory, number>>;

/**
 * What `eraseSubjects` did, or with `dryRun` would do. `kept.identifiers` is true while the subject and identifier rows are kept for a sanction in
 * force; `pending` is the canonical subject that remainder belongs to (null when nothing is kept). It never reaches a receipt.
 * @experimental
 */
export interface ErasureCounts {
  removed: ErasureRemoved;
  kept: { identifiers: boolean; sanctions: number; heldReports: number };
  pending: SubjectId | null;
  /** False when no subject of the plan exists (nothing was done). */
  found: boolean;
}

/**
 * The receipt row a store keeps. `counts` is what the receipt shows (no subject, no text). `pendingSubject` is set only while a remainder is kept, and is
 * cleared when the erase finishes.
 * @experimental
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

/** What `erase` with `dryRun` returns. @experimental */
export interface ErasePreview {
  dryRun: true;
  mode: EraseMode;
  removed: ErasureRemoved;
  kept: { identifiers: boolean; sanctions: number; heldReports: number };
}

/**
 * What an erase hands back: counts per category, what was kept, and nothing about the person. `auditFailed` is set when the audit row written after the
 * commit failed (the erase stands).
 * @experimental
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
 * @experimental
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
  appeals: Array<{ createdAt: number; kind: string; rule: string | null; status: string; statement: string | null; decidedAt: number | null }>;
  signals: Array<{ at: number; kind: string }>;
  mutes: { placed: number; received: number };
  ai: { noAutomation: string | null; reads: number; outcomes: Array<{ verdict: string; agreement: string }> };
  audit: Array<{ at: number; action: string }>;
  holds: Array<{ reportId: string; at: number; code: string }>;
  truncated: string[];
}

/**
 * A person's export as `cw.privacy.export` returns it (a JSON-safe object).
 * @experimental
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
