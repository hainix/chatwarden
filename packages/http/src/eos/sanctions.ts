import { errorClass, safeWarn } from '@chatwarden/core';
import type { Chatwarden, RuleRef, SanctionKind } from '@chatwarden/core';
import { createDeliveryQueue } from '../internal/deliveryQueue.js';
import type { Attempt } from '../internal/deliveryQueue.js';
import { attemptOf } from './client.js';
import type { EosClient, EosReply } from './client.js';
import type { EosKind, ResolvedEosOptions } from './options.js';
import { EXTERNAL_RE, justificationOf, keyOf, sanctionBody } from './wire.js';

// Push (K5 design 9.3): a kit sanction becomes an EOS sanction, and a revoked one is removed again. Everything here runs after the kit's own commit and is fenced: a failure is
// logged by class and never reaches a kit operation. The jobs run one at a time, in order, on the kit's shared delivery queue (so a revoke queued behind a create runs after it).
// The kit stores no EOS id: the adopter's `productUserIdsOf` maps a person to their product user ids, and `cw.links` keeps only the hashed key and EOS's referenceId.

interface Job {
  type: 'apply' | 'revoke';
  groupId: string;
  refCode: string;
  /** The staff ref the event named. */
  target: string;
  kind: EosKind;
  until: number | null;
  rule: RuleRef | null;
  automated: boolean;
  /** The product user ids, resolved on the first attempt and reused by a retry. */
  ids?: string[];
  /** The ids that are finished (done or failed for good), so a retry repeats only the rest. */
  done: Set<string>;
}

export interface Sanctions {
  dispose(): void;
}

/** The most product user ids used for one person. */
const IDS_MAX = 20;
/** The lookup before a create reads at most this many pages of this many sanctions. */
const LOOKUP_PAGES = 5;
const PAGE = 100;
const ID_RE = /^[\x21-\x7e]{1,128}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How one account went: finished, to try again, or failed for good with an HTTP status the queue will log. */
type Outcome = { kind: 'done' } | { kind: 'retry'; attempt: Attempt } | { kind: 'final'; attempt: Attempt };

