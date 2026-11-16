/** Where in a refresh a failure happened. Logged with the code, never with the content that failed. */
export type CorpusStage = 'index' | 'download' | 'verify' | 'unpack' | 'validate' | 'cache';

/** Why a refresh or a verification stopped. A closed list: a caller can switch on it, and a log line carries it instead of any text. */
export type CorpusErrorCode =
  | 'no_trusted_keys'
  | 'offline'
  | 'timeout'
  | 'too_large'
  | 'bad_index'
  | 'unknown_key'
  | 'revoked_key'
  | 'bad_signature'
  | 'rollback'
  | 'index_expired'
  | 'no_such_version'
  | 'revoked_release'
  | 'kit_too_old'
  | 'hash_mismatch'
  | 'bad_zip'
  | 'bad_manifest'
  | 'bad_pack'
  | 'cache_failed';

// One fixed sentence per code. Nothing from the input is ever put into a message: the input is a download, a cached file or a
// term list, and an error is logged and shown, so it must not be able to carry any of that.
const MESSAGES: Readonly<Record<CorpusErrorCode, string>> = {
  no_trusted_keys: 'corpus: this kit has no trusted keys, so no release can be verified',
  offline: 'corpus: the release server could not be reached',
  timeout: 'corpus: the release server did not answer in time',
  too_large: 'corpus: a download was larger than the limit',
  bad_index: 'corpus: the index is not valid',
  unknown_key: 'corpus: the signing key is not one this kit trusts',
  revoked_key: 'corpus: the signing key has been revoked',
  bad_signature: 'corpus: the signature does not verify',
  rollback: 'corpus: the index is older than one already accepted',
  index_expired: 'corpus: the index has expired',
  no_such_version: 'corpus: the requested release is not on the index',
  revoked_release: 'corpus: the release has been revoked',
  kit_too_old: 'corpus: the release needs a newer kit',
  hash_mismatch: 'corpus: the download does not match the index',
  bad_zip: 'corpus: the archive is not valid',
  bad_manifest: 'corpus: the release manifest is not valid',
  bad_pack: 'corpus: the release does not load as a term list',
  cache_failed: 'corpus: the cache could not be written',
};

/**
 * What the corpus code throws. The message is fixed by `code`; the `stage` says where. It carries no cause, no URL, no path, no
 * key and no content.
 * @experimental
 */
export class CorpusError extends Error {
  readonly code: CorpusErrorCode;
  readonly stage: CorpusStage;
  constructor(code: CorpusErrorCode, stage: CorpusStage) {
    super(MESSAGES[code]);
    this.name = 'CorpusError';
    this.code = code;
    this.stage = stage;
  }
}
