import { LazyActions } from '../screens/lazy.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `RecentActions`.
 * @experimental
 */
export interface RecentActionsProps extends PieceProps {
  /** A person an action was taken against was chosen. Without it they are plain text. */
  onOpenPerson?: (person: string) => void;
}

/**
 * Everything that was done to anyone, newest first, a page at a time, with a filter for what the term filter did by itself. Needs the
 * `history.read` permission.
 *
 * ```tsx
 * <RecentActions onOpenPerson={(ref) => navigate(`/people/${ref}`)} />
 * ```
 * @experimental
 */
export function RecentActions({ className, onOpenPerson }: RecentActionsProps) {
  return (
    <Piece name="RecentActions" need="history.read" className={className} links={{ onOpenPerson }}>
      <LazyActions />
    </Piece>
  );
}