/** Start the push half: subscribe to the sanction events and queue a job for each. */
export function createSanctions(cw: Chatwarden, o: ResolvedEosOptions, client: EosClient): Sanctions {
  const push = o.sanctions;
  if (push === null) return { dispose() {} };
  const { logger, clock } = o;
  let disposed = false;
  const fail = (detail: { op: string; error?: string; status?: number }): void => safeWarn(logger, 'chatwarden.eos_failed', detail);

  /** The product user ids of the person, validated; an empty list when there is nothing to push (the reason is logged). */
  const resolve = async (target: string): Promise<string[]> => {
    let raw: unknown;
    try {
      const canonical = cw.people.canonical(target);
      raw = await push.productUserIdsOf(canonical, cw.people.aliases(canonical));
    } catch (err) {
      fail({ op: 'resolve', error: errorClass(err) });
      return [];
    }
    if (!Array.isArray(raw)) {
      fail({ op: 'resolve', error: 'BadAnswer' });
      return [];
    }
    const ids = [...new Set((raw as unknown[]).filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, IDS_MAX);
    if (ids.length === 0) fail({ op: 'resolve', error: 'NoAccounts' });
    return ids;
  };

  /** Fold a reply that is not 2xx into an outcome; logs nothing (the queue logs the final status). */
  const bad = (reply: EosReply): Outcome => {
    const attempt = attemptOf(reply);
    return attempt.kind === 'final' ? { kind: 'final', attempt } : { kind: 'retry', attempt };
  };

  const putLink = (key: string, external: string, state: string): boolean => {
    try {
      cw.links.put({ system: 'eos-sanction', ref: key, external, state, at: clock.now() });
      return true;
    } catch (err) {
      // The sanction exists in EOS; only the ledger missed it. The retry finds it again by `cw_ref` and writes the link then.
      fail({ op: 'link', error: errorClass(err) });
      return false;
    }
  };

  /** Look for this group's sanction among the user's own (newest first, at most 5 pages). */
  const lookup = async (job: Job, id: string, signal: AbortSignal): Promise<{ found: { referenceId: string; removed: boolean } | null } | Outcome> => {
    for (let page = 0; page < LOOKUP_PAGES; page++) {
      const reply = await client.userSanctions(id, { limit: PAGE, offset: page * PAGE, signal });
      // UNVERIFIED (design 15): what EOS answers for a user who has no sanctions at all. A 404 is read as "none found", so the first sanction of every user is created.
      if (reply.status === 404) return { found: null };
      if (reply.status < 200 || reply.status >= 300) return bad(reply);
      const body = reply.json;
      const elements = isObject(body) ? body['elements'] : undefined;
      if (!Array.isArray(elements)) {
        fail({ op: 'reconcile', error: 'BadAnswer' });
        return { kind: 'done' };
      }
      for (const el of elements as unknown[]) {
        if (!isObject(el)) continue;
        const meta = el['metadata'];
        if (isObject(meta) && meta['cw_ref'] === job.refCode && typeof el['referenceId'] === 'string' && EXTERNAL_RE.test(el['referenceId'])) {
          return { found: { referenceId: el['referenceId'], removed: el['status'] === 'Removed' } };
        }
      }
      const paging = isObject(body) ? body['paging'] : undefined;
      const total = isObject(paging) ? paging['total'] : undefined;
      if (elements.length < PAGE || (typeof total === 'number' && (page + 1) * PAGE >= total)) return { found: null };
    }
    // More sanctions than we are willing to read, and ours is not among them: a create now could make a second one, so none is made.
    fail({ op: 'reconcile', error: 'TooMany' });
    return { kind: 'done' };
  };

  const applyOne = async (job: Job, id: string, signal: AbortSignal): Promise<Outcome> => {
    const key = keyOf(job.groupId, id);
    if (cw.links.get('eos-sanction', key) !== null) return { kind: 'done' };
    const looked = await lookup(job, id, signal);
    if (disposed) return { kind: 'done' };
    if ('kind' in looked) return looked;
    if (looked.found !== null) {
      return putLink(key, looked.found.referenceId, looked.found.removed ? 'removed' : 'active')
        ? { kind: 'done' }
        : { kind: 'retry', attempt: { kind: 'retry', error: 'LinkFailed' } };
    }
    // The action, rule and times are read when the request is made, so a retry counts the time already used.
    const action = push.actions.get(job.kind);
    if (action === undefined) return { kind: 'done' };
    let reason: string | null = null;
    if (push.justification === 'reason') reason = cw.sanctions.byRef(job.refCode)?.reason ?? null;
    const body = sanctionBody({
      productUserId: id,
      action,
      justification: justificationOf(push.justification, job.refCode, job.rule, reason),
      refCode: job.refCode,
      rule: job.rule,
      until: job.until,
      now: clock.now(),
      automated: job.automated,
    });
    const reply = await client.createSanctions([body], signal);
    if (disposed) return { kind: 'done' };
    if (reply.status < 200 || reply.status >= 300) return bad(reply);
    const elements = isObject(reply.json) ? reply.json['elements'] : undefined;
    const first: unknown = Array.isArray(elements) ? elements[0] : undefined;
    const referenceId = isObject(first) ? first['referenceId'] : undefined;
    if (typeof referenceId !== 'string' || !EXTERNAL_RE.test(referenceId)) {
      fail({ op: 'create', error: 'BadAnswer' });
      return { kind: 'done' };
    }
    return putLink(key, referenceId, 'active') ? { kind: 'done' } : { kind: 'retry', attempt: { kind: 'retry', error: 'LinkFailed' } };
  };

  const revokeOne = async (job: Job, id: string, signal: AbortSignal): Promise<Outcome> => {
    const key = keyOf(job.groupId, id);
    const row = cw.links.get('eos-sanction', key);
    if (row === null || row.state !== 'active') return { kind: 'done' };
    const reply = await client.deleteSanctions([row.external], `Lifted: ${job.refCode}`, signal);
    if (disposed) return { kind: 'done' };
    // A 404 says EOS no longer has it: the same end.
    if ((reply.status >= 200 && reply.status < 300) || reply.status === 404) {
      return putLink(key, row.external, 'removed') ? { kind: 'done' } : { kind: 'retry', attempt: { kind: 'retry', error: 'LinkFailed' } };
    }
    return bad(reply);
  };

  /** One attempt at a job: every account not finished yet. A retry-worthy failure on any account is a retry of the job; the finished accounts are not repeated. */
  const send = async (job: Job, signal: AbortSignal): Promise<Attempt> => {
    if (disposed) return { kind: 'ok' };
    job.ids ??= await resolve(job.target);
    let retry: Attempt | null = null;
    let final: Attempt | null = null;
    for (const id of job.ids) {
      if (disposed) return { kind: 'ok' };
      if (job.done.has(id)) continue;
      const outcome = job.type === 'apply' ? await applyOne(job, id, signal) : await revokeOne(job, id, signal);
      if (outcome.kind === 'retry') retry ??= outcome.attempt;
      else {
        job.done.add(id);
        if (outcome.kind === 'final') final ??= outcome.attempt;
      }
    }
    return retry ?? final ?? { kind: 'ok' };
  };

  const queue = createDeliveryQueue<Job>({
    send,
    clock,
    random: o.random,
    ...(logger === undefined ? {} : { logger }),
    event: 'chatwarden.eos',
    detail: (job) => ({ op: job.type }),
  });

  const actionFor = (kind: SanctionKind): EosKind | undefined => (kind !== 'note' && push.actions.has(kind) ? kind : undefined);

  const enqueue = (job: Omit<Job, 'done'>): void => {
    if (disposed) return;
    queue.push({ ...job, done: new Set() });
  };

  const handled = (op: string, run: () => void): void => {
    try {
      run();
    } catch (err) {
      fail({ op, error: errorClass(err) });
    }
  };

  const unsubscribers = [
    cw.on('sanction.applied', (event) =>
      handled('enqueue', () => {
        if (event.type !== 'sanction.applied') return;
        const kind = actionFor(event.kind);
        if (kind === undefined) return;
        if (event.automated && !push.includeAutomatic) return;
        enqueue({ type: 'apply', groupId: event.groupId, refCode: event.refCode, target: event.target, kind, until: event.until, rule: event.rule, automated: event.automated });
      }),
    ),
    cw.on('sanction.revoked', (event) =>
      handled('enqueue', () => {
        if (event.type !== 'sanction.revoked') return;
        // A group of a kind that was never pushed has no link: leave it out without asking the adopter for accounts.
        const view = cw.sanctions.byRef(event.refCode);
        const kind = view === null ? 'chat' : actionFor(view.kind);
        if (kind === undefined) return;
        if (view?.automated === true && !push.includeAutomatic) return;
        enqueue({ type: 'revoke', groupId: event.groupId, refCode: event.refCode, target: event.subject, kind, until: null, rule: event.rule, automated: false });
      }),
    ),
    ...(push.includeAutomatic
      ? [
          cw.on('auto.restricted', (event) =>
            handled('enqueue', () => {
              if (event.type !== 'auto.restricted') return;
              const view = cw.sanctions.byRef(event.refCode);
              if (view === null) return;
              const kind = actionFor(view.kind);
              if (kind === undefined) return;
              enqueue({ type: 'apply', groupId: event.groupId, refCode: event.refCode, target: event.subject, kind, until: view.endsAt, rule: view.rule, automated: true });
            }),
          ),
        ]
      : []),
  ];

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribers) off();
      queue.dispose();
    },
  };
}
