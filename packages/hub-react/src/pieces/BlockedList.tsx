import { LazyBlocked } from '../screens/lazy.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `BlockedList`.
 * @experimental
 */
export interface BlockedListProps extends PieceProps {
  /** A person was chosen. Without it they are plain text. */
  onOpenPerson?: (person: string) => void;
  /**
   * Where `TermsManager` is in your page. Called after "Add an exception" or "View term" has told it which word (the choice is kept
   * in the hub's session, so a `TermsManager` that mounts next starts on it). Without it those two buttons are not shown.
   */
  onOpenTerms?: () => void;
}

/**
 * The chat lines the term filter refused, newest first, over the last day, week or month. Blocked words stay masked until a moderator
 * shows them. Needs the `blocked.read` permission. Opening the list is one audited read.
 *
 * ```tsx
 * <BlockedList onOpenPerson={(ref) => navigate(`/people/${ref}`)} />
 * ```
 * @experimental
 */
export function BlockedList({ className, onOpenPerson, onOpenTerms }: BlockedListProps) {
  return (
    <Piece name="BlockedList" need="blocked.read" className={className} links={{ onOpenPerson, onOpenTerms }}>
      <LazyBlocked />
    </Piece>
  );
}
