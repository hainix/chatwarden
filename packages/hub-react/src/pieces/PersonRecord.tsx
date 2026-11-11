import { Person } from '../screens/Person.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `PersonRecord`.
 * @experimental
 */
export interface PersonRecordProps extends PieceProps {
  /** The person's staff ref (from the queue, a report or an action: `CaseList`'s `onOpenCase`, `onOpenPerson`). */
  person: string;
  /** A report in their timeline was chosen. Without it the report is plain text. */
  onOpenReport?: (reportId: string) => void;
  /** Another person was chosen. Without it they are plain text. */
  onOpenPerson?: (person: string) => void;
}

/**
 * One person: what is in force now (each with a Revoke), their timeline of reports and every sanction, and how the reports they
 * filed have gone, with the buttons to sanction them or add a note. Opening it is one audited read of their history. Needs the
 * `history.read` permission.
 *
 * ```tsx
 * <PersonRecord person={ref} onOpenReport={(id) => navigate(`/cases/${id}`)} />
 * ```
 * @experimental
 */
export function PersonRecord({ person, className, onOpenReport, onOpenPerson }: PersonRecordProps) {
  return (
    <Piece name="PersonRecord" need="history.read" className={className} links={{ onOpenReport, onOpenPerson }}>
      <Person person={person} />
    </Piece>
  );
}
