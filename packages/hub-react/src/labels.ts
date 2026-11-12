import type { HubError } from './client.js';
import { DURATIONS, hasLength, outcomeChoice } from './decision.js';
import type { Choice, DurationKey } from './decision.js';
import { actorName } from './claims.js';
import { formatDuration, longDuration, personTag } from './format.js';
import type { HubT, HubText } from './i18n.js';
import type { ReportCategory, SanctionGroupView, SanctionKind, SanctionSource, Suggestion } from './types.js';

// Words for the kit's fixed vocabularies. One table per vocabulary, typed against the catalog, so a new category or kind in the
// kit is a compile error here until it has a word.

const CATEGORY: Record<ReportCategory, HubText> = {
  harassment: 'hub.category.harassment',
  hate: 'hub.category.hate',
  cheating: 'hub.category.cheating',
  spam: 'hub.category.spam',
  disruption: 'hub.category.disruption',
  other: 'hub.category.misc',
};

const KIND: Record<SanctionKind, HubText> = {
  chat: 'hub.sanction.kind.chat',
  area: 'hub.sanction.kind.area',
  ban: 'hub.sanction.kind.ban',
  warning: 'hub.sanction.kind.warning',
  note: 'hub.sanction.kind.note',
};

const SOURCE: Record<SanctionSource, HubText> = {
  moderator: 'hub.source.moderator',
  auto_filter: 'hub.source.auto_filter',
  coop: 'hub.source.coop',
  api: 'hub.source.api',
  ai: 'hub.source.ai',
};

/** Every report category, in the order the catalog lists them. */
export const CATEGORY_LIST = Object.keys(CATEGORY) as ReportCategory[];

export const categoryLabel = (t: HubT, category: ReportCategory): string => t(CATEGORY[category]);
/** What the reporter said a report was for, as a chip: the reason's name now, or "No reason given". */
export const reasonChip = (t: HubT, label: string | null): string => (label === null ? t('hub.reason.none') : label);
/** The same with its lead-in: "Reported as Hate", or "No reason given". */
export const reasonSaid = (t: HubT, label: string | null): string => (label === null ? t('hub.reason.none') : t('hub.reason.reportedAs', { reason: label }));
export const kindLabel = (t: HubT, kind: SanctionKind): string => t(KIND[kind]);
export const sourceLabel = (t: HubT, source: SanctionSource): string => t(SOURCE[source]);

/** How long a sanction lasts, as text: `permanent`, `24h`, `7d`; empty for a warning or note, which have no length. */
export function sanctionLength(t: HubT, locale: string, s: Pick<SanctionGroupView, 'kind' | 'startsAt' | 'endsAt'>): string {
  if (s.kind === 'warning' || s.kind === 'note') return '';
  if (s.endsAt === null) return t('hub.sanction.permanent');
  return formatDuration(s.endsAt - s.startsAt, locale);
}

/** The rule a sanction was filed under: `Rule 3`, `No rule fits yet`, or `No rule` for a row written before rules existed. */
export function ruleLabel(t: HubT, rule: number | 'uncovered' | null): string {
  if (rule === null) return t('hub.sanction.ruleNone');
  if (rule === 'uncovered') return t('hub.sanction.ruleUncovered');
  return t('hub.sanction.rule', { rule });
}

export type SanctionState = 'revoked' | 'pending' | 'active' | 'ended';

/** Where a sanction stands: revoked wins, then "not enforced yet", then running, then over. */
export function sanctionState(s: Pick<SanctionGroupView, 'revokedAt' | 'pending' | 'active'>): SanctionState {
  if (s.revokedAt !== null) return 'revoked';
  if (s.pending) return 'pending';
  return s.active ? 'active' : 'ended';
}

/** A failure as one plain sentence. The server's own message is not echoed: words come from the catalog. */
export function errorText(t: HubT, error: HubError): string {
  if (error.code === 'network') return t('hub.error.network');
  if (error.status === 401) return t('hub.error.unauthorized');
  if (error.status === 403) return t('hub.error.forbidden');
  if (error.status === 404) return t('hub.error.notFound');
  if (error.status === 429) {
    return error.retryAfter === undefined ? t('hub.error.rateLimited') : t('hub.error.rateLimited.after', { count: error.retryAfter });
  }
  if (error.status >= 500) return t('hub.error.server');
  return t('hub.error.generic');
}

