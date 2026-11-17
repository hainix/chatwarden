// The words and the view of a player notice: the one place that turns a `PlayerNotice` into text. The subpath `@chatwarden/core/notice-copy`.
//
// Player-react draws a notice with it, and the hub's "what the player sees" panel draws the same output, so the two cannot word a notice
// differently. Pure: no React, no `node:` module, no clock of its own (the time is passed in), nothing read from a store.
//
// The keys are player-react's (`player.notice.title.warning`, ...), so a studio's translation of those keys keeps working: spread
// `NOTICE_WORDS` (or `englishWords()`) under yours and a key you leave out falls back to English.

import type { PlayerNotice } from './notices.js';
import type { RuleRef } from './rules.js';
import type { NoticeKind } from './types.js';

const WORDS = {
  'player.notice.title.warning': 'You have a warning',
  'player.notice.title.chat': 'Your chat is turned off',
  'player.notice.title.area': 'You cannot join public rooms',
  'player.notice.title.ban': 'You are banned',
  'player.notice.title.report_outcome': 'Thanks for your report',
  'player.notice.title.rename_required': 'Please choose a new name',
  'player.notice.title.appeal_upheld': 'We looked again and kept the decision',
  'player.notice.title.appeal_reduced': 'We looked again and changed the decision',
  'player.notice.title.appeal_revoked': 'We looked again and removed the decision',
  'player.notice.title.fallback': 'A message from the moderators',
  'player.notice.body.warning': 'A moderator gave you a warning for something you wrote. You can keep playing.',
  'player.notice.body.chat': 'A moderator turned off your chat. You can still play.',
  'player.notice.body.area': 'A moderator stopped you joining public rooms and matchmaking. You can still play in private rooms.',
  'player.notice.body.ban': 'A moderator banned you from playing.',
  'player.notice.body.report_outcome': 'A moderator looked at your report and took action. We do not share what was done.',
  'player.notice.body.rename_required': 'A moderator asked you to change your name because it breaks the community rules. Choose a new name to keep playing.',
  'player.notice.body.appeal_upheld': 'A moderator read your appeal. The original decision stands.',
  'player.notice.body.appeal_reduced': 'A moderator read your appeal and made the decision lighter. The new decision is on your record.',
  'player.notice.body.appeal_revoked': 'A moderator read your appeal and took the decision off your record.',
  'player.notice.body.fallback': 'There is a new message about your account.',
  'player.notice.rule': 'Rule',
  'player.notice.given': 'Given',
  'player.notice.until': 'Until',
  'player.notice.ended': 'Ended',
  'player.notice.noEnd': 'No end date',
  'player.notice.onRecordUntil': 'On your record until',
  'player.notice.untilLeft': '{when} ({left})',
  'player.notice.ref': 'Reference',
  'player.notice.refHint': 'Quote this code if you contact us.',
  'player.notice.lines': 'Your messages that led to this',
  'player.notice.todo.warning': 'Press Acknowledge to confirm you saw this.',
  'player.notice.acknowledge': 'Acknowledge',
  'player.notice.gotIt': 'Got it',
  'player.notice.appeal': 'Think this is a mistake?',
  'player.restricted.moderator.until': 'A moderator turned off your chat until {when} ({left}).',
  'player.restricted.moderator.noEnd': 'A moderator turned off your chat. It does not end on its own.',
};

/** A key of {@link NOTICE_WORDS}. */
export type NoticeWordKey = keyof typeof WORDS;

/** The words a notice is drawn with: every key of {@link NOTICE_WORDS}, each a template (`{when}` and `{left}` mark values to fill in). */
export type NoticeWords = Readonly<Record<NoticeWordKey, string>>;

/**
 * The English words of every notice kind (title and body), the labels of its facts, its hints, its buttons and the two lines of a chat that
 * a moderator turned off. Deep-frozen; {@link englishWords} is a copy to spread.
 */
export const NOTICE_WORDS: NoticeWords = Object.freeze({ ...WORDS });

/** A fresh copy of {@link NOTICE_WORDS}, for a catalog to spread: `{ ...englishWords(), ...mine }`. */
export function englishWords(): Record<NoticeWordKey, string> {
  return { ...WORDS };
}

