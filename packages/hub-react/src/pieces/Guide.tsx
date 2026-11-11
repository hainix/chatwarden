import { LazyGuide } from '../screens/lazy.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `Guide`: a class name.
 * @experimental
 */
export type GuideProps = PieceProps;

/**
 * The moderator guide the kit generates from your rules and your ladder: what each rule means, what each step does, and how to word a
 * decision. Needs the `policy.read` permission.
 *
 * ```tsx
 * <Guide />
 * ```
 * @experimental
 */
export function Guide({ className }: GuideProps) {
  return (
    <Piece name="Guide" need="policy.read" className={className}>
      <LazyGuide />
    </Piece>
  );
}
