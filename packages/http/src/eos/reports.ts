import { errorClass, safeWarn } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import { RETRY_AFTER_CAP_MS, RETRY_AFTER_FLOOR_MS } from '../internal/deliveryQueue.js';
import type { EosClient, EosReply } from './client.js';
import type { EosSeat, ResolvedEosOptions } from './options.js';
import { EXTERNAL_RE, cutText, reportKeyOf } from './wire.js';

// Pull (K5 design 9.4): EOS player reports about players the adopter names become kit reports, but only when the adopter's own session table seats BOTH players in the SAME room.
// EOS has no "list all reports": `find` needs a player id, so the adopter says who is in play. An EOS report has no id, so it is keyed by a hash of its own fields; the
// `eos-report` link says "seen" and the `eos-cursor` link says how far we have read. Everything in a report is written by a client, so it is shape-checked and cut: the message
// becomes the note (500), the `context` is read for one short `lineId` and nothing else, the `time` is used only to place the cursor (never past now plus a minute) and never as
// the report's own time. Nothing in a report picks the reporter or the room: both come from the adopter's `seatOf`.

/** The most players asked about in one poll. */
const PLAYERS_MAX = 500;
/** The reports asked for in one request. */
const PAGE = 50;
/** The most elements looked at in one page, whatever comes back. */
const PAGE_LOOKED_AT = 100;
/** The most pages read for one batch of players in one poll. */
const PAGES_MAX = 20;
/** `find` looks this far before the cursor: a client writes `time`, so a report can arrive late. */
const OVERLAP_MS = 10 * 60_000;
/** The cursor never goes further ahead of the clock than this. */
const AHEAD_MS = 60_000;
/** One request is aborted after this long. */
const REQUEST_TIMEOUT_MS = 10_000;
/** The note is the report's message, cut to this many characters. */
const NOTE_MAX = 500;
/** A `context` longer than this is ignored. */
const CONTEXT_MAX = 4096;
/** How long polling pauses after a 429 that names no wait. */
const PAUSE_DEFAULT_MS = 60_000;

const ID_RE = /^[\x21-\x7e]{1,128}$/;
const LINE_ID_RE = /^[\x21-\x7e]{1,64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A report from EOS after its shape is checked. `at` is its time as epoch milliseconds. */
interface Found {
  time: string;
  at: number;
  reportingPlayerId: string;
  reportedPlayerId: string;
  reasonId: number;
  message: string | undefined;
  context: string | undefined;
}

/** The report, or null when it is not one (a hostile or damaged answer). */
function check(el: unknown): Found | null {
  if (!isObject(el)) return null;
  const { time, reportingPlayerId, reportedPlayerId, reasonId, message, context } = el;
  if (typeof time !== 'string' || time.length > 40 || !TIME_RE.test(time)) return null;
  const at = Date.parse(time);
  if (!Number.isFinite(at)) return null;
  if (typeof reportingPlayerId !== 'string' || !ID_RE.test(reportingPlayerId)) return null;
  if (typeof reportedPlayerId !== 'string' || !ID_RE.test(reportedPlayerId)) return null;
  if (typeof reasonId !== 'number' || !Number.isSafeInteger(reasonId) || reasonId < 0 || reasonId > 1_000_000) return null;
  return {
    time,
    at,
    reportingPlayerId,
    reportedPlayerId,
    reasonId,
    message: typeof message === 'string' ? message : undefined,
    context: typeof context === 'string' ? context : undefined,
  };
}

/** The `lineId` of a report's `context`, only when the context is JSON with a short visible string of that name; anything else in it is ignored. */
function lineIdOf(context: string | undefined): string | undefined {
  if (context === undefined || context.length > CONTEXT_MAX) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(context);
  } catch {
    return undefined;
  }
  if (!isObject(value) || !Object.hasOwn(value, 'lineId')) return undefined;
  const id = value['lineId'];
  return typeof id === 'string' && LINE_ID_RE.test(id) ? id : undefined;
}

/** A seat as the adopter gave it, or null when it is not one. */
function seatOk(v: unknown): EosSeat | null {
  if (!isObject(v)) return null;
  const { roomId, seatId } = v;
  return typeof roomId === 'string' && roomId.length >= 1 && roomId.length <= 128 && typeof seatId === 'string' && seatId.length >= 1 && seatId.length <= 128 ? { roomId, seatId } : null;
}

export interface PollResult {
  seen: number;
  filed: number;
  skipped: Record<string, number>;
  refused: Record<string, number>;
}