const LENGTH_WORD = {
  '1h': 'hub.decide.choice.length.hour',
  '24h': 'hub.decide.choice.length.day',
  '7d': 'hub.decide.choice.length.week',
  '30d': 'hub.decide.choice.length.month',
  permanent: 'hub.decide.choice.length.permanent',
} as const satisfies Record<DurationKey, HubText>;

/** A length as a phrase: `24 hours`, `6 hours`, `3 days`, `permanent`. */
export function lengthPhrase(t: HubT, locale: string, durationMs: number | null): string {
  const known = DURATIONS.find((d) => d.ms === durationMs);
  return known === undefined ? longDuration(durationMs ?? 0, locale) : t(LENGTH_WORD[known.key]);
}

/** What an action does, in words: `Warning`, `Note`, `Chat restriction, 24 hours`, `Ban, permanent`. */
export function choiceLabel(t: HubT, locale: string, choice: Choice): string {
  if (!hasLength(choice.kind)) return kindLabel(t, choice.kind);
  return t('hub.decide.choice.timed', { kind: kindLabel(t, choice.kind), length: lengthPhrase(t, locale, choice.durationMs) });
}

/** The ladder's suggested outcome, in words. */
export function outcomeLabel(t: HubT, locale: string, outcome: Suggestion['outcome']): string {
  const choice = outcomeChoice(outcome);
  return choice === null ? t('hub.decide.suggest.none') : choiceLabel(t, locale, choice);
}

/**
 * Why a decision did not go through, as one sentence from the catalog (the server's own words are never shown). A refused
 * body gets the most specific line its code allows.
 *
 * One sentence per code, on purpose: a 400 from `POST /reports/:id/decide` names no field (only `invalid_request`,
 * `invalid_sanction` or `invalid_excerpt`), so there is nothing true to mark on a field. The form checks the same rules before it
 * sends (`decision.ts`, held to the server's by the oracle test), so a field-level message is given there, and a 400 that still
 * gets through (a rule retired meanwhile, say) is shown with its input kept.
 */
export function decideErrorText(t: HubT, error: HubError): string {
  if (error.code === 'claimed') {
    return error.heldBy === undefined ? t('hub.decide.fail.claimedUnknown') : t('hub.decide.fail.claimed', { name: actorName(error.heldBy) });
  }
  if (error.status === 413) return t('hub.decide.fail.tooLarge');
  if (error.status === 400) {
    if (error.code === 'duration_not_offered') return t('hub.error.durationNotOffered');
    if (error.code === 'invalid_excerpt') return t('hub.decide.fail.excerpt');
    if (error.code === 'invalid_sanction') return t('hub.decide.fail.sanction');
    return t('hub.decide.fail.invalid');
  }
  return errorText(t, error);
}

/** Why a term change did not go through. A flat 400 `invalid_term` names no field and no reason, so one sentence says what it may be. */
export function termErrorText(t: HubT, error: HubError): string {
  if (error.status === 400) return error.code === 'invalid_term' ? t('hub.terms.refused') : t('hub.terms.form.fail.invalid');
  return errorText(t, error);
}

/**
 * A handle as text, and the only way one becomes text (names, design 5.5). A handle the server flags (`names.maskInHub`) is the same "hidden" label a blocked line
 * has until a moderator shows it; a handle that is not flagged, or from a server that flags nothing, is as typed. No handle is the empty string: a caller that
 * must say something else (the tag) says it. The label holds no part of the name, not even its length.
 * @experimental
 */
export function displayName(t: HubT, name: { handle: string | null; flagged?: boolean | undefined; revealed?: boolean | undefined }): string {
  if (name.handle === null) return '';
  return name.flagged === true && name.revealed !== true ? t('hub.mask.label') : name.handle;
}

/** How a reported person is named in a queue or a toast: their handle (hidden when flagged), or "Person" and the short tag. */
export function groupName(t: HubT, g: { handle: string | null; person: string; handleFlagged?: boolean | undefined }, revealed = false): string {
  return g.handle === null ? t('hub.person.unnamed', { tag: personTag(g.person) }) : displayName(t, { handle: g.handle, flagged: g.handleFlagged, revealed });
}
