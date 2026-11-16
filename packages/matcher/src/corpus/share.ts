import type { Clock, Logger } from '@chatwarden/core';
import { collapseLikePreset, foldTerm } from '../normalise.js';
import { readBounded } from './bounded.js';
import { systemSchedule, type Schedule } from './loader.js';
import { leadingZeroBitsAfter } from './sha256.js';
import { signedMessage } from './sign.js';

// The client of the contribution API (design 6.8, 8.4, 10.2). One term at a time, from a person, built from a closed list of keys: a share
// can carry no chat line, name, subject, seat, client key, account id, IP, room, hit or excerpt, because there is nowhere in the payload to
// put one and nothing here reads one. The body is serialised once and those very bytes are signed, stamped and sent. Nothing the service
// says is passed on: an answer becomes a closed code. Nothing here throws once configured, and no error or log carries text.
// Isomorphic; it is built in the adopter's server, which holds the installation key (`installationKey(dir)` in corpus/node).

/** Where the project's service listens. @experimental */
export const COMMUNITY_ENDPOINT = 'https://corpus.chatwarden.dev';

/** What the person offers. Only these fields are read; anything else on the object is ignored and never sent. @experimental */
export interface ShareInput {
  /** One word of plain letters (accents allowed), 40 characters at most, 3 or more letters once repeats collapse. */
  term: string;
  /** A language tag (`en`, `es`, `pt`; `pt-BR` is sent as `pt`). */
  language: string;
  category: 'slur' | 'abuse' | 'sexual' | 'other';
  /** For a slur, who it is aimed at; default `none`. */
  target?: string;
  /** At most 200 characters; no URL, no `@`, no run of more than 4 digits. */
  note?: string | null;
}

/** @experimental */
export type ShareResult =
  | { ok: true; status: 'received' | 'known' | 'duplicate'; id?: string }
  | { ok: false; code: 'invalid' | 'too_large' | 'unsupported_language' | 'rate_limited' | 'offline' | 'rejected'; retryAfterMs?: number };

/** Why a person reports a term of the shared list (design 10.6). A closed list: there is no free text. @experimental */
export type ReportKind = 'innocent_sense' | 'wrong_category' | 'removal';

/** What a report says: which term, and why. The id is the term's public id on the list (`CWT-2026-00042`); the word is never sent. @experimental */
export interface ReportInput {
  termId: string;
  kind: ReportKind;
}

/** The service takes a report as a ticket and answers with an acknowledgement id at most; the same report twice in a day is also `ok`. @experimental */
export type ReportResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'invalid' | 'rate_limited' | 'offline' | 'rejected'; retryAfterMs?: number };

/** @experimental */
export interface CommunityShare {
  /** Never throws: every failure is a closed code in the result. */
  share(input: ShareInput): Promise<ShareResult>;
  /** The state of an earlier share, or null (an unknown id, any failure, an answer that is not understood). */
  status(id: string): Promise<{ status: 'received' | 'in_review' | 'accepted' | 'declined' | 'merged'; reason?: string } | null>;
  /** Report a problem with a term of the shared list: a signed ticket of a term id and a closed kind. Never throws. */
  report(input: ReportInput): Promise<ReportResult>;
}

const SCHEMA = 'chatwarden-corpus-submission/1';
const REPORT_SCHEMA = 'chatwarden-corpus-report/1';
const REPORT_KINDS: readonly string[] = ['innocent_sense', 'wrong_category', 'removal'];
const TERM_ID_RE = /^CWT-\d{4}-\d{5}$/;
const CATEGORIES: readonly string[] = ['slur', 'abuse', 'sexual', 'other'];
const TARGETS: readonly string[] = ['none', 'ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other'];
const STATUSES: readonly string[] = ['received', 'in_review', 'accepted', 'declined', 'merged'];
const REASONS: readonly string[] = ['known_innocent', 'not_a_term', 'duplicate', 'needs_context', 'other'];
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const KIT_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const LANG_RE = /^[a-z]{2,3}$/;
const BODY_MAX_BYTES = 2048;
const ANSWER_MAX_BYTES = 8192;
const STAMP_BITS = 16;
const TIMEOUT_MS = 15_000;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60 * 1000;
const NOTE_MAX = 200;
/** A scheme, `www.`, or a bare host under a common top-level domain. The same rule the service applies. */
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|gg|me|tv|co|ly|xyz|info|app|gl|to|us|uk|de|fr|es|pt|br|ru|cn|jp|ca|au)\b/i;
// A control character, plus what could make a reviewer's screen lie: C1 controls, line and paragraph separators, and the bidi controls.
// The same list as the service's (services/corpus/src/gates.ts), so the kit never sends a note the service refuses.
// eslint-disable-next-line no-control-regex -- control characters in a note are refused
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- the stamp (hashcash): SHA-256 of body then nonce starts with `bits` zero bits ---

