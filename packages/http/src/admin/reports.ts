import { BULK_DISMISS_MAX, reasonLabel, safeWarn, suggestedRule } from '@chatwarden/core';
import type { AiBrief, CaseClaim, Chatwarden, ReporterAccuracy, ReportQuery, StaffReport } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import { roleAtLeast } from '../permissions.js';
import { flagKey, handleFlags } from './handles.js';
import { namedIn, parseDecision, peopleOf } from './apply.js';
import type { AdminCall, AdminContext } from './context.js';
import { gateCase } from './claims.js';
import { decideAs } from './decideAs.js';
import { bodyAiEcho, bodyDecideRename, bodyDismissOpen, bodyHandoff, bodyId, bodyLevel, bodyObject, bodyRule, bodyTakeOver, bodyUrgentOn, has, optionalBody, queryLevel, queryLimit } from './validate.js';

/** How many recent reports `GET /people/:ref/history` summarises when `limit` is absent. */
const HISTORY_REPORTS_DEFAULT = 20;

/**
 * The Community Rule suggested for a report: the first still-citable rule of the reason the reporter gave, from the reasons in force now, or
 * `'uncovered'` when they gave none (the moderator picks). Never decides anything.
 */
const ruleOf = (cw: Chatwarden, report: StaffReport) => suggestedRule(cw.profile.reporting.reasons, report.reportedReason, cw.rules);

/** The context the report's room had (its `context` tag as written, even one the profile does not declare: the hub shows it), or null. */
const contextOf = (r: Pick<StaffReport, 'tags'>): string | null => (Object.hasOwn(r.tags, 'context') && typeof r.tags['context'] === 'string' ? r.tags['context'] : null);

/** The room for `suggest`: the report's own (an empty one is no room). Never from the request. */
const roomOf = (report: StaffReport): string | null => (report.roomId === '' ? null : report.roomId);

/**
 * One row of the queue: enough to sort, filter and group by person, and nothing of the evidence. No excerpt, chat text,
 * handle, seat, reporter note, moderator note or bad-faith evidence: those are on `GET /reports/:id`, which is audited
 * with the report id. `targetPerson` / `reporterPerson` are the canonical staff refs a hub groups by. The decision shows
 * as `status` (`actioned` / `dismissed`), `badFaith`, `actionedAt` and `actionedBy`.
 */
export interface ReportSummary {
  id: string;
  createdAt: number;
  roomId: string;
  tags: Record<string, string>;
  /** The 0.1.1 category the report is kept under (derived from the reason). Prefer `reportedReason`. */
  category: StaffReport['category'];
  /** The reason the reporter gave (an id from the reporting reasons; an old category reads as its new id), or null when they gave none. A hint, never the truth. */
  reportedReason: string | null;
  /** The reason's label as it is now (a relabel shows at once), the id itself when the reason is no longer listed, null when none was given. */
  reportedReasonLabel: string | null;
  status: StaffReport['status'];
  badFaith: boolean;
  targetPerson: string;
  /** The staff ref of the person who filed the report, or null for a report nobody filed (a chat filter's flag). */
  reporterPerson: string | null;
  actionedAt: number | null;
  actionedBy: string | null;
  /**
   * The reported person's handle as it was when the report was filed (the target seat's, or the cited line's author's), so
   * the queue can show a name. Null when none was recorded. Staff only, like the report page itself.
   */
  targetHandle: string | null;
  /** The reporter's handle as it was when the report was filed, on the same terms as {@link ReportSummary.targetHandle}: so a reporter from another room is named, not just tagged. Null when none was recorded. Staff only. */
  reporterHandle: string | null;
  /**
   * Who is handling the reported person's case, from when and until when it lapses: `{ by, since, until }`, or null when
   * nobody holds it (or the report is no longer open). Staff only. A claim is a courtesy: it never hides or blocks a read.
   */
  claim: { by: string; since: number; until: number } | null;
  /** The other staff actors who have this person's case open right now (the caller left out), sorted. In-memory per process, a hint. */
  viewing: string[];
  /**
   * How the reporter's reports of the last 30 days turned out, on OPEN rows and only for a caller whose role holds `history.read`;
   * null on a decided row, for a caller without that permission, when the reporter has no decided report in the window, and when
   * the store cannot tell. Optional on the type (a client reads an older server's rows), always set by this server. `falseRate` is null below 5 decided reports. A ranking hint and a line on the case: never a reason to
   * hide a report. Staff only.
   */
  reporterAccuracy?: ReporterAccuracySummary | null;
  /**
   * What the AI read of an OPEN report, as a brief: `{ severity, confidence, rule, stale, injectionSuspected, hasRecommendation }`. Null on
   * a decided row, when the AI is off, and when the report has no read yet. No summary, no line ids, no model: the queue carries nothing of
   * the evidence. `hasRecommendation` is true at level 2 only. Always set by this server; optional on the type (a client reads an older
   * server's rows). Staff only.
   */
  ai?: AiBrief | null;
  /**
   * Present (true) only when the queue signal feed (`feeds.queue`) is on, the caller's role holds `history.read`, and the reported person
   * meets its threshold; absent otherwise, so a server with the feed off answers exactly as before. A ranking hint (the hub's priority
   * sort adds a capped amount): never a reason to hide a report, and it names no signal. Staff only. @experimental
   */
  boosted?: true;
  /**
   * Present only on a report nobody filed: `'filter'` for a chat filter's flag (`'watch'` later). Such a report has `reporterPerson` and `reporterHandle`
   * null, no note and no reporter accuracy. Absent on a player's report, so those bodies are as they were. Staff only.
   */
  origin?: 'filter' | 'watch';
  /** With a `phrase.<id>` key whose rule is still in the settings: that rule's label as it is now, so a queue can say "Filter: Gold ads". Absent otherwise. */
  originLabel?: string;
  /** With `origin`: the filter counter key that made the report (`link.unlisted`, `phrase.<id>` ...): a closed shape, never text from a line. The hub words it ("Filter: Links"). */
  originKey?: string;
  /**
   * Present (true) only on an urgent report: its reason is flagged urgent (a snapshot taken when it was filed) or a moderator marked it. Absent otherwise, so a body with none urgent is
   * as it was. A word on the row, never a colour. Staff only. @experimental
   */
  urgent?: true;
  /** Present only after a moderator marked the case as passed to the game's safety team: when (never who). Staff only. @experimental */
  handoffAt?: number;
  /**
   * Present only with `desk.workflow` on, on an OPEN report that someone asked a senior or the owner to look at: the role asked (never who, never why). The queue is not reordered by it. Staff
   * only. @experimental
   */
  escalatedTo?: 'senior' | 'owner';
  /** Present (true) only when the reported person's handle is one the matcher flags and `names.maskInHub` is on: the hub masks it until shown. Staff only. */
  targetHandleFlagged?: true;
  /** The same for the reporter's handle. */
  reporterHandleFlagged?: true;
}

