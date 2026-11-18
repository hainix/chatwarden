/** A trusted public key: the id the signature file names, and the raw 32-byte Ed25519 key as base64url. */
export interface CorpusKey {
  id: string;
  publicKey: string;
}

/**
 * The keys this kit trusts to sign a release: the active key and the standby. Empty until the maintainer adds the public halves in
 * the release step; with none, every verification answers `no_trusted_keys` and nothing is loaded.
 */
export const CORPUS_KEYS: readonly CorpusKey[] = Object.freeze([] as CorpusKey[]);

/** Key ids this kit refuses whatever an index says (a key that has leaked is moved here in a kit patch). */
export const CORPUS_REVOKED_KEY_IDS: readonly string[] = Object.freeze([] as string[]);

/** Where the signed releases are served from. */
export const CORPUS_BASE_URL = 'https://releases.chatwarden.dev/v1';

/**
 * The password on a release zip. It is public, printed in the docs: it keeps scanners and indexers from reading raw words, it is
 * not a secret.
 */
export const CORPUS_ZIP_PASSWORD = 'chatwarden-terms';
