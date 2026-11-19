import type { AppealReasonCode } from './appeals.js';
import { ruleRefOf } from './appealService.js';
import { safeWarn } from './log.js';
import { buildDeliveryContent, noticeWordsFor } from './noticeLocales.js';
import type { AppealWordOverrides } from './noticeLocales.js';
import type { NoticeService } from './notices.js';
import type { CommunityRules, RuleRef } from './rules.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, SanctionKind, Source, Store, SubjectId } from './types.js';

// The delivery hook (`ChatwardenOptions.notices.deliver`, 0.2.1): the kit tells the game what a person was told, so the game can send it by email or any other channel. After the
// commit, fenced, once per notice, and only when an account id is known (never an address hash): the kit has no email address and sends nothing itself.

/**
 * One thing to tell a person: a sanction was given, or an appeal was decided. `to` is the account id the game gave us (the one the person was most recently seen with), never a key, an
 * address or a subject id. `subject`, `text` and `html` are ready to send, in `locale`; they carry no line the person wrote. `appealUrl` is the signed link to the appeal page (a
 * capability for this one sanction: do not log it), or null without `appeals.landingUrl`. `sanction` is the sanction the message is about: for `appeal_outcome` the original (upheld,
 * revoked) or the replacement (reduced).
 */
export interface NoticeDelivery {
  kind: 'sanction' | 'appeal_outcome';
  noticeId: string;
  to: { accountId: string };
  locale: string;
  subject: string;
  text: string;
  html: string;
  appealUrl: string | null;
  sanction: { kind: SanctionKind; until: number | null; rule: RuleRef | null; source: Source; automated: boolean };
  outcome?: { status: 'upheld' | 'reduced' | 'revoked'; reason: AppealReasonCode };
}

/** What `ChatwardenOptions.notices` holds. */
export interface NoticeDeliveryOptions {
  /**
   * Told after the commit that a person should hear something. Fenced: a throw or a rejection is logged by class (`chatwarden.delivery_failed`) and never fails the sanction; it is never awaited, so a
   * hook that never settles holds nothing. Called once per notice. Retry and dedupe are the hook's: `noticeId` is the stable key.
   */
  deliver?: (d: NoticeDelivery) => void | Promise<void>;
  /** The language to write in for an account: a tag such as `es-MX`, or nothing for English. A throw reads as English. Given `{ accountId }` and nothing else. */
  localeOf?: (to: { accountId: string }) => string | undefined;
}

export interface DeliveryServiceDeps {
  store: Store;
  subjects: SubjectIndex;
  notices: NoticeService;
  rules: CommunityRules;
  clock: Clock;
  logger?: Logger | undefined;
  options: NoticeDeliveryOptions;
  /** The signed appeal link for a notice, or null. */
  link: (noticeId: string) => string | null;
  /** The game's own words by language (`appeals.words`), read live. */
  words: () => AppealWordOverrides;
}

const SKIP_LOG_EVERY_MS = 60_000;

const errName = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
};

const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

type Sanction = NoticeDelivery['sanction'];

/**
 * Tells the game, after a commit, what a person should hear. Never throws and never blocks: every read is fenced, the hook is called without being awaited and a failure is logged by class only
 * (never the delivery, the account id, the link or the text).
 */
export class DeliveryService {
  private readonly d: DeliveryServiceDeps;
  /** No-account skips since the last log line, and when that line was written. */
  private skipped = 0;
  private lastSkipLogAt: number | null = null;

  constructor(deps: DeliveryServiceDeps) {
    this.d = deps;
  }

  private on(): boolean {
    return typeof this.d.options.deliver === 'function';
  }

  private warn(event: string, detail: Record<string, string | number | boolean>): void {
    safeWarn(this.d.logger, event, detail);
  }

  /** A sanction notice was committed and announced: tell the game. Never throws. */
  sanctionNoticed(noticeId: string): void {
    if (!this.on()) return;
    try {
      const row = this.d.store.loadNotice?.(noticeId) ?? null;
      if (row === null || row.groupId === null || !(row.kind === 'warning' || row.kind === 'chat' || row.kind === 'area' || row.kind === 'ban')) return;
      const group = this.d.store.loadSanctionSubjectRow?.(row.groupId) ?? null;
      if (group === null) return;
      const person = this.d.subjects.canonical(row.subject);
      const to = this.recipient(person);
      if (to === null) return;
      const view = this.d.notices.viewOf(row);
      const appealUrl = this.linkFor(row.id);
      const { locale, words } = this.words(to);
      const content = buildDeliveryContent({
        words,
        locale,
        kind: 'sanction',
        notice: { kind: view.kind, rule: view.rule, ruleLabel: view.ruleLabel, until: view.until, refCode: view.refCode, createdAt: view.createdAt, ...(view.evidence === undefined ? {} : { evidence: view.evidence }) },
        appealUrl,
      });
      const sanction: Sanction = { kind: row.kind, until: row.kind === 'warning' ? null : row.until, rule: ruleRefOf(row.rule), source: group.source, automated: group.automated };
      this.call({ kind: 'sanction', noticeId: row.id, to: { accountId: to }, locale, ...content, appealUrl, sanction });
    } catch (err) {
      this.warn('chatwarden.delivery_failed', { error: errName(err) });
    }
  }

