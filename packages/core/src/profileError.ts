// Kept apart from profile.ts so pace.ts (which profile.ts imports) can throw it without an import cycle.

/** A profile that fails validation. `path` names the field (`'profile.firstOffense.banter'`); the message never echoes a value. */
export class ProfileError extends Error {
  readonly path: string;
  /** The rule that was broken, without the path. Never a value. */
  readonly reason: string;
  /** A stable code for the few failures a caller tells apart (a signal feed's `unknown_kind`, `positive_kind` or `window`); undefined for the rest. */
  readonly code: string | undefined;
  constructor(path: string, reason: string, code?: string) {
    super(`${path} ${reason}`);
    this.name = 'ProfileError';
    this.path = path;
    this.reason = reason;
    this.code = code;
  }
}
