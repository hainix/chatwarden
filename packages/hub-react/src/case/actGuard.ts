// What every act key and button of a case shares: a held key is one action, and a case accepts an act key only a moment after it
// appeared. The age is read on a monotonic clock (`performance.now()`), not the hub's `now`: the hub's clock may be frozen (a test, a
// demo) or stepped by the system, and a guard against fingers must measure the machine's time.

/**
 * A case accepts a quick key or a quick-action click only this long after it appeared. The second tap of a double tap, meant for the
 * case just closed, then cannot act on the next one, and a case that rendered under the finger is not acted on unread.
 * @experimental
 */
export const QUICK_ACT_COOLDOWN_MS = 300;

/** Set on the hub's root from a move with J, K or an arrow key until the case it opens is on screen: no act key acts meanwhile. */
export const MOVING_ATTRIBUTE = 'data-cw-moving';

/** Whether the hub that `root` belongs to is moving to another case. */
export const isMoving = (root: Element | null): boolean => root !== null && root.hasAttribute(MOVING_ATTRIBUTE);

/** The monotonic time, in milliseconds. */
export const monotonicNow = (): number => performance.now();

/** Whether a case that was drawn at `shownAt` (monotonic) is old enough to accept an act key. */
export const hasAged = (shownAt: number | null): boolean => shownAt !== null && monotonicNow() - shownAt >= QUICK_ACT_COOLDOWN_MS;

/** A click that is the second (or later) of a quick run of clicks: never an act, the first one has been answered. */
export const isRepeatClick = (e: { detail?: number } | undefined): boolean => (e?.detail ?? 0) > 1;
