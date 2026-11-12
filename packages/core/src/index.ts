export const VERSION = '0.1.5';

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
  ReporterDecision,
  ReporterOutcomeRow,
  AiCallUsage,
  AiErrorKind,
  AiExampleRow,
  AiOutcomeDetail,
  AiOutcomeInsert,
  AiOutcomeRow,
  AiReadDone,
  AiReadPending,
  AiReadRow,
  AiReadStatus,
  AiReserveResult,
  AiStatsRow,
  AiVerdict,
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
export { REPORT_DETAIL_WINDOW_MS } from './reports.js';
export type {
  ReportCounts,
  ReportDetailInput,
  ReportDetailRefusal,
  ReportDetailResult,
  ReportInput,
  ReportRefusal,
  ReportResult,
  ReportServiceDeps,
} from './reports.js';
export {
  canonicalReasonId,
  DEFAULT_REPORT_FLOW,
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_THANKS,
  defaultReporting,
  findReason,
  isReasonId,
  legacyCategoryOf,
  LEGACY_REASON_ALIASES,
  MAX_REASON_RULES,
  MAX_REPORT_REASONS,
  OTHER_REASON_ID,
  playerReporting,
  reasonLabel,
  reasonOfCategory,
  REPORT_FLOWS,
  suggestedRule,
} from './reporting.js';
export type {
  PlayerReporting,
  ReportFlow,
  ReportingSettings,
  ReportReason,
  ReportReasonInput,
  ResolvedReporting,
} from './reporting.js';
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
export { BULK_DISMISS_MAX, BULK_REPORTER_SCAN_MAX } from './dismissMany.js';
export type { DismissManyInput, DismissManyResult, DismissScope } from './dismissMany.js';
export {
  RANK_DOWN_SCAN_MAX,
  REPORTER_ACCURACY_BATCH_MAX,
  REPORTER_ACCURACY_MIN_DECIDED,
  REPORTER_ACCURACY_WINDOW_MS,
  REPORTER_FALSE_RATE_HABITUAL,
  REPORTER_FALSE_RATE_NOTICEABLE,
  REPORTER_RANK_LAPSE_MS,
  reporterAccuracyFor,
  summarizeOutcomes,
} from './reporterAccuracy.js';
export type { ReporterAccuracy } from './reporterAccuracy.js';
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
  AUDIT_REASON_MAX,
  AUDIT_TARGET_TYPES,
  AuditQueryError,
  isValidAuditActor,
  ROLES,
} from './audit.js';
export type {
  AuditAction,
  AuditItem,
  AuditDetail,
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
export { GUIDE_SECTIONS, agentBrief, bindDocuments, codeOfConduct, moderatorGuide, policyJson } from './documents.js';
export type {
  CodeOfConductOptions,
  DocumentFormat,
  DocumentPolicy,
  Documents,
  GuideSection,
  ModeratorGuideOptions,
  PolicyJson,
} from './documents.js';
export { LIMITS_DEFAULTS, resolveLimits } from './limits.js';
export type { Limits, LimitsInput } from './limits.js';
export {
  actionStep,
  DEFAULT_AREA_RULES,
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
export {
  DECISION_EVIDENCE_MAX,
  DECISION_REASON_MAX,
  DecisionService,
  NO_ACTION_DEFAULT_REASON,
  decisionKey,
  isDefaultNoActionReason,
  revokeAndWithdraw,
} from './decide.js';
export type {
  DecisionAction,
  DecisionAiEcho,
  DecisionGroup,
  DecisionInput,
  DecisionResult,
  DecisionServiceDeps,
  RevokeDeps,
} from './decide.js';
export {
  applyPolicyLayer,
  changedSections,
  DEFAULT_DURATIONS,
  defineProfile,
  layerSections,
  MAX_DURATION_MS,
  MAX_DURATIONS,
  MAX_GUIDELINE_OUTCOME,
  MAX_RULE_LIST,
  MAX_WINDOW_DAYS,
  AI_DAILY_CALLS_DEFAULT,
  AI_DAILY_CALLS_MAX,
  POLICY_SECTIONS,
  PRESETS,
  ProfileError,
  resolveProfile,
  validateProfile,
} from './profile.js';
export { POLICY_REFRESH_MS, PREVIEW_SAMPLES } from './policy.js';
export type {
  PolicyPreview,
  PolicySaveContext,
  PolicySaveResult,
  PolicyState,
  PreviewOutcome,
  PreviewSample,
} from './policy.js';
export type {
  DeepPartial,
  GuidelineCover,
  GuidelineTier,
  LevelDescription,
  AISettings,
  ModerationProfile,
  ModerationProfileBase,
  Outcome,
  PolicyCell,
  PolicyLadderRow,
  PolicyLayer,
  PolicySection,
  PresetName,
  ProfanityConfig,
  ProfileInput,
  ProfileOverrides,
  ResolvedProfile,
  RulesFlavour,
} from './profile.js';

// AI levels 1 and 2: the provider-free contract (@experimental). Kept apart from the rest so a bundler can drop it.
export { AI_PROMPT_VERSION, AIError } from './ai/types.js';
export type { AbortSignalLike, AIExample, AIExampleInput, AIPerson, AIRead, AIReadInput, AIReadResult, AIStoredRead, AIUsage, ModerationAI } from './ai/types.js';
export { AI_OUTPUT_SCHEMA } from './ai/schema.js';
export { validateAIOutput } from './ai/validate.js';
export type { AIValidation, AIValidationContext } from './ai/validate.js';
export { AI_MAX_KIND, AI_MAX_PREFILL_MS, AICeilingError, assertWithinCeilings, automationAllowed, isAllowedKind } from './ai/ceilings.js';
export { redactNote, redactText } from './ai/redact.js';
export { chooseLines, redactReportNote } from './ai/lines.js';
export type { ChosenLine, ChosenLines } from './ai/lines.js';
export { aiPolicyText, buildAIInput, PROMPT_VERSION, usedExampleIds } from './ai/prompt.js';
export type { BuildAIInputArgs } from './ai/prompt.js';
export { inputHash } from './ai/hash.js';
export { looksLikeInjection } from './ai/injection.js';
export { aiActorOf, AiService, READ_AGAIN_PER_MINUTE, SWEEP_BATCH, SWEEP_EVERY_MS } from './ai/service.js';
export { createInertAi } from './ai/inert.js';
export type {
  AiBrief,
  AiFacade,
  AiOptions,
  AiReadAgain,
  AiReadView,
  AiStatsRuleView,
  AiStatsView,
  AiStatus,
  SuggestionStep,
} from './ai/service.js';
export { createFakeModerationAI, fakeRead, FAKE_USAGE } from './ai/fake.js';
export type { FakeCallContext, FakeModerationAI, FakeScript, FakeStep } from './ai/fake.js';
export { agreementOf, compareSteps } from './ai/agreement.js';
export type { Agreement, HumanDecision, StepLike } from './ai/agreement.js';
export { AI_EXAMPLES_MIN } from './ai/casebook.js';
export type { AiOutcomeArgs, AiOutcomeHook } from './ai/casebook.js';
