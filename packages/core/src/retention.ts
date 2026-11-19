import { utcDay } from './chatCounter.js';
import { MUTE_TTL_MS } from './mutes.js';

/** The shared pacer's rows are swept after this long untouched: the longest window any pacing check can have. */
const PACE_ROW_MAX_AGE_MS = 3_600_000;
import { ProfileError } from './profile.js';
import { WEBHOOK_KEY_TTL_MS } from './types.js';
import type { Store } from './types.js';

const DAY_MS = 86_400_000;

/** A row of a subject that does not exist is a stray only once it is this old (a subject row can trail its first row by a moment). */
export const STRAY_AGE_MS = 10 * 60_000;

/** How long each kind of row is kept. */
export interface RetentionPolicy {
  /** A report is deleted once it is older than this. */
  reportsMs: number;
  /** An ended or revoked sanction row is deleted this long after it ended or was revoked. */
  sanctionAfterEndMs: number;
  /** A strike (and the raw line kept with it) is deleted once it is older than this. */
  strikesMs: number;
  /**
   * A withdrawn notice, and a seen warning or report outcome, is deleted once it is older than this; so is any
   * notice whose end is this far past. A notice for a permanent or running sanction is kept while it applies.
   */
  noticesMs: number;
  /**
   * A report dismissed as bad faith is kept this long after it was actioned, even once it is past `reportsMs`: the
   * reporter's suspension counts it (see `SUSPEND_WINDOW_MS`).
   */
  badFaithMs: number;
  /** A staff audit entry is deleted once it is older than this. */
  auditMs: number;
  /**
   * An AI outcome row (the agree-or-override record: ids and counts, no chat text) is kept this long. At least 90 days. A read
   * itself goes with its report (`reportsMs`).
   */
  aiOutcomesMs: number;
  /**
   * The pseudonymised example text kept with an AI outcome is deleted once it is older than this. It is the only chat text that
   * outlives a report, so it is the shortest of the three; 0 keeps no text at all.
   */
  aiExamplesMs: number;
  /**
   * An AI action row (what the AI did or, in shadow, would have done: ids, the rule and conduct level, a state, a closed code and times; no chat text) is kept this long after it was
   * made. At least 90 days: the gates read 90 days of actions. A reviewer's private note on it is cleared with the report (`reportsMs`), and the row stays.
   */
  aiActionsMs: number;
  /**
   * A signal row (what a game recorded about a player, `flood_triggered` included) is deleted once it is older than this. At least 14
   * days: a counting window needs at least two weeks of rows. A feed window longer than this is refused.
   */
  signalsMs: number;
  /**
   * The statement of a decided (or closed) appeal is set to nothing this long after the decision. It is the one new free text a player
   * writes, so it is the shortest of the three. An open appeal's statement is kept until it is decided. 0 clears it at the next purge
   * (and at the decision itself); no floor.
   */
  appealStatementsMs: number;
  /**
   * A decided appeal row is deleted this long after its decision. At least 90 days: the per-rule counts and the false-positive rate read
   * these rows over a 90 day window. An appeal on a permanent sanction that is still in force is kept regardless (it stops a second appeal
   * against it), and an open appeal is never deleted.
   */
  appealsMs: number;
  /** A blocked name kept as evidence (`names.keepBlocked`) is deleted once it is older than this. The same clock as strikes. No floor. */
  blockedNamesMs: number;
  /**
   * A chat-filter hit counter row (one per UTC day, key and action: no person, room or text) is deleted once its day is wholly older than this. At
   * least 30 days: the hub reads a 30 day window. A report a filter filed (`origin: 'filter'`) goes with the others, on `reportsMs`.
   */
  filterHitsMs: number;
  /**
   * A report whose reason is `welfare` (its excerpt, note, comments and decision row) is deleted once it is older than this: the most
   * sensitive text the kit holds, so a shorter clock than `reportsMs`. At least 1 day (a floor, not an off switch).
   */
  welfareReportsMs: number;
  /** A daily line count (`desk.insights`: a date and two counts, no player data) is deleted once its day is older than this. At least 31 days: Insights reads a 90 day window and the page says "counted from". */
  chatCountsMs: number;
  /**
   * The identity index (0.2.2): a person (the subject and every subject merged into it: the account id as the game gave it, the hashed client key and the hashed address)
   * is deleted once the newest `last_seen` of their identifiers is older than this AND no table the privacy registry lists still names them (a sanction, a report, a
   * mute or block, a legal hold, an appeal, an overturn, a strike, a signal, a claim, an audit row, ...). Optional: absent means 400 days, the longest other default. At
   * least 90 days (a floor, not an off switch: 0 would take a player who is connected now).
   */
  subjectsMs?: number;
}

