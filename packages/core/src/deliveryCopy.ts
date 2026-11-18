// The text a game delivers when a sanction is given or an appeal is decided (0.2.1): a subject, a plain-text body and a small HTML body. Part of the subpath
// `@chatwarden/core/notice-locales`. Pure: no Node module, no clock, nothing read from a store. It takes the words (a game's own words are untrusted markup,
// so the HTML escapes every one of them) and what to say, and it never takes a line the player wrote: an email is not the place for one (Plan ruling 6).

import type { AppealReasonCode } from './appeals.js';
import { APPEAL_WORDS } from './appealWords.js';
import { bodyKey, durationText, fillWords, isSanction, NOTICE_WORDS, titleKey, untilText, WARNING_DAYS } from './noticeCopy.js';
import type { RuleRef } from './rules.js';
import type { NoticeKind, SanctionKind } from './types.js';

export interface DeliveryContentInput {
  /** The words to say it in (`noticeWordsFor(locale, overrides).words`). A key that is missing reads in English. */
  words: Readonly<Record<string, string>>;
  /** The language of the words (`en`, `es`, `pt` or a game's own): numbers, dates and the HTML `lang`. */
  locale: string;
  kind: 'sanction' | 'appeal_outcome';
  /** The sanction notice (kind 'sanction'), or the appeal outcome notice (kind appeal_upheld | appeal_reduced | appeal_revoked). Only these fields are read: never a line of the player. */
  notice: { kind: NoticeKind; rule: RuleRef | null; ruleLabel: string | null; until: number | null; refCode: string | null; createdAt: number };
  outcome?: { status: 'upheld' | 'reduced' | 'revoked'; reason: AppealReasonCode };
  /** appeal_outcome: the sanction as it stands now (null when lifted). */
  standing?: { kind: SanctionKind; until: number | null } | null;
  appealUrl: string | null;
}

const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe for HTML, in an element or in a quoted attribute: `&`, `<`, `>`, `"` and `'`. */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

const DAY_MS = 86_400_000;

/** An address worth linking: http or https, nothing else, no space or control character. */
function usableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !(url.startsWith('http://') || url.startsWith('https://'))) return false;
  return ![...url].some((ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127);
}

/**
 * The subject, the plain text and the HTML of one delivery. The text is lines joined by a newline with no trailing space: the title and body of the notice kind, its facts (the rule,
 * when it ends or leaves the record, the reference; every time in UTC and marked so), for an outcome the reason sentence of its outcome and code and the sanction that stands now, the
 * link when there is a usable one (http or https), the note that times are UTC, and the footer. Never a line the player wrote. The HTML says the same in a small document with no script,
 * no remote resource and no style, every word escaped.
 */
export function buildDeliveryContent(i: DeliveryContentInput): { subject: string; text: string; html: string } {
  const { notice: n, locale } = i;
  const word = (key: string): string => {
    const own = Object.hasOwn(i.words, key) ? i.words[key] : undefined;
    if (typeof own === 'string' && own !== '') return own;
    const fallback = (NOTICE_WORDS as Readonly<Record<string, string>>)[key] ?? (APPEAL_WORDS as Readonly<Record<string, string>>)[key];
    return typeof fallback === 'string' ? fallback : key;
  };
  const utc = (at: number): string => {
    try {
      return `${untilText(at, locale, 'UTC')} UTC`;
    } catch {
      return String(at);
    }
  };
  const url = usableUrl(i.appealUrl) ? i.appealUrl : null;
  const isOutcome = i.kind === 'appeal_outcome';
  const status = i.outcome?.status ?? (n.kind === 'appeal_upheld' ? 'upheld' : n.kind === 'appeal_reduced' ? 'reduced' : n.kind === 'appeal_revoked' ? 'revoked' : null);

  // The subject.
  let subject: string;
  const length = n.until === null ? '' : durationText(n.until - n.createdAt, locale);
  if (isOutcome && status !== null) subject = word(`delivery.subject.appeal_${status}`);
  else if (n.kind === 'warning') subject = word('delivery.subject.warning');
  else if (n.kind === 'area') subject = word('delivery.subject.area');
  else if (n.kind === 'chat' || n.kind === 'ban') subject = n.until === null ? word(`delivery.subject.${n.kind}.noEnd`) : fillWords(word(`delivery.subject.${n.kind}.timed`), { length });
  else subject = word(titleKey(n.kind));

  // The facts.
  const facts: string[] = [];
  if (typeof n.ruleLabel === 'string' && n.ruleLabel !== '') facts.push(`${word('player.notice.rule')}: ${n.ruleLabel}`);
  if (n.kind === 'warning') facts.push(`${word('player.notice.onRecordUntil')}: ${utc(n.createdAt + WARNING_DAYS * DAY_MS)}`);
  else if (isSanction(n.kind)) facts.push(n.until === null ? `${word('player.notice.until')}: ${word('player.notice.noEnd')}` : `${word('player.notice.until')}: ${utc(n.until)}`);
  if (typeof n.refCode === 'string' && n.refCode !== '') facts.push(`${word('player.notice.ref')}: ${n.refCode}`);

  // For an outcome: why, and what stands now.
  const outcomeLines: string[] = [];
  if (isOutcome && i.outcome !== undefined) {
    const exact = `player.appeal.reason.${i.outcome.status}.${i.outcome.reason}`;
    const key = Object.hasOwn(APPEAL_WORDS, exact) ? exact : `player.appeal.reason.${i.outcome.status}.context_considered`;
    outcomeLines.push(`${word('delivery.reason')}: ${word(key)}`);
  }
  if (isOutcome && status !== 'upheld' && i.standing !== undefined && i.standing !== null) {
    const stands = i.standing;
    const title = word(titleKey(stands.kind));
    const end = stands.kind === 'warning' ? '' : stands.until === null ? ` (${word('player.notice.noEnd')})` : ` (${word('player.notice.until')}: ${utc(stands.until)})`;
    outcomeLines.push(`${word('delivery.standing')}: ${title}${end}`);
  }

  const title = word(titleKey(n.kind));
  const body = word(bodyKey(n.kind));
  const hint = word(isOutcome ? 'delivery.outcomeHint' : 'delivery.appealHint');
  const linkText = word(isOutcome ? 'delivery.outcomeLink' : 'delivery.appealLink');
  const times = word('delivery.times');
  const footer = word('delivery.footer');

  const blocks: string[][] = [[title, body], facts, outcomeLines, url === null ? [] : [hint, url], [times, footer]];
  const text = blocks
    .filter((b) => b.length > 0)
    .map((b) => b.join('\n'))
    .join('\n\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

  const e = escapeHtml;
  const list = (items: string[]): string => (items.length === 0 ? '' : `<ul>${items.map((f) => `<li>${e(f)}</li>`).join('')}</ul>`);
  const html =
    `<!doctype html><html lang="${e(locale)}"><head><meta charset="utf-8"><title>${e(subject)}</title></head><body>` +
    `<h1>${e(title)}</h1><p>${e(body)}</p>` +
    list(facts) +
    outcomeLines.map((l) => `<p>${e(l)}</p>`).join('') +
    (url === null ? '' : `<p>${e(hint)}</p><p><a href="${e(url)}">${e(linkText)}</a></p>`) +
    `<p>${e(times)}</p><p>${e(footer)}</p></body></html>`;

  return { subject: subject.trimEnd(), text, html };
}
