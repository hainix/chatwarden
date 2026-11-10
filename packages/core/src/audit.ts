import { randomBytes } from 'node:crypto';
import { safeWarn } from './log.js';
import { b64urlDecode, b64urlEncode } from './staffReports.js';
import type { Clock, Logger, Store } from './types.js';

/** What a staff member may do. Ordered from least to most. */
export const ROLES = ['moderator', 'senior', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The closed list of things the audit trail records. The `term.*` and `exception.*` names also cover the rows the
 * term editor (`LiveTerms`) wrote before the trail existed.
 */
export const AUDIT_ACTIONS = [
  'report.view',
  'report.decide',
  'sanction.apply',
  'sanction.revoke',
  'gap.close',
  'term.add',
  'term.update',
  'term.toggle',
  'exception.add',
  'exception.update',
  'exception.toggle',
  'history.view',
  'suggest',
  'policy.view',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What an entry points at: a report id, a sanction group id, a person (a staff ref), a term id or an exception id. */
export const AUDIT_TARGET_TYPES = ['report', 'sanction', 'person', 'term', 'exception'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export interface AuditTarget {
  type: AuditTargetType;
  /**
   * An id: 1..64 characters of `A-Z a-z 0-9 _ . : -`. It holds ids only (a report id, a sanction group id, a
   * subject id, a term id), never text: pass the id of a term, not the term.
   */
  ref: string;
}

/** What {@link AuditService.record} takes. Nothing else is read, so nothing else can be stored. */
export interface AuditRecordInput {
  /**
   * The staff member: a staff ref or login, 1..128 characters of `A-Z a-z 0-9 _ . : @ + -`, no whitespace. Never a
   * display name or any message. (Rows written before the trail existed may carry other actors; `list` returns
   * them as they are.)
   */
  actor: string;
  role: Role;
  action: AuditAction;
  target?: AuditTarget;
}

/** One entry as the store keeps and returns it. There is no field for chat text, a reason or a note. */
export interface AuditRow {
  id: string;
  /** Epoch ms. */
  at: number;
  actor: string;
  /** Null for an entry written before roles existed. */
  role: Role | null;
  action: AuditAction;
  target: AuditTarget | null;
}

/** What {@link Store.listAudit} takes. */
export interface AuditListQuery {
  /** Epoch ms; only entries before this (exclusive), or at it with an id below `beforeId`. */
  before?: number;
  beforeId?: string;
  /** Clamped to 1..200 by the store. */
  limit: number;
  actor?: string;
  action?: AuditAction;
}

/** One entry of `cw.audit.list`: `target` is absent when the entry had none. */
export interface AuditItem {
  id: string;
  at: number;
  actor: string;
  role: Role | null;
  action: AuditAction;
  target?: AuditTarget;
}

/** What `cw.audit.list` takes. `limit` is required. */
export interface AuditQuery {
  /** The `next` of the previous page. Omit or null for the first page. */
  before?: string | null;
  /** An integer from 1 to 200; anything else throws `RangeError`. */
  limit: number;
  actor?: string;
  action?: AuditAction;
}

/** One page, newest first. `next` is an opaque cursor for `before`, or null when this page was not full. */
export interface AuditPage {
  items: AuditItem[];
  next: string | null;
}

/** The largest page. */
export const AUDIT_PAGE_MAX = 200;

/** A list query that cannot be answered: a `before` cursor we did not issue, or an unknown `action` / bad `actor`. */
export class AuditQueryError extends Error {
  readonly field: 'before' | 'action' | 'actor';
  constructor(field: 'before' | 'action' | 'actor') {
    super(`audit.list: invalid ${field}`);
    this.name = 'AuditQueryError';
    this.field = field;
  }
}

const REF_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ACTOR_RE = /^[A-Za-z0-9_.:@+-]{1,128}$/;

/** True when `actor` is a string the audit trail accepts: 1..128 characters of `A-Z a-z 0-9 _ . : @ + -`. */
export const isValidAuditActor = (actor: unknown): actor is string => typeof actor === 'string' && ACTOR_RE.test(actor);

const newId = (): string => randomBytes(16).toString('base64url');

const isAction = (v: unknown): v is AuditAction => typeof v === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(v);
const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
const isTargetType = (v: unknown): v is AuditTargetType =>
  typeof v === 'string' && (AUDIT_TARGET_TYPES as readonly string[]).includes(v);

/** The opaque cursor for "older than this entry": base64url of `at:id`. */
export function encodeAuditCursor(at: number, id: string): string {
  return b64urlEncode(`${at}:${id}`);
}

/** Read a cursor made by {@link encodeAuditCursor}; throws {@link AuditQueryError} for anything else. */
export function decodeAuditCursor(cursor: unknown): { at: number; id: string } {
  const text = typeof cursor === 'string' ? b64urlDecode(cursor) : null;
  const sep = text === null ? -1 : text.indexOf(':');
  if (text === null || sep < 1 || sep === text.length - 1) throw new AuditQueryError('before');
  const time = text.slice(0, sep);
  const at = Number(time);
  if (!/^\d{1,16}$/.test(time) || !Number.isSafeInteger(at)) throw new AuditQueryError('before');
  return { at, id: text.slice(sep + 1) };
}

/** Parse the input of `record`; null when anything is off. Copies only the known fields. */
function parse(input: unknown): AuditRecordInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const { actor, role, action, target } = input as Record<string, unknown>;
  if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) return null;
  if (!isRole(role) || !isAction(action)) return null;
  if (target === undefined) return { actor, role, action };
  if (typeof target !== 'object' || target === null) return null;
  const { type, ref } = target as Record<string, unknown>;
  if (!isTargetType(type) || typeof ref !== 'string' || !REF_RE.test(ref)) return null;
  return { actor, role, action, target: { type, ref } };
}

/**
 * The staff audit trail: who (actor and role) did what (a name from {@link AUDIT_ACTIONS}) to which id, and when.
 * It stores no chat text, reason, note or evidence: there is no field for any, and a target must look like an id.
 */
export class AuditService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;

  constructor(deps: { store: Store; clock: Clock; logger?: Logger | undefined }) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.logger = deps.logger;
  }

  /**
   * Write one entry, now. Synchronous and fenced: it never throws, and returns false (nothing written, one log line
   * carrying the event name and at most the error class) for an input outside the closed lists or a store failure.
   */
  record(input: AuditRecordInput): boolean {
    try {
      const parsed = parse(input);
      if (parsed === null) {
        safeWarn(this.logger, 'chatwarden.audit_refused');
        return false;
      }
      this.store.insertAudit({
        id: newId(),
        at: this.clock.now(),
        actor: parsed.actor,
        role: parsed.role,
        action: parsed.action,
        target: parsed.target ?? null,
      });
      return true;
    } catch (err) {
      safeWarn(this.logger, 'chatwarden.audit_failed', { error: err instanceof Error ? err.name : typeof err });
      return false;
    }
  }

  /**
   * One page of the trail, newest first (ties on `at` by id, newest id first). `limit` must be an integer from 1 to
   * 200 (`RangeError` otherwise). An unknown `action`, a bad `actor` or a `before` we did not issue is an
   * {@link AuditQueryError}. Messages never echo the input.
   */
  list(q: AuditQuery): AuditPage {
    const query: Partial<AuditQuery> = typeof q === 'object' && q !== null ? q : {};
    const limit: unknown = query.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) {
      throw new RangeError(`audit.list: limit must be an integer from 1 to ${AUDIT_PAGE_MAX}`);
    }
    if (query.action !== undefined && !isAction(query.action)) throw new AuditQueryError('action');
    if (query.actor !== undefined && (typeof query.actor !== 'string' || query.actor === '')) {
      throw new AuditQueryError('actor');
    }
    const cursor = query.before === undefined || query.before === null ? null : decodeAuditCursor(query.before);
    const rows = this.store.listAudit({
      limit,
      ...(cursor === null ? {} : { before: cursor.at, beforeId: cursor.id }),
      ...(query.actor === undefined ? {} : { actor: query.actor }),
      ...(query.action === undefined ? {} : { action: query.action }),
    });
    const last = rows[rows.length - 1];
    return {
      items: rows.map(
        (r): AuditItem => ({
          id: r.id,
          at: r.at,
          actor: r.actor,
          role: r.role,
          action: r.action,
          ...(r.target === null ? {} : { target: { type: r.target.type, ref: r.target.ref } }),
        }),
      ),
      next: rows.length === limit && last !== undefined ? encodeAuditCursor(last.at, last.id) : null,
    };
  }
}
