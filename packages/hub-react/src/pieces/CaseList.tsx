import { QueuePane } from '../shell/QueuePane.js';
import { useQueueRunning } from '../pieceRuntime.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * See the README.
 * @experimental
 */
export interface CaseListProps extends PieceProps {
  /** The case that is open in your page (a report id): its row is marked, and never disappears under the moderator while it is open. */
  selected?: string | null;
  /**
   * A row was chosen (a click or Enter), or Take next took a case: the reported person's ref and the id of their newest open report.
   * Without it a row is plain text, and the piece never moves the page.
   */
  onOpenCase?: (person: string, reportId: string) => void;
}

function Body({ selected, onOpenCase }: Pick<CaseListProps, 'selected' | 'onOpenCase'>) {
  useQueueRunning();
  return <QueuePane route={null} shortcuts={false} piece={{ selected: selected ?? null, onOpenCase }} />;
}

/**
 * The queue of open cases: one row per reported person, longest wait first, who is handling each, and a Take next button. It is kept
 * fresh in the background (one poll of the change token however many pieces use the queue). Needs the `reports.read` permission.
 *
 * ```tsx
 * <HubProvider client={client}>
 *   <CaseList selected={openReportId} onOpenCase={(person, reportId) => navigate(`/cases/${reportId}`)} />
 * </HubProvider>
 * ```
 * @experimental
 */
export function CaseList({ className, selected, onOpenCase }: CaseListProps) {
  return (
    <Piece name="CaseList" need="reports.read" className={className} links={{ onOpenCase }}>
      <Body selected={selected} onOpenCase={onOpenCase} />
    </Piece>
  );
}