/** The part of a reporter's accuracy a queue row carries. */
export interface ReporterAccuracySummary {
  decided: number;
  unfounded: number;
  falseRate: number | null;
  habitual: boolean;
}

/** What a bulk dismissal answers: counts only. Never a report id, a subject id or a reporter ref. */
const counts = (res: Extract<Awaited<ReturnType<Chatwarden['reports']['dismissMany']>>, { ok: true }>) => ({
  ok: true,
  dryRun: res.dryRun,
  open: res.open,
  dismissed: res.dismissed,
  replayed: res.replayed,
  skipped: { claimed: res.skipped.claimed, decided: res.skipped.decided, urgent: res.skipped.urgent },
  more: res.more,
});

/** The claim as the API shows it: exactly `{ by, since, until }`. */
const claimView = (c: CaseClaim | undefined): ReportSummary['claim'] => (c === undefined ? null : { by: c.by, since: c.since, until: c.until });

/** The origin of a report nobody filed, as the body carries it: nothing at all for a player's report. */
const originOf = (r: Pick<StaffReport, 'origin' | 'originKey'>): { origin?: 'filter' | 'watch'; originKey?: string } =>
  r.origin === null || r.origin === undefined ? {} : { origin: r.origin, ...(r.originKey === null || r.originKey === undefined ? {} : { originKey: r.originKey }) };

/** At most this many distinct entities are listed for a person. */
const ENTITIES_MAX = 5;

/** The distinct entities (by kind and ref) that these OPEN reports name, in the order met, at most {@link ENTITIES_MAX}: `{ kind, ref, label }` and `labelFlagged: true` when the label is flagged. */
function openEntities(reports: ReadonlyArray<{ status: string; entity: { kind: string; ref: string; label: string } | null }>, flagged: (text: string) => boolean): Array<{ kind: string; ref: string; label: string; labelFlagged?: true }> {
  const out: Array<{ kind: string; ref: string; label: string; labelFlagged?: true }> = [];
  for (const r of reports) {
    if (r.status !== 'open' || r.entity === null || out.length >= ENTITIES_MAX) continue;
    if (out.some((e) => e.kind === r.entity?.kind && e.ref === r.entity?.ref)) continue;
    out.push({ kind: r.entity.kind, ref: r.entity.ref, label: r.entity.label, ...(flagged(r.entity.label) ? { labelFlagged: true as const } : {}) });
  }
  return out;
}

/** Project a report to its queue summary. Lists each field by name, so a field added to the record never leaks in. */
const summarize = (
  r: StaffReport,
  claim: CaseClaim | undefined,
  viewing: string[] | undefined,
  label: string | null,
  accuracy: ReporterAccuracy | undefined,
  ai: AiBrief | undefined,
  boosted = false,
  originLabel?: string,
  escalated = false,
): ReportSummary => ({
  id: r.id,
  createdAt: r.createdAt,
  roomId: r.roomId,
  tags: { ...r.tags },
  category: r.category,
  reportedReason: r.reportedReason,
  reportedReasonLabel: label,
  status: r.status,
  badFaith: r.badFaith,
  targetPerson: r.targetPerson,
  reporterPerson: r.reporterPerson,
  actionedAt: r.actionedAt,
  actionedBy: r.actionedBy,
  targetHandle: r.targetHandle === '' ? null : r.targetHandle,
  reporterHandle: r.reporterHandle === '' ? null : r.reporterHandle,
  claim: claimView(claim),
  viewing: viewing === undefined ? [] : [...viewing],
  reporterAccuracy:
    accuracy === undefined ? null : { decided: accuracy.decided, unfounded: accuracy.unfounded, falseRate: accuracy.falseRate, habitual: accuracy.habitual },
  ai: ai === undefined ? null : { ...ai },
  ...(boosted ? { boosted: true as const } : {}),
  ...originOf(r),
  ...(originLabel === undefined ? {} : { originLabel }),
  ...(r.urgent ? { urgent: true as const } : {}),
  ...(r.handoffAt === null ? {} : { handoffAt: r.handoffAt }),
  ...(escalated && r.status === 'open' && r.escalatedTo !== null ? { escalatedTo: r.escalatedTo } : {}),
});

