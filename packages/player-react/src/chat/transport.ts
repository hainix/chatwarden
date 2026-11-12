import type { ReportRefusal, ReportResult } from '@chatwarden/core';
import { bad, send as callRoute } from '../client.js';
import type { ReportDraft } from '../ReportDialog.js';
import { fetchTransport } from '../transport.js';
import type { FetchTransportOptions } from '../transport.js';
import { createSseParser } from './sse.js';
import type { ChatClosedWhy, ChatStatus } from './status.js';
import type { SseEvent } from './sse.js';
import { MAX_FRAME_BYTES, readFrame, readLine, readRefusal } from './wire.js';
import type { ChatFrame, MuteTarget, SendResult } from './wire.js';

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
  /** Mute or unmute. Resolves `true` when it changed something. */
  mute(target: MuteTarget, on: boolean): Promise<boolean>;
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
  /** @internal The source of the jitter, a number in [0, 1). For tests. Default `Math.random`. */
  random?: () => number;
}

/** No hello this long after the response starts: the attempt is abandoned as a failure. */
const HELLO_WAIT_MS = 10_000;
/** The longest a `retry-after` is honoured: a server asking for more is not taken at its word (and a timer cannot hold much more). */
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Seconds from a `retry-after` header as ms; null when it is missing or not whole seconds. */
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
  helloTimer: ReturnType<typeof setTimeout> | undefined;
}

/** The default transport: the stream with `fetch`, the rest through `fetchTransport`'s calls. `baseUrl` is where `chatRoutes` is mounted. */
export function sseTransport(options: SseTransportOptions): ChatTransport {
  // The calls up are fetchTransport's: it also throws the TypeError for a missing baseUrl.
  const rest = fetchTransport(options);
  const base = options.baseUrl.replace(/\/+$/, '');
  const initialMs = positive(options.retry?.initialMs, 1000);
  const maxMs = Math.max(initialMs, positive(options.retry?.maxMs, 30_000));
  const random = options.random ?? Math.random;

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
        if (closed || status === 'open') return;
        clearTimeout(retryTimer);
        retryTimer = undefined;
        // An attempt that is hanging (the network just came back) is abandoned for a fresh one.
        const hanging = current;
        current = null;
        if (hanging !== null) {
          clearTimeout(hanging.helloTimer);
          hanging.ac.abort();
        }
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
        if (live !== null) {
          clearTimeout(live.helloTimer);
          live.ac.abort();
        }
      };
      const finish = (why: ChatClosedWhy): void => {
        setStatus('closed', why);
        stop();
      };

      /** The attempt is over and the stream did not end for good: wait, then try again. */
      const retry = (attempt: Attempt, atLeastMs = 0): void => {
        if (closed || current !== attempt) return;
        current = null;
        clearTimeout(attempt.helloTimer);
        const cap = Math.min(maxMs, initialMs * 2 ** Math.min(failures, 30));
        failures += 1;
        const delay = Math.max(Math.floor(random() * cap), atLeastMs);
        setStatus('reconnecting');
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void run();
        }, delay);
      };

      async function run(): Promise<void> {
        if (closed) return;
        const attempt: Attempt = { ac: new AbortController(), helloTimer: undefined };
        current = attempt;
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
        if (!res.ok || res.body === null) {
          const wait = res.status === 429 ? retryAfterMs(res) : null;
          release(res);
          retry(attempt, wait ?? 0);
          return;
        }

        attempt.helloTimer = setTimeout(() => attempt.ac.abort(), HELLO_WAIT_MS);
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
            clearTimeout(attempt.helloTimer);
            failures = 0;
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
            parser.push(decoder.decode(value, { stream: true }));
          }
        } catch {
          // The stream broke (or was aborted): the cases are told apart below.
        }
        clearTimeout(attempt.helloTimer);
        if (closed || current !== attempt) {
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
          if (!isObject(body) || typeof body.ok !== 'boolean') throw bad();
          return body.ok;
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
