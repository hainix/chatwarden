import type { ReportRefusal, ReportResult } from '@chatwarden/core';
import { bad, send as callRoute } from '../client.js';
import type { ReportDraft } from '../ReportDialog.js';
import { fetchTransport } from '../transport.js';
import type { FetchTransportOptions } from '../transport.js';
import { createSseParser } from './sse.js';
import type { ChatClosedWhy, ChatStatus } from './status.js';
import type { SseEvent } from './sse.js';
import { MAX_FRAME_BYTES, readFrame, readLine, readMuteResult, readRefusal } from './wire.js';
import type { ChatFrame, MuteResult, MuteTarget, SendResult } from './wire.js';

export type { ChatClosedWhy, ChatStatus } from './status.js';

export interface ChatTransportEvents {
  /** A frame arrived. Frames from a transport are validated by the box; an unknown or malformed frame is ignored. */
  frame(frame: ChatFrame): void;
  /** The connection changed. `closed` carries why when the transport knows. */
  status(status: ChatStatus, why?: ChatClosedWhy): void;
}

/** One open connection to one room. */
export interface ChatConnection {
  /** Send a line. Resolves with the kit's answer (delivered or refused); rejects with a `PlayerError` only when no answer arrived. */
  send(text: string): Promise<SendResult>;
  /**
   * Mute or unmute. Resolves with `{ ok, hiddenIds }` (the lines the server hid, see `MuteResult`); a custom transport that cannot name
   * them may resolve a plain boolean (`true` when it changed something), and then only the line that was clicked is hidden at once.
   */
  mute(target: MuteTarget, on: boolean): Promise<boolean | MuteResult>;
  /** File a report on a line. Resolves with the dialog's `ReportResult` shape. */
  report(lineId: string, draft: ReportDraft): Promise<ReportResult>;
  /** Stop, and do not reconnect. */
  close(): void;
}

/** How a box reaches a room. The default is `sseTransport`; a game with its own socket writes one. */
export interface ChatTransport {
  open(room: string, events: ChatTransportEvents): ChatConnection;
}

export interface SseTransportOptions extends FetchTransportOptions {
  /** Reconnect delays in ms: the first, then doubling to the largest, each with full jitter. Default `{ initialMs: 1000, maxMs: 30000 }`. */
  retry?: { initialMs?: number; maxMs?: number };
  /**
   * How long the stream may be silent after the hello before it is dropped and reconnected, in ms. Any bytes count, a heartbeat included.
   * Default: 2.5 times the heartbeat the server announces in its hello (50 000 for the broadcaster's 20 s), never under 10 000.
   */
  staleMs?: number;
}

/** What only tests set. Not part of the public options. */
export interface SseTransportInternals {
  /** The source of the jitter, a number in [0, 1). Default `Math.random`. */
  random?: () => number;
}

/** No hello this long after the attempt starts (connect, headers and hello): it is abandoned as a failure. */
const HELLO_WAIT_MS = 10_000;
/** The silence allowed after the hello, in heartbeats; and its floor and ceiling in ms. */
const STALE_HEARTBEATS = 2.5;
const MIN_STALE_MS = 10_000;
const MAX_STALE_MS = 10 * 60 * 1000;
/** The back-off starts over only when a connection has stayed open this long, so a hello-then-drop loop keeps backing off. */
const STABLE_MS = 30_000;
/** The shortest wait before a retry: full jitter may pick near 0, and two instant retries in a row are a storm in miniature. */
const MIN_RETRY_MS = 100;
/** The longest a `retry-after` is honoured: a server asking for more is not taken at its word (and a timer cannot hold much more). */
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Seconds from a `retry-after` header (on a 429 or 503) as ms; null when it is missing or not whole seconds. An HTTP date is not read. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  return raw !== null && /^\d{1,9}$/.test(raw.trim()) ? Math.min(Number(raw.trim()) * 1000, MAX_RETRY_AFTER_MS) : null;
}

/** The size of a JSON text in bytes without encoding it when it cannot be over the limit (3 bytes a UTF-16 unit at most). */
function bytesOf(text: string): number {
  return text.length * 3 <= MAX_FRAME_BYTES ? text.length : new TextEncoder().encode(text).length;
}

