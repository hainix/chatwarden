export const VERSION = '0.1.8';

export { NoticeQueue } from './NoticeQueue.js';
export type { NoticeQueueProps } from './NoticeQueue.js';
export { MyRecord } from './MyRecord.js';
export type { MyRecordProps } from './MyRecord.js';
export { RulesPage } from './RulesPage.js';
export type { RulesPageProps } from './RulesPage.js';
export { ReportDialog } from './ReportDialog.js';
export type { ReportFollowUp, ReportDialogProps, ReportDraft } from './ReportDialog.js';
export { RestrictedChatLine } from './RestrictedChatLine.js';
export type { RestrictedChatLineProps } from './RestrictedChatLine.js';

export { createPlayerClient, PlayerError, toPlayerError } from './client.js';
export type { PlayerClient, PlayerClientOptions, PlayerRule, PlayerRules } from './client.js';
export { fetchTransport, routerTransport } from './transport.js';
export type {
  FetchTransportOptions,
  RouterRequest,
  RouterResponse,
  RouterTransportOptions,
  Transport,
  TransportRequest,
  TransportResponse,
} from './transport.js';

export { createT, en } from './i18n.js';
export type { PlayerCatalog, PlayerParams, PlayerT, PlayerText } from './i18n.js';
export type { PlayerUiProps } from './ui.js';
export { dayText, secondsLeft, timeLeft, untilText } from './format.js';

export type { NoticeKind, PlayerNotice, PlayerReporting, ReportDetailResult, ReportFlow, ReportRefusal, ReportResult } from '@chatwarden/core';
