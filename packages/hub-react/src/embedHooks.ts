import { useMemo } from 'react';
import type { HubError } from './client.js';
import { holderOf } from './claims.js';
import type { Holder } from './claims.js';
import { useHub } from './context.js';
import { useStore } from './controllerContext.js';
import type { DecideCommand, HubController } from './headless/controller.js';
import type { TakeOutcome } from './headless/cases.js';
import type { ActionResult } from './headless/env.js';
import type { DecideOptions, DecisionEntry, DecisionOutcome } from './headless/decisions.js';
import { visibleRows } from './headless/liveQueue.js';
import type { Connection } from './headless/liveQueue.js';
import { useHubData } from './hooks.js';
import { useCaseShown, useQueueRunning } from './pieceRuntime.js';
import { useHubController } from './provider.js';
import type { QueueFilter, QueueGroup } from './queue.js';
import type { BlockedDays, BlockedLine, Claim, Me, PermissionKey, PersonHistory, ReportDetail, StaffReport, TermsList } from './types.js';

// The headless hooks: the hub's behaviour with no markup, for a dashboard that draws its own. Each is a thin wrapper over the
// controller's stores and commands (so the Undo hold, claims, heartbeat and live queue are the hub's own, not a copy), and each
// answers with a value for what it expects: a 409, a 404, a role without the permission or a dropped connection is never a throw.
// They work under `<HubProvider>` (or `<Hub>`) and share its one controller with every piece on the page.

/**
 * One read: the answer for the current key, the last failure, whether it is loading, and how to ask again.
 * @experimental
 */
