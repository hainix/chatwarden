import { randomId } from './crypto.js';
import { POLICY_SECTIONS } from './profile.js';
import type { PolicySection } from './profile.js';
import { safeWarn } from './log.js';
import { b64urlDecode, b64urlEncode } from './staffReports.js';
import type { Clock, Logger, Store } from './types.js';

/** What a staff member may do. Ordered from least to most. */
export const ROLES = ['moderator', 'senior', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The closed list of things the audit trail records. The `term.*` and `exception.*` names also cover the rows the
 * term editor (`LiveTerms`) wrote before the trail existed. The list only ever grows at the end.
 *
 * The three `ai.*` actions target a report and carry no detail: `ai.read` is written by the AI itself (an `ai:` actor, no role)
 * when a read finishes, `ai.rerun` by a moderator who asked for another read, `ai.outcome` by a moderator whose decision was
 * recorded against a read.
 *
 * The three appeal and name actions (0.1.9): `appeal.view` is a staff read of the inbox, one appeal or the numbers (its target is the
 * `appeal`, or none for the list and the numbers); `appeal.decide` points at the `appeal` decided and needs it; `name.rename_required`
 * points at the `person` asked to rename and needs it. None of them carries a detail: a statement, a reason or a name never reaches the trail.
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
  'blocked.view',
  'case.takeover',
  'reason.add',
  'reason.update',
  'reason.toggle',
  'policy.update',
  'policy.reset',
  'report.dismiss_case',
  'report.dismiss_reporter',
  'ai.read',
  'ai.rerun',
  'ai.outcome',
  'appeal.view',
  'appeal.decide',
  'name.rename_required',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * What a `policy.update` or `policy.reset` row says it did: the editable sections it changed, and the reason the owner gave.
 * The reason is the one free text an audit row may carry (1 to {@link AUDIT_REASON_MAX} characters, trimmed); the sections are
 * names from a closed list. No layer value is ever recorded.
 */
export interface AuditDetail {
  sections: PolicySection[];
  reason?: string;
}

/** The longest reason a policy audit row keeps. */
export const AUDIT_REASON_MAX = 2000;

/** The actions that point at a report (and only at one), and carry nothing else. */
const AI_ACTIONS: readonly string[] = ['ai.read', 'ai.rerun', 'ai.outcome'];

/** The actions that point at an appeal (and only at one). `appeal.view` may point at none: the list and the numbers are not about one. */
const APPEAL_ACTIONS: readonly string[] = ['appeal.view', 'appeal.decide'];

/** The actions that cannot be recorded without a target. */
const TARGET_REQUIRED: readonly string[] = [...AI_ACTIONS, 'appeal.decide', 'name.rename_required'];

/** An actor that is the AI itself, not a person: `ai:` and the adapter's id (`ai:anthropic:claude-haiku-5-5`). */
const AI_ACTOR_PREFIX = 'ai:';

/** The actions whose row carries an {@link AuditDetail}, and the only ones that may. */
const DETAIL_ACTIONS: readonly string[] = ['policy.update', 'policy.reset'];

/** What an entry points at: a report id, a sanction group id, a person (a staff ref), a term id, an exception id, a saved reason id or an appeal id. */
export const AUDIT_TARGET_TYPES = ['report', 'sanction', 'person', 'term', 'exception', 'reason', 'appeal'] as const;
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
  /** The staff member's role. `null` only for the AI's own actor (`ai:<adapter id>`), which records `ai.read` and nothing else. */
  role: Role | null;
  action: AuditAction;
  target?: AuditTarget;
  /** Required for `policy.update` and `policy.reset` (and refused for every other action). */
  detail?: AuditDetail;
}

/**
 * One entry as the store keeps and returns it. There is no field for chat text or a note. The one free text is the `reason` inside
 * the `detail` of a `policy.update` or `policy.reset` row (the owner's own reason for changing the settings).
 */
