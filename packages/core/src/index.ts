export const VERSION = '0.0.0';

export type {
  Clock,
  Hasher,
  Identifiers,
  Logger,
  Matcher,
  MuteRow,
  RawWho,
  ReportActivity,
  ReportCategory,
  ReportExcerptLine,
  SanctionKind,
  SanctionRow,
  SanctionTargetType,
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
  SANCTION_KINDS,
  SANCTION_SOURCES,
  SanctionIndex,
} from './sanctions.js';
export type { ActiveSanction, SanctionInput } from './sanctions.js';
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