export interface Reports {
  poll(): Promise<PollResult>;
  start(): void;
  stop(): void;
  dispose(): void;
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Make the pull half. Nothing runs until `poll` or `start`. */
export function createReports(cw: Chatwarden, o: ResolvedEosOptions, client: EosClient): Reports {
  const pull = o.reports;
  const none = (): PollResult => ({ seen: 0, filed: 0, skipped: {}, refused: {} });
  if (pull === null) return { poll: () => Promise.resolve(none()), start() {}, stop() {}, dispose() {} };
  const { logger, clock } = o;
  let disposed = false;
  let inflight: Promise<PollResult> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pausedUntil = 0;
  const lifetime = new AbortController();
  const fail = (detail: { op: string; error?: string; status?: number }): void => safeWarn(logger, 'chatwarden.eos_failed', detail);

  /** The players to ask about: validated, deduplicated, at most 500. An empty list says why in the log. */
  const players = async (): Promise<string[]> => {
    let raw: unknown;
    try {
      raw = await pull.players();
    } catch (err) {
      fail({ op: 'players', error: errorClass(err) });
      return [];
    }
    if (!Array.isArray(raw)) {
      fail({ op: 'players', error: 'BadAnswer' });
      return [];
    }
    return [...new Set((raw as unknown[]).filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, PLAYERS_MAX);
  };

  const seatOf = async (id: string): Promise<EosSeat | null | 'error'> => {
    try {
      const raw: unknown = await pull.seatOf(id);
      if (raw === null) return null;
      const seat = seatOk(raw);
      if (seat === null) {
        fail({ op: 'seat', error: 'BadAnswer' });
        return 'error';
      }
      return seat;
    } catch (err) {
      fail({ op: 'seat', error: errorClass(err) });
      return 'error';
    }
  };

  const readCursor = (): number | null => {
    const row = cw.links.get('eos-cursor', 'reports');
    if (row === null) return null;
    const at = Date.parse(row.external);
    return Number.isFinite(at) ? at : null;
  };

  /** One request, with its own time limit and the poll's abort. */
  const find = async (ids: readonly string[], start: number, offset: number): Promise<EosReply> => {
    const ctl = new AbortController();
    const abort = (): void => ctl.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
    (timeout as { unref?: () => void }).unref?.();
    try {
      return await client.findReports({ reportedPlayerIds: ids, startTime: new Date(start).toISOString(), offset, limit: PAGE, signal: ctl.signal });
    } finally {
      clearTimeout(timeout);
      lifetime.signal.removeEventListener('abort', abort);
    }
  };

  const run = async (): Promise<PollResult> => {
    const result = none();
    if (disposed || clock.now() < pausedUntil) return result;
    const ids = await players();
    if (disposed || ids.length === 0) return result;
    const now = clock.now();
    let previous = readCursor();
    if (previous === null) {
      // The first poll reads from now: the history before the adapter started is not backfilled.
      previous = now;
      try {
        cw.links.put({ system: 'eos-cursor', ref: 'reports', external: new Date(now).toISOString(), state: 'cursor', at: now });
      } catch (err) {
        fail({ op: 'link', error: errorClass(err) });
      }
    }
    const start = previous - OVERLAP_MS;
    const ceiling = now + AHEAD_MS;
    const seenKeys = new Set<string>();
    let handled = 0;
    let newest = -Infinity;
    /** The lowest point any unfinished batch has read up to: the cursor must not pass it. */
    let held = Infinity;
    let stopped = false;

    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += pull.batch) batches.push(ids.slice(i, i + pull.batch));

    for (const batch of batches) {
      if (stopped || disposed) {
        held = Math.min(held, previous);
        continue;
      }
      let reach = -Infinity;
      let finished = false;
      for (let page = 0; page < PAGES_MAX && !finished; page++) {
        let reply: EosReply;
        try {
          reply = await find(batch, start, page * PAGE);
        } catch (err) {
          if (!disposed) fail({ op: 'poll', error: errorClass(err) });
          stopped = true;
          break;
        }
        if (disposed) return result;
        if (reply.status < 200 || reply.status >= 300) {
          fail({ op: 'poll', status: reply.status });
          if (reply.status === 429) pausedUntil = clock.now() + Math.min(Math.max(reply.retryAfterMs ?? PAUSE_DEFAULT_MS, RETRY_AFTER_FLOOR_MS), RETRY_AFTER_CAP_MS);
          stopped = true;
          break;
        }
        const elements = isObject(reply.json) ? reply.json['elements'] : undefined;
        if (!Array.isArray(elements)) {
          fail({ op: 'poll', error: 'BadAnswer' });
          stopped = true;
          break;
        }
        const looked = (elements as unknown[]).slice(0, PAGE_LOOKED_AT);
        for (const el of looked) {
          result.seen++;
          const found = check(el);
          if (found === null) {
            bump(result.skipped, 'malformed');
            continue;
          }
          const at = Math.min(found.at, ceiling);
          if (handled >= pull.maxPerPoll) {
            // The cap is for new reports; the rest wait for the next poll, and the cursor stays where this batch had read to.
            const key = reportKeyOf(found);
            if (!seenKeys.has(key) && cw.links.get('eos-report', key) === null) {
              stopped = true;
              break;
            }
          }
          if (await handle(found, seenKeys, result)) handled++;
          if (disposed) return result;
          newest = Math.max(newest, at);
          reach = Math.max(reach, at);
        }
        if (stopped) break;
        const paging = isObject(reply.json) ? reply.json['paging'] : undefined;
        const total = isObject(paging) ? paging['total'] : undefined;
        finished = elements.length < PAGE || (typeof total === 'number' && Number.isFinite(total) && (page + 1) * PAGE >= total);
      }
      if (!finished) held = Math.min(held, reach === -Infinity ? previous : reach);
    }
    if (disposed) return result;

    // The cursor moves to the newest report time seen (never past now plus a minute, never backwards), and not past what an unfinished batch has read.
    const target = Math.min(newest, held, ceiling);
    if (target > previous) {
      try {
        cw.links.put({ system: 'eos-cursor', ref: 'reports', external: new Date(target).toISOString(), state: 'cursor', at: clock.now() });
      } catch (err) {
        fail({ op: 'link', error: errorClass(err) });
      }
    }
    for (const [reason, count] of Object.entries(result.skipped)) safeWarn(logger, 'chatwarden.eos_report_skipped', { reason, count });
    for (const [code, count] of Object.entries(result.refused)) safeWarn(logger, 'chatwarden.eos_report_skipped', { reason: `refused_${code}`, count });
    return result;
  };

  /** One report: skip what is known, place both players, ask the kit. True when it was new (it counts toward the cap). */
  const handle = async (r: Found, seenKeys: Set<string>, result: PollResult): Promise<boolean> => {
    const key = reportKeyOf(r);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    try {
      if (cw.links.get('eos-report', key) !== null) return false;
    } catch (err) {
      fail({ op: 'link', error: errorClass(err) });
      return false;
    }
    const link = (state: string, external: string): void => {
      if (disposed) return;
      try {
        cw.links.put({ system: 'eos-report', ref: key, external, state, at: clock.now() });
      } catch (err) {
        fail({ op: 'link', error: errorClass(err) });
      }
    };
    const skip = (code: string): true => {
      bump(result.skipped, code);
      link('skipped', code);
      return true;
    };
    if (r.reportingPlayerId === r.reportedPlayerId) return skip('self');
    const reporter = await seatOf(r.reportingPlayerId);
    const target = reporter === 'error' ? 'error' : await seatOf(r.reportedPlayerId);
    if (disposed) return false;
    if (reporter === 'error' || target === 'error') {
      // Not linked: the next poll tries again.
      bump(result.skipped, 'seat_error');
      return true;
    }
    if (reporter === null || target === null) return skip('unseated');
    if (reporter.roomId !== target.roomId) return skip('different_room');
    const note = r.message === undefined ? '' : cutText(r.message.trim(), NOTE_MAX).trim();
    const lineId = lineIdOf(r.context);
    const reason = pull.reasons.get(r.reasonId) ?? null;
    let res: Awaited<ReturnType<Chatwarden['reports']['submit']>>;
    try {
      res = await cw.reports.submit({
        roomId: reporter.roomId,
        reporterSeat: reporter.seatId,
        targetSeat: target.seatId,
        reason,
        ...(note === '' ? {} : { note }),
        ...(lineId === undefined ? {} : { lineId }),
      });
    } catch (err) {
      fail({ op: 'submit', error: errorClass(err) });
      bump(result.refused, 'error');
      return true;
    }
    if (disposed) return false;
    if (res.ok) {
      result.filed++;
      link('filed', EXTERNAL_RE.test(res.reportId) ? res.reportId : 'unknown');
    } else {
      bump(result.refused, res.refused);
      link('skipped', `refused_${res.refused}`);
    }
    return true;
  };

  const poll = (): Promise<PollResult> => {
    inflight ??= run()
      .catch((err: unknown) => {
        if (!disposed) fail({ op: 'poll', error: errorClass(err) });
        return none();
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    poll,
    start() {
      if (disposed || timer !== undefined) return;
      timer = setInterval(() => {
        // A poll still running when the next tick fires is skipped.
        if (inflight === null) void poll();
      }, pull.pollMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      lifetime.abort();
    },
  };
}
