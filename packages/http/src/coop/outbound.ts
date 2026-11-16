import { errorClass, safeWarn } from '@chatwarden/core';
import type { Chatwarden, StaffReport } from '@chatwarden/core';
import { discardBody, readBoundedText } from '../internal/boundedText.js';
import { MAX_RETRIES, QUEUE_MAX, createDeliveryQueue } from '../internal/deliveryQueue.js';
import type { Attempt } from '../internal/deliveryQueue.js';
import type { ResolvedCoopOptions } from './options.js';
import { buildReport } from './wire.js';
import type { CoopReportBody } from './wire.js';

// Outbound (K5 design 8.3): a kit report becomes a Coop job. One request at a time, in order, on the kit's shared retry rules (`createDeliveryQueue`). The kit's
// report stays `open` while the job is out; the link row (`coop-report`, kit report id -> Coop report id) is the ledger that stops a second send. Everything here
// runs after the kit's own commit and is fenced: a failure is logged by class and never reaches a kit operation.

/** How a job ended, for `sweep`'s counts. */
type Outcome = 'sent' | 'skipped' | 'failed';

interface Job {
  reportId: string;
  /** Built once, on the first attempt, so a retry sends the same body. */
  body?: CoopReportBody;
  attempts: number;
  /** Settles the job's outcome once (a sweep awaits it). */
  settle: (outcome: Outcome) => void;
}

export interface SweepResult {
  sent: number;
  skipped: number;
  failed: number;
}

export interface Outbound {
  sweep(): Promise<SweepResult>;
  dispose(): void;
}