/** How many days a warning stays on a record (the same as core's notice record window). */
export const WARNING_DAYS = 90;

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const TITLES: Readonly<Record<NoticeKind, NoticeWordKey>> = {
  warning: 'player.notice.title.warning',
  chat: 'player.notice.title.chat',
  area: 'player.notice.title.area',
  ban: 'player.notice.title.ban',
  report_outcome: 'player.notice.title.report_outcome',
  rename_required: 'player.notice.title.rename_required',
  appeal_upheld: 'player.notice.title.appeal_upheld',
  appeal_reduced: 'player.notice.title.appeal_reduced',
  appeal_revoked: 'player.notice.title.appeal_revoked',
};
const BODIES: Readonly<Record<NoticeKind, NoticeWordKey>> = {
  warning: 'player.notice.body.warning',
  chat: 'player.notice.body.chat',
  area: 'player.notice.body.area',
  ban: 'player.notice.body.ban',
  report_outcome: 'player.notice.body.report_outcome',
  rename_required: 'player.notice.body.rename_required',
  appeal_upheld: 'player.notice.body.appeal_upheld',
  appeal_reduced: 'player.notice.body.appeal_reduced',
  appeal_revoked: 'player.notice.body.appeal_revoked',
};

/** The key of a notice kind's title; the fallback title for a kind this version does not know. */
export const titleKey = (kind: NoticeKind | string): NoticeWordKey => (Object.hasOwn(TITLES, kind) ? (TITLES[kind as NoticeKind] as NoticeWordKey) : 'player.notice.title.fallback');

/** The key of a notice kind's body; the fallback body for a kind this version does not know. */
export const bodyKey = (kind: NoticeKind | string): NoticeWordKey => (Object.hasOwn(BODIES, kind) ? (BODIES[kind as NoticeKind] as NoticeWordKey) : 'player.notice.body.fallback');

/** A sanction a player can contest (a thank-you for a report, a required rename and the outcome of an appeal are not one). */
export const isSanction = (kind: string): boolean => kind === 'warning' || kind === 'chat' || kind === 'area' || kind === 'ban';

function safeLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/** Some runtimes put a narrow no-break space before "PM". A plain space reads the same and survives a copy. */
const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, ' ');

/**
 * A UTC day from the kit (`2027-01-15`) as the locale writes a date (`Jan 15, 2027`), in UTC whatever the viewer's zone: the kit
 * names the day in UTC, so a notice never shows a different day than the moderator's tools. A value that is not a day comes back
 * as it was; it is never shown as "Invalid Date".
 */
