import type { HubError } from './client.js';
import { formatDuration } from './format.js';
import type { HubT, HubText } from './i18n.js';
import type { ReportCategory, SanctionGroupView, SanctionKind, SanctionSource } from './types.js';

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

export const categoryLabel = (t: HubT, category: ReportCategory): string => t(CATEGORY[category]);
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
