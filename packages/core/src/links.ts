// `cw.links` (K5 design 5.1): "this kit id is that outside id", one small table for the outside-system adapters (Coop jobs, EOS sanctions,
// EOS report keys and one polling cursor). Rows are ids and one short state word, never text: no chat line, handle, reason or outside
// account id is written here, and a check pins the value shapes.

/** The systems a link can belong to: a closed list. */
export const LINK_SYSTEMS = ['coop-report', 'eos-sanction', 'eos-report', 'eos-cursor'] as const;
export type LinkSystem = (typeof LINK_SYSTEMS)[number];

/**
 * One link row.
 */
export interface LinkRow {
  system: LinkSystem;
  /** A kit id or a key derived from outside data (never an outside account id): 1..128 characters of A-Z a-z 0-9 _ . : # -. */
  ref: string;
  /** The outside system's id for it (a Coop report uuid, an EOS referenceId, an ISO cursor): 1..128 characters of the same set. */
  external: string;
  /** One short word: 'sent', 'decided', 'active', 'removed', 'filed', 'skipped'. 1..32 characters of a-z _ . */
  state: string;
  /** Epoch ms, from the kit's clock. */
  at: number;
}

/** The longest ref or external. */
export const LINK_VALUE_MAX = 128;
/** The longest state. */
export const LINK_STATE_MAX = 32;
/** `list` takes at most this many rows; the default is {@link LINK_LIST_DEFAULT}. */
export const LINK_LIST_MAX = 500;
export const LINK_LIST_DEFAULT = 100;

const VALUE_RE = /^[A-Za-z0-9_.:#-]+$/;
const STATE_RE = /^[a-z_.]+$/;

/** True for a system on the closed list. */
export function isLinkSystem(value: unknown): value is LinkSystem {
  return typeof value === 'string' && (LINK_SYSTEMS as readonly string[]).includes(value);
}

/** True for a `ref` or `external` value: 1..128 characters of the allowed set. */
export function isLinkValue(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= LINK_VALUE_MAX && VALUE_RE.test(value);
}

/**
 * Check a row's shape. Throws `TypeError` for a value that is not an object and `RangeError` for a field outside its shape; the message
 * names the field and never the value.
 */
export function checkLinkRow(row: LinkRow): void {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new TypeError('a link row is an object');
  if (!isLinkSystem(row.system)) throw new RangeError('link system is not one of the known systems');
  if (!isLinkValue(row.ref)) throw new RangeError(`link ref must be 1 to ${LINK_VALUE_MAX} characters of A-Z a-z 0-9 _ . : # -`);
  if (!isLinkValue(row.external)) throw new RangeError(`link external must be 1 to ${LINK_VALUE_MAX} characters of A-Z a-z 0-9 _ . : # -`);
  if (typeof row.state !== 'string' || row.state.length < 1 || row.state.length > LINK_STATE_MAX || !STATE_RE.test(row.state)) {
    throw new RangeError(`link state must be 1 to ${LINK_STATE_MAX} characters of a-z _ .`);
  }
  if (typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at < 0) throw new RangeError('link at must be a finite non-negative number');
}

/** The default and the clamp of `list`'s limit: a fraction is floored, a non-number or NaN is the default. */
export function linkLimit(limit: unknown): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) return LINK_LIST_DEFAULT;
  return Math.min(LINK_LIST_MAX, Math.max(1, Math.floor(limit)));
}

/** True when the store has all four link methods. */
export function hasLinkMethods(store: {
  getLink?: unknown;
  putLink?: unknown;
  listLinks?: unknown;
  purgeLinks?: unknown;
}): boolean {
  return (
    typeof store.getLink === 'function' &&
    typeof store.putLink === 'function' &&
    typeof store.listLinks === 'function' &&
    typeof store.purgeLinks === 'function'
  );
}
