// Every word the player components show is a key in this catalog; components never hold English.
//
// Key naming: `player.<area>.<thing>[.<detail>]`, lower camel case segments, for example `player.notice.title.warning`.
// Areas: error, state, notice, notices, record, rules, restricted, report, chat. The `chat` words live in `chat/words.ts` (`enChat`), so
// the main entry does not carry them; `PlayerText` names them all and the chat box falls back to them when a catalog lacks one.
// Plural forms add the CLDR category as the last segment: `player.report.remaining.one`, `.other`. A caller asks for the base
// key with a numeric `count` (`t('player.report.remaining', { count: 3 })`); `.zero` is used for 0 when it exists.
// `{name}` marks a value to fill in. To translate, spread this catalog over yours so a missing key falls back to English:
// `createT({ ...en, ...de }, 'de')`.
//
// The copy is written for a player in the middle of a game: second person, sentence case, plain words, and never shaming. It says
// what happened, until when, and what the player can do.

import type { enChat } from './chat/words.js';

export const en = {
  'player.error.network': 'Could not reach the server. Check your connection and try again.',
  'player.error.unauthorized': 'You are signed out. Sign in again, then try again.',
  'player.error.forbidden': 'This account cannot do that.',
  'player.error.notFound': 'That could not be found.',
  'player.error.rateLimited': 'Too many requests. Try again in a moment.',
  'player.error.rateLimited.after.one': 'Too many requests. Try again in {count} second.',
  'player.error.rateLimited.after.other': 'Too many requests. Try again in {count} seconds.',
  'player.error.server': 'The server had a problem. Try again in a moment.',
  'player.error.generic': 'Something went wrong.',

  'player.state.retry': 'Try again',

  'player.notices.loadFailed': 'We could not check for notices.',

  'player.notice.title.warning': 'You have a warning',
  'player.notice.title.chat': 'Your chat is turned off',
  'player.notice.title.area': 'You cannot join public rooms',
  'player.notice.title.ban': 'You are banned',
  'player.notice.title.report_outcome': 'Thanks for your report',
  'player.notice.title.fallback': 'A message from the moderators',
  'player.notice.body.warning': 'A moderator gave you a warning for something you wrote. You can keep playing.',
  'player.notice.body.chat': 'A moderator turned off your chat. You can still play.',
  'player.notice.body.area': 'A moderator stopped you joining public rooms and matchmaking. You can still play in private rooms.',
  'player.notice.body.ban': 'A moderator banned you from playing.',
  'player.notice.body.report_outcome': 'A moderator looked at your report and took action. We do not share what was done.',
  'player.notice.body.fallback': 'There is a new message about your account.',
  'player.notice.position': 'Notice {n} of {total}',
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
  'player.notice.ackFailed': 'Your notice is still here.',
  'player.notice.closeForNow': 'Close for now',

  'player.record.title': 'Your record',
  'player.record.loading': 'Loading your record',
  'player.record.loadFailed': 'We could not load your record.',
  'player.record.intro': 'This is what is on your record now. A warning stays for {days} days.',
  'player.record.empty': 'Your record is clear. Nothing is on it right now.',
  'player.record.kind.warning': 'Warning',
  'player.record.kind.chat': 'Chat restriction',
  'player.record.kind.area': 'Public rooms restriction',
  'player.record.kind.ban': 'Ban',
  'player.record.kind.fallback': 'Notice',

  'player.rules.title': 'Community rules',
  'player.rules.loading': 'Loading the rules',
  'player.rules.loadFailed': 'We could not load the rules.',
  'player.rules.empty': 'No rules are published yet.',

  'player.restricted.moderator.until': 'A moderator turned off your chat until {when} ({left}).',
  'player.restricted.moderator.noEnd': 'A moderator turned off your chat. It does not end on its own.',
  'player.restricted.filter.until': 'Your chat is off until {when} ({left}). The automatic filter caught a message.',
  'player.restricted.filter.noEnd': 'Your chat is off. It does not end on its own. The automatic filter caught a message.',
  'player.restricted.ended': 'Your chat is back on. The restriction ended {when}.',
  'player.restricted.ref': 'Reference {code}',

  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.title': 'Report a player',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.titleNamed': 'Report {name}',
  'player.report.intro': 'Tell us why and a moderator will look at it.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.legend': 'What happened?',
  'player.report.titleOneTap': 'Report this message?',
  'player.report.titleOneTapNamed': 'Report {name}?',
  'player.report.titleOneTapPlayer': 'Report this player?',
  'player.report.titleSent': 'Report sent',
  'player.report.titleRefused': "Couldn't send the report",
  'player.report.oneTap.intro': 'We will pass it to the moderators. You do not need to say why.',
  'player.report.oneTap.send': 'Report',
  'player.report.quote': '“{line}”',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.skip': 'Skip and report',
  'player.report.needReason': 'Choose a reason.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.needReasonOrSkip': 'Choose what happened, or skip.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.addReason': 'Add a reason',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.addReasonHint': 'This helps, but the moderators decide what it really is. You can add this for a few minutes after you report.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.legend': 'What was it about?',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.send': 'Add to my report',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.need': 'Choose a reason or write a note.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.added': 'Added. Thanks.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.failed': 'We could not add that.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.refused.off': 'Adding to a report is not available right now.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.refused.not_found': 'We cannot find that report any more.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.refused.not_reporter': 'Only the player who sent a report can add to it.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.refused.too_late': 'It is too late to add to this report. We still have the report.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.refused.already_added': 'You already added to this report.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.detail.refused.reason_unknown': 'That reason is not available any more. Your report is still with us.',
  'player.report.note': 'Note (optional)',
  'player.report.addNote': 'Add a note',
  'player.report.why': 'Why? (optional)',
  'player.report.whyRequired': 'Why?',
  'player.report.choose': 'Choose a reason (optional)',
  'player.report.chooseRequired': 'Choose a reason',
  'player.report.noteHint': 'A moderator will read this. Up to {max} characters. Do not include passwords or personal details.',
  /** @deprecated unused since 0.1.3; removed in a later minor */
  'player.report.send': 'Send report',
  'player.report.cancel': 'Cancel',
  'player.report.close': 'Close',
  'player.report.failed': 'Your report was not sent.',
  'player.report.thanks': 'Thanks. We got your report.',
  'player.report.remaining.zero': 'You have no more reports left today.',
  'player.report.remaining.one': 'You can send {count} more report today.',
  'player.report.remaining.other': 'You can send {count} more reports today.',
  'player.report.refused.duplicate': 'You already reported this player here. We have your report.',
  'player.report.refused.rate': 'You have sent as many reports as you can today. You can send more tomorrow.',
  'player.report.refused.self': 'You cannot report yourself.',
  'player.report.refused.not_player': 'We cannot find that player any more. They may have left.',
  'player.report.refused.off': 'Reports are not available right now. Try again later.',
  'player.report.refused.suspended': 'You cannot send reports from this account for now.',
  'player.report.refused.reason_required': 'This report needs a reason. Close this and report again to choose one.',
  'player.report.refused.reason_unknown': 'That reason is not available any more. Close this and report again.',
  'player.report.refused.unknown': 'We could not take that report.',
} as const;

