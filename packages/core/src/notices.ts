import { randomBytes } from 'node:crypto';
import { safeWarn } from './log.js';
import { maskSpans } from './mask.js';
import { parseRuleRef } from './rules.js';
import type { CommunityRules, RuleRef } from './rules.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, Matcher, NoticeKind, NoticeRow, ReportExcerptLine, Store, StoredReport, SubjectId } from './types.js';

export type { NoticeKind } from './types.js';

const DAY_MS = 86_400_000;

/** The most lines a notice excerpt may carry. */
export const NOTICE_EXCERPT_MAX = 5;

/** "My record" keeps an ended sanction this long after its notice was made. */
export const NOTICE_RECORD_WINDOW_MS = 90 * DAY_MS;

const SANCTION_NOTICE_KINDS: readonly NoticeKind[] = ['warning', 'chat', 'area', 'ban'];

/**
 * What a player is shown about a sanction taken against them, or about a report they filed. The ONLY shape that
 * leaves the kit for a player. It carries no subject, key, hash, room, seat or handle, no moderator reason or
 * identity, and (in `excerpt`) only lines the player wrote themselves, as a day and text.
 */
export interface PlayerNotice {
  /** Random; the handle for `ack`. */
  id: string;
  kind: NoticeKind;
  /** The Community Rule cited; null for a report outcome. */
  rule: RuleRef | null;
  /** The player-facing name of the rule. */
  ruleLabel: string | null;
  /** Epoch ms the sanction ends; null = no end (permanent, a warning, or a report outcome). */
  until: number | null;
  /** The reference code to quote to a moderator; null for a report outcome. */
  refCode: string | null;
  /** At most five of the player's own lines. `day` is UTC `YYYY-MM-DD`. A blocked line has its matched terms masked. */
  excerpt: Array<{ text: string; day: string }>;
  /** Epoch ms. */
  createdAt: number;
  /** True for a warning: the client must show it and get an `ack` before the player starts the next game. */
  mustAcknowledge: boolean;
}

export type ExcerptErrorCode = 'foreign_line' | 'too_many' | 'invalid_line';

/** An excerpt that cannot be shown. The message never carries a line id, text or identifier. */
export class ExcerptError extends Error {
  readonly code: ExcerptErrorCode;
  constructor(code: ExcerptErrorCode) {
    super(
      code === 'foreign_line'
        ? 'excerpt: a requested line is not one the player wrote'
        : code === 'too_many'
          ? `excerpt: at most ${NOTICE_EXCERPT_MAX} lines`
          : 'excerpt: a line is malformed',
    );
    this.name = 'ExcerptError';
    this.code = code;
  }
}

const copyLine = (l: ReportExcerptLine): ReportExcerptLine => ({ ...l, audience: l.audience === null ? null : [...l.audience] });

/**
 * The lines of `report` that `subject` wrote themselves, for `lineIds`, in the report's order. A line is the
 * subject's when `people[p]` canonicalises to the subject (so a merged alias's line is theirs); a line with no
 * writer (`p` null), an index outside `people`, or someone else's is never theirs.
 *
 * Throws {@link ExcerptError}: `too_many` above {@link NOTICE_EXCERPT_MAX} distinct ids, `foreign_line` when ANY
 * requested id is not the subject's own line (an id absent from the excerpt counts). Nothing partial is returned.
 */
export function ownLines(
  report: Pick<StoredReport, 'people' | 'excerpt'>,
  subject: SubjectId,
  lineIds: readonly string[],
  subjects: SubjectIndex,
): ReportExcerptLine[] {
  if (!Array.isArray(lineIds)) throw new ExcerptError('foreign_line');
  const wanted = new Set<string>(lineIds);
  if (wanted.size > NOTICE_EXCERPT_MAX) throw new ExcerptError('too_many');
  const person = subjects.canonical(subject);
  const isOwn = (l: ReportExcerptLine): boolean => {
    const p = l.p;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p >= report.people.length) return false;
    const who = report.people[p];
    return who !== undefined && subjects.canonical(who) === person;
  };
  const out: ReportExcerptLine[] = [];
  const found = new Set<string>();
  for (const l of report.excerpt) {
    if (!wanted.has(l.lineId)) continue;
    if (!isOwn(l)) throw new ExcerptError('foreign_line');
    found.add(l.lineId);
    out.push(copyLine(l));
  }
  if (found.size !== wanted.size) throw new ExcerptError('foreign_line');
  return out;
}

/** Options for creating a notice. */
export interface NoticeCreateOptions {
  /** Default true. False skips the push; call `announce` after the surrounding transaction commits. */
  notify?: boolean;
}

/** What a notice is told about a sanction. `excerptLines` come through {@link ownLines}. */
export interface SanctionNoticeInput {
  groupId: string;
  refCode: string;
  kind: 'warning' | 'chat' | 'area' | 'ban';
  /** Epoch ms the sanction ends; null = permanent (and always null for a warning). */
  until: number | null;
  /** The cited rule, or null when the sanction predates rules. */
  rule: RuleRef | null;
  subject: SubjectId;
}