const NONCE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_STAMP_BITS = 32;
const MAX_MINT_BITS = 26;

function checkBits(bits: unknown, max: number, who: string): number {
  if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 0 || bits > max) throw new RangeError(`${who}: bits must be a whole number from 0 to ${max}`);
  return bits;
}
function checkBody(body: unknown, who: string): Uint8Array {
  if (body === null || typeof body !== 'object' || !ArrayBuffer.isView(body)) throw new TypeError(`${who}: body must be a Uint8Array`);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * A hashcash stamp for `body`: `<bits>:<nonce>`, where SHA-256 of the body followed by the nonce starts with at least `bits` zero bits.
 * Deterministic (the nonce counts up in base 36), synchronous, about a second of one core for 16 bits in the worst of a few cases.
 * @experimental
 */
export function mintStamp(body: Uint8Array, bits: number): string {
  const bytes = checkBody(body, 'mintStamp');
  checkBits(bits, MAX_MINT_BITS, 'mintStamp');
  const zeros = leadingZeroBitsAfter(bytes);
  for (let n = 0; ; n += 1) {
    const nonce = n.toString(36);
    if (zeros(encoder.encode(nonce)) >= bits) return `${bits}:${nonce}`;
  }
}

/** The same search, in slices, so a server is not blocked for the whole of it. */
async function mintStampSliced(body: Uint8Array, bits: number): Promise<string> {
  const zeros = leadingZeroBitsAfter(body);
  for (let n = 0; ; n += 1) {
    const nonce = n.toString(36);
    if (zeros(encoder.encode(nonce)) >= bits) return `${bits}:${nonce}`;
    if (n % 2048 === 2047) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Whether `stamp` is a good stamp for `body` at `bits` bits: well formed, claiming at least `bits`, and its hash really has the zero bits
 * it claims. A stamp one bit short, or one that claims more than it did, is false. Never throws for a bad stamp.
 * @experimental
 */
export function checkStamp(body: Uint8Array, stamp: string, bits: number): boolean {
  const bytes = checkBody(body, 'checkStamp');
  checkBits(bits, MAX_STAMP_BITS, 'checkStamp');
  if (typeof stamp !== 'string') return false;
  const m = /^(\d{1,2}):([^:]*)$/.exec(stamp);
  if (m === null || !NONCE_RE.test(m[2] as string)) return false;
  const claimed = Number(m[1]);
  if (claimed > MAX_STAMP_BITS || ((m[1] as string).length > 1 && (m[1] as string).startsWith('0'))) return false;
  if (claimed < bits) return false;
  return leadingZeroBitsAfter(bytes)(encoder.encode(m[2] as string)) >= claimed;
}

// --- the payload ---

interface Submission {
  term: string;
  language: string;
  category: string;
  target: string;
  note: string | null;
}

/** One word of plain letters, as the person wrote it (trimmed), or null. */
function plainWord(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0 || t.length > 40 || !/^\p{L}[\p{L}\p{M}]*$/u.test(t)) return null;
  const folded = foldTerm(t);
  if (!/^[a-z]+$/.test(folded) || collapseLikePreset(folded).length < 3) return null;
  return t;
}

function languageTag(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const tag = v.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return LANG_RE.test(tag) && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(v.trim()) ? tag : null;
}

function noteText(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return null;
  if (t.length > NOTE_MAX || CONTROL_RE.test(t)) return undefined;
  // The `@`, digit and URL checks run on the NFKC form, so a full-width `@`, a compatibility digit or a full-width dot does not get round them.
  const n = t.normalize('NFKC');
  if (n.includes('@') || /\p{Nd}{5,}/u.test(n) || URL_RE.test(n)) return undefined;
  return t;
}

/** Reads the five fields once each and nothing else, or null for anything that is not a good submission. */
function readInput(input: unknown): Submission | null {
  try {
    if (input === null || typeof input !== 'object') return null;
    const raw = input as Record<string, unknown>;
    const term = plainWord(raw.term);
    const language = languageTag(raw.language);
    const category = raw.category;
    const rawTarget = raw.target;
    const note = noteText(raw.note);
    const target = rawTarget === undefined ? 'none' : rawTarget;
    if (term === null || language === null || note === undefined) return null;
    if (typeof category !== 'string' || !CATEGORIES.includes(category)) return null;
    if (typeof target !== 'string' || !TARGETS.includes(target)) return null;
    return { term, language, category, target, note };
  } catch {
    return null;
  }
}

/** `{ termId, kind }` read once each, or null for anything that is not a good report. Nothing else on the input is read. */
function readReport(input: unknown): { termId: string; kind: ReportKind } | null {
  try {
    if (input === null || typeof input !== 'object') return null;
    const raw = input as Record<string, unknown>;
    const termId = raw.termId;
    const kind = raw.kind;
    if (typeof termId !== 'string' || !TERM_ID_RE.test(termId)) return null;
    if (typeof kind !== 'string' || !REPORT_KINDS.includes(kind)) return null;
    return { termId, kind: kind as ReportKind };
  } catch {
    return null;
  }
}

/** The day of `now` in UTC as `YYYY-MM-DD`, or null if the clock gives nothing usable. */
function dayOf(now: number): string | null {
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;
  const date = new Date(now);
  const y = date.getUTCFullYear();
  if (!Number.isFinite(y) || y < 2000 || y > 9999) return null;
  return date.toISOString().slice(0, 10);
}

// --- the client ---

const base64url = (bytes: Uint8Array): string => {
  // only the 64-byte signature goes through here when a caller's `sign` returns raw bytes; strings are used as given
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

/** Options for {@link createCommunityShare}. @experimental */
export interface CommunityShareOptions {
  /** Default {@link COMMUNITY_ENDPOINT}. `https` (or `http` for localhost), origin only. */
  endpoint?: string;
  /** Signs a message with the installation key and returns the signature as base64url (see `installationKey` in corpus/node). */
  sign: (message: Uint8Array) => Promise<string>;
  /** The installation's public key, base64url (32 bytes). */
  publicKey: string;
  fetch?: typeof fetch;
  clock: Clock;
  /** The kit's version, sent so the service knows what built the share. Default `0.0.0`. */
  kit?: string;
  logger?: Logger;
  /** The timer for the request deadline (15 seconds). Default `setTimeout`. */
  schedule?: Schedule;
  /** The work each share does before it is sent, in leading zero bits of a hash (design 6.8: 16, about a second at worst). The service says how many it wants. */
  stampBits?: number;
}

function originOf(endpoint: unknown): string {
  let url: URL;
  try {
    url = new URL(String(endpoint));
  } catch {
    throw new RangeError('createCommunityShare: endpoint must be an https URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  if (!schemeOk || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new RangeError('createCommunityShare: endpoint must be an https origin with no path, query or login');
  }
  return url.origin;
}

/**
 * The share client. `share(input)` validates, builds the closed-key payload, serialises it once, signs and stamps those bytes (16 bits)
 * and posts them; `status(id)` is a signed GET. Throws a `RangeError` (naming the option) only for a configuration that cannot work.
 * @experimental
 */
export function createCommunityShare(options: CommunityShareOptions): CommunityShare {
  const o = options;
  if (o === null || typeof o !== 'object') throw new RangeError('createCommunityShare: options are required');
  if (typeof o.sign !== 'function') throw new RangeError('createCommunityShare: sign must be a function');
  if (typeof o.publicKey !== 'string' || !KEY_RE.test(o.publicKey)) throw new RangeError('createCommunityShare: publicKey must be 32 bytes of base64url');
  if (o.clock === null || typeof o.clock !== 'object' || typeof o.clock.now !== 'function') throw new RangeError('createCommunityShare: clock must have now()');
  if (o.kit !== undefined && (typeof o.kit !== 'string' || !KIT_RE.test(o.kit))) throw new RangeError('createCommunityShare: kit must be a version such as 0.1.11');
  const stampBits = o.stampBits === undefined ? STAMP_BITS : checkBits(o.stampBits, MAX_MINT_BITS, 'createCommunityShare.stampBits');
  const origin = originOf(o.endpoint ?? COMMUNITY_ENDPOINT);
  const { sign, publicKey, clock } = o;
  const kit = o.kit ?? '0.0.0';
  const schedule = o.schedule ?? systemSchedule;

  const warn = (code: string, event = 'corpus.share_failed'): void => {
    try {
      const out: unknown = o.logger === undefined ? console.warn(event, { code }) : o.logger.warn(event, { code });
      if (typeof (out as { then?: unknown } | null | undefined)?.then === 'function') (out as PromiseLike<unknown>).then(undefined, () => undefined);
    } catch {
      // a logger that throws must not break a share
    }
  };
  const fail = (code: Extract<ShareResult, { ok: false }>['code'], retryAfterMs?: number): ShareResult => {
    warn(code);
    return retryAfterMs === undefined ? { ok: false, code } : { ok: false, code, retryAfterMs };
  };

  /** A request with a deadline. Resolves to the status, headers' retry-after and a bounded body, or null for any failure of the transport. */
  async function request(url: string, init: RequestInit): Promise<{ status: number; retryAfter: string | null; body: Uint8Array | null } | null> {
    let cancel: () => void = () => undefined;
    // The request is aborted at the deadline, so a hung one does not keep its socket; the race still ends it for a fetch that ignores the signal.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const deadline = new Promise<null>((resolve) => {
      cancel = schedule.after(TIMEOUT_MS, () => {
        resolve(null);
        try {
          controller?.abort();
        } catch {
          // nothing to abort
        }
      });
    });
    const work = (async () => {
      try {
        const res = await (o.fetch ?? globalThis.fetch)(url, {
          ...init,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          ...(controller === null ? {} : { signal: controller.signal }),
        });
        if (res === null || typeof res !== 'object' || typeof res.status !== 'number') return null;
        let body: Uint8Array | null = null;
        try {
          body = await readBounded(res, ANSWER_MAX_BYTES);
        } catch {
          body = null;
        }
        return { status: res.status, retryAfter: res.headers?.get?.('retry-after') ?? null, body };
      } catch {
        return null;
      }
    })();
    work.catch(() => undefined);
    try {
      return await Promise.race([work, deadline]);
    } finally {
      cancel();
    }
  }

  /** The signature of `message`, as base64url, or null when `sign` fails, answers badly or does not answer within the deadline. */
  async function signed(message: Uint8Array): Promise<string | null> {
    let cancel: () => void = () => undefined;
    const deadline = new Promise<null>((resolve) => {
      cancel = schedule.after(TIMEOUT_MS, () => resolve(null));
    });
    try {
      const out = await Promise.race([Promise.resolve(sign(message)).then((v) => v as unknown), deadline]);
      if (out === null) return null;
      const signature = typeof out === 'string' ? out : base64url(out as Uint8Array);
      return /^[A-Za-z0-9_-]{1,200}$/.test(signature) ? signature : null;
    } catch {
      return null;
    } finally {
      cancel();
    }
  }

  const parseJson = (bytes: Uint8Array | null): Record<string, unknown> | null => {
    if (bytes === null) return null;
    try {
      const v: unknown = JSON.parse(decoder.decode(bytes));
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const idOf = (v: unknown): { id: string } | Record<string, never> => (typeof v === 'string' && ID_RE.test(v) ? { id: v } : {});

  async function share(input: ShareInput): Promise<ShareResult> {
    const submission = readInput(input);
    if (submission === null) return fail('invalid');
    const day = dayOf(clock.now());
    if (day === null) return fail('invalid');
    // The closed list of keys, in this order, and nothing else.
    const body = encoder.encode(
      JSON.stringify({
        schema: SCHEMA,
        term: submission.term,
        language: submission.language,
        category: submission.category,
        target: submission.target,
        note: submission.note,
        day,
        kit,
      }),
    );
    if (body.length > BODY_MAX_BYTES) return fail('too_large');
    const signature = await signed(signedMessage('submission', body));
    if (signature === null) return fail('rejected');
    const stamp = await mintStampSliced(body, stampBits);
    const res = await request(`${origin}/v1/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cw-key': publicKey, 'x-cw-sig': signature, 'x-cw-stamp': stamp },
      body,
    });
    if (res === null) return fail('offline');
    const json = parseJson(res.body);
    const { status } = res;
    if (status === 429) {
      const seconds = res.retryAfter !== null && /^\d{1,9}$/.test(res.retryAfter.trim()) ? Number(res.retryAfter.trim()) : null;
      return seconds === null ? fail('rate_limited') : fail('rate_limited', Math.min(seconds * 1000, RETRY_AFTER_MAX_MS));
    }
    if (status === 202 || status === 200) {
      const s = json?.status;
      if (status === 202 && s === 'received') {
        return { ok: true, status: 'received', ...idOf(json?.id) };
      }
      if (status === 200 && s === 'known') return { ok: true, status: 'known', ...idOf(json?.termId) };
      if (status === 200 && s === 'duplicate') return { ok: true, status: 'duplicate' };
      return fail('rejected');
    }
    if (status === 400) {
      const e = json?.error;
      if (e === 'invalid' || e === 'too_large' || e === 'unsupported_language') return fail(e);
      return fail('rejected');
    }
    if (status === 413) return fail('too_large');
    if (status >= 500) return fail('offline');
    return fail('rejected');
  }

  async function status(id: string): Promise<{ status: 'received' | 'in_review' | 'accepted' | 'declined' | 'merged'; reason?: string } | null> {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const signature = await signed(signedMessage('submission', encoder.encode(id)));
    if (signature === null) {
      warn('rejected');
      return null;
    }
    const res = await request(`${origin}/v1/submissions/${id}`, { method: 'GET', headers: { 'x-cw-key': publicKey, 'x-cw-sig': signature } });
    if (res === null || res.status !== 200) return null;
    const json = parseJson(res.body);
    const s = json?.status;
    if (typeof s !== 'string' || !STATUSES.includes(s)) return null;
    const reason = json?.reason;
    const out = s as 'received' | 'in_review' | 'accepted' | 'declined' | 'merged';
    return typeof reason === 'string' && REASONS.includes(reason) ? { status: out, reason } : { status: out };
  }

  const failReport = (code: Extract<ReportResult, { ok: false }>['code'], retryAfterMs?: number): ReportResult => {
    warn(code, 'corpus.report_failed');
    return retryAfterMs === undefined ? { ok: false, code } : { ok: false, code, retryAfterMs };
  };

  async function report(input: ReportInput): Promise<ReportResult> {
    const report = readReport(input);
    if (report === null) return failReport('invalid');
    const day = dayOf(clock.now());
    if (day === null) return failReport('invalid');
    // The closed list of keys, in this order, and nothing else. No word, no text, no stamp: a report only opens a ticket.
    const body = encoder.encode(JSON.stringify({ schema: REPORT_SCHEMA, termId: report.termId, kind: report.kind, day, kit }));
    const signature = await signed(signedMessage('report', body));
    if (signature === null) return failReport('rejected');
    const res = await request(`${origin}/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cw-key': publicKey, 'x-cw-sig': signature },
      body,
    });
    if (res === null) return failReport('offline');
    const { status } = res;
    if (status === 429) {
      const seconds = res.retryAfter !== null && /^\d{1,9}$/.test(res.retryAfter.trim()) ? Number(res.retryAfter.trim()) : null;
      return seconds === null ? failReport('rate_limited') : failReport('rate_limited', Math.min(seconds * 1000, RETRY_AFTER_MAX_MS));
    }
    if (status === 202 || status === 200) {
      const json = parseJson(res.body);
      const s = json?.status;
      if (status === 202 && s === 'received') return { ok: true, ...idOf(json?.id) };
      if (status === 200 && s === 'duplicate') return { ok: true };
      return failReport('rejected');
    }
    if (status === 400 && parseJson(res.body)?.error === 'invalid') return failReport('invalid');
    if (status >= 500) return failReport('offline');
    return failReport('rejected');
  }

  return { share, status, report };
}
