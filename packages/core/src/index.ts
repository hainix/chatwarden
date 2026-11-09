export const VERSION = '0.0.0';

export type {
  Clock,
  Hasher,
  Identifiers,
  Logger,
  Platform,
  Matcher,
  MuteRow,
  NoticeKind,
  NoticeRow,
  RawWho,
  ReportActivity,
  DecisionRow,
  ReportCategory,
  ReportExcerptLine,
  ReportRecord,
  SanctionKind,
  SanctionRow,
  SanctionTargetType,
  Severity,
  Source,
  Store,
  SubjectId,
  SubjectIdKind,
  SubjectIdRecord,
  StoredReport,
  StrikeRow,
  SubjectRecord,
} from './types.js';
export { hashWho, makeHasher } from './hasher.js';
export { maskSpans, type MaskSpan } from './mask.js';
export { SubjectIndex } from './subjects.js';
export {
  EVIDENCE_MAX_AGE_MS,
  EVIDENCE_MAX_LINES,
  EvidenceBuffer,
  RoomRoster,
} from './evidence.js';
export type { EvidenceBufferOptions, EvidenceLine } from './evidence.js';
export {
  applySanction,
  refCode,
  revokeSanction,
  GAP_NOTE_MAX,
  SANCTION_KINDS,
  SanctionError,
  SANCTION_SOURCES,
  SanctionIndex,
} from './sanctions.js';
export type { ActiveSanction, SanctionInput, WrittenSanction } from './sanctions.js';
export { MAX_MUTES_PER_VIEWER, MUTE_TTL_MS, MuteService } from './mutes.js';
export {
  REPEAT_LOOKBACK_MS,
  REPEAT_RESTRICT_MS,
  STRIKE_FIRST_RESTRICT_MS,
  STRIKE_WINDOW_MS,
  STRIKES_TO_RESTRICT,
  StrikeService,
} from './strikes.js';
export type { StrikeDecision } from './strikes.js';
export { slidingWindow } from './rateLimit.js';
export type { SlidingWindow } from './rateLimit.js';
export { ChatService } from './chat.js';
export type { ChatResult, ChatServiceDeps, Starrer } from './chat.js';
export {
  REPORT_CATEGORIES,
  REPORT_NOTE_MAX,
  REPORTS_PER_DAY,
  ReportService,
  SUSPEND_AFTER,
  SUSPEND_WINDOW_MS,
} from './reports.js';
export type { ReportCounts, ReportInput, ReportRefusal, ReportResult, ReportServiceDeps } from './reports.js';
export { DoorService } from './doors.js';
export type { DoorKind, DoorRefusal, DoorServiceDeps } from './doors.js';
export { purge, RETENTION_DEFAULTS } from './retention.js';
export type { PurgeResult, RetentionPolicy } from './retention.js';
export {
  ExcerptError,
  NOTICE_EXCERPT_MAX,
  NOTICE_RECORD_WINDOW_MS,
  NoticeService,
  ownLines,
} from './notices.js';
export type {
  ExcerptErrorCode,
  NoticeCreateOptions,
  NoticeServiceDeps,
  PlayerNotice,
  SanctionNoticeInput,
} from './notices.js';
export { createChatwarden } from './chatwarden.js';
export type { Chatwarden, ChatwardenOptions } from './chatwarden.js';
export {
  CATEGORY_TO_RULE,
  CommunityRules,
  defineRules,
  parseRuleRef,
  rulesPolicyText,
  RulesError,
  STARTER_RULES,
} from './rules.js';
export type { CommunityRule, RuleRef } from './rules.js';
export {
  actionStep,
  HISTORY_LOOKBACK_MS,
  historyOf,
  LADDER_TABLE,
  recordStep,
  suggestAction,
} from './ladder.js';
export type { ActionRecord, LadderCell, LadderRow, LadderStep } from './ladder.js';
export { DECISION_REASON_MAX, DecisionService, decisionKey, revokeAndWithdraw } from './decide.js';
export type {
  DecisionAction,
  DecisionGroup,
  DecisionInput,
  DecisionResult,
  DecisionServiceDeps,
  RevokeDeps,
} from './decide.js';