export interface NoticeServiceDeps {
  store: Store;
  subjects: SubjectIndex;
  rules: CommunityRules;
  clock: Clock;
  /** Masks blocked lines. Without it (or without `spans`) a blocked line is shown fully starred. */
  matcher?: Matcher;
  logger?: Logger;
  /**
   * Told after a notice is written, with the person's pending count. Fenced: a throw or a rejection is logged and
   * never reaches the caller. Never carries a notice body.
   */
  notify?: (subject: SubjectId, event: { type: 'notice_pending'; count: number }) => unknown;
}

const newId = (): string => randomBytes(16).toString('base64url');

const errName = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
};

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The sanction and report-outcome notices shown to players: create, list, acknowledge, record, withdraw. */
export class NoticeService {
  private readonly store: Store;
  private readonly subjects: SubjectIndex;
  private readonly rules: CommunityRules;
  private readonly clock: Clock;
  private readonly matcher: Matcher | undefined;
  private readonly logger: Logger | undefined;
  private readonly hook: NoticeServiceDeps['notify'];

  constructor(deps: NoticeServiceDeps) {
    this.store = deps.store;
    this.subjects = deps.subjects;
    this.rules = deps.rules;
    this.clock = deps.clock;
    this.matcher = deps.matcher;
    this.logger = deps.logger;
    this.hook = deps.notify;
  }

  /**
   * Write the notice for a sanction group and tell the player's client. Returns the notice id.
   * `excerptLines` must already be the target's own lines (see {@link ownLines}); at most five. A blocked line is
   * masked here, and no raw blocked text is ever stored. Throws on a malformed input (nothing is written).
   *
   * Pass `{ notify: false }` when this runs inside a larger `store.transaction` that may still roll back, then call
   * {@link announce} once that transaction has committed.
   */
  createForSanction(
    group: SanctionNoticeInput,
    excerptLines: readonly ReportExcerptLine[] = [],
    opts: NoticeCreateOptions = {},
  ): string {
    if (!SANCTION_NOTICE_KINDS.includes(group.kind)) throw new Error('createForSanction: invalid kind');
    if (!nonEmpty(group.groupId) || typeof group.refCode !== 'string') throw new Error('createForSanction: invalid group');
    if (!nonEmpty(group.subject)) throw new Error('createForSanction: invalid subject');
    if (group.until !== null && !Number.isFinite(group.until)) throw new Error('createForSanction: invalid end');
    if (group.rule !== null) parseRuleRef(String(group.rule)); // refuses a value the store could not read back
    const excerpt = this.excerptOf(excerptLines);
    const subject = this.subjects.canonical(group.subject);
    return this.insert(
      {
        subject,
        groupId: group.groupId,
        kind: group.kind,
        rule: group.rule === null ? null : String(group.rule),
        until: group.until,
        refCode: group.refCode,
        excerpt,
      },
      subject,
      opts.notify !== false,
    );
  }

  /** Tell a reporter that their report led to action. No rule, code, end or excerpt: nothing about the other player. */
  createReportOutcome(reporter: SubjectId, opts: NoticeCreateOptions = {}): string {
    if (!nonEmpty(reporter)) throw new Error('createReportOutcome: invalid subject');
    const subject = this.subjects.canonical(reporter);
    return this.insert(
      { subject, groupId: null, kind: 'report_outcome', rule: null, until: null, refCode: null, excerpt: [] },
      subject,
      opts.notify !== false,
    );
  }

  /** Notices not yet seen or withdrawn, oldest first, across the person's merged subjects. */
  pending(subject: SubjectId): PlayerNotice[] {
    return this.rowsOf(subject)
      .filter((r) => r.ackedAt === null && r.withdrawnAt === null)
      .map((r) => this.toPlayer(r));
  }

  /**
   * Mark a notice seen. True when it is this person's live notice (marking an already seen one again is fine);
   * false for someone else's, an unknown id, or a withdrawn notice.
   */
  ack(subject: SubjectId, id: string): boolean {
    if (!nonEmpty(id)) return false;
    const row = this.rowsOf(subject).find((r) => r.id === id);
    if (row === undefined || row.withdrawnAt !== null) return false;
    if (row.ackedAt !== null) return true;
    this.store.transaction(() => this.store.ackNotice(id, this.clock.now()));
    return true;
  }

  /**
   * Tell the player's client how many notices are pending now (the same fenced push a create does). Use it after
   * the transaction a `{ notify: false }` create ran in has committed. Never throws.
   */
  announce(subject: SubjectId): void {
    if (!nonEmpty(subject)) return;
    this.push(this.subjects.canonical(subject));
  }