export const RETENTION_DEFAULTS: Readonly<Required<RetentionPolicy>> = {
  reportsMs: 90 * DAY_MS,
  sanctionAfterEndMs: 90 * DAY_MS,
  strikesMs: 30 * DAY_MS,
  noticesMs: 90 * DAY_MS,
  badFaithMs: 30 * DAY_MS,
  auditMs: 365 * DAY_MS,
  aiOutcomesMs: 365 * DAY_MS,
  aiExamplesMs: 180 * DAY_MS,
  aiActionsMs: 365 * DAY_MS,
  signalsMs: 90 * DAY_MS,
  appealStatementsMs: 90 * DAY_MS,
  appealsMs: 365 * DAY_MS,
  blockedNamesMs: 30 * DAY_MS,
  filterHitsMs: 90 * DAY_MS,
  welfareReportsMs: 30 * DAY_MS,
  chatCountsMs: 400 * DAY_MS,
  subjectsMs: 400 * DAY_MS,
};

/** The ladder looks back 90 days and "My record" shows 90 days, so the rows behind them must outlive that. */
const RECORD_FLOOR_MS = 90 * DAY_MS;

const FIELDS = ['reportsMs', 'sanctionAfterEndMs', 'strikesMs', 'noticesMs', 'badFaithMs', 'auditMs', 'aiOutcomesMs', 'aiExamplesMs', 'aiActionsMs', 'signalsMs', 'appealStatementsMs', 'appealsMs', 'blockedNamesMs', 'filterHitsMs', 'welfareReportsMs', 'chatCountsMs', 'subjectsMs'] as const;

/**
 * Refuse a retention policy that would delete rows the kit still reads. Only the fields present are checked (an
 * absent one takes a default, and the defaults satisfy every floor):
 * - `sanctionAfterEndMs` at least 90 days: the ladder reads that far back
 * - `noticesMs` at least 90 days: "My record" shows that far back
 * - `badFaithMs` at least `suspendWindowMs`: a bad-faith dismissal weighs against its reporter for that long
 * - `auditMs` at least 90 days: the staff trail is how a community answers "who did that"
 * - `aiOutcomesMs` at least 90 days: the agree-or-override record is the data the AI's later gates read
 * - `aiExamplesMs` at least 0 (0 keeps no example text at all)
 * - `aiActionsMs` at least 90 days: the gates read 90 days of the AI's actions
 * - `signalsMs` at least 14 days: a counting window needs at least two weeks of rows
 * - `appealsMs` at least 90 days: the per-rule appeal counts read that far back
 * - `filterHitsMs` at least 30 days: the hub's longest window of filter counts
 * - `welfareReportsMs` at least 1 day and `chatCountsMs` at least 31 days (neither is an off switch: 0 is refused)
 * - `appealStatementsMs` and `blockedNamesMs` at least 0 (0 keeps the text only until the next purge)
 * - `subjectsMs` at least 90 days: the identity rows of a person with no record go that long after the person was last seen (0 would take a connected player)
 *
 * Every field present must also be a finite number (`reportsMs` and `strikesMs` have no floor, only this).
 *
 * Throws {@link ProfileError} naming the field and why. Anything that is not a number at least the floor fails,
 * NaN included.
 */
