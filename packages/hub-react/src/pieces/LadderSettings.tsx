import { LazyLadderSettings } from '../screens/lazy.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `LadderSettings`: a class name.
 * @experimental
 */
export type LadderSettingsProps = PieceProps;

/**
 * The steps and ladder, editable: the lengths moderators can pick, the ladder grid, the first offences, the repeat rule, the area and
 * severe rules and the guidelines' outcome text, with a preview of what each change would suggest. Needs `policy.read` to open; changing
 * the settings needs `policy.write` (an owner by default), and a store that can keep them. The settings are read once when the piece
 * opens and again after a save or a reset.
 *
 * ```tsx
 * <LadderSettings />
 * ```
 * @experimental
 */
export function LadderSettings({ className }: LadderSettingsProps) {
  return (
    <Piece name="LadderSettings" need="policy.read" className={className}>
      <LazyLadderSettings />
    </Piece>
  );
}