export function dayText(day: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return day;
  return new Intl.DateTimeFormat(safeLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

/** A date and time: `Jan 15, 2027, 8:30 PM`. Pass a time zone for a fixed one; the default is the viewer's. An unknown zone is ignored. */
export function untilText(at: number, locale: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return plain(new Intl.DateTimeFormat(safeLocale(locale), { ...options, ...(timeZone === undefined ? {} : { timeZone }) }).format(at));
  } catch {
    return plain(new Intl.DateTimeFormat(safeLocale(locale), options).format(at));
  }
}

/**
 * How long is left until `at`, as the locale says it ("in 3 hours"): minutes under an hour (a part of a minute counts as a whole
 * one, so a live restriction never reads "in 0 minutes"), hours under two days, then days. Null when `at` is now or has passed.
 */
export function timeLeft(at: number, now: number, locale: string): string | null {
  const left = at - now;
  if (!(left > 0)) return null;
  const rtf = new Intl.RelativeTimeFormat(safeLocale(locale), { numeric: 'always' });
  if (left < HOUR) return rtf.format(Math.max(1, Math.ceil(left / MIN)), 'minute');
  if (left < 2 * DAY) return rtf.format(Math.round(left / HOUR), 'hour');
  return rtf.format(Math.round(left / DAY), 'day');
}

/** What {@link noticeView} needs besides the notice. */
export interface NoticeViewContext {
  /** The words, as player-react's catalog holds them (a key it lacks reads in English). */
  words: NoticeWords;
  locale: string;
  /** A fixed time zone for the times; default the viewer's. */
  timeZone?: string;
  /** The time now, for "in 3 hours" and for telling a live restriction from one that ended. */
  now: () => number;
  /** "My record": adds the day the notice was given. */
  record?: boolean;
}

/** One row of a notice's facts: `id` is stable, `term` and `value` are words. */
export interface NoticeFact {
  id: 'rule' | 'given' | 'onRecordUntil' | 'until' | 'ended' | 'ref';
  term: string;
  value: string;
}

/** A notice as a player reads it: plain text, ready to draw. */
export interface NoticeView {
  kind: string;
  title: string;
  body: string;
  facts: NoticeFact[];
  /** "Quote this code if you contact us.", or null when the notice has no reference code. */
  refHint: string | null;
  /** "Your messages that led to this", or null when the notice has no lines. */
  linesLabel: string | null;
  lines: Array<{ day: string; text: string }>;
  /** True for a warning, and for anything the kit says must be acknowledged. */
  mustAcknowledge: boolean;
  /** "Press Acknowledge to confirm you saw this.", or null when the notice needs no acknowledgement. */
  todo: string | null;
  /** The word on the one button: "Acknowledge" or "Got it". */
  button: string;
  /** A sanction the player can contest: a notice of any other kind has no appeal slot. */
  sanction: boolean;
}

/** A template with its `{name}` values filled in; a name with no value stays as written. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? (values[name] as string) : whole));
}

/**
 * The text of a notice, exactly as player-react's notice card and "My record" draw it: the title and body of its kind (the fallback for a kind
 * this version does not know), the rows of facts (the rule, when it was given in the record, when a warning leaves the record or when a
 * restriction ends or ended or that it has no end, and the reference), the reference hint, the lines with their day, and the button.
 */
export function noticeView(notice: PlayerNotice, ctx: NoticeViewContext): NoticeView {
  const { locale, timeZone } = ctx;
  const word = (key: NoticeWordKey): string => ctx.words[key] ?? NOTICE_WORDS[key];
  const facts: NoticeFact[] = [];
  if (notice.ruleLabel !== null) facts.push({ id: 'rule', term: word('player.notice.rule'), value: notice.ruleLabel });
  if (ctx.record === true) facts.push({ id: 'given', term: word('player.notice.given'), value: untilText(notice.createdAt, locale, timeZone) });
  if (notice.kind === 'warning') {
    // A warning has no end of its own: it stays on the record for 90 days from when it was made.
    facts.push({ id: 'onRecordUntil', term: word('player.notice.onRecordUntil'), value: untilText(notice.createdAt + WARNING_DAYS * DAY, locale, timeZone) });
  } else if (isSanction(notice.kind) || notice.until !== null) {
    if (notice.until === null) facts.push({ id: 'until', term: word('player.notice.until'), value: word('player.notice.noEnd') });
    else {
      const when = untilText(notice.until, locale, timeZone);
      const left = timeLeft(notice.until, ctx.now(), locale);
      facts.push(
        left === null
          ? { id: 'ended', term: word('player.notice.ended'), value: when }
          : { id: 'until', term: word('player.notice.until'), value: fill(word('player.notice.untilLeft'), { when, left }) },
      );
    }
  }
  if (notice.refCode !== null) facts.push({ id: 'ref', term: word('player.notice.ref'), value: notice.refCode });
  const mustAcknowledge = notice.kind === 'warning' || notice.mustAcknowledge;
  return {
    kind: notice.kind,
    title: word(titleKey(notice.kind)),
    body: word(bodyKey(notice.kind)),
    facts,
    refHint: notice.refCode === null ? null : word('player.notice.refHint'),
    linesLabel: notice.excerpt.length === 0 ? null : word('player.notice.lines'),
    lines: notice.excerpt.map((l) => ({ day: dayText(l.day, locale), text: l.text })),
    mustAcknowledge,
    todo: mustAcknowledge ? word('player.notice.todo.warning') : null,
    button: word(mustAcknowledge ? 'player.notice.acknowledge' : 'player.notice.gotIt'),
    sanction: isSanction(notice.kind),
  };
}

/** "Community Rule 2: Title", the name of a rule a player is told: the number and the title, "Community Rule 99" when there is no title, and a plain line for `'uncovered'`. */
export function communityRuleLabel(ref: RuleRef, title?: string): string {
  if (ref === 'uncovered') return 'Not covered by a rule yet';
  return title === undefined ? `Community Rule ${ref}` : `Community Rule ${ref}: ${title}`;
}