/**
 * The report and decision routes (staff only, each audited):
 * - `GET /reports?urgent=1&status=open&cursor&limit` (`reports.read`): the OPEN urgent reports only, as summaries, newest first, found at any age (a report older than the queue's pages
 *   still shows). `urgent` must be `1`; a status other than `open` is 400 `invalid_query`, so is any other value. An urgent row carries `urgent: true` (and `handoffAt` once marked); a row that
 *   is not urgent has neither key. Every other row is as below.
 * - `POST /reports/:id/urgent { on }` (`reports.urgent`, a moderator's by default): mark a report urgent or not urgent. `{ ok: true }`, also for a repeat; 404 `not_found`; 409
 *   `already_decided` for a decided report; 400 `invalid_request` for anything but exactly `{ on: boolean }`. Audited `report.urgent` on the report, after the write (best effort).
 * - `POST /reports/:id/handoff { takeOver? }` (`reports.handoff`, a moderator's by default): mark the case as passed to the game's safety team: who and when, the first mark only (a
 *   repeat is `{ ok: true }` and changes nothing). It honours the claim gate exactly like a decision (409 `claimed`; `takeOver` needs `claims.override` and is audited `case.takeover`, first).
 *   It contacts no one. 404 `not_found`; 409 `already_decided`. Audited `report.handoff` on the report, after the write (best effort). The kit raises `report.handoff` (ids and a time).
 * - `GET /reports?status&reason&cursor&limit`: the queue as summaries (`reason` is a reason id, the old `disruption` included, or `none` for
 *   the reports that gave no reason; a malformed one is 400 `invalid_query`), no evidence beyond the `targetHandle` and `reporterHandle`
 *   (`report.view`, no target)
 *   Each item also carries `claim` and `viewing` for its open cases (see {@link ReportSummary}).
 *   An open item also carries `ai` (the AI's brief, see {@link ReportSummary.ai}), or null. With the queue signal feed (`feeds.queue`) on, an open
 *   item whose person meets it also carries `boosted: true` (only for a caller who holds `history.read`); with the feed off the key is absent.
 * - `GET /reports/:id?level`: one report (with `reportedReasonLabel` beside its `reportedReason`) with each person's history and the
 *   suggestion for the reported person (`rule` is the first rule of the reported reason, `'uncovered'` with none), and the
 *   `claim` on the reported person's case (`{ by, since, until }` or null) (`report.view`). It also carries `ai`: null, or the AI's read
 *   `{ id, severity, rule, summary, evidenceLineIds, confidence, stale, injectionSuspected, model, at, recommendation }` where
 *   `recommendation` is null at level 1 and otherwise `{ verdict, severity, rule, evidenceLineIds, step, stepWithinCeiling }` (`step` is
 *   the ladder's suggestion for the AI's conduct level, computed now; `stepWithinCeiling` says a one-key accept may fill it). Opening a
 *   case with no read, or a stale one, queues a read. Never an error: with the AI off, broken or over budget it is null.
 * - `POST /reports/:id/suggest { level, rule?, person? }`: a suggestion (`suggest`). When a signal ladder rule (`feeds.ladder`) fired it also
 *   carries `signals: { raised, ids }` and the rule's sentence is in `why`; `GET /reports/:id` carries the same in its `suggest`. Both are only
 *   for a caller whose role holds `history.read` (the sentence is a count of what other players did, like the counts on the record): a caller
 *   without it gets the same outcome and label, but no `signals` key and no such sentence in `why`.
 * - `POST /reports/:id/decide { verdict, actions, reason?, evidence?, rename?, takeOver? }`: decide (`report.decide`, replays too). `reason` may be
 *   left out (or blank) only for a `no_action` with no actions, a one-click dismissal: the core then stores `NO_ACTION_DEFAULT_REASON`.
 *   Every other decision needs a real reason (400 `invalid_request`). The body may carry `ai: { readId, accepted, severity? }`, the read the
 *   moderator saw, whether they accepted its pre-fill in one click and the conduct level their form settled on: it records an outcome against
 *   the AI read (the server computes agree or override itself; it records one for every decision on a report that has a read, with or without
 *   this) and never changes the answer; a malformed `ai` is 400, an unknown `readId` is ignored. Another
 *   moderator's live claim on the reported person is 409 `claimed` unless `takeOver: true` and the caller holds
 *   `claims.override` (then the takeover is audited as `case.takeover`, first). Deciding the person's last open report releases the
 *   caller's claim; while they have other open reports it is kept (one case per person). `rename: { rule }` also asks the reported person to
 *   choose a new name (an upheld verdict, actions only on that person, `sanctions.apply`, renames on; else 400, 403 or 404 before anything is
 *   written). It is asked after the decision is written, with the decision's reason, and the answer gains `rename: { status: 'asked' | 'already' |
 *   'failed', error? }` (`error` is `off`, `not_found` or `invalid` for a refusal; a throw is `failed` with none; the decision stands either way).
 *   A rename that was asked is audited as `name.rename_required` after the decision's own row. A replay never asks a second time: once a rename was
 *   asked of the person at or after the decision was written (even if they have renamed since), the replay answers `rename: { status: 'already' }`.
 * - `POST /reports/dismiss-open { scope: 'person' | 'reporter', ref, takeOver?, dryRun? }`: "nothing wrong here" for every open report about a person
 *   (their case) or from a reporter, in one call (`reports.decide.bulk`, and `reports.decide`): at most 200, `more: true` when there are
 *   more. 200 `{ ok, dryRun, open, dismissed, replayed, skipped: { claimed, decided }, more }`: counts only, no ids. Each report is
 *   closed like a single `no_action` with the standard reason; a sweep never marks bad faith. Person scope behaves like `decide`: another
 *   moderator's live claim is 409 `claimed` unless `takeOver: true` and the caller holds `claims.override` (audited `case.takeover`,
 *   first). Reporter scope never takes a case over: cases held by others are skipped and counted. Audited: one `report.dismiss_case` or
 *   `report.dismiss_reporter` row first (required: a sweep that cannot be recorded does not happen), then one `report.decide` row per
 *   report closed (best effort). `dryRun` counts and writes nothing. An unknown ref is 200 with zeros. `reason` is not accepted.
 * - `GET /people/:ref/history?limit`: a person's actions, recent reports against them, their sanctions as
 *   `SanctionGroupView`s (the last 90 days and every unrevoked permanent one, newest first) and how the reports they
 *   filed stand, `asReporter` (with `reasonMatched` of `reasonDecided`: how often their reported reason was borne out by the decision), and `handle`, their handle on the newest report filed against them that recorded one, or null (`history.view`). With the record signal feed (`feeds.record`) on it also carries `signals`: the chosen kinds' counts over the chosen window
 *   (`SignalCount[]`, `[]` when none qualifies); with the feed off the key is absent.
 *   Two more keys, each only while its feature is on or there is something to show (else the body is what 0.1.7 sent): `appeals`, the
 *   person's appeals as the core's `AppealSummary`s, newest first, with no statement (only for a caller who holds `appeals.read`), and `renames`,
 *   `{ at, pending }` for each time a rename was required (no reason, no actor). A third, `automation: { code, at }`, only while a senior has marked the
 *   person "do not automate" (the closed reason code and when; never who).
 * - `noticeText` on each excerpt line of `GET /reports/:id` that some person wrote themselves (`ownLineIds`): the text that person's notice shows for it
 *   (`cw.notices.lineText`: delivered, or with only the blocked terms starred, never raw). A line nobody wrote has none.
 * - Handle flags: beside a handle the matcher flags, while `names.maskInHub` is on (the default), a body carries `true` under `targetHandleFlagged` /
 *   `reporterHandleFlagged` (a queue row, and the report in `GET /reports/:id`), `handleFlagged` on each excerpt line of that report and on the
 *   history's `handle`. Otherwise the key is absent, so an unflagged body is what 0.1.7 sent. It is the matcher's reading only
 *   (`cw.names.flagged`): nothing is stored, and a matcher that fails reads as not flagged.
 */