export interface AuditRow {
  id: string;
  /** Epoch ms. */
  at: number;
  actor: string;
  /** Null for an entry written before roles existed. */
  role: Role | null;
  action: AuditAction;
  target: AuditTarget | null;
  /** Only on a `policy.update` or `policy.reset` row. */
  detail?: AuditDetail;
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
  /** Only on a `policy.update` or `policy.reset` row. */
  detail?: AuditDetail;
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

const newId = (): string => randomId(16);

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

/** The detail of a policy row, or null when it is not valid: sections from the closed list, an optional reason, nothing else. */
function parseDetail(detail: unknown): AuditDetail | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  for (const k of Object.keys(d)) if (k !== 'sections' && k !== 'reason') return null;
  const sections = d.sections;
  if (!Array.isArray(sections)) return null;
  const known: readonly string[] = POLICY_SECTIONS;
  if (!sections.every((x) => typeof x === 'string' && known.includes(x))) return null;
  const unique = [...new Set(sections as PolicySection[])];
  if (d.reason === undefined) return { sections: unique };
  if (typeof d.reason !== 'string') return null;
  const reason = d.reason.trim();
  if (reason === '' || reason.length > AUDIT_REASON_MAX) return null;
  return { sections: unique, reason };
}

/** Parse the input of `record`; null when anything is off. Copies only the known fields. */
function parse(input: unknown): AuditRecordInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const { actor, role, action, target, detail } = input as Record<string, unknown>;
  if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) return null;
  if (!isAction(action)) return null;
  // The AI is the one actor with no role: `ai:<adapter id>` records `ai.read`, and only it does. A person always has a role.
  if (actor.startsWith(AI_ACTOR_PREFIX)) {
    if (actor.length === AI_ACTOR_PREFIX.length || role !== null || action !== 'ai.read') return null;
  } else if (!isRole(role) || action === 'ai.read') {
    return null;
  }
  const roleOut: Role | null = actor.startsWith(AI_ACTOR_PREFIX) ? null : (role as Role);
  // A policy row must say what it changed; no other row may carry anything but ids.
  let parsedDetail: AuditDetail | undefined;
  if (DETAIL_ACTIONS.includes(action)) {
    const d = parseDetail(detail);
    if (d === null) return null;
    parsedDetail = d;
  } else if (detail !== undefined) {
    return null;
  }
  const extra = parsedDetail === undefined ? {} : { detail: parsedDetail };
  if (target === undefined) return TARGET_REQUIRED.includes(action) ? null : { actor, role: roleOut, action, ...extra };
  if (typeof target !== 'object' || target === null) return null;
  const { type, ref } = target as Record<string, unknown>;
  if (!isTargetType(type) || typeof ref !== 'string' || !REF_RE.test(ref)) return null;
  if (AI_ACTIONS.includes(action) && type !== 'report') return null;
  if (APPEAL_ACTIONS.includes(action) && type !== 'appeal') return null;
  if (action === 'name.rename_required' && type !== 'person') return null;
  return { actor, role: roleOut, action, target: { type, ref }, ...extra };
}

/**
 * The staff audit trail: who (actor and role) did what (a name from {@link AUDIT_ACTIONS}) to which id, and when.
 * It stores no chat text, note or evidence: there is no field for any, and a target must look like an id. The one free text it
 * keeps is the owner's `reason` in the `detail` of a `policy.update` or `policy.reset` row, next to the section names.
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
   *
   * A person always has a `role`. The AI is the one actor without: pass `role: null` explicitly (`undefined` is refused) with an actor
   * that begins `ai:` (and is longer than that), for `ai.read` only. So a staff ref or login that begins `ai:` is refused (false), and
   * so is `ai.read` from anyone else. The three `ai.*` actions need a `report` target and take no detail.
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
        ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
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
          ...(r.detail === undefined ? {} : { detail: { sections: [...r.detail.sections], ...(r.detail.reason === undefined ? {} : { reason: r.detail.reason }) } }),
        }),
      ),
      next: rows.length === limit && last !== undefined ? encodeAuditCursor(last.at, last.id) : null,
    };
  }
}
