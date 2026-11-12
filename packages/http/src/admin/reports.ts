import { reasonLabel, safeWarn, suggestedRule } from '@chatwarden/core';
import type { CaseClaim, Chatwarden, ReportQuery, StaffReport } from '@chatwarden/core';
import { NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import { applyDecision, checkDurationsOffered, needForDecision, parseDecision, peopleOf } from './apply.js';
import type { AdminContext } from './context.js';
import { gateCase } from './claims.js';
import { bodyId, bodyLevel, bodyObject, bodyRule, bodyTakeOver, has, queryLevel, queryLimit } from './validate.js';

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
}

/** The claim as the API shows it: exactly `{ by, since, until }`. */
const claimView = (c: CaseClaim | undefined): ReportSummary['claim'] => (c === undefined ? null : { by: c.by, since: c.since, until: c.until });

/** Project a report to its queue summary. Lists each field by name, so a field added to the record never leaks in. */
const summarize = (r: StaffReport, claim: CaseClaim | undefined, viewing: string[] | undefined, label: string | null): ReportSummary => ({
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
});

/**
 * The report and decision routes (staff only, each audited):
 * - `GET /reports?status&reason&cursor&limit`: the queue as summaries (`reason` is a reason id, the old `disruption` included, or `none` for
 *   the reports that gave no reason; a malformed one is 400 `invalid_query`), no evidence beyond the `targetHandle` and `reporterHandle`
 *   (`report.view`, no target)
 *   Each item also carries `claim` and `viewing` for its open cases (see {@link ReportSummary}).
 * - `GET /reports/:id?level`: one report (with `reportedReasonLabel` beside its `reportedReason`) with each person's history and the
 *   suggestion for the reported person (`rule` is the first rule of the reported reason, `'uncovered'` with none), and the
 *   `claim` on the reported person's case (`{ by, since, until }` or null) (`report.view`)
 * - `POST /reports/:id/suggest { level, rule?, person? }`: a suggestion (`suggest`)
 * - `POST /reports/:id/decide { verdict, actions, reason?, evidence?, takeOver? }`: decide (`report.decide`, replays too). `reason` may be
 *   left out (or blank) only for a `no_action` with no actions, a one-click dismissal: the core then stores `NO_ACTION_DEFAULT_REASON`.
 *   Every other decision needs a real reason (400 `invalid_request`). Another
 *   moderator's live claim on the reported person is 409 `claimed` unless `takeOver: true` and the caller holds
 *   `claims.override` (then the takeover is audited as `case.takeover`, first). Deciding the person's last open report releases the
 *   caller's claim; while they have other open reports it is kept (one case per person).
 * - `GET /people/:ref/history?limit`: a person's actions, recent reports against them, their sanctions as
 *   `SanctionGroupView`s (the last 90 days and every unrevoked permanent one, newest first) and how the reports they
 *   filed stand, `asReporter` (with `reasonMatched` of `reasonDecided`: how often their reported reason was borne out by the decision), and `handle`, their handle on the newest report filed against them that recorded one, or null (`history.view`)
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
      c.audit('report.view');
      const items = page.items.map((r) =>
        r.status === 'open' ? summarize(r, claims.get(r.targetPerson), viewers.get(r.targetPerson), labelOf(r)) : summarize(r, undefined, undefined, labelOf(r)),
      );
      return { status: 200, body: { items, next: page.next } };
    }),

    'GET /reports/:id': ctx.secure('reports.read', (c) => {
      const id = c.params.id as string;
      const level = queryLevel(c.req.query.level);
      const report = load(id);
      const rule = ruleOf(cw, report);
      const history = Object.fromEntries(peopleOf(report).map((p) => [p, cw.history(p)]));
      const suggest = cw.suggest(report.targetPerson, level, rule, { roomId: roomOf(report) });
      const claim = claimView(claimOf(report));
      c.audit('report.view', { type: 'report', ref: id });
      return { status: 200, body: { report: { ...report, reportedReasonLabel: labelOf(report) }, history, suggest, rule, claim } };
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
      });
      c.audit('suggest', { type: 'report', ref: id });
      return { status: 200, body: suggestion };
    }),

    'POST /reports/:id/decide': ctx.secure('reports.decide', async (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);
      const decision = parseDecision(body);
      const takeOver = bodyTakeOver(body);

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
      const result = await applyDecision(cw, id, decision, c.authz.actor);
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
      c.audit('history.view', { type: 'person', ref });
      return { status: 200, body: { history, reports, sanctions, asReporter, handle } };
    }),
  };
}
