import { CATEGORY_TO_RULE } from '@chatwarden/core';
import type { DecisionInput, ReportQuery, StaffReport } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { bodyId, bodyLevel, bodyObject, bodyRule, bodyText, has, parseAction, queryLevel, queryLimit } from './validate.js';

/** The most actions one decision may carry. A report involves a handful of people. */
const MAX_ACTIONS = 20;
/** How many recent reports `GET /people/:ref/history` summarises when `limit` is absent. */
const HISTORY_REPORTS_DEFAULT = 20;

const VERDICTS: readonly DecisionInput['verdict'][] = ['upheld', 'noted', 'no_action', 'bad_faith'];

/** The room for `suggest`: the report's own (an empty one is no room). Never from the request. */
const roomOf = (report: StaffReport): string | null => (report.roomId === '' ? null : report.roomId);

/** Everyone a report names, as staff refs: the target, the reporter and the people who wrote in the excerpt. */
function peopleOf(report: StaffReport): string[] {
  return [...new Set([report.targetPerson, report.reporterPerson, ...report.people])];
}

/**
 * The report and decision routes (staff only, each audited):
 * - `GET /reports?status&cursor&limit`: the queue (`report.view`, no target)
 * - `GET /reports/:id?level`: one report with each person's history and the suggestion for the reported person (`report.view`)
 * - `POST /reports/:id/suggest { level, rule?, person? }`: a suggestion (`suggest`)
 * - `POST /reports/:id/decide { verdict, actions, reason, evidence? }`: decide (`report.decide`, replays too)
 * - `GET /people/:ref/history?limit`: a person's actions and recent reports against them (`history.view`)
 */
export function reportRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;

  const load = (id: string): StaffReport => {
    const report = cw.reports.get(id);
    if (report === null) throw new NotFoundError();
    return report;
  };

  return {
    'GET /reports': ctx.secure('reports.read', (c) => {
      const { status, cursor } = c.req.query;
      const limit = queryLimit(c.req.query.limit);
      // The facade validates `status` and the cursor (ReportQueryError -> 400) and clamps the limit.
      const page = cw.reports.list({
        ...(status === undefined ? {} : { status: status as NonNullable<ReportQuery['status']> }),
        ...(cursor === undefined ? {} : { before: cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
      c.audit('report.view');
      return { status: 200, body: page };
    }),

    'GET /reports/:id': ctx.secure('reports.read', (c) => {
      const id = c.params.id as string;
      const level = queryLevel(c.req.query.level);
      const report = load(id);
      const rule = CATEGORY_TO_RULE[report.category];
      const history = Object.fromEntries(peopleOf(report).map((p) => [p, cw.history(p)]));
      const suggest = cw.suggest(report.targetPerson, level, rule, { roomId: roomOf(report) });
      c.audit('report.view', { type: 'report', ref: id });
      return { status: 200, body: { report, history, suggest, rule } };
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
      const suggestion = cw.suggest(person ?? report.targetPerson, level, rule ?? CATEGORY_TO_RULE[report.category], {
        roomId: roomOf(report),
      });
      c.audit('suggest', { type: 'report', ref: id });
      return { status: 200, body: suggestion };
    }),

    'POST /reports/:id/decide': ctx.secure('reports.decide', async (c) => {
      const id = c.params.id as string;
      const body = bodyObject(c.req);

      const verdict = body.verdict;
      if (typeof verdict !== 'string' || !(VERDICTS as readonly string[]).includes(verdict)) throw new ValidationError();
      if (!Array.isArray(body.actions) || body.actions.length > MAX_ACTIONS) throw new ValidationError();
      const actions = body.actions.map(parseAction);
      const reason = bodyText(body.reason);
      const evidence = has(body, 'evidence') ? bodyText(body.evidence) : undefined;

      // Authorization for what the decision DOES, before anything is read or written.
      if (actions.length > 0) c.need('sanctions.apply');
      if (actions.some((a) => a.kind === 'ban' && a.durationMs === null)) c.need('sanctions.apply.ban_permanent');

      const report = load(id);
      // The staff refs the report shows, or the ids it was filed under (the facade makes them canonical, so a ref gone
      // stale through a later merge still replays).
      const named = new Set([...peopleOf(report), report.targetSubject, report.reporterSubject]);
      if (!actions.every((a) => named.has(a.subject))) throw new ValidationError();

      const result = await cw.decide({
        reportId: id,
        verdict: verdict as DecisionInput['verdict'],
        ...(evidence === undefined ? {} : { evidence }),
        actions,
        // Never from the body: the caller is who the auth hook says, and an admin route is always a moderator's.
        actor: c.authz.actor,
        reason,
        source: 'moderator',
      });
      if (!result.ok) {
        if (result.error === 'not_found') throw new NotFoundError();
        if (result.error === 'already_decided') throw new HttpError('already_decided');
        throw new ValidationError();
      }
      // The decision has committed (a replay included): an audit failure is logged, never turned into an error.
      c.audit('report.decide', { type: 'report', ref: id }, 'best-effort');
      return {
        status: 200,
        body: {
          ok: true,
          replay: result.replay,
          groups: result.groups.map((g) => ({ refCode: g.refCode, kind: g.kind })),
        },
      };
    }),

    'GET /people/:ref/history': ctx.secure('history.read', (c) => {
      const ref = c.params.ref as string;
      const limit = queryLimit(c.req.query.limit) ?? HISTORY_REPORTS_DEFAULT;
      const history = cw.history(ref);
      const reports = cw.reports.list({ person: ref, limit }).items.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        category: r.category,
      }));
      c.audit('history.view', { type: 'person', ref });
      return { status: 200, body: { history, reports } };
    }),
  };
}
