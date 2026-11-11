import { LazyTerms } from '../screens/lazy.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `TermsManager`: a class name.
 * @experimental
 */
export type TermsManagerProps = PieceProps;

/**
 * The blocked terms and their exceptions, by language: add, change and switch off, with a dry run against the live list before a
 * term goes in. Needs the `terms.read` permission (and `terms.write` to change anything). Opened from a blocked line in
 * `BlockedList` (its "Add an exception" or "View term"), it starts on that word.
 *
 * ```tsx
 * <TermsManager />
 * ```
 * @experimental
 */
export function TermsManager({ className }: TermsManagerProps) {
  return (
    <Piece name="TermsManager" need="terms.read" className={className}>
      <LazyTerms />
    </Piece>
  );
}