  /**
   * "My record": the person's sanction notices (seen or not) that are not withdrawn and still apply. A warning
   * applies for 90 days from when it was made (the ladder lookback). Any other kind applies while it is permanent
   * (until it is withdrawn), still running, or made within 90 days. Report outcomes are never included. Decided from
   * the notice row alone; `purgeNotices` agrees with this, so a row that applies is never purged.
   */
  record(subject: SubjectId): PlayerNotice[] {
    const now = this.clock.now();
    return this.rowsOf(subject)
      .filter(
        (r) =>
          r.withdrawnAt === null &&
          r.kind !== 'report_outcome' &&
          (r.createdAt >= now - NOTICE_RECORD_WINDOW_MS ||
            (r.kind !== 'warning' && (r.until === null || r.until > now))),
      )
      .map((r) => this.toPlayer(r));
  }

  /** Withdraw the notices of a sanction group (it was revoked). Returns how many were withdrawn. */
  withdrawGroup(groupId: string): number {
    if (!nonEmpty(groupId)) return 0;
    return this.store.transaction(() => this.store.withdrawNoticeGroup(groupId, this.clock.now()));
  }

  /** True while the person has a warning they have not acknowledged. */
  pendingWarning(subject: SubjectId): boolean {
    return this.rowsOf(subject).some((r) => r.kind === 'warning' && r.ackedAt === null && r.withdrawnAt === null);
  }

  private insert(
    fields: Omit<NoticeRow, 'id' | 'createdAt' | 'ackedAt' | 'withdrawnAt'>,
    subject: SubjectId,
    notify: boolean,
  ): string {
    const id = newId();
    const row: NoticeRow = { id, ...fields, createdAt: this.clock.now(), ackedAt: null, withdrawnAt: null };
    this.store.transaction(() => this.store.insertNotice(row));
    if (notify) this.push(subject);
    return id;
  }

  /** After the commit. Nothing in here can affect the caller. */
  private push(subject: SubjectId): void {
    const hook = this.hook;
    if (hook === undefined) return;
    try {
      const told: unknown = hook(subject, { type: 'notice_pending', count: this.pending(subject).length });
      // An async hook is type-legal against `=> void`; its rejection must not escape as an unhandled one.
      if (isThenable(told)) {
        told.then(undefined, (err: unknown) => {
          this.warn('notices.notify_failed', { error: errName(err) });
        });
      }
    } catch (err) {
      this.warn('notices.notify_failed', { error: errName(err) });
    }
  }

  /** The person's notices, oldest first. Rows are read by every id merged into the person, then re-checked. */
  private rowsOf(subject: SubjectId): NoticeRow[] {
    if (!nonEmpty(subject)) return [];
    const person = this.subjects.canonical(subject);
    return this.store.loadNotices(this.subjects.aliasesOf(person)).filter((r) => this.subjects.canonical(r.subject) === person);
  }

  private toPlayer(r: NoticeRow): PlayerNotice {
    if (r.kind === 'report_outcome') {
      return { id: r.id, kind: r.kind, rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: r.createdAt, mustAcknowledge: false };
    }
    let rule: RuleRef | null = null;
    if (r.rule !== null) {
      try {
        rule = parseRuleRef(r.rule);
      } catch {
        rule = null;
      }
    }
    return {
      id: r.id,
      kind: r.kind,
      rule,
      ruleLabel: rule === null ? null : this.rules.label(rule),
      until: r.until,
      refCode: r.refCode,
      excerpt: r.excerpt.map((l) => ({ text: l.text, day: l.day })),
      createdAt: r.createdAt,
      mustAcknowledge: r.kind === 'warning',
    };
  }

  private excerptOf(lines: readonly ReportExcerptLine[]): Array<{ text: string; day: string }> {
    if (!Array.isArray(lines)) throw new ExcerptError('invalid_line');
    if (lines.length > NOTICE_EXCERPT_MAX) throw new ExcerptError('too_many');
    return lines.map((l) => {
      if (typeof l.raw !== 'string' || !Number.isFinite(l.ts) || Number.isNaN(new Date(l.ts).getTime())) {
        throw new ExcerptError('invalid_line');
      }
      const text = l.blocked !== true && typeof l.delivered === 'string' ? l.delivered : this.maskRaw(l.raw);
      return { text, day: new Date(l.ts).toISOString().slice(0, 10) };
    });
  }

  /**
   * A line that was blocked (or has no delivered form): its matched terms starred. If the matcher cannot say where
   * they are (no `spans`, an empty or unusable answer, a throw) the whole line is starred, never shown.
   */
  private maskRaw(raw: string): string {
    const full = '*'.repeat(raw.length);
    const matcher = this.matcher;
    if (matcher === undefined || typeof matcher.spans !== 'function') return full;
    try {
      const found: unknown = matcher.spans(raw);
      if (!Array.isArray(found) || found.length === 0) return full;
      const masked = maskSpans(raw, found as Array<{ start: number; end: number }>);
      return masked === raw ? full : masked;
    } catch (err) {
      this.warn('notices.mask_failed', { error: errName(err) });
      return full;
    }
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    safeWarn(this.logger, event, detail);
  }
}