/** The most pages of 200 a sweep reads. */
const SWEEP_PAGES = 5;
const PAGE_SIZE = 200;
/** A Coop report id is kept as the link's `external` only when it fits the link alphabet (design 5.1). */
const EXTERNAL_RE = /^[A-Za-z0-9_.:#-]{1,128}$/;
/** The most of a response body that is read for the id. */
const ANSWER_MAX = 4096;

/** The report id Coop answered a 201 with, or `unknown` when there is none that can be kept. */
async function externalOf(res: Response): Promise<string> {
  try {
    const text = await readBoundedText(res, ANSWER_MAX);
    if (text === null) return 'unknown';
    const value: unknown = JSON.parse(text);
    const id = typeof value === 'object' && value !== null ? (value as { reportId?: unknown }).reportId : undefined;
    return typeof id === 'string' && EXTERNAL_RE.test(id) ? id : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Throw away a response body we do not read, so the connection is released. */
const drop = discardBody;

/** A `retry-after` header in whole seconds as milliseconds (the queue clamps it); undefined for anything else. */
function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (v === null || !/^\d{1,6}$/.test(v.trim())) return undefined;
  return Number(v.trim()) * 1000;
}

/** Start the outbound half: subscribe to `report.created` and queue each report. */
export function createOutbound(cw: Chatwarden, o: ResolvedCoopOptions): Outbound {
  const { logger, clock } = o;
  let disposed = false;
  /** Jobs a `sweep` is waiting on, so a dispose can release it. */
  const awaited = new Set<Job>();
  const call = o.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));
  const fail = (op: string, err: unknown): void => safeWarn(logger, 'chatwarden.coop_failed', { op, error: errorClass(err) });

  /** The adopter's AI severity for a report; a throw, a rejection or a value that is not a number drops the field (the body builder checks the range). */
  const severityOf = async (report: StaffReport): Promise<unknown> => {
    if (o.aiSeverity === undefined) return undefined;
    try {
      return await o.aiSeverity(report);
    } catch {
      return undefined;
    }
  };

  const finish = (job: Job, outcome: Outcome): void => {
    awaited.delete(job);
    job.settle(outcome);
  };

  /** One attempt. Returns how it went; a throw is a retry (the queue logs its class). */
  const send = async (job: Job, signal: AbortSignal): Promise<Attempt> => {
    job.attempts++;
    // A throw (a store or network failure) is a retry; the last one fails the job for good.
    const lastTry = (): boolean => job.attempts > MAX_RETRIES;
    try {
      if (disposed) return { kind: 'ok' };
      if (cw.links.get('coop-report', job.reportId) !== null) {
        finish(job, 'skipped');
        return { kind: 'ok' };
      }
      const report = cw.reports.get(job.reportId);
      // Gone, or decided in the hub while it waited: there is nothing left to review.
      if (report === null || report.status !== 'open') {
        finish(job, 'skipped');
        return { kind: 'ok' };
      }
      job.body ??= buildReport(report, o, cw, await severityOf(report));
      const res = await call(`${o.baseUrl}/api/v1/report`, {
        method: 'POST',
        headers: { 'X-API-KEY': o.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(job.body),
        // A redirect would send the key somewhere the adopter did not name.
        redirect: 'manual',
        signal,
      });
      const status = res.status;
      if (status >= 200 && status < 300) {
        const external = await externalOf(res);
        if (disposed) return { kind: 'ok' };
        try {
          // The callback may have decided the report while this request was out: that row stands (state `decided`), and only learns the Coop id.
          const existing = cw.links.get('coop-report', job.reportId);
          if (existing === null) cw.links.put({ system: 'coop-report', ref: job.reportId, external, state: 'sent', at: clock.now() });
          else if (existing.external === 'unknown' && external !== 'unknown') cw.links.put({ ...existing, external });
        } catch (err) {
          // The job is out; only the ledger missed it. The next `sweep` sends it once more (Coop counts a second report on the item), which is the documented cost.
          fail('link', err);
        }
        finish(job, 'sent');
        return { kind: 'ok' };
      }
      drop(res);
      if (status === 429 || status >= 500) {
        if (lastTry()) finish(job, 'failed');
        const after = status === 429 ? retryAfterMs(res) : undefined;
        return { kind: 'retry', status, ...(after === undefined ? {} : { afterMs: after }) };
      }
      // Any other answer (a 4xx, a redirect we did not follow) will not change by asking again.
      finish(job, 'failed');
      return { kind: 'final', status };
    } catch (err) {
      if (lastTry() || disposed) finish(job, 'failed');
      throw err;
    }
  };

  const queue = createDeliveryQueue<Job>({ send, clock, random: o.random, ...(logger === undefined ? {} : { logger }), event: 'chatwarden.coop' });

  const enqueue = (reportId: string, settle: Job['settle'] = () => undefined): Job | null => {
    if (disposed) return null;
    const job: Job = { reportId, attempts: 0, settle };
    queue.push(job);
    return job;
  };

  const unsubscribe = cw.on('report.created', (event) => {
    try {
      if (event.type !== 'report.created') return;
      if (cw.links.get('coop-report', event.reportId) !== null) return;
      enqueue(event.reportId);
    } catch (err) {
      fail('enqueue', err);
    }
  });

  /** The open reports of the last `catchUpMs`, newest first, at most 5 pages. */
  const recentOpen = (): StaffReport[] => {
    const since = clock.now() - o.catchUpMs;
    const found: StaffReport[] = [];
    let before: string | null = null;
    for (let page = 0; page < SWEEP_PAGES; page++) {
      const result = cw.reports.list({ status: 'open', limit: PAGE_SIZE, ...(before === null ? {} : { before }) });
      for (const item of result.items) {
        if (item.createdAt < since) return found;
        found.push(item);
      }
      if (result.next === null) break;
      before = result.next;
    }
    return found;
  };

  return {
    async sweep() {
      const counts: SweepResult = { sent: 0, skipped: 0, failed: 0 };
      if (disposed) return counts;
      let reports: StaffReport[];
      try {
        reports = recentOpen();
      } catch (err) {
        fail('sweep', err);
        return counts;
      }
      const waiting: Array<Promise<Outcome>> = [];
      for (const report of reports) {
        let linked: boolean;
        try {
          linked = cw.links.get('coop-report', report.id) !== null;
        } catch (err) {
          fail('sweep', err);
          continue;
        }
        // A full queue would drop its oldest job: leave the rest for the next sweep.
        if (linked || queue.size() >= QUEUE_MAX) {
          counts.skipped++;
          continue;
        }
        waiting.push(
          new Promise<Outcome>((resolve) => {
            const job = enqueue(report.id, resolve);
            if (job === null) resolve('failed');
            else awaited.add(job);
          }),
        );
      }
      for (const outcome of await Promise.all(waiting)) counts[outcome]++;
      return counts;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      queue.dispose();
      for (const job of [...awaited]) finish(job, 'failed');
    },
  };
}
