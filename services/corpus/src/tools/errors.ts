// The maintainers' tools fail with a closed code and a fixed message. A message never holds a passphrase, a key, a path, a word, a line or a
// token: what could be one is not part of any message (the tools print the code and the fixed sentence, and that is all).

export type ToolErrorCode =
  | 'usage'
  | 'bad_key'
  | 'no_key'
  | 'no_passphrase'
  | 'weak_passphrase'
  | 'passphrase_mismatch'
  | 'in_git_tree'
  | 'exists'
  | 'bad_file'
  | 'bad_kind'
  | 'bad_id'
  | 'bad_input'
  | 'bad_signature'
  | 'sequence'
  | 'version_exists'
  | 'bad_index'
  | 'upload_failed'
  | 'verify_failed'
  | 'rolled_back'
  | 'network'
  | 'zenodo'
  | 'no_token'
  | 'unknown';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}
