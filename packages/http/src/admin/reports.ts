import { BULK_DISMISS_MAX, reasonLabel, safeWarn, suggestedRule } from '@chatwarden/core';
import type { AiBrief, CaseClaim, Chatwarden, ReporterAccuracy, ReportQuery, StaffReport } from '@chatwarden/core';
import { NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import { roleAtLeast } from '../permissions.js';
import { applyDecision, checkDurationsOffered, needForDecision, parseDecision, peopleOf } from './apply.js';
import type { AdminCall, AdminContext } from './context.js';
import { gateCase } from './claims.js';
import { bodyAiEcho, bodyDismissOpen, bodyId, bodyLevel, bodyObject, bodyRule, bodyTakeOver, has, queryLevel, queryLimit } from './validate.js';

/** How many recent reports `GET /people/:ref/history` summarises when `limit` is absent. */
const HISTORY_REPORTS_DEFAULT = 20;

/**
 * The Community Rule suggested for a report: the first still-citable rule of the reason the reporter gave, from the reasons in force now, or
 * `'uncovered'` when they gave none (the moderator picks). Never decides anything.
 */
const ruleOf = (cw: Chatwarden, report: StaffReport) => suggestedRule(cw.profile.reporting.reasons, report.reportedReason, cw.rules);

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
  reporterPerson: string;
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
  skipped: { claimed: res.skipped.claimed, decided: res.skipped.decided },
  more: res.more,
});

/** The claim as the API shows it: exactly `{ by, since, until }`. */
const claimView = (c: CaseClaim | undefined): ReportSummary['claim'] => (c === undefined ? null : { by: c.by, since: c.since, until: c.until });

/** Project a report to its queue summary. Lists each field by name, so a field added to the record never leaks in. */
const summarize = (
  r: StaffReport,
  claim: CaseClaim | undefined,
  viewing: string[] | undefined,
  label: string | null,
  accuracy: ReporterAccuracy | undefined,
  ai: AiBrief | undefined,
  boosted = false,
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
});

/**
 * The report and decision routes (staff only, each audited):
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
 * - `POST /reports/:id/decide { verdict, actions, reason?, evidence?, takeOver? }`: decide (`report.decide`, replays too). `reason` may be
 *   left out (or blank) only for a `no_action` with no actions, a one-click dismissal: the core then stores `NO_ACTION_DEFAULT_REASON`.
 *   Every other decision needs a real reason (400 `invalid_request`). The body may carry `ai: { readId, accepted, severity? }`, the read the
 *   moderator saw, whether they accepted its pre-fill in one click and the conduct level their form settled on: it records an outcome against
 *   the AI read (the server computes agree or override itself; it records one for every decision on a report that has a read, with or without
 *   this) and never changes the answer; a malformed `ai` is 400, an unknown `readId` is ignored. Another
 *   moderator's live claim on the reported person is 409 `claimed` unless `takeOver: true` and the caller holds
 *   `claims.override` (then the takeover is audited as `case.takeover`, first). Deciding the person's last open report releases the
 *   caller's claim; while they have other open reports it is kept (one case per person).
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
 *   `{ at, pending }` for each time a rename was required (no reason, no actor).
 */