/** A catalog: keys to English (or translated) text. Any object of strings will do. */
export type PlayerCatalog = Readonly<Record<string, string>>;

type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type BaseKey<K extends string> = K extends `${infer B}.${PluralForm}` ? B : K;

/** Every key a component may ask for: the English catalog's keys with the plural suffix taken off. */
export type PlayerText = BaseKey<keyof typeof en | keyof typeof enChat>;

export type PlayerParams = Readonly<Record<string, string | number>>;

/** The `t` the components take: a key and optional values, always a string back. */
export type PlayerT = (key: PlayerText, params?: PlayerParams) => string;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Builds the `t` function for a catalog and a locale.
 * - `{name}` is replaced by `params.name`; a name with no value stays as written; a value is never expanded again.
 * - Numbers are formatted for the locale (`1,234`).
 * - With a numeric `count`, the plural form for the locale is used (`key.one`, `key.other`, ...), `key.zero` for 0 if it
 *   exists, and `key.other` when the locale's form is missing.
 * - A key with no text comes back as the key itself, so a gap in a translation is visible instead of blank.
 */
export function createT(catalog: PlayerCatalog, locale = 'en'): PlayerT {
  let numbers: Intl.NumberFormat;
  let plurals: Intl.PluralRules;
  try {
    numbers = new Intl.NumberFormat(locale);
    plurals = new Intl.PluralRules(locale);
  } catch {
    numbers = new Intl.NumberFormat('en');
    plurals = new Intl.PluralRules('en');
  }
  const has = (key: string): boolean => Object.hasOwn(catalog, key);

  return (key, params) => {
    let template: string | undefined;
    const count = params?.count;
    if (isCount(count)) {
      const form = count === 0 && has(`${key}.zero`) ? 'zero' : plurals.select(count);
      for (const candidate of [`${key}.${form}`, `${key}.other`]) {
        if (has(candidate)) {
          template = catalog[candidate];
          break;
        }
      }
    }
    template ??= has(key) ? catalog[key] : undefined;
    if (template === undefined) return key;
    if (params === undefined) return template;
    return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
      if (!Object.hasOwn(params, name)) return whole;
      const value = params[name];
      return typeof value === 'number' ? numbers.format(value) : String(value);
    });
  };
}
