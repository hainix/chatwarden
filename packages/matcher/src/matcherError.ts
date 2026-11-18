/** Thrown for a malformed active term or exception row; the message names the row id. */
export class MatcherBuildError extends Error {
  /** `rowId` lets a caller log which row failed without logging the message, which may quote the term. */
  readonly rowId?: string;
  /** A short fixed description of what is wrong. Unlike the message it never quotes the term, so it is safe to
   *  log or show next to a row id. */
  readonly reason?: string;
  // No parameter property: erasableSyntaxOnly forbids it.
  constructor(message: string, rowId?: string, reason?: string) {
    super(message);
    this.name = 'MatcherBuildError';
    this.rowId = rowId;
    this.reason = reason;
  }
}
