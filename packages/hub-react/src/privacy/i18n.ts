import { useCallback, useMemo } from 'react';
import { useHub } from '../context.js';
import { createT } from '../i18n.js';
import type { HubParams, HubText } from '../i18n.js';

// The words of the privacy and legal-hold parts (the Person page's "Data requests", the Erase dialog, Settings > Advanced > Privacy requests, and the case's Legal hold).
// They live apart from the hub's catalog on purpose, like the AI's: every part that uses them is loaded when first needed, and a catalog that rode in the first load
// would be paid for by every moderator, owner or not. The hub's own `t` is asked first, so an adopter who supplies these keys (their own words, or a translation) is
// used; only a key it does not know falls back to the English here. `loadPrivacyWords()` hands an adopter this catalog to spread.
//
// Plain words, no legal claims: these screens describe what the kit stores and does. Nothing here says a request is valid or that a law is met.

export const privacyEn = {
  'hub.privacy.menu': 'Data requests',
  'hub.privacy.menu.hint': 'For a request from this person about their data. Only the owner sees this.',
  'hub.privacy.export.item': 'Export data...',
  'hub.privacy.export.done': 'The export was downloaded.',
  'hub.privacy.export.failed': 'Could not export. Nothing was downloaded.',
  'hub.privacy.erase.item': 'Erase data...',

  'hub.privacy.erase.title': 'Erase the data about this person',
  'hub.privacy.erase.lead': 'This removes what the kit holds about this person. It cannot be undone. It is not legal advice, and the kit does not tell the player.',
  'hub.privacy.erase.keep': 'What to keep',
  'hub.privacy.erase.keep.safety': 'Keep what is needed to enforce a ban or hold a report',
  'hub.privacy.erase.keep.safety.hint': 'A ban that applies now stays enforceable until retention removes it, then the rest is erased on its own. Held reports stay whole.',
  'hub.privacy.erase.keep.none': 'Keep only held reports',
  'hub.privacy.erase.keep.none.warn': 'A ban this person is under will stop applying. Their accounts, keys and addresses are removed at once.',
  'hub.privacy.erase.preview': 'What would happen',
  'hub.privacy.erase.preview.loading': 'Counting what would be removed.',
  'hub.privacy.erase.preview.none': 'Nothing would be removed.',
  'hub.privacy.erase.preview.failed': 'Could not count what would be removed.',
  'hub.privacy.erase.removed': 'Removed',
  'hub.privacy.erase.kept': 'Kept',
  'hub.privacy.erase.kept.identifiers': 'The account, key and address rows stay while a ban applies, and are removed after it.',
  'hub.privacy.erase.kept.sanctions': 'Sanction rows kept: {count}',
  'hub.privacy.erase.kept.held': 'Reports held for legal reasons, kept whole: {count}',
  'hub.privacy.erase.kept.nothing': 'Nothing is kept.',
  'hub.privacy.erase.cat.subjects': 'The person (their id)',
  'hub.privacy.erase.cat.identifiers': 'Accounts, keys and addresses',
  'hub.privacy.erase.cat.sanctions': 'Sanction rows',
  'hub.privacy.erase.cat.notices': 'Notices',
  'hub.privacy.erase.cat.reports_filed': 'Reports they filed (their name removed, the report stays)',
  'hub.privacy.erase.cat.reports_about': 'Reports about them',
  'hub.privacy.erase.cat.report_lines': 'Their lines in other players\' reports',
  'hub.privacy.erase.cat.strikes': 'Blocked lines',
  'hub.privacy.erase.cat.mutes': 'Mutes',
  'hub.privacy.erase.cat.blocked_names': 'Blocked names',
  'hub.privacy.erase.cat.appeals': 'Appeals',
  'hub.privacy.erase.cat.signals': 'Signals',
  'hub.privacy.erase.cat.ai': 'AI reads, marks and outcomes',
  'hub.privacy.erase.cat.workflow': 'Case claims and links',
  'hub.privacy.erase.cat.pace': 'Chat pacing state',
  'hub.privacy.erase.cat.audit': 'Audit entries now pointing at the receipt',
  'hub.privacy.erase.cat.holds': 'Holds',
  'hub.privacy.erase.word': 'Type ERASE to confirm',
  'hub.privacy.erase.cancel': 'Cancel',
  'hub.privacy.erase.go': 'Erase data',
  'hub.privacy.erase.failed': 'Could not erase. The choice is kept so you can try again.',

  'hub.privacy.receipt.title': 'Erased',
  'hub.privacy.receipt.lead': 'This receipt holds counts and words only: no name, line or account. You can send it to the person who asked.',
  'hub.privacy.receipt.id': 'Receipt',
  'hub.privacy.receipt.download': 'Download receipt (JSON)',
  'hub.privacy.receipt.done': 'Done',
  'hub.privacy.receipt.auditFailed': 'The data is erased, but the audit entry could not be written.',

  'hub.privacy.settings.title': 'Privacy requests',
  'hub.privacy.settings.intro': 'Find a person by the account id the game gave you, then export or erase their data from their page. You check who is asking first: the kit cannot.',
  'hub.privacy.find.label': 'Account id',
  'hub.privacy.find.go': 'Find person',
  'hub.privacy.find.none': 'No person has this account id. Nothing was created.',
  'hub.privacy.find.failed': 'Could not look up the account id.',
  'hub.privacy.statement.title': 'What the kit keeps',
  'hub.privacy.statement.col.what': 'What',
  'hub.privacy.statement.col.export': 'In an export',
  'hub.privacy.statement.col.safety': 'Erase, keeping what a ban needs',
  'hub.privacy.statement.col.none': 'Erase, keeping nothing',
  'hub.privacy.statement.col.kept': 'Kept for',
  'hub.privacy.statement.days': '{count} days',
  'hub.privacy.statement.until': 'Until removed',
  'hub.privacy.statement.welfare': '{count} days for reports of someone who may be at risk',
  'hub.privacy.statement.note': 'This describes what the kit stores. It is not legal advice and makes no claim that any law is met.',
  'hub.privacy.statement.cat.subjects': 'Person',
  'hub.privacy.statement.cat.identifiers': 'Accounts, keys, addresses',
  'hub.privacy.statement.cat.sanctions': 'Sanctions',
  'hub.privacy.statement.cat.notices': 'Notices',
  'hub.privacy.statement.cat.reports_filed': 'Reports they filed',
  'hub.privacy.statement.cat.reports_about': 'Reports about them',
  'hub.privacy.statement.cat.report_lines': 'Their lines in other reports',
  'hub.privacy.statement.cat.strikes': 'Blocked lines',
  'hub.privacy.statement.cat.mutes': 'Mutes',
  'hub.privacy.statement.cat.blocked_names': 'Blocked names',
  'hub.privacy.statement.cat.appeals': 'Appeals',
  'hub.privacy.statement.cat.signals': 'Signals',
  'hub.privacy.statement.cat.ai': 'AI reads and marks',
  'hub.privacy.statement.cat.workflow': 'Case claims and links',
  'hub.privacy.statement.cat.audit': 'Audit trail',
  'hub.privacy.statement.cat.holds': 'Legal holds',

  'hub.legal.menu': 'Legal hold',
  'hub.legal.hold.item': 'Hold for legal...',
  'hub.legal.release.item': 'Release hold...',
  'hub.legal.held': 'Held for legal reasons: {reason}.',
  'hub.legal.hold.title': 'Hold this report',
  'hub.legal.hold.lead': 'A held report, its decisions, its sanctions and the lines in it are kept past retention and cannot be erased until the hold is released. This is not a legal conclusion.',
  'hub.legal.hold.reason': 'Reason',
  'hub.legal.hold.go': 'Hold report',
  'hub.legal.hold.done': 'The report is held.',
  'hub.legal.hold.already': 'This report is already held.',
  'hub.legal.hold.failed': 'Could not hold the report.',
  'hub.legal.code.law_enforcement_request': 'A law enforcement request',
  'hub.legal.code.legal_proceeding': 'A legal proceeding',
  'hub.legal.code.platform_request': 'A request from the platform',
  'hub.legal.code.safety_review': 'A safety review',
  'hub.legal.code.else': 'Another reason',
  'hub.legal.release.title': 'Release the hold',
  'hub.legal.release.lead': 'Retention and erase reach this report again. If it is past its clock, the next retention pass removes it.',
  'hub.legal.release.go': 'Release hold',
  'hub.legal.release.done': 'The hold was released.',
  'hub.legal.release.failed': 'Could not release the hold.',
  'hub.legal.cancel': 'Cancel',
} as const;

type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type BaseKey<K extends string> = K extends `${infer B}.${PluralForm}` ? B : K;

/** Every key the privacy and legal-hold parts may ask for, with the plural suffix taken off. */
export type PrivacyText = BaseKey<keyof typeof privacyEn>;

/** The `t` of the privacy and legal-hold parts: the hub's words first, then the English here. */
export type PrivacyT = (key: PrivacyText | HubText, params?: HubParams) => string;

/**
 * The words of the privacy and legal-hold parts. The hub's `t` is asked first (an adopter's own words or translation win); a key it has no text for comes back as the
 * key itself, and only then the English of {@link privacyEn} is used.
 */
export function usePrivacyT(): PrivacyT {
  const { t, locale } = useHub();
  const own = useMemo(() => createT(privacyEn, locale), [locale]);
  return useCallback<PrivacyT>(
    (key, params) => {
      const said = t(key as HubText, params);
      return said === key ? own(key as HubText, params) : said;
    },
    [t, own],
  );
}
