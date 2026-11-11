import { LazyGaps } from '../screens/lazy.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `RuleGaps`: a class name.
 * @experimental
 */
export type RuleGapsProps = PieceProps;

/**
 * The cases no rule covered, and how each was closed. An owner (the `gaps.close` permission) can close one by ruling it under an
 * existing rule or writing a new one. Needs the `gaps.read` permission.
 *
 * ```tsx
 * <RuleGaps />
 * ```
 * @experimental
 */
export function RuleGaps({ className }: RuleGapsProps) {
  return (
    <Piece name="RuleGaps" need="gaps.read" className={className}>
      <LazyGaps />
    </Piece>
  );
}