export interface HubRead<T> {
  /** False when the role does not hold the permission the read needs: then nothing is asked of the server. */
  allowed: boolean;
  /** The answer, kept through a failed reload; undefined until the first one (and when not `allowed`). */
  data: T | undefined;
  error: HubError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Who is signed in.
 * @experimental
 */
export interface UseMe {
  me: Me;
  /** Whether the signed-in role holds a permission (the server's own table, overrides included). */
  can: (permission: PermissionKey) => boolean;
}

/**
 * Who is signed in and what their role may do. The provider has already asked `GET /me` (it shows a plain message until it has the
 * answer), so this is never loading.
 *
 * ```tsx
 * const { me, can } = useMe();
 * return can('audit.read') ? <AuditLog /> : <p>Hello {me.actor}</p>;
 * ```
 * @experimental
 */
export function useMe(): UseMe {
  useHubController();
  const { me, can } = useHub();
  return { me, can };
}

/**
 * The open cases, kept fresh.
 * @experimental
 */
export interface UseCases {
  /** False when the role cannot read reports: the list is then empty and nothing is asked of the server. */
  allowed: boolean;
  /** `loading` until the first read, `error` if there has never been one, `ready` after (even while a refresh fails: see `connection`). */
  status: 'loading' | 'ready' | 'error';
  /** The cases that pass the filter, one per reported person, longest wait first. */
  cases: QueueGroup[];
  /** How many open reports were read, and whether the queue was longer than what was read. */
  reports: number;
  partial: boolean;
  /** New cases that wait behind `showIncoming()`, so the list never moves under the pointer. */
  incoming: number;
  /** `live`, `lost` (retrying), `offline` or `signedOut`. */
  connection: Connection;
  error: HubError | null;
  filter: QueueFilter;
  setFilter: (patch: Partial<QueueFilter>) => void;
  showIncoming: () => void;
  /** Read the queue again now. */
  reload: () => Promise<QueueGroup[]>;
  /** Claim and open the oldest free case that matches the filter. Says how it went. */
  takeNext: () => Promise<TakeOutcome>;
}

/**
 * The open cases: loaded once and kept fresh in the background (one poll of the change token however many parts use the queue), with
 * the filter, the "N new" count, the connection state and Take next. Needs `reports.read`; without it the list is empty and nothing is
 * asked.
 *
 * ```tsx
 * const { cases, takeNext } = useCases();
 * return <ul>{cases.map((c) => <li key={c.person}>{c.handle} ({c.open})</li>)}</ul>;
 * ```
 * @experimental
 */
export function useCases(): UseCases {
  const controller = useHubController();
  const { can, me, now } = useHub();
  const allowed = can('reports.read');
  useQueueRunning(true);
  const state = useStore(controller.queue);
  const nowMs = now();
  const visible = useMemo(() => visibleRows(state.rows, state.filter, state.pending, me.actor, nowMs), [state.rows, state.filter, state.pending, me.actor, nowMs]);
  const q = controller.queue;
  return {
    allowed,
    status: allowed ? state.status : 'ready',
    cases: allowed ? visible.map((r) => r.group) : [],
    reports: allowed ? state.reports : 0,
    partial: allowed && state.partial,
    incoming: allowed ? state.incoming : 0,
    connection: state.connection,
    error: allowed ? state.error : null,
    filter: state.filter,
    setFilter: q.setFilter,
    showIncoming: q.showIncoming,
    reload: q.reload,
    takeNext: () => (allowed ? controller.takeNext() : Promise.resolve({ status: 'busy' })),
  };
}

/**
 * See the README.
 * @experimental
 */
export interface UseCaseOptions {
  /** Claim the case while it is shown, and renew the claim (every 60 seconds) and the "viewing" hint (every 20) while the tab is visible. Default `true`. */
  claim?: boolean;
}

/**
 * One case: the read of the report, who holds it, and what is going on with its decision.
 * @experimental
 */
export interface UseCase {
  /** `idle` for no case (`null`), `loading`, `ready`, or `error` (a 404 for a report that is not there is an error, not a throw). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** `GET /reports/:id`: the report with its evidence, history and the ladder's suggestion. One audited read. */
  detail: ReportDetail | undefined;
  report: StaffReport | undefined;
  error: HubError | null;
  reload: () => void;
  /** Who holds the reported person's case: nobody, you, or someone else (their name is in `by`). */
  holder: Holder;
  /** What is going on with this report's decision: held for Undo, sending, done, failed, conflict or undone. */
  decision: DecisionEntry | undefined;
}

/**
 * One case. While it is in use the moderator is its handler if nobody is (the claim and the heartbeat are the hub's own: once per
 * case however many parts show it, and let go when the last one leaves). Pass `null` for no case. Only one case is held at a time: the
 * one most recently shown.
 *
 * ```tsx
 * const { report, holder } = useCase(reportId);
 * return holder.kind === 'other' ? <p>{holder.by} is on it</p> : <p>{report?.category}</p>;
 * ```
 * @experimental
 */
export function useCase(reportId: string | null, options: UseCaseOptions = {}): UseCase {
  const controller = useHubController();
  const { client, can, me, now } = useHub();
  const allowed = can('reports.read') && reportId !== null;
  useQueueRunning(allowed);
  useCaseShown(reportId, allowed && options.claim !== false);
  const read = useHubData<ReportDetail | null>(allowed ? `case:${reportId}` : 'case:idle', () => (allowed && reportId !== null ? client.getReport(reportId) : Promise.resolve(null)));
  const queue = useStore(controller.queue);
  const decisions = useStore(controller.decisions);
  const detail = read.data ?? undefined;
  const group = reportId === null ? undefined : queue.groups.find((g) => g.reportIds.includes(reportId));
  const claim: Claim | null = group !== undefined ? group.claim : (detail?.claim ?? null);
  let status: UseCase['status'] = 'loading';
  if (!allowed) status = 'idle';
  else if (detail !== undefined) status = 'ready';
  else if (read.error !== null) status = 'error';
  return {
    status,
    detail,
    report: detail?.report,
    error: allowed ? read.error : null,
    reload: read.reload,
    holder: holderOf(claim, me.actor, now()),
    decision: reportId === null ? undefined : decisions.get(reportId),
  };
}

/**
 * What `useDecide` hands back.
 * @experimental
 */
export interface UseDecide {
  /**
   * Decide a report. It is held for the Undo window (5 seconds unless `hold` says otherwise: `false` sends at once), then sent; the case
   * leaves the queue at once and comes back if the send fails. The promise says how it ended and never rejects for a 409, a 404 or a
   * dropped connection: `done`, `failed` (with the error), `conflict` (someone else decided first) or `undone`.
   */
  decide: (command: DecideCommand, options?: DecideOptions) => Promise<DecisionOutcome>;
  /** Cancel a held decision: nothing is sent and the case comes back. A no-op once it is on its way. */
  undo: (reportId: string) => void;
  /** Send a failed decision again, at once, with the same body. */
  retry: (reportId: string) => Promise<DecisionOutcome | { status: 'none' }>;
  /** Forget a finished, failed or undone decision. */
  dismiss: (reportId: string) => void;
  /** What is going on with one report's decision, or undefined. */
  entry: (reportId: string) => DecisionEntry | undefined;
  /** Every decision in flight or just finished, by report id. */
  entries: ReadonlyMap<string, DecisionEntry>;
}

/**
 * Decisions, with the hub's Undo hold: held, sent at once when the page goes, retried on failure. The same store the pieces use, so a
 * decision made here shows in a `CaseCard` and the other way round.
 *
 * ```tsx
 * const { decide, undo } = useDecide();
 * const outcome = await decide({ reportId, person, input: { verdict: 'no_action', reason: 'Banter.', actions: [] } });
 * ```
 * @experimental
 */
export function useDecide(): UseDecide {
  const controller: HubController = useHubController();
  const entries = useStore(controller.decisions);
  return useMemo(
    () => ({
      decide: controller.decide,
      undo: controller.undo,
      retry: controller.retry,
      dismiss: controller.dismiss,
      entry: (reportId: string) => entries.get(reportId),
      entries,
    }),
    [controller, entries],
  );
}

/**
 * Who holds a person's case, and what you can do about it.
 * @experimental
 */
export interface UseClaim {
  holder: Holder;
  /** Claim a free case (or beat your own claim). Someone else's live claim is `{ ok: false, error }` with `code: 'claimed'` and `heldBy`. */
  claim: () => Promise<ActionResult<Claim>>;
  /** A senior or owner moving another moderator's live claim to themselves (the `claims.override` permission). Audited by the server. */
  takeOver: () => Promise<ActionResult<{ claim: Claim; tookOverFrom: string | null }>>;
  /** Release your own claim. */
  release: () => Promise<ActionResult<{ released: boolean }>>;
}

/**
 * The claim on one person's case: who holds it now (live, from the queue) and the three things a moderator does about it. Each
 * answers with a value, never a throw.
 *
 * ```tsx
 * const { holder, claim } = useClaim(person);
 * return holder.kind === 'none' ? <button onClick={claim}>Take it</button> : null;
 * ```
 * @experimental
 */
export function useClaim(person: string): UseClaim {
  const controller = useHubController();
  const { me, now } = useHub();
  useQueueRunning(true);
  const queue = useStore(controller.queue);
  const group = queue.groups.find((g) => g.person === person);
  return {
    holder: holderOf(group?.claim ?? null, me.actor, now()),
    claim: () => controller.claim(person),
    takeOver: () => controller.takeOver(person),
    release: () => controller.release(person),
  };
}

/**
 * The blocked terms and their exceptions. Needs `terms.read`; without it nothing is asked and `allowed` is false. To change them, use
 * `TermsManager`, or `client.addTerm` and the other writes on the client you gave the provider.
 *
 * ```tsx
 * const { data } = useTerms();
 * return <p>{data?.terms.length ?? 0} terms</p>;
 * ```
 * @experimental
 */
export function useTerms(): HubRead<TermsList> {
  const { client, can } = useHub();
  const allowed = can('terms.read');
  const read = useHubData<TermsList | null>(allowed ? 'terms' : 'terms:idle', () => (allowed ? client.listTerms() : Promise.resolve(null)));
  return { allowed, data: read.data ?? undefined, error: allowed ? read.error : null, loading: allowed && read.loading, reload: read.reload };
}

/**
 * The chat lines the term filter refused (default the last 7 days). Needs `blocked.read`. Opening the list is one audited read, and so
 * is each change of window.
 *
 * ```tsx
 * const { data } = useBlocked({ days: 1 });
 * return <p>{data?.items.length ?? 0} lines today</p>;
 * ```
 * @experimental
 */
export function useBlocked(options: { days?: BlockedDays } = {}): HubRead<{ items: BlockedLine[] }> {
  const { client, can } = useHub();
  const allowed = can('blocked.read');
  const days = options.days ?? 7;
  const read = useHubData<{ items: BlockedLine[] } | null>(allowed ? `blocked:${days}` : 'blocked:idle', () => (allowed ? client.listBlocked({ days }) : Promise.resolve(null)));
  return { allowed, data: read.data ?? undefined, error: allowed ? read.error : null, loading: allowed && read.loading, reload: read.reload };
}

/**
 * One person's record: reports about them, every sanction with where it stands, and the reports they filed. Needs `history.read`. Pass
 * `null` for no one (nothing is asked). Opening it is one audited read.
 *
 * ```tsx
 * const { data } = usePerson(ref);
 * return <p>{data?.sanctions.length ?? 0} sanctions</p>;
 * ```
 * @experimental
 */
export function usePerson(ref: string | null): HubRead<PersonHistory> {
  const { client, can } = useHub();
  const allowed = can('history.read');
  const on = allowed && ref !== null;
  const read = useHubData<PersonHistory | null>(on ? `person:${ref}` : 'person:idle', () => (on && ref !== null ? client.personHistory(ref) : Promise.resolve(null)));
  return { allowed, data: read.data ?? undefined, error: on ? read.error : null, loading: on && read.loading, reload: read.reload };
}