const release = (res: Response): void => {
  void res.body?.cancel().catch(() => undefined);
};

interface Attempt {
  ac: AbortController;
  /** The one watchdog: the wait for a hello, then the allowed silence. When it fires the attempt is aborted. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Fires once the connection has stayed open for `STABLE_MS`. */
  stable: ReturnType<typeof setTimeout> | undefined;
  /** The silence allowed once open; set by the hello. */
  stale: number;
  opened: boolean;
}

/** The default transport: the stream with `fetch`, the rest through `fetchTransport`'s calls. `baseUrl` is where `chatRoutes` is mounted. */
export function sseTransport(options: SseTransportOptions): ChatTransport {
  return createSseTransport(options, {});
}

/** `sseTransport` with the test-only knobs. Not exported from the package. @internal */
export function createSseTransport(options: SseTransportOptions, internals: SseTransportInternals): ChatTransport {
  // The calls up are fetchTransport's: it also throws the TypeError for a missing baseUrl.
  const rest = fetchTransport(options);
  const base = options.baseUrl.replace(/\/+$/, '');
  const initialMs = positive(options.retry?.initialMs, 1000);
  const maxMs = Math.max(initialMs, positive(options.retry?.maxMs, 30_000));
  const explicitStale = positive(options.staleMs, 0);
  const staleFor = (heartbeatMs: number): number => (explicitStale > 0 ? explicitStale : Math.min(MAX_STALE_MS, Math.max(MIN_STALE_MS, heartbeatMs * STALE_HEARTBEATS)));
  const random = internals.random ?? Math.random;

  return {
    open(room, events) {
      const roomPath = `/rooms/${encodeURIComponent(room)}`;
      const streamUrl = `${base}${roomPath}/stream`;
      let closed = false;
      let status: ChatStatus | null = null;
      let failures = 0;
      let current: Attempt | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;

      // A listener that throws must not break the stream.
      const guard = (fn: () => void): void => {
        try {
          fn();
        } catch {
          // The caller's code failed; the connection carries on.
        }
      };
      const setStatus = (next: ChatStatus, why?: ChatClosedWhy): void => {
        if (closed || (next === status && why === undefined)) return;
        status = next;
        guard(() => events.status(next, why));
      };

      const onOnline = (): void => {
        if (closed) return;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        // The network just came back: whatever is running (a hanging attempt, or a stream that may be dead and has not said so) is
        // abandoned for a fresh one. A live stream restarted this way costs one snapshot, which merges.
        const old = current;
        current = null;
        if (old !== null) end(old);
        if (status === 'open') setStatus('reconnecting');
        void run();
      };
      const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : undefined;
      win?.addEventListener('online', onOnline);

      const stop = (): void => {
        closed = true;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        win?.removeEventListener('online', onOnline);
        const live = current;
        current = null;
        if (live !== null) end(live);
      };
      /** Stop an attempt's timers and its request. */
      const end = (a: Attempt): void => {
        clearTimeout(a.timer);
        clearTimeout(a.stable);
        a.ac.abort();
      };
      const arm = (a: Attempt, ms: number): void => {
        clearTimeout(a.timer);
        a.timer = setTimeout(() => a.ac.abort(), ms);
      };
      const finish = (why: ChatClosedWhy): void => {
        setStatus('closed', why);
        stop();
      };

      /** The attempt is over and the stream did not end for good: wait, then try again. */
      const retry = (attempt: Attempt, atLeastMs = 0): void => {
        if (closed || current !== attempt) return;
        current = null;
        end(attempt);
        const cap = Math.min(maxMs, initialMs * 2 ** Math.min(failures, 30));
        failures += 1;
        const delay = Math.max(Math.floor(random() * cap), MIN_RETRY_MS, atLeastMs);
        setStatus('reconnecting');
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void run();
        }, delay);
      };

      async function run(): Promise<void> {
        if (closed) return;
        const attempt: Attempt = { ac: new AbortController(), timer: undefined, stable: undefined, stale: staleFor(20_000), opened: false };
        current = attempt;
        arm(attempt, HELLO_WAIT_MS); // connect, headers and hello all fit in it
        if (status === null) setStatus('connecting');

        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(options.headers ?? {})) if (key.toLowerCase() !== 'accept') headers[key] = value;
        headers.accept = 'text/event-stream';
        const init: RequestInit = { headers, signal: attempt.ac.signal };
        if (options.credentials !== undefined) init.credentials = options.credentials;

        let res: Response;
        try {
          res = await (options.fetch ?? globalThis.fetch)(streamUrl, init);
        } catch {
          retry(attempt);
          return;
        }
        if (closed || current !== attempt) {
          release(res);
          return;
        }
        if (res.status === 401 || res.status === 403) {
          release(res);
          finish(res.status === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
        if (res.status === 404) {
          release(res);
          finish('not_found');
          return;
        }
        if (!res.ok || res.body === null) {
          const wait = res.status === 429 || res.status === 503 ? retryAfterMs(res) : null;
          release(res);
          retry(attempt, wait ?? 0);
          return;
        }
        if (!/^\s*text\/event-stream\b/i.test(res.headers.get('content-type') ?? '')) {
          release(res);
          finish('unsupported');
          return;
        }

        const onEvent = (event: SseEvent): void => {
          if (closed || current !== attempt) return;
          let frame: ChatFrame | null;
          try {
            frame = readFrame(JSON.parse(event.data) as unknown, bytesOf(event.data));
          } catch {
            return; // not JSON
          }
          if (frame === null) return;
          const got: ChatFrame = frame;
          if (got.type === 'hello') {
            attempt.opened = true;
            attempt.stale = staleFor(got.heartbeatMs);
            arm(attempt, attempt.stale);
            clearTimeout(attempt.stable);
            attempt.stable = setTimeout(() => {
              failures = 0;
            }, STABLE_MS);
            setStatus('open');
          }
          guard(() => events.frame(got));
          if (got.type === 'bye') finish(got.reason);
        };

        const parser = createSseParser(onEvent);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (closed || current !== attempt) break;
            if (done) break;
            if (attempt.opened) arm(attempt, attempt.stale); // any bytes at all, a heartbeat included
            parser.push(decoder.decode(value, { stream: true }));
          }
        } catch {
          // The stream broke (or was aborted): the cases are told apart below.
        }
        if (closed || current !== attempt) {
          end(attempt);
          void reader.cancel().catch(() => undefined);
          return;
        }
        retry(attempt);
      }

      void run();

      return {
        send: async (text) => {
          const body = await callRoute(rest, { method: 'POST', path: `${roomPath}/lines`, body: { text } });
          if (!isObject(body)) throw bad();
          if (body.ok === true) {
            const line = readLine(body.line);
            if (line === null) throw bad();
            return { ok: true, line };
          }
          if (body.ok === false) {
            const refused = readRefusal(body.refused);
            if (refused === null) throw bad();
            return { ok: false, refused };
          }
          throw bad();
        },
        mute: async (target, on) => {
          const body = await callRoute(rest, { method: 'POST', path: `${roomPath}/mute`, body: { ...target, on } });
          const result = readMuteResult(body);
          if (result === null) throw bad();
          return result;
        },
        report: async (lineId, draft) => {
          const payload: Record<string, string> = { lineId };
          if (draft.reason !== undefined) payload.reason = draft.reason;
          if (draft.note !== undefined) payload.note = draft.note;
          const body = await callRoute(rest, { method: 'POST', path: `${roomPath}/report`, body: payload });
          if (!isObject(body)) throw bad();
          const remaining = typeof body.remaining === 'number' && Number.isFinite(body.remaining) && body.remaining >= 0 ? body.remaining : undefined;
          if (body.ok === true) {
            // The answer never carries a report id (the dialog does not read one).
            if (remaining === undefined) throw bad();
            return { ok: true, reportId: '', remaining };
          }
          if (body.ok === false && typeof body.refused === 'string' && body.refused !== '') {
            // `not_found` (a line that aged out, or one the reporter cannot see) is not one of the kit's refusals; the dialog words an unknown one.
            const refused = body.refused as ReportRefusal;
            return remaining === undefined ? { ok: false, refused } : { ok: false, refused, remaining };
          }
          throw bad();
        },
        close: stop,
      };
    },
  };
}