export function reportRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;

  /** The reason's label in force now; the id when it is no longer listed; null when none was given. */
  const labelOf = (r: StaffReport): string | null =>
    r.reportedReason === null ? null : (reasonLabel(cw.profile.reporting.reasons, r.reportedReason) ?? r.reportedReason);

  /** A report's claim, only while its case is open. */
  const claimOf = (r: StaffReport): CaseClaim | undefined => (r.status === 'open' ? cw.cases.holders([r.targetPerson]).get(r.targetPerson) : undefined);

  const load = (id: string): StaffReport => {
    const report = cw.reports.get(id);
    if (report === null) throw new NotFoundError();
    return report;
  };

  // The signal rules' sentence is a count of what other players did to the person: it needs `history.read`, like the counts on the record. The
  // outcome still moves (that is what a decider must see); only the sentence and the `signals` key are left out for a caller without it.
  const hideSignalsFor = (c: AdminCall): { hideSignalText?: true } => (roleAtLeast(c.authz.role, ctx.permissions['history.read']) ? {} : { hideSignalText: true });

  return {
    'GET /reports': ctx.secure('reports.read', (c) => {
      const { status, cursor, reason } = c.req.query;
      const limit = queryLimit(c.req.query.limit);
      // The facade validates `status` and the cursor (ReportQueryError -> 400) and clamps the limit.
      const page = cw.reports.list({
        ...(status === undefined ? {} : { status: status as NonNullable<ReportQuery['status']> }),
        ...(cursor === undefined ? {} : { before: cursor }),
        ...(limit === undefined ? {} : { limit }),
        // `none` is the reports with no reason; a malformed id is the facade's ReportQueryError (400).
        ...(reason === undefined ? {} : { reason: reason === 'none' ? null : reason }),
      });
      const open = [...new Set(page.items.filter((r) => r.status === 'open').map((r) => r.targetPerson))];
      const claims = cw.cases.holders(open);
      const viewers = cw.cases.viewersOf(open, c.authz.actor);
      // The reporters' false-report figures: one batch for the page, for a caller who may read people's histories only. A failure
      // here must not take the queue down: the rows then carry null.
      let accuracy = new Map<string, ReporterAccuracy>();
      let boosted = new Set<string>();
      if (roleAtLeast(c.authz.role, ctx.permissions['history.read'])) {
        // Who meets the queue signal feed: one grouped read for the page, and none at all with the feed off. It never throws.
        if (open.length > 0 && cw.profile.signals.feeds.queue !== undefined) boosted = cw.signals.boosted(open);
        const reporters = [...new Set(page.items.filter((r) => r.status === 'open').map((r) => r.reporterPerson))];
        if (reporters.length > 0) {
          try {
            accuracy = cw.reports.reporterAccuracy(reporters);
          } catch {
            safeWarn(ctx.logger, 'chatwarden.http_accuracy_failed');
          }
        }
      }
      // The AI's brief of each open report: one batch for the page. The AI can never take the queue down; it answers an empty map.
      const briefs = cw.ai.briefs(page.items.filter((r) => r.status === 'open').map((r) => r.id));
      c.audit('report.view');
      const items = page.items.map((r) =>
        r.status === 'open'
          ? summarize(r, claims.get(r.targetPerson), viewers.get(r.targetPerson), labelOf(r), accuracy.get(r.reporterPerson), briefs.get(r.id), boosted.has(r.targetPerson))
          : summarize(r, undefined, undefined, labelOf(r), undefined, undefined),
      );
      return { status: 200, body: { items, next: page.next } };
    }),

    'GET /reports/:id': ctx.secure('reports.read', (c) => {
      const id = c.params.id as string;
      const level = queryLevel(c.req.query.level);
      const report = load(id);
      const rule = ruleOf(cw, report);
      const history = Object.fromEntries(peopleOf(report).map((p) => [p, cw.history(p)]));
      const suggest = cw.suggest(report.targetPerson, level, rule, { roomId: roomOf(report), ...hideSignalsFor(c) });
      const claim = claimView(claimOf(report));
      // Opening a case is when a missing or stale read is asked for; the answer is whatever is stored now.
      const ai = cw.ai.read(id, { open: true });
      // Whether a read is on its way, so the hub waits only when one is: present when the AI is on (level 1 or 2), absent when it is off, so a
      // server with the AI off answers exactly as before. False in a degraded mode (breaker open, a daily cap reached, a read that ended
      // without an answer).
      const aiExpected = cw.ai.level() === 0 ? undefined : cw.ai.expected(id);
      c.audit('report.view', { type: 'report', ref: id });
      return {
        status: 200,
        body: { report: { ...report, reportedReasonLabel: labelOf(report) }, history, suggest, rule, claim, ai, ...(aiExpected === undefined ? {} : { aiExpected }) },
      };
    }),

    'POST /reports/:id/suggest': ctx.secure('reports.read', (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      const level = bodyLevel(body.level);
      const person = has(body, 'person') ? bodyId(body.person) : undefined;
      const rule = has(body, 'rule') ? bodyRule(body.rule) : undefined;
      if (rule !== undefined && !cw.rules.isCitable(rule)) throw new ValidationError();
      const report = load(id);
      // Only the people the report names: this is not a way to look up anyone's record.
      const named = new Set([...peopleOf(report), report.targetSubject, report.reporterSubject]);
      if (person !== undefined && !named.has(person)) throw new ValidationError();
      const suggestion = cw.suggest(person ?? report.targetPerson, level, rule ?? ruleOf(cw, report), {
        roomId: roomOf(report),
        ...hideSignalsFor(c),
      });
      c.audit('suggest', { type: 'report', ref: id });
      return { status: 200, body: suggestion };
    }),

    'POST /reports/:id/decide': ctx.secure('reports.decide', async (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      const decision = parseDecision(body);
      const takeOver = bodyTakeOver(body);
      const echo = has(body, 'ai') ? bodyAiEcho(body.ai) : undefined;

      // Authorization for what the decision DOES, before anything is read or written.
      needForDecision(decision.actions, c.need);

      // Another moderator's live claim on the reported person stops the decision, unless a senior takes the case over.
      // A report that is no longer open is a replay or an already_decided: a claim taken since must not turn that into a 409.
      const existing = cw.reports.get(id);
      // The lengths on offer apply to a decision that would be applied now: a replay, or a different decision on a report that is
      // already decided, is answered as such (`already_decided` or a replay) whatever the rule says today.
      if (existing !== null && existing.status === 'open') checkDurationsOffered(cw, decision.actions);
      const person = existing !== null && existing.status === 'open' ? existing.targetPerson : null;
      if (person !== null) gateCase(ctx, c, person, takeOver);

      // Never from the body: the caller is who the auth hook says, and an admin route is always a moderator's.
      const result = await applyDecision(cw, id, decision, c.authz.actor, { ...(echo === undefined ? {} : { echo }), role: c.authz.role });
      // The decision has committed (a replay included): an audit failure is logged, never turned into an error.
      c.audit('report.decide', { type: 'report', ref: id }, 'best-effort');
      // Deciding the person's last open report ends the caller's own claim; while other reports about them are open the claim is
      // kept (one case per person), so nobody else can take the case from the moderator who is working through it. Not on a
      // replay: the caller may hold a fresh claim on the person's next report.
      if (person !== null && !result.replay) {
        try {
          cw.cases.releaseWhenDone(person, c.authz.actor);
        } catch {
          safeWarn(ctx.logger, 'chatwarden.http_release_failed');
        }
      }
      return { status: 200, body: { ok: true, replay: result.replay, groups: result.groups } };
    }),

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
      const asReporter = cw.reports.reporterRecord(ref);
      // The Person page record (`feeds.record`): the chosen kinds and window, counted by distinct source. Absent with the feed off.
      const signals = cw.profile.signals.feeds.record === undefined ? undefined : cw.signals.forRecord(ref);
      // Their appeals (summaries, no statement) for a caller who may read appeals, and their rename requests: each present only while its feature is
      // on or there is something to show, so with both off the body is what 0.1.7 sent.
      const mayReadAppeals = roleAtLeast(c.authz.role, ctx.permissions['appeals.read']);
      const appeals = mayReadAppeals ? cw.appeals.forPerson(ref) : [];
      const showAppeals = mayReadAppeals && (appeals.length > 0 || cw.appeals.enabled());
      const renames = cw.names.renamesOf(ref);
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
          ...(signals === undefined ? {} : { signals }),
          ...(showAppeals ? { appeals } : {}),
          ...(showRenames ? { renames } : {}),
        },
      };
    }),
  };
}