export function checkRetentionFloors(policy: Partial<RetentionPolicy>, suspendWindowMs: number): void {
  // Every field present must be a finite number, whatever its floor: Infinity or NaN would make every later purge
  // throw (and so delete nothing from any table).
  for (const field of FIELDS) {
    const v: unknown = policy[field];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) {
      throw new ProfileError(`retention.${field}`, 'must be a finite number of milliseconds');
    }
  }
  const below = (v: unknown, floor: number): boolean => v !== undefined && !(typeof v === 'number' && v >= floor);
  if (below(policy.sanctionAfterEndMs, RECORD_FLOOR_MS)) {
    throw new ProfileError(
      'retention.sanctionAfterEndMs',
      "must be at least 90 days: the ladder looks back that far at a person's earlier actions",
    );
  }
  if (below(policy.noticesMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.noticesMs', "must be at least 90 days: players' records reach back that far");
  }
  if (below(policy.auditMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.auditMs', 'must be at least 90 days: the audit trail answers who did what, and when');
  }
  if (below(policy.aiOutcomesMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.aiOutcomesMs', 'must be at least 90 days: it is the record of how often the AI and the moderators agreed');
  }
  if (below(policy.aiActionsMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.aiActionsMs', 'must be at least 90 days: the gates read the last 90 days of what the AI did');
  }
  if (below(policy.aiExamplesMs, 0)) {
    throw new ProfileError('retention.aiExamplesMs', 'must be 0 or more: 0 keeps no example text at all');
  }
  if (below(policy.signalsMs, 14 * DAY_MS)) {
    throw new ProfileError('retention.signalsMs', 'must be at least 14 days: a counting window needs at least two weeks of rows');
  }
  if (below(policy.appealsMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.appealsMs', 'must be at least 90 days: the per-rule appeal counts read that far back');
  }
  if (below(policy.filterHitsMs, 30 * DAY_MS)) {
    throw new ProfileError('retention.filterHitsMs', 'must be at least 30 days: the hub reads a 30 day window of filter counts');
  }
  if (below(policy.welfareReportsMs, DAY_MS)) {
    throw new ProfileError('retention.welfareReportsMs', 'must be at least 1 day: a welfare report is kept for a short time, not removed on sight');
  }
  if (below(policy.chatCountsMs, 31 * DAY_MS)) {
    throw new ProfileError('retention.chatCountsMs', 'must be at least 31 days: the Insights page reads a month of daily line counts');
  }
  if (below(policy.subjectsMs, RECORD_FLOOR_MS)) {
    throw new ProfileError('retention.subjectsMs', 'must be at least 90 days: the identity rows are what recognises a returning player');
  }
  if (below(policy.appealStatementsMs, 0)) {
    throw new ProfileError('retention.appealStatementsMs', 'must be 0 or more: 0 clears a statement as soon as its appeal is decided');
  }
  if (below(policy.blockedNamesMs, 0)) {
    throw new ProfileError('retention.blockedNamesMs', 'must be 0 or more');
  }
  if (below(policy.badFaithMs, suspendWindowMs)) {
    throw new ProfileError(
      'retention.badFaithMs',
      `must be at least limits.reports.suspendWindowMs (${Math.round((suspendWindowMs / DAY_MS) * 100) / 100} days): ` +
        "a report dismissed as bad faith counts toward its reporter's suspension for that long",
    );
  }
}

/** Rows deleted, per table. */
export interface PurgeResult {
  reports: number;
  sanctions: number;
  strikes: number;
  mutes: number;
  notices: number;
  audit: number;
  webhookKeys: number;
  /** AI reads deleted by the retention pass (a read also goes with its report). 0 for a store without the AI methods. */
  aiReads: number;
  /** AI casebook outcomes deleted. 0 for a store without the AI methods. */
  aiOutcomes: number;
  /** AI action rows deleted (`retention.aiActionsMs`). 0 for a store without the action rows. */
  aiActions: number;
  /** Signal rows deleted (flood_triggered included). 0 for a store without the signal methods. */
  signals: number;
  /** Decided appeal rows deleted. 0 for a store without the appeal methods. */
  appeals: number;
  /** Appeal statements set to nothing (the row stays). A statement counted here may belong to a row deleted in the same pass. 0 for a store without the appeal methods. */
  appealStatements: number;
  /** Kept blocked names deleted. 0 for a store without the blocked-name methods. */
  blockedNames: number;
  /** Open appeals mooted because retention removed their sanction rows. 0 for a store without the appeal methods. */
  appealsClosed: number;
  /** Chat-filter hit counter rows deleted (`retention.filterHitsMs`). */
  filterHits: number;
  /** Welfare reports deleted (`retention.welfareReportsMs`; their comments go with them). Not counted in `reports`. 0 for a store without the method. */
  welfareReports: number;
  /** Daily line-count rows deleted (`retention.chatCountsMs`). 0 for a store without the method. */
  chatCounts: number;
  /** The shared pacer's rows not touched for an hour, deleted (operational state; no setting). 0 for a store without the pace methods. */
  pace: number;
  /**
   * Subject rows deleted by the identity age-out (`retention.subjectsMs`): people last seen before the window with no record in any registry table. Their identifier rows
   * go with them and are not counted. 0 for a store without `purgeIdleSubjects`.
   */
  idleSubjects: number;
  /** Erasures that kept a remainder (a sanction in force) and were finished by this pass: the person's subject and identifier rows were deleted. */
  erasuresFinished: number;
  /** Strike, signal, notice and kept-name rows dropped because their subject has no subject row and they were older than ten minutes. */
  strayRows: number;
}

function checkWindow(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`purge: invalid ${name}`);
}

/**
 * Delete rows past their retention, all in one transaction (every table or none). Run it from a timer
 * or a maintenance job: it is a store call, not part of any hot path.
 *
 * - reports: `createdAt < now - reportsMs`, except a bad-faith dismissal actioned at or after `now - badFaithMs`
 *   (it still counts toward its reporter's suspension). The recorded decisions of deleted reports go with them.
 * - sanctions: ended (`endsAt < now - sanctionAfterEndMs`) or revoked (`revokedAt < now - sanctionAfterEndMs`).
 *   A warning or a note ends where it starts, so it goes `sanctionAfterEndMs` (90 days by default) after its start.
 *   A permanent, unrevoked sanction is never deleted, nor is one whose rule gap is still open.
 * - strikes: `at < now - strikesMs`
 * - audit: `at < now - auditMs` (365 days by default, never less than 90): every staff audit entry, including the
 *   term-editor rows written before the trail existed
 * - webhook keys: `createdAt < now - 24 h` (incoming-webhook idempotency keys, pending or done)
 * - mutes: `createdAt < now - 180 days`, the mute TTL (a mute past it is already ignored)
 * - AI reads: `createdAt < now - reportsMs` (a read also goes with its report, in `purgeReports`); AI outcomes (agree-or-override
 *   record, no chat text): `decidedAt < now - aiOutcomesMs`; the pseudonymised example kept with an outcome:
 *   `decidedAt < now - aiExamplesMs`, the row stays with its counts. AI action rows: `createdAt < now - aiActionsMs` (365 days by default, never less than 90), and a reviewer's note
 *   on a row older than `reportsMs` is cleared. A store without the AI methods has none of these.
 * - signals: `at < now - signalsMs` (90 days by default, never less than 14); a store without the signal methods has none
 * - appeals: the statement of an appeal decided (or closed) before `now - appealStatementsMs` is set to nothing, the row stays; then a
 *   decided row with `decidedAt < now - appealsMs` is deleted (365 days by default, never less than 90), EXCEPT one whose sanction is
 *   permanent, or timed and not yet ended before that cutoff, and not revoked (that row stops a second appeal). An open appeal is never
 *   deleted or cleared; but one whose sanction rows this pass removed (or that has none) is first mooted, so it ends up decided-like. Blocked names: `at < now - blockedNamesMs` (30 days by default).
 *   A store without the appeal or blocked-name methods has none of these.
 * - filter hits: a counter row of a UTC day wholly before `now - filterHitsMs` (90 days by default, never less than 30). Reports a filter filed (`origin`) go on `reportsMs` with every report.
 * - links (`cw.links`): `at < now - reportsMs` (90 days by default), every system. A store without the link methods has none.
 * - notices: withdrawn, or a seen warning / report outcome, with `createdAt < now - noticesMs`; or
 *   `until < now - noticesMs`. A notice for a permanent or running sanction is kept while it applies (agrees with
 *   `NoticeService.record`), and an unseen warning is kept until it is seen or withdrawn. The four message kinds: seen, as a report outcome;
 *   unseen, kept until the longer of `noticesMs` and `appealsMs` (appeal outcomes) or of `noticesMs` and `auditMs` (a required rename).
 *
 * - erasures: a pending erase (one that kept a remainder for a sanction in force) is finished once nothing keeps the person: their sanction rows are gone, or
 *   the only ones left are held by a legal hold and are not in force. Finishing deletes the person's subject and identifier rows. Rows of a subject that has no
 *   subject row (written by a process that had not heard of an erase) are swept once they are older than ten minutes, unless `sweepStrays` is false.
 *
 * - identity age-out: a person (a subject and everything merged into it) whose newest identifier `last_seen` is before `now - subjectsMs` (400 days by default, never less than
 *   90) and who has no record in any table the privacy registry lists loses the subject and identifier rows (account id, key hash, address hash), after everything above, so a
 *   person whose last record aged out in this pass goes in it. A person with any record (an in-force or recent sanction, a report naming them, a mute or block, a legal hold,
 *   an appeal, an overturn, a strike, a signal, ...) keeps their rows until the record is gone. Counted as `idleSubjects`. A store without `purgeIdleSubjects` has none.
 *
 * Every cutoff is strict: a row exactly on the line is kept. Subjects and terms are otherwise never touched (only the finish of an erase, the identity age-out and the stray sweep delete
 * subject-keyed rows). The in-memory indexes need no update: they already ignore everything this removes.
 *
 * `options.sweepStrays` (default true) is false when the caller knows a person made in its own process has not been written to the store yet (the save failed): the
 * rows of that person look like strays until the subject row exists, so the sweep waits.
 */
export async function purge(
  store: Store,
  now: number,
  policy: Partial<RetentionPolicy> = {},
  options: { sweepStrays?: boolean } = {},
): Promise<PurgeResult> {
  const p: Required<RetentionPolicy> = {
    reportsMs: policy.reportsMs ?? RETENTION_DEFAULTS.reportsMs,
    sanctionAfterEndMs: policy.sanctionAfterEndMs ?? RETENTION_DEFAULTS.sanctionAfterEndMs,
    strikesMs: policy.strikesMs ?? RETENTION_DEFAULTS.strikesMs,
    noticesMs: policy.noticesMs ?? RETENTION_DEFAULTS.noticesMs,
    badFaithMs: policy.badFaithMs ?? RETENTION_DEFAULTS.badFaithMs,
    auditMs: policy.auditMs ?? RETENTION_DEFAULTS.auditMs,
    aiOutcomesMs: policy.aiOutcomesMs ?? RETENTION_DEFAULTS.aiOutcomesMs,
    aiExamplesMs: policy.aiExamplesMs ?? RETENTION_DEFAULTS.aiExamplesMs,
    aiActionsMs: policy.aiActionsMs ?? RETENTION_DEFAULTS.aiActionsMs,
    signalsMs: policy.signalsMs ?? RETENTION_DEFAULTS.signalsMs,
    appealStatementsMs: policy.appealStatementsMs ?? RETENTION_DEFAULTS.appealStatementsMs,
    appealsMs: policy.appealsMs ?? RETENTION_DEFAULTS.appealsMs,
    blockedNamesMs: policy.blockedNamesMs ?? RETENTION_DEFAULTS.blockedNamesMs,
    filterHitsMs: policy.filterHitsMs ?? RETENTION_DEFAULTS.filterHitsMs,
    welfareReportsMs: policy.welfareReportsMs ?? RETENTION_DEFAULTS.welfareReportsMs,
    chatCountsMs: policy.chatCountsMs ?? RETENTION_DEFAULTS.chatCountsMs,
    subjectsMs: policy.subjectsMs ?? RETENTION_DEFAULTS.subjectsMs,
  };
  if (!Number.isFinite(now)) throw new Error('purge: invalid now');
  checkWindow('reportsMs', p.reportsMs);
  checkWindow('sanctionAfterEndMs', p.sanctionAfterEndMs);
  checkWindow('strikesMs', p.strikesMs);
  checkWindow('noticesMs', p.noticesMs);
  checkWindow('badFaithMs', p.badFaithMs);
  checkWindow('auditMs', p.auditMs);
  checkWindow('aiOutcomesMs', p.aiOutcomesMs);
  checkWindow('aiExamplesMs', p.aiExamplesMs);
  checkWindow('aiActionsMs', p.aiActionsMs);
  checkWindow('signalsMs', p.signalsMs);
  checkWindow('appealStatementsMs', p.appealStatementsMs);
  checkWindow('appealsMs', p.appealsMs);
  checkWindow('blockedNamesMs', p.blockedNamesMs);
  checkWindow('filterHitsMs', p.filterHitsMs);
  checkWindow('welfareReportsMs', p.welfareReportsMs);
  checkWindow('chatCountsMs', p.chatCountsMs);
  checkWindow('subjectsMs', p.subjectsMs);
  return store.transaction(() => {
    // The most sensitive reports first, on their own shorter clock (a report held for legal reasons is skipped by the store); then every other report on `reportsMs`.
    const welfareReports = store.purgeReportsByReason?.('welfare', now - p.welfareReportsMs) ?? 0;
    const reports = store.purgeReports(now - p.reportsMs, now - p.badFaithMs);
    // Link rows (`cw.links`) are ids only and outlive the report they name by no useful time: the same clock as reports. Not counted in the result. A live row (an active EOS sanction, the EOS cursor) is kept by the store whatever its age.
    store.purgeLinks?.(now - p.reportsMs);
    const ai = store.purgeAi?.(now - p.reportsMs, now - p.aiOutcomesMs, now - p.aiExamplesMs) ?? { reads: 0, outcomes: 0 };
    const result: Omit<PurgeResult, 'erasuresFinished' | 'strayRows' | 'idleSubjects'> = {
      reports,
      sanctions: store.purgeSanctions(now - p.sanctionAfterEndMs),
      strikes: store.purgeStrikes(now - p.strikesMs),
      mutes: store.purgeMutes(now - MUTE_TTL_MS),
      // An unseen message notice is kept until seen, but not for ever: an appeal outcome goes with the appeal row it describes, a required
      // rename with the audit trail. Never earlier than a seen one would go (`noticesMs`).
      notices: store.purgeNotices(now - p.noticesMs, {
        appealBefore: now - Math.max(p.noticesMs, p.appealsMs),
        renameBefore: now - Math.max(p.noticesMs, p.auditMs),
      }),
      audit: store.purgeAudit(now - p.auditMs),
      webhookKeys: store.purgeWebhookKeys(now - WEBHOOK_KEY_TTL_MS),
      aiReads: ai.reads,
      aiOutcomes: ai.outcomes,
      // Action rows by their own clock; a reviewer's private note goes with the report window and the row stays.
      aiActions: store.purgeAiActions?.(now - p.aiActionsMs, now - p.reportsMs) ?? 0,
      signals: store.purgeSignals?.(now - p.signalsMs) ?? 0,
      // An open appeal whose sanction rows were just removed can never be decided (`gone`): moot it, so it leaves the inbox and its statement
      // goes on the decided clock (cleared at once when `appealStatementsMs` is 0).
      appealsClosed: store.closeOrphanAppeals?.('retention', now, p.appealStatementsMs === 0) ?? 0,
      // Statements first: a statement is player text and goes on its own, shorter clock even when its row stays (or goes in the next call).
      appealStatements: store.clearAppealStatements?.(now - p.appealStatementsMs) ?? 0,
      // The overturn rows (0.2.1) are the record of a granted appeal: they go on the same clock and count with the appeals.
      appeals: (store.purgeAppeals?.(now - p.appealsMs) ?? 0) + (store.purgeOverturns?.(now - p.appealsMs) ?? 0),
      blockedNames: store.purgeBlockedNames?.(now - p.blockedNamesMs) ?? 0,
      // Counter rows are keyed by UTC day: a day goes once it ended before the cutoff (strictly older than the day the cutoff falls in).
      filterHits: store.purgeFilterHits(Math.floor((now - p.filterHitsMs) / DAY_MS)),
      welfareReports,
      // Daily line counts (Insights), keyed by UTC day like the filter counters: a day goes once it ended before the day the cutoff falls in.
      chatCounts: store.purgeChatCounts?.(utcDay(now - p.chatCountsMs)) ?? 0,
      // The shared pacer's state: rows nobody touched for an hour (the longest window any check can have). No setting.
      pace: store.paceSweep?.(now - PACE_ROW_MAX_AGE_MS) ?? 0,
    };
    // Last: the finish of an erase that kept a remainder (a sanction in force) needs the sanction rows above to be gone, and the sweep of stray rows (a row whose person was
    // erased, written by a process that had not yet heard) needs the persons' rows to be gone first. A stray younger than ten minutes is kept: a subject row can trail its first
    // strike by a moment.
    let erasuresFinished = 0;
    for (const pending of store.loadPendingErasures()) if (store.finishErasure(pending.id, now)) erasuresFinished += 1;
    // The identity age-out runs after every table above, so a person whose last record aged out in this very pass goes in it. It moves the erasure epoch, so the other
    // processes forget the people it took.
    const idleSubjects = store.purgeIdleSubjects?.(now - p.subjectsMs) ?? 0;
    const strayRows = options.sweepStrays === false ? 0 : store.purgeStrayRows(now - STRAY_AGE_MS);
    return { ...result, idleSubjects, erasuresFinished, strayRows };
  });
}
