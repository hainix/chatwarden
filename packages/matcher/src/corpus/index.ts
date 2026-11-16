// @chatwarden/matcher/corpus: the signed, verified shared term list. Isomorphic: WebCrypto and an injected fetch only, no node: import.
// Everything here is @experimental until 0.2. The matcher's root entry imports nothing from this folder.

export { CorpusError, type CorpusErrorCode, type CorpusStage } from './errors.js';
export { CORPUS_BASE_URL, CORPUS_KEYS, CORPUS_REVOKED_KEY_IDS, CORPUS_ZIP_PASSWORD, type CorpusKey } from './keys.js';
export { signedMessage, verifySignature } from './sign.js';
export { ZIP_LIMITS, readZip, type ZipLimits } from './zip.js';
export {
  chooseRelease,
  parseIndex,
  revokedKeyIdsOf,
  type ChooseOptions,
  type CorpusIndex,
  type CorpusKind,
  type CorpusLanguageCounts,
  type CorpusMirror,
  type CorpusReleaseEntry,
  type CorpusRevokedRelease,
  type CorpusRevokeReason,
} from './index-file.js';
