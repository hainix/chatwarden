import { ReportingSettingsScreen } from '../screens/ReportingSettings.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `ReportingSettings`: a class name.
 * @experimental
 */
export type ReportingSettingsProps = PieceProps;

/**
 * The reporting settings, editable: how players report (one tap, a reason first, or a reason required), the reasons they can give (add,
 * rename, group, reorder, switch off, map to rules, ask for a note), the thank-you, and a picture of what players will see. Needs
 * `policy.read` to open; changing the settings needs `policy.write` (an owner by default), and a store that can keep them. The settings are
 * read once when the piece opens and again after a save or a reset.
 *
 * ```tsx
 * <ReportingSettings />
 * ```
 * @experimental
 */
export function ReportingSettings({ className }: ReportingSettingsProps) {
  return (
    <Piece name="ReportingSettings" need="policy.read" className={className}>
      <ReportingSettingsScreen />
    </Piece>
  );
}