  /**
   * An appeal was decided and committed. `noticeId` is the outcome message notice; `originalNoticeId` the sanction notice the appeal was filed from (its link is valid after the commit: a withdrawn
   * notice with a decided appeal keeps a read-only one). Never throws.
   */
  appealDecided(o: {
    noticeId: string;
    originalNoticeId: string;
    person: SubjectId;
    status: 'upheld' | 'reduced' | 'revoked';
    reason: AppealReasonCode;
    sanction: Sanction;
    standing: { kind: SanctionKind; until: number | null } | null;
    refCode: string | null;
  }): void {
    if (!this.on()) return;
    try {
      const to = this.recipient(this.d.subjects.canonical(o.person));
      if (to === null) return;
      const appealUrl = this.linkFor(o.originalNoticeId);
      const { locale, words } = this.words(to);
      const content = buildDeliveryContent({
        words,
        locale,
        kind: 'appeal_outcome',
        notice: {
          kind: `appeal_${o.status}`,
          rule: o.sanction.rule,
          ruleLabel: o.sanction.rule === null ? null : this.d.rules.label(o.sanction.rule),
          until: null,
          refCode: o.refCode,
          createdAt: this.d.clock.now(),
        },
        outcome: { status: o.status, reason: o.reason },
        standing: o.standing,
        appealUrl,
      });
      this.call({ kind: 'appeal_outcome', noticeId: o.noticeId, to: { accountId: to }, locale, ...content, appealUrl, sanction: o.sanction, outcome: { status: o.status, reason: o.reason } });
    } catch (err) {
      this.warn('chatwarden.delivery_failed', { error: errName(err) });
    }
  }

  /** The account to write to, or null (counted, not named). */
  private recipient(person: SubjectId): string | null {
    const account = this.d.subjects.latestAccount(person);
    if (account !== null) return account;
    this.skipped += 1;
    const now = this.d.clock.now();
    if (this.lastSkipLogAt === null || now - this.lastSkipLogAt >= SKIP_LOG_EVERY_MS) {
      this.warn('chatwarden.delivery_skipped_no_account', { count: this.skipped });
      this.skipped = 0;
      this.lastSkipLogAt = now;
    }
    return null;
  }

  /** The signed link for the notice; a failure leaves it out. */
  private linkFor(noticeId: string): string | null {
    try {
      const url: unknown = this.d.link(noticeId);
      return typeof url === 'string' && url !== '' ? url : null;
    } catch (err) {
      this.warn('chatwarden.delivery_failed', { error: errName(err) });
      return null;
    }
  }

  /** The language and words for an account: `localeOf` (a throw reads as English), the game's own words over the shipped ones. */
  private words(accountId: string): { locale: string; words: Record<string, string> } {
    let tag: unknown;
    try {
      tag = this.d.options.localeOf?.({ accountId });
    } catch {
      tag = undefined;
    }
    let overrides: AppealWordOverrides;
    try {
      overrides = this.d.words();
    } catch {
      overrides = {};
    }
    return noticeWordsFor(typeof tag === 'string' ? tag : 'en', overrides);
  }

  /** Call the hook: never awaited, never rethrown. */
  private call(delivery: NoticeDelivery): void {
    const deliver = this.d.options.deliver;
    if (typeof deliver !== 'function') return;
    try {
      const result: unknown = deliver.call(this.d.options, delivery);
      if (isThenable(result)) {
        result.then(undefined, (err: unknown) => {
          this.warn('chatwarden.delivery_failed', { error: errName(err) });
        });
      }
    } catch (err) {
      this.warn('chatwarden.delivery_failed', { error: errName(err) });
    }
  }
}

/**
 * Check `ChatwardenOptions.notices` once, at creation: an object, whose `deliver` and `localeOf`, when given, are functions (`TypeError` naming `notices.deliver` or `notices.localeOf`, never the
 * value). Returns a copy to deliver with, or undefined when the game gave no `deliver` (then the kit delivers nothing and reads nothing for it).
 */
export function checkDeliveryOptions(input: unknown): NoticeDeliveryOptions | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('createChatwarden: notices must be an object');
  const { deliver, localeOf } = input as Record<string, unknown>;
  if (deliver !== undefined && typeof deliver !== 'function') throw new TypeError('createChatwarden: notices.deliver must be a function');
  if (localeOf !== undefined && typeof localeOf !== 'function') throw new TypeError('createChatwarden: notices.localeOf must be a function');
  if (typeof deliver !== 'function') return undefined;
  return { deliver: deliver as NoticeDeliveryOptions['deliver'] & object, ...(typeof localeOf === 'function' ? { localeOf: localeOf as NoticeDeliveryOptions['localeOf'] & object } : {}) };
}
