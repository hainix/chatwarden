import type { FeedItem } from './types';

/** The chat keeps about this many lines once the reader is at the bottom. */
export const FEED_MAX = 60;
/** A reader who stays scrolled up keeps their place, but the feed still cannot grow without bound. */
const FEED_HARD_MAX = FEED_MAX * 3;

/**
 * The feed with one more line. The oldest lines are dropped only while the reader is at the bottom: trimming the top of a feed
 * someone has scrolled up in would jump what they are reading.
 */
export function appendLine(feed: readonly FeedItem[], item: FeedItem, atBottom: boolean): FeedItem[] {
  const next = [...feed, item];
  const keep = atBottom ? FEED_MAX : FEED_HARD_MAX;
  return next.length > keep ? next.slice(next.length - keep) : next;
}

/**
 * Which line the tour points at. `current` is the one it already points at: it keeps it while that line is still in the feed and
 * has not been reported, however many rude lines arrive after it. Otherwise Bo's newest rude line that nobody reported, then any
 * line of Bo's, then the last line that is not the visitor's. Null in an empty room.
 */
export function pickTourLine(feed: readonly FeedItem[], reported: ReadonlySet<string>, current: string | null): string | null {
  if (current !== null && !reported.has(current) && feed.some((f) => f.id === current)) return current;
  const others = feed.filter((f) => !f.you && !f.refused);
  const newestFirst = [...others].reverse();
  const pick =
    newestFirst.find((f) => f.seat === 'bo' && f.rude === true && !reported.has(f.id)) ??
    newestFirst.find((f) => f.seat === 'bo' && !reported.has(f.id)) ??
    newestFirst.find((f) => !reported.has(f.id)) ??
    newestFirst[0];
  return pick?.id ?? null;
}
