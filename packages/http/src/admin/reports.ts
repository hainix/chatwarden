import { CATEGORY_TO_RULE, SANCTION_KINDS } from '@chatwarden/core';
import type { DecisionAction, DecisionInput, SanctionKind, StaffReport } from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { asObject, bodyId, bodyLevel, bodyObject, bodyRule, has, queryLevel, queryLimit } from './validate.js';

/** The most actions one decision may carry. A report involves a handful of people. */
const MAX_ACTIONS = 20;
/** The most excerpt lines a notice may quote per action (the facade's own cap). */
const MAX_LINE_IDS = 5;
const MAX_TEXT = 2000;
/** How many recent reports `GET /people/:ref/history` summarises when `limit` is absent. */
const HISTORY_REPORTS_DEFAULT = 20;

const VERDICTS: readonly DecisionInput['verdict'][] = ['upheld', 'noted', 'no_action', 'bad_faith'];

/** The room for `suggest`: the report's own (an empty one is no room). Never from the request. */
const roomOf = (report: StaffReport): string | null => (report.roomId === '' ? null : report.roomId);

/** Everyone a report names, as staff refs: the target, the reporter and the people who wrote in the excerpt. */
function peopleOf(report: StaffReport): string[] {
  return [...new Set([report.targetPerson, report.reporterPerson, ...report.people])];
}

const text = (v: unknown, max = MAX_TEXT): string => {
  if (typeof v !== 'string' || v.length > max) throw new ValidationError();
  return v;
};

/** One request action, checked for shape and cut down to the fields the facade reads. Rules and limits stay with the facade. */
function parseAction(raw: unknown): DecisionAction {
  const a = asObject(raw);
  if (a === undefined) throw new ValidationError();
  const subject = bodyId(a.subject);
  const kind = a.kind;
  if (typeof kind !== 'string' || !(SANCTION_KINDS as readonly string[]).includes(kind)) throw new ValidationError();
  // Required, not defaulted: leaving a duration out must never turn a chat restriction or a ban into a permanent one.
  const durationMs = a.durationMs;
  if (durationMs !== null && !(typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs > 0)) {
    throw new ValidationError();
  }
  const action: DecisionAction = { subject, kind: kind as SanctionKind, durationMs, rule: bodyRule(a.rule) };
  if (has(a, 'gapNote')) action.gapNote = text(a.gapNote);
  if (has(a, 'includeIp')) {
    if (typeof a.includeIp !== 'boolean') throw new ValidationError();
    action.includeIp = a.includeIp;
  }
  if (has(a, 'lineIds')) {
    const ids = a.lineIds;
    if (!Array.isArray(ids) || ids.length > MAX_LINE_IDS) throw new ValidationError();
    action.lineIds = ids.map((id) => text(id, 64));
  }
  return action;
}

/**
 * Pair each decided group with the kind of the action that made it. The facade writes groups in the order of its sorted
 * actions (canonical subject, then kind), and the subjects here were checked to be the report's canonical staff refs, so
 * each person's kinds, sorted, line up with that person's groups.
 */
function kindsOf(groups: ReadonlyArray<{ subject: string }>, actions: readonly DecisionAction[]): SanctionKind[] {
  const bySubject = new Map<string, SanctionKind[]>();
  for (const a of actions) bySubject.set(a.subject, [...(bySubject.get(a.subject) ?? []), a.kind]);
  for (const kinds of bySubject.values()) kinds.sort();
  const spare = [...actions].map((a) => a.kind).sort();
  return groups.map((g) => {
    const own = bySubject.get(g.subject)?.shift();
    // A person merged since the first (replayed) decision has no list under their old id: fall back to what is left.
    return own ?? spare.shift() ?? actions[0]?.kind ?? 'note';
  });
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
        ...(status === undefined ? {} : { status: status as never }),
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
      const reason = text(body.reason);
      const evidence = has(body, 'evidence') ? text(body.evidence) : undefined;

      // Authorization for what the decision DOES, before anything is read or written.
      if (actions.length > 0) c.need('sanctions.apply');
      if (actions.some((a) => a.kind === 'ban' && a.durationMs === null)) c.need('sanctions.apply.ban_permanent');

      const report = load(id);
      const named = new Set(peopleOf(report));
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
      const kinds = kindsOf(result.groups, actions);
      return {
        status: 200,
        body: {
          ok: true,
          replay: result.replay,
          groups: result.groups.map((g, i) => ({ refCode: g.refCode, kind: kinds[i] })),
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
