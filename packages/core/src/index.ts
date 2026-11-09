export const VERSION = '0.0.0';

export type {
  Clock,
  Hasher,
  Identifiers,
  Logger,
  RawWho,
  Store,
  SubjectId,
  SubjectIdKind,
  SubjectIdRecord,
  SubjectRecord,
} from './types.js';
export { hashWho, makeHasher } from './hasher.js';
export { SubjectIndex } from './subjects.js';
