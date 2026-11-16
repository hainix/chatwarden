// @chatwarden/matcher/corpus: the signed, verified shared term list. Isomorphic: WebCrypto and an injected fetch only, no node: import.
// Everything here is @experimental until 0.2. The matcher's root entry imports nothing from this folder.

export { CorpusError, type CorpusErrorCode, type CorpusStage } from './errors.js';
export { CORPUS_BASE_URL, CORPUS_KEYS, CORPUS_REVOKED_KEY_IDS, CORPUS_ZIP_PASSWORD, type CorpusKey } from './keys.js';
export { signedMessage, verifySignature } from './sign.js';
export { ZIP_LIMITS, readZip, type ZipLimits } from './zip.js';
export {
  parseTermsRelease,
  type ExceptionRow6,
  type NegativeFile,
  type ReleaseManifest,
  type TermRow6,
  type TermsRelease,
} from './release.js';
export { releaseToPack, type PackSelection } from './select.js';
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
export {
  createCorpusLoader,
  type CorpusCache,
  type CorpusLoader,
  type CorpusLoaderOptions,
  type CorpusState,
  type CorpusStatus,
  type RefreshResult,
  type Schedule,
} from './loader.js';
export {
  COMMUNITY_ENDPOINT,
  checkStamp,
  createCommunityShare,
  mintStamp,
  type CommunityShare,
  type CommunityShareOptions,
  type ShareInput,
  type ShareResult,
} from './share.js';
