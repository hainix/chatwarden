import { errorClass, safeWarn } from '@chatwarden/core';
import { bodyObject } from '../admin/validate.js';
import { BODY_MAX_BYTES, utf8ByteLength } from '../body.js';
import { HttpError, ValidationError, withErrors } from '../errors.js';
import { Limiter } from '../limiter.js';
import type { RouteTable } from '../router.js';
import type { KitRequest, KitResponse } from '../types.js';
import { verify } from '../webhooks/sign.js';
import type { ResolvedCoopOptions } from './options.js';
import { cutText } from './wire.js';

// The signal route (K5 design 8.7): `POST /coop/signal`. A Coop plugin (examples/coop-signal) posts the lines of a reported thread, signed with the kit's own HMAC
// scheme (`x-chatwarden-timestamp`, `x-chatwarden-signature`, a 5 minute window, a replay cache); the adopter's `read` answers a severity from 0 to 100. The route only
// reads: it never decides anything. No identifier is in the request or the answer: each line is copied as `{ label, text }` and nothing else, so an extra key never
// reaches `read`. Failures are a fixed 503 with an empty body.

/** How many lines are read; the rest are dropped. */
export const SIGNAL_LINES_MAX = 50;
/** Each text is cut to this many characters. */
export const SIGNAL_TEXT_MAX = 400;
const LABEL_MAX = 32;
/** How long `read` may take. */
export const SIGNAL_READ_MS = 8000;
/** The rate limiter's one key: there is one secret. */
const LIMIT_KEY = 'signal';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Line = { label: string; text: string };
type Answered = { ok: true; severity: number } | { ok: false; error: string };

export interface SignalRoute {
  routes: RouteTable;
  dispose(): void;
}

/** The lines of a request body, copied and capped, or a `ValidationError` for a shape that is not `{ lines: [{ label, text }], item?: { text } }`. */
function linesOf(body: Record<string, unknown>): Line[] {
  const given = body['lines'];
  if (!Array.isArray(given) || given.length === 0) throw new ValidationError();
  const lines: Line[] = [];
  for (const entry of given.slice(0, SIGNAL_LINES_MAX)) {
    if (!isObject(entry)) throw new ValidationError();
    const { label, text } = entry;
    if (typeof label !== 'string' || label.length === 0 || typeof text !== 'string') throw new ValidationError();
    lines.push({ label: cutText(label, LABEL_MAX), text: cutText(text, SIGNAL_TEXT_MAX) });
  }
  const item = body['item'];
  if (item !== undefined) {
    if (!isObject(item) || typeof item['text'] !== 'string') throw new ValidationError();
    lines.push({ label: 'item', text: cutText(item['text'], SIGNAL_TEXT_MAX) });
  }
  return lines;
}

export function createSignal(o: ResolvedCoopOptions): SignalRoute | null {
  const signal = o.signal;
  if (signal === null) return null;
  const { logger, clock } = o;
  const limiter = new Limiter(signal.rateLimit);
  let disposed = false;
  /** Reads in flight, each with the function that ends it, so a dispose leaves no timer and no waiting request. */
  const inFlight = new Set<(a: Answered) => void>();

  /** `read` raced against the limit. A throw, a rejection, a timeout and an answer that is not a finite number are all a failure, by class. */
  const readWithin = (lines: readonly Line[]): Promise<Answered> =>
    new Promise<Answered>((resolve) => {
      let cancel: () => void = () => undefined;
      const finish = (answer: Answered): void => {
        if (!inFlight.delete(finish)) return;
        cancel();
        resolve(answer);
      };
      inFlight.add(finish);
      cancel = o.schedule(() => finish({ ok: false, error: 'Timeout' }), SIGNAL_READ_MS);
      // Already finished (the schedule ran at once)? `cancel` was assigned late, so cancel again.
      if (!inFlight.has(finish)) cancel();
      let pending: Promise<number>;
      try {
        pending = Promise.resolve(signal.read(lines));
      } catch (err) {
        finish({ ok: false, error: errorClass(err) });
        return;
      }
      pending.then(
        (value) => finish(typeof value === 'number' && Number.isFinite(value) ? { ok: true, severity: Math.min(100, Math.max(0, value)) } : { ok: false, error: 'BadAnswer' }),
        (err: unknown) => finish({ ok: false, error: errorClass(err) }),
      );
    });

  const handler = withErrors(async (req: KitRequest): Promise<KitResponse> => {
    const raw = req.rawBody;
    if (raw === undefined) {
      safeWarn(logger, 'chatwarden.coop_failed', { op: 'no_raw_body' });
      return { status: 500, body: { error: 'internal' } };
    }
    if (raw.length * 3 > BODY_MAX_BYTES && utf8ByteLength(raw) > BODY_MAX_BYTES) throw new HttpError('payload_too_large');
    // Verify BEFORE parsing. Every failure is the same 401.
    if (disposed || !verify(signal.secret, req.headers, raw, clock.now(), signal.replay)) throw new HttpError('unauthorized');
    // A verified request costs `read`: the limiter counts only those.
    const wait = limiter.hit(LIMIT_KEY, clock.now());
    if (wait > 0) throw new HttpError('rate_limited', { 'retry-after': String(Math.max(1, Math.ceil(wait / 1000))) });

    const lines = linesOf(bodyObject(req));
    const answer = await readWithin(lines);
    if (!answer.ok) {
      safeWarn(logger, 'chatwarden.coop_failed', { op: 'signal', error: answer.error });
      return { status: 503, body: '' };
    }
    return { status: 200, body: { severity: answer.severity } };
  }, logger);

  return {
    routes: { 'POST /coop/signal': handler },
    dispose() {
      disposed = true;
      for (const finish of [...inFlight]) finish({ ok: false, error: 'Disposed' });
    },
  };
}