export function reportRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;

  /** The reason's label in force now; the id when it is no longer listed; null when none was given. */
  const labelOf = (r: StaffReport): string | null =>
    r.reportedReason === null ? null : (reasonLabel(cw.profile.reporting.reasons, r.reportedReason) ?? r.reportedReason);

  /** The label of the phrase rule a filter report names, as the settings have it now; undefined for any other report or a rule that is gone. */
  const originLabelOf = (r: Pick<StaffReport, 'originKey'>): string | undefined => {
    const key = r.originKey;
    if (typeof key !== 'string' || !key.startsWith('phrase.')) return undefined;
    return cw.profile.filters.phrases.find((p) => `phrase.${p.id}` === key)?.label;
  };

  /** A report's claim, only while its case is open. */
  const claimOf = (r: StaffReport): CaseClaim | undefined => (r.status === 'open' ? cw.cases.holders([r.targetPerson]).get(r.targetPerson) : undefined);

  /** The report, read through the caller's staff scope: a report out of scope (or with none) is exactly an unknown one. */
  const load = (id: string, scope?: readonly string[]): StaffReport => {
    const report = cw.reports.get(id, scope === undefined ? undefined : { scope });
    if (report === null) throw new NotFoundError();
    return report;
  };

  // The signal rules' sentence is a count of what other players did to the person: it needs `history.read`, like the counts on the record. The
  // outcome still moves (that is what a decider must see); only the sentence and the `signals` key are left out for a caller without it.
  const hideSignalsFor = (c: AdminCall): { hideSignalText?: true } => (roleAtLeast(c.authz.role, ctx.permissions['history.read']) ? {} : { hideSignalText: true });

  return {
    'GET /reports': ctx.secure('reports.read', (c) => {
      const scope = c.scope;
      const { status, cursor, reason, urgent } = c.req.query;
      const limit = queryLimit(c.req.query.limit);
      // The urgent queue: `urgent=1` and nothing else is a value; it means open reports, so another status is a contradiction (the facade refuses it too).
      if (urgent !== undefined && urgent !== '1') throw new HttpError('invalid_query');
      const urgentOnly = urgent === '1';
      // The facade validates `status` and the cursor (ReportQueryError -> 400) and clamps the limit.
      const page = cw.reports.list({
        ...(urgentOnly ? { urgent: true as const } : {}),
        ...(status === undefined ? {} : { status: status as NonNullable<ReportQuery['status']> }),
        ...(cursor === undefined ? {} : { before: cursor }),
        ...(limit === undefined ? {} : { limit }),
        // `none` is the reports with no reason; a malformed id is the facade's ReportQueryError (400).
        ...(reason === undefined ? {} : { reason: reason === 'none' ? null : reason }),
        // A scoped caller's list is filtered in the store query by their scope; it never comes from the request.
        ...(scope === undefined ? {} : { scope }),
      });
      const open = [...new Set(page.items.filter((r) => r.status === 'open').map((r) => r.targetPerson))];
      const claims = cw.cases.holders(open);
      const viewers = cw.cases.viewersOf(open, c.authz.actor);
      // The reporters' false-report figures: one batch for the page, for a caller who may read people's histories only. A failure
      // here must not take the queue down: the rows then carry null.
      let accuracy = new Map<string, ReporterAccuracy>();
      let boosted = new Set<string>();
      // A scoped caller sees no reporter record, signal boost or AI brief: each is read across scopes.
      if (scope === undefined && roleAtLeast(c.authz.role, ctx.permissions['history.read'])) {
        // Who meets the queue signal feed: one grouped read for the page, and none at all with the feed off. It never throws.
        if (open.length > 0 && cw.profile.signals.feeds.queue !== undefined) boosted = cw.signals.boosted(open);
        const reporters = [...new Set(page.items.filter((r) => r.status === 'open').flatMap((r) => (r.reporterPerson === null ? [] : [r.reporterPerson])))];
        if (reporters.length > 0) {
          try {
            accuracy = cw.reports.reporterAccuracy(reporters);
          } catch {
            safeWarn(ctx.logger, 'chatwarden.http_accuracy_failed');
          }
        }
      }
      // The AI's brief of each open report: one batch for the page. The AI can never take the queue down; it answers an empty map.
      const briefs = scope === undefined ? cw.ai.briefs(page.items.filter((r) => r.status === 'open').map((r) => r.id)) : new Map<string, AiBrief>();
      c.audit('report.view');
      const flagged = handleFlags(cw);
      const workflow = cw.desk.workflowEnabled();
      const items = page.items.map((r) => ({
        ...(r.status === 'open'
          ? summarize(r, claims.get(r.targetPerson), viewers.get(r.targetPerson), labelOf(r), r.reporterPerson === null ? undefined : accuracy.get(r.reporterPerson), briefs.get(r.id), boosted.has(r.targetPerson), originLabelOf(r), workflow)
          : summarize(r, undefined, undefined, labelOf(r), undefined, undefined, false, originLabelOf(r), workflow)),
        ...flagKey(flagged, 'targetHandleFlagged', r.targetHandle),
        ...flagKey(flagged, 'reporterHandleFlagged', r.reporterHandle),
        // The room's context, only for a room that had one (a queue of untagged rooms is byte-for-byte what it was).
        ...(contextOf(r) === null ? {} : { context: contextOf(r) }),
      }));
      return { status: 200, body: { items, next: page.next } };
    }, { scoped: true }),

    'GET /reports/:id': ctx.secure('reports.read', (c) => {
      const id = c.params.id as string;
      const scope = c.scope;
      const level = queryLevel(c.req.query.level);
      const report = load(id, scope);
      const rule = ruleOf(cw, report);
      // A scoped caller reads the record as it stands in their scope: the history is the actions made from their reports, the suggestion is built from it and no signal is read.
      const history = Object.fromEntries(peopleOf(report).map((p) => [p, scope === undefined ? cw.history(p) : cw.scopedHistory(p, scope).history]));
      const suggest = cw.suggest(report.targetPerson, level, rule, { roomId: roomOf(report), ...hideSignalsFor(c), ...(scope === undefined ? {} : { scope }) });
      const claim = claimView(claimOf(report));
      // Opening a case is when a missing or stale read is asked for; the answer is whatever is stored now. The AI's read was made from the whole record, so a scoped caller is not shown it.
      const ai = scope === undefined ? cw.ai.read(id, { open: true }) : null;
      // Whether a read is on its way, so the hub waits only when one is: present when the AI is on (level 1 or 2), absent when it is off, so a
      // server with the AI off answers exactly as before. False in a degraded mode (breaker open, a daily cap reached, a read that ended
      // without an answer).
      const aiExpected = scope !== undefined || cw.ai.level() === 0 ? undefined : cw.ai.expected(id);
      c.audit('report.view', { type: 'report', ref: id });
      // The handles the matcher flags (the report's two, and each excerpt line's): the hub masks them until shown. Absent when none is.
      const flagged = handleFlags(cw);
      // The text the player's notice shows for a line, on each line some person wrote themselves (`ownLineIds`): delivered, or starred where a
      // term was blocked, never raw. A line nobody wrote has none.
      const own = new Set(Object.values(report.ownLineIds).flat());
      // A line that cannot be worded (a damaged row) has no `noticeText`; it never fails the whole report. Logged once per read, by class only.
      const failed: unknown[] = [];
      const noticeTextOf = (l: StaffReport['excerpt'][number]): { noticeText?: string } => {
        if (!own.has(l.lineId)) return {};
        try {
          return { noticeText: cw.notices.lineText(l) };
        } catch (err) {
          failed.push(err);
          return {};
        }
      };
      // Which lines the room still holds, and which of those were taken back: retracted is true for a line taken back before or after the report was filed, removable for one a moderator can still take back
      // (in the evidence buffer, delivered and not yet taken back). A line is the same line only when its time matches too (a reopened room restarts its numbers). No text, seat or handle comes from this.
      const live = new Map(cw.rooms.lineStates(report.roomId).map((s) => [s.lineId, s]));
      const excerpt = report.excerpt.map((l) => {
        const now = live.get(l.lineId);
        const same = now !== undefined && now.ts === l.ts;
        return {
          ...l,
          retracted: l.retracted === true || (same && now.retracted),
          removable: same && !now.retracted && !l.blocked,
          ...noticeTextOf(l),
          ...(flagged(l.handle) ? { handleFlagged: true as const } : {}),
        };
      });
      if (failed.length > 0) safeWarn(ctx.logger, 'chatwarden.http_notice_text_failed', { error: failed[0] instanceof Error ? failed[0].name : 'unknown', count: failed.length });
      // A player's report carries no `origin` keys (the body is as it was); a report nobody filed carries them, with `reporterPerson` null. The raw hand-off, escalation and evidence
      // columns are not the body's shape: `urgent` and `handoff: { at, by }` stand in for them (staff ids, never a player's).
      const { origin: _origin, originKey: _originKey, handoffAt, handoffBy, escalatedTo, escalatedBy, escalatedAt, evidenceRef: _ref, scope: _scope, entity, ...plain } = report;
      void [_origin, _originKey, _ref, _scope];
      // With the workflow on: the staff thread and the second look asked of a senior or the owner. With it off the keys are not there at all.
      const workflow = cw.desk.workflowEnabled()
        ? {
            comments: cw.comments.list(id).map((cm) => ({ id: cm.id, at: cm.at, author: cm.author, role: cm.role, kind: cm.kind, text: cm.text })),
            escalation: escalatedTo === null || report.status !== 'open' ? null : { to: escalatedTo, by: escalatedBy, at: escalatedAt },
          }
        : {};
      // A held report shows `hold: { code, at }` (never who held it); every other body is as it was.
      const held = scope === undefined ? cw.legal.status(id) : null;
      const shown = {
        ...plain,
        urgent: report.urgent,
        context: contextOf(report),
        handoff: handoffAt === null ? null : { at: handoffAt, by: handoffBy },
        ...workflow,
        ...originOf(report),
        ...(held === null ? {} : { hold: held }),
        ...(originLabelOf(report) === undefined ? {} : { originLabel: originLabelOf(report) }),
        reportedReasonLabel: labelOf(report),
        // The clan, guild or team the report is about (a report about a player alone has no key at all); its label is a name, so it is masked like one.
        ...(entity === null ? {} : { entity, ...flagKey(flagged, 'entityLabelFlagged', entity.label) }),
        ...flagKey(flagged, 'targetHandleFlagged', report.targetHandle),
        ...flagKey(flagged, 'reporterHandleFlagged', report.reporterHandle),
        excerpt,
      };
      return {
        status: 200,
        body: { report: shown, history, suggest, rule, claim, ai, ...(aiExpected === undefined ? {} : { aiExpected }) },
      };
    }, { scoped: true }),

    'POST /reports/:id/urgent': ctx.secure('reports.urgent', (c) => {
      const id = c.params.id as string;
      const on = bodyUrgentOn(bodyObject(c.req));
      const res = cw.cases.setUrgent(id, c.authz.actor, on);
      if (!res.ok) throw res.refused === 'closed' ? new HttpError('already_decided') : new NotFoundError();
      // The mark has committed: an audit failure is logged, never turned into an error.
      c.audit('report.urgent', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),

    'POST /reports/:id/handoff': ctx.secure('reports.handoff', (c) => {
      const id = c.params.id as string;
      const { takeOver } = bodyHandoff(optionalBody(c.req));
      const report = load(id);
      // The same claim gate as a decision, on the reported person's case; a decided report is not gated (it answers already_decided below).
      if (report.status === 'open') gateCase(ctx, c, report.targetPerson, takeOver);
      const res = cw.cases.handoff(id, c.authz.actor);
      if (!res.ok) throw res.refused === 'closed' ? new HttpError('already_decided') : new NotFoundError();
      c.audit('report.handoff', { type: 'report', ref: id }, 'best-effort');
      return { status: 200, body: { ok: true } };
    }),

    'POST /reports/:id/suggest': ctx.secure('reports.read', (c) => {
      const id = c.params.id as string;
      const scope = c.scope;
      const body = bodyObject(c.req);
      const level = bodyLevel(body.level);
      const person = has(body, 'person') ? bodyId(body.person) : undefined;
      const rule = has(body, 'rule') ? bodyRule(body.rule) : undefined;
      if (rule !== undefined && !cw.rules.isCitable(rule)) throw new ValidationError();
      const report = load(id, scope);
      // Only the people the report names: this is not a way to look up anyone's record.
      const named = namedIn(report);
      if (person !== undefined && !named.has(person)) throw new ValidationError();
      const suggestion = cw.suggest(person ?? report.targetPerson, level, rule ?? ruleOf(cw, report), {
        roomId: roomOf(report),
        ...hideSignalsFor(c),
        ...(scope === undefined ? {} : { scope }),
      });
      c.audit('suggest', { type: 'report', ref: id });
      return { status: 200, body: suggestion };
    }, { scoped: true }),

    'POST /reports/:id/decide': ctx.secure('reports.decide', async (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      // A rename rides on an upheld decision: it needs the right to ask for one and renames to be on, checked before the rest of the body is
      // judged (as `POST /people/:ref/rename` does) and before anything is written.
      let rename: { rule: number } | undefined;
      if (has(body, 'rename')) {
        // Names and renames are not scope-aware: a scoped caller never asks one (before anything is read, so it tells nothing about the id).
        if (c.scope !== undefined) throw new HttpError('forbidden');
        c.need('sanctions.apply');
        if (!cw.names.renamesEnabled()) throw new NotFoundError();
        rename = bodyDecideRename(body.rename);
      }
      const decision = parseDecision(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'rename')));
      const takeOver = bodyTakeOver(body);
      const echo = has(body, 'ai') ? bodyAiEcho(body.ai) : undefined;
      const reported = cw.reports.get(id, c.scope === undefined ? undefined : { scope: c.scope });
      if (rename !== undefined) {
        // Only an upheld decision asks for a rename, and only of the reported person: an action on anyone else is refused, never moved.
        if (decision.verdict !== 'upheld') throw new ValidationError();
        if (reported !== null) {
          const target = cw.people.canonical(reported.targetPerson);
          if (!decision.actions.every((a) => cw.people.canonical(a.subject) === target)) throw new ValidationError();
        }
      }

      // The whole decision path is `decideAs`, shared with the Discord bot and the Coop callback: the permissions the decision needs, the
      // lengths on offer, another moderator's claim (a senior may take the case over, on the record: the takeover's audit row is written
      // first, in required mode), the decision itself and ending the caller's claim on the person's last open report. Never from the body:
      // the caller is who the auth hook says and an admin route is always a moderator's.
      const result = await decideAs(cw, {
        reportId: id,
        decision,
        actor: c.authz.actor,
        role: c.authz.role,
        permissions: ctx.permissions,
        claims: 'gate',
        ...(c.scope === undefined ? {} : { scoped: { scope: c.scope, limits: ctx.scopedLimits } }),
        ...(takeOver ? { takeOver: true as const } : {}),
        onTakeOver: (person) => c.audit('case.takeover', { type: 'person', ref: cw.people.canonical(person) }, 'required'),
        ...(echo === undefined ? {} : { echo }),
        ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
      });
      // The decision has committed (a replay included): an audit failure is logged, never turned into an error.
      c.audit('report.decide', { type: 'report', ref: id }, 'best-effort');
      if (rename === undefined || reported === null) return { status: 200, body: { ok: true, replay: result.replay, groups: result.groups } };

      // The claim was gated once, above; the rename follows the decision and never undoes it: a refusal or a throw here is the answer's `failed`.
      let answer: { status: 'asked' | 'already' | 'failed'; error?: 'off' | 'not_found' | 'invalid' };
      try {
        // A replay is the same request again: once a rename was asked since the decision was written (and the player has perhaps obeyed it
        // already, so none waits), it is not asked a second time. A request from before the decision is not this one.
        if (result.replay && askedSince(cw, reported.targetPerson, cw.reports.get(id)?.actionedAt ?? null)) {
          return { status: 200, body: { ok: true, replay: true, groups: result.groups, rename: { status: 'already' } } };
        }
        const asked = cw.names.requireRename({ subject: reported.targetPerson, actor: c.authz.actor, reason: decision.reason ?? '', rule: rename.rule });
        if (asked.ok) answer = { status: 'asked' };
        else if (asked.error === 'pending') answer = { status: 'already' };
        else answer = { status: 'failed', error: asked.error };
      } catch (err) {
        safeWarn(ctx.logger, 'chatwarden.http_rename_failed', { error: err instanceof Error ? err.name : 'unknown' });
        answer = { status: 'failed' };
      }
      if (answer.status === 'asked') c.audit('name.rename_required', { type: 'person', ref: cw.people.canonical(reported.targetPerson) }, 'best-effort');
      return { status: 200, body: { ok: true, replay: result.replay, groups: result.groups, rename: answer } };
    }, { scoped: true }),

    'POST /reports/dismiss-open': ctx.secure('reports.decide.bulk', async (c) => {
      // A sweep is a lot of dismissals: it also needs the right to dismiss one (lowering one permission never bypasses the other).
      c.need('reports.decide');
      const { scope, ref, takeOver, dryRun } = bodyDismissOpen(bodyObject(c.req));
      const actor = c.authz.actor;
      const canonical = cw.people.canonical(ref);

      if (dryRun) {
        // Counts only: nothing is written, no case is taken over, no audit row. The claims are counted, not honoured, so the
        // preview shows how many reports are held by someone else.
        const res = await cw.reports.dismissMany({ scope: scope === 'person' ? { person: ref } : { reporter: ref }, actor, dryRun: true });
        if (!res.ok) throw new ValidationError();
        return { status: 200, body: counts(res) };
      }

      // A person's case is claimed by one moderator at a time: another's live claim is 409 unless a senior takes it over (audited
      // `case.takeover`, first). A reporter's sweep spans many cases and never takes one over: held cases are skipped and counted.
      if (scope === 'person') gateCase(ctx, c, ref, takeOver);
      // The summary row first, in `required` mode: a sweep that cannot be recorded does not happen.
      c.audit(scope === 'person' ? 'report.dismiss_case' : 'report.dismiss_reporter', { type: 'person', ref: canonical }, 'required');
      const res = await cw.reports.dismissMany({
        scope: scope === 'person' ? { person: ref } : { reporter: ref },
        actor,
        ignoreClaims: scope === 'person',
        limit: BULK_DISMISS_MAX,
        // One `report.decide` row per report closed (a replay included, like the single route), written the moment it is closed, so a
        // store failure later in the sweep still leaves a row for every report already closed. The reports are closed: an audit
        // failure is logged, never turned into an error (and a throw here never stops the sweep).
        onClosed: (id) => c.audit('report.decide', { type: 'report', ref: id }, 'best-effort'),
      });
      if (!res.ok) throw new ValidationError();
      // The caller's own claim ends on a case with nothing left open; while other reports about the person are open it is kept.
      for (const person of res.targets) {
        try {
          cw.cases.releaseWhenDone(person, actor);
        } catch {
          safeWarn(ctx.logger, 'chatwarden.http_release_failed');
        }
      }
      return { status: 200, body: counts(res) };
    }),

    'GET /people/:ref/history': ctx.secure('history.read', (c) => {
      const ref = c.params.ref as string;
      const limit = queryLimit(c.req.query.limit) ?? HISTORY_REPORTS_DEFAULT;
      if (c.scope !== undefined) {
        // A scoped caller sees the reports filed in their rooms and the sanctions that came from them: no account ids, signals, links, appeals, renames or the person's record as a reporter.
        // A person with nothing in scope is a person nobody holds (404).
        const seen = cw.scopedHistory(ref, c.scope);
        if (seen.reports.length === 0) throw new NotFoundError();
        c.audit('history.view', { type: 'person', ref });
        return {
          status: 200,
          body: { history: seen.history, reports: seen.reports.slice(0, limit), sanctions: seen.sanctions, handle: seen.handle, ...flagKey(handleFlags(cw), 'handleFlagged', seen.handle) },
        };
      }
      const history = cw.history(ref);
      const filed = cw.reports.list({ person: ref, limit }).items;
      const reports = filed.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        category: r.category,
      }));
      // The name to show for the person: their handle on the newest report filed against them (null when none, or none recorded).
      const handle = filed.find((r) => r.targetHandle !== '')?.targetHandle ?? null;
      const sanctions = cw.sanctions.forPerson(ref);
      // The clans, guilds or teams that open reports about the person name, each once (the rename form's choice). Present only when there is one; a label is a name, so it is marked when the matcher flags it.
      const entities = openEntities(filed, handleFlags(cw));
      const asReporter = cw.reports.reporterRecord(ref);
      // The Person page record (`feeds.record`): the chosen kinds and window, counted by distinct source. Absent with the feed off.
      const signals = cw.profile.signals.feeds.record === undefined ? undefined : cw.signals.forRecord(ref);
      // Their appeals (summaries, no statement) for a caller who may read appeals, and their rename requests: each present only while its feature is
      // on or there is something to show, so with both off the body is what 0.1.7 sent.
      const mayReadAppeals = roleAtLeast(c.authz.role, ctx.permissions['appeals.read']);
      const appeals = mayReadAppeals ? cw.appeals.forPerson(ref) : [];
      const showAppeals = mayReadAppeals && (appeals.length > 0 || cw.appeals.enabled());
      const renames = cw.names.renamesOf(ref);
      // The "do not automate" mark (AI levels 3 and 4): only while there is one, as its closed code and when it was set; never who set it.
      const mark = cw.people.automation.get(ref);
      const showRenames = renames.length > 0 || cw.names.renamesEnabled();
      c.audit('history.view', { type: 'person', ref });
      return {
        status: 200,
        body: {
          history,
          reports,
          sanctions,
          asReporter,
          handle,
          ...flagKey(handleFlags(cw), 'handleFlagged', handle),
          ...(signals === undefined ? {} : { signals }),
          ...(showAppeals ? { appeals } : {}),
          ...(showRenames ? { renames } : {}),
          ...(entities.length === 0 ? {} : { entities }),
          ...(mark.allowed ? {} : { automation: { code: mark.code, at: mark.at } }),
        },
      };
    }, { scoped: true }),
  };
}

/** Whether a rename was asked of this person at or after `since` (the time the report's decision was written); false for no time or a fault. */
function askedSince(cw: Chatwarden, person: string, since: number | null): boolean {
  if (since === null) return false;
  try {
    return cw.names.renamesOf(person).some((r) => r.at >= since);
  } catch {
    return false;
  }
}
