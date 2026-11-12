export const VERSION = '0.1.8';

export { Hub } from './Hub.js';
export type { HubProps } from './Hub.js';
export type { HubMode } from './mode.js';

// Embedding: the provider, the pieces and the hooks. All `@experimental` until 0.2 (see the README's list).
export { HubProvider, useHubController } from './provider.js';
export type { HubControllerSource, HubProviderOptions, HubProviderProps } from './provider.js';
export type { PieceLinks, PieceProps } from './pieces/Piece.js';
export { CaseList } from './pieces/CaseList.js';
export type { CaseListProps } from './pieces/CaseList.js';
export { CaseCard } from './pieces/CaseCard.js';
export type { CaseCardProps } from './pieces/CaseCard.js';
export { CaseWorkbench } from './pieces/CaseWorkbench.js';
export type { CaseWorkbenchProps } from './pieces/CaseWorkbench.js';
export { PersonRecord } from './pieces/PersonRecord.js';
export type { PersonRecordProps } from './pieces/PersonRecord.js';
export { TermsManager } from './pieces/TermsManager.js';
export type { TermsManagerProps } from './pieces/TermsManager.js';
export { BlockedList } from './pieces/BlockedList.js';
export type { BlockedListProps } from './pieces/BlockedList.js';
export { AuditLog } from './pieces/AuditLog.js';
export type { AuditLogProps } from './pieces/AuditLog.js';
export { RuleGaps } from './pieces/RuleGaps.js';
export type { RuleGapsProps } from './pieces/RuleGaps.js';
export { Guide } from './pieces/Guide.js';
export type { GuideProps } from './pieces/Guide.js';
export { LadderSettings } from './pieces/LadderSettings.js';
export type { LadderSettingsProps } from './pieces/LadderSettings.js';
export { ReportingSettings } from './pieces/ReportingSettings.js';
export type { ReportingSettingsProps } from './pieces/ReportingSettings.js';
export { RecentActions } from './pieces/RecentActions.js';
export type { RecentActionsProps } from './pieces/RecentActions.js';
export { useBlocked, useCase, useCases, useClaim, useDecide, useMe, usePerson, useTerms } from './embedHooks.js';
export type { HubRead, UseCase, UseCaseOptions, UseCases, UseClaim, UseDecide, UseMe } from './embedHooks.js';
export { usePolicy } from './policyHooks.js';
export type { ResetResult, UsePolicy } from './policyHooks.js';

export { createHubClient, fetchAll, HubError, toHubError } from './client.js';
export type { HubClient } from './client.js';
export { fetchTransport, routerTransport } from './transport.js';
export type { FetchTransportOptions, RouterTransportOptions, Transport, TransportRequest, TransportResponse } from './transport.js';

export { createT, en } from './i18n.js';
export type { HubCatalog, HubParams, HubT, HubText } from './i18n.js';
import type { HubCatalog as AiCatalog } from './i18n.js';

/**
 * The English of the AI's parts (the strip on a case, its menu, the pre-filled decision, Settings > AI). They are loaded when first
 * needed, not with the hub, so they are not in `en`. To translate them, spread this under your own words with `en`:
 * `createT({ ...en, ...(await loadAiWords()), ...de }, 'de')`. A key you leave out reads in English.
 * @experimental
 */
export const loadAiWords = (): Promise<AiCatalog> => import('./ai/i18n.js').then((m) => m.aiEn);

export { buildPath, hashRouter, memoryRouter, normalizePath, parseRoute, tabOf } from './router.js';
export type { HubRouter, MemoryRouter, ObservableRouter, QueueStatus, Route, SettingsSection, TabName } from './router.js';

export { filterGroups, groupQueue, loadAiRank, queueStats } from './queue.js';
export type { QueueFilter, QueueGroup, QueueSort, QueueStats, RankSignals } from './queue.js';

export { actorInitial, actorName, holderOf, liveClaim, teamOf } from './claims.js';
export type { Holder, TeamMember } from './claims.js';

export { UNDO_MS, useToasts } from './toasts.js';
export type { Hold, HoldInput, ToastInput, Toasts } from './toasts.js';

export { shortcutFor } from './shortcuts.js';
export type { ShortcutAction } from './shortcuts.js';

export { useHub } from './context.js';
export type { HubContextValue } from './context.js';
export { useHubAction, useHubData, usePagedList } from './hooks.js';
export type { ActionResult, HubAction, HubData, PagedList } from './hooks.js';

export { absoluteTime, formatDuration, personTag, relativeTime, waitTone } from './format.js';
export { displayName } from './labels.js';

export type * from './types.js';
