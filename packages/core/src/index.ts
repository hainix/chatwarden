export const VERSION = '0.1.1';

export type {
  Clock,
  Hasher,
  Identifiers,
  Logger,
  Platform,
  Matcher,
  ProfanityFilter,
  MuteRow,
  NoticeKind,
  NoticeRow,
  RawWho,
  ReportActivity,
  WebhookKeyReservation,
  DecisionRow,
  DiscordThreadRow,
  ReportCategory,
  ReportExcerptLine,
  ReportListQuery,
  ReportRecord,
  SanctionKind,
  SanctionListQuery,
  SanctionRow,
  SanctionTargetType,
  ReporterTally,
  ClaimAttempt,
  ClaimMode,
  ClaimRow,
  OpenReportQuery,
  ReasonRow,
  ConductLevel,
  Source,
  Store,
  SubjectId,
  SubjectIdKind,
  SubjectIdRecord,
  StoredReport,
  StrikeRow,
  SubjectRecord,
} from './types.js';
export { CLAIM_TTL_MS, CONDUCT_LEVELS } from './types.js';
export {
  CaseDesk,
  CLAIM_BUSY_TRIES,
  VIEWING_PER_ACTOR_MAX,
  REASON_LABEL_MAX,
  REASON_TEXT_MAX,
  REASONS_MAX,
  ReasonBook,
  ReasonError,
  ViewingPresence,
  VIEWING_TTL_MS,
} from './team.js';
export type { CaseClaim, ClaimOutcome, NextCase } from './team.js';
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
  MAX_SANCTION_DURATION_MS,
  SANCTION_KINDS,
  SanctionError,
  SANCTION_SOURCES,
  SanctionIndex,
  validateSanctionInput,
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
export type { ChatResult, ChatServiceDeps, RefuseReason, RestrictedAnswer } from './chat.js';
export {
  REPORT_CATEGORIES,
  REPORT_NOTE_MAX,
  REPORTS_PER_DAY,
  ReportService,
  SUSPEND_AFTER,
  SUSPEND_WINDOW_MS,
} from './reports.js';
export type { ReportCounts, ReportInput, ReportRefusal, ReportResult, ReportServiceDeps } from './reports.js';
export {
  decodeReportCursor,
  encodeReportCursor,
  listStaffReports,
  REPORT_PAGE_DEFAULT,
  REPORT_PAGE_MAX,
  ReportQueryError,
  staffReport,
} from './staffReports.js';
export type { ReportPage, ReportQuery, StaffReport } from './staffReports.js';
export {
  BLOCKED_DAYS,
  BLOCKED_MAX,
  PERSON_SANCTIONS_MAX,
  SANCTION_PAGE_DEFAULT,
  SANCTION_PAGE_MAX,
  SanctionQueryError,
  isSanctionActive,
  sanctionGroupView,
} from './staffViews.js';
export type {
  BlockedDays,
  BlockedItem,
  PersonSanctionView,
  ReporterRecord,
  SanctionGroupView,
  SanctionListInput,
  SanctionPage,
} from './staffViews.js';
export {
  AUDIT_ACTIONS,
  AUDIT_PAGE_MAX,
  AUDIT_TARGET_TYPES,
  AuditQueryError,
  isValidAuditActor,
  ROLES,
} from './audit.js';
export type {
  AuditAction,
  AuditItem,
  AuditListQuery,
  AuditPage,
  AuditQuery,
  AuditRecordInput,
  AuditRow,
  AuditTarget,
  AuditTargetType,
  Role,
} from './audit.js';
export { errorClass, safeWarn } from './log.js';
export { DoorService } from './doors.js';
export type { DoorKind, DoorRefusal, DoorServiceDeps } from './doors.js';
export { checkRetentionFloors, purge, RETENTION_DEFAULTS } from './retention.js';
export { WEBHOOK_KEY_TTL_MS } from './types.js';
export type { PurgeResult, RetentionPolicy } from './retention.js';
export {
  ExcerptError,
  NOTICE_EXCERPT_MAX,
  NOTICE_RECORD_WINDOW_MS,
  NoticeService,
  ownLineIdsByPerson,
  ownLines,
} from './notices.js';
export type {
  ExcerptErrorCode,
  NoticeCreateOptions,
  NoticeServiceDeps,
  PlayerNotice,
  SanctionNoticeInput,
} from './notices.js';
export { KIT_EVENT_TYPES } from './events.js';
export type { KitEvent, KitEventOf, KitListener, StaffRef, Subscribe } from './events.js';
export { createChatwarden } from './chatwarden.js';
export type { Chatwarden, ChatwardenOptions, GapRow } from './chatwarden.js';
export {
  CATEGORY_TO_RULE,
  CommunityRules,
  defineRules,
  parseRuleRef,
  rulesPolicyText,
  RulesError,
  STARTER_RULES,
  starterRules,
} from './rules.js';
export type { CommunityRule, RuleRef } from './rules.js';
export { agentBrief, bindDocuments, codeOfConduct, moderatorGuide, policyJson } from './documents.js';
export type {
  CodeOfConductOptions,
  DocumentFormat,
  DocumentPolicy,
  Documents,
  ModeratorGuideOptions,
  PolicyJson,
} from './documents.js';
export { LIMITS_DEFAULTS, resolveLimits } from './limits.js';
export type { Limits, LimitsInput } from './limits.js';
export {
  actionStep,
  DEFAULT_SEVERE_RULES,
  HISTORY_LOOKBACK_MS,
  historyOf,
  LADDER_TABLE,
  lengthLabel,
  outcomeLabel,
  recordStep,
  suggest,
} from './ladder.js';
export type { ActionRecord, LadderCell, LadderRow, LadderStep, Suggestion, SuggestContext } from './ladder.js';
export { DECISION_EVIDENCE_MAX, DECISION_REASON_MAX, DecisionService, decisionKey, revokeAndWithdraw } from './decide.js';
export type {
  DecisionAction,
  DecisionGroup,
  DecisionInput,
  DecisionResult,
  DecisionServiceDeps,
  RevokeDeps,
} from './decide.js';
export {
  defineProfile,
  MAX_DURATION_MS,
  MAX_WINDOW_DAYS,
  PRESETS,
  ProfileError,
  resolveProfile,
  validateProfile,
} from './profile.js';
export type {
  DeepPartial,
  GuidelineCover,
  GuidelineTier,
  LevelDescription,
  ModerationProfile,
  Outcome,
  PresetName,
  ProfanityConfig,
  ProfileOverrides,
  RulesFlavour,
} from './profile.js';
