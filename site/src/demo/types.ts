import type { PlayerNotice, RefuseReason } from './engine';

/** One line in the lobby chat as the visitor sees it. */
export interface FeedItem {
  id: string;
  seat: string;
  name: string;
  text: string;
  you: boolean;
  /** Set on the visitor's own refused lines: they see these, nobody else does. */
  refused?: { reason: RefuseReason; rule?: number };
  /** Tour hint only. */
  rude?: boolean;
}

export type PendingBySeat = Record<string, PlayerNotice[]>;
