import { CaseProvider } from '../case/CaseContext.js';
import { CaseCard as CaseCardView } from '../case/CaseCard.js';
import { useCaseShown, useQueueRunning, useRuntime } from '../pieceRuntime.js';
import { Piece } from './Piece.js';
import type { PieceLinks, PieceProps } from './Piece.js';

/**
 * The props of `CaseCard`.
 * @experimental
 */
export interface CaseCardProps extends PieceProps, PieceLinks {
  /** The report to show: the person's case is its newest open report. */
  reportId: string;
}

function Body({ reportId }: { reportId: string }) {
  useQueueRunning();
  useCaseShown(reportId);
  return (
    <CaseProvider key={reportId} reportId={reportId}>
      <CaseCardView />
    </CaseProvider>
  );
}

/**
 * One case as a card: who, why, what they said, their record, the ladder's suggestion, and three ways to answer it (the suggested
 * step, No action needed, Something else). The case is claimed while the card is shown. A decision is held for 5 seconds with Undo,
 * and sent at once when the page goes. Keys 1, 2 and Ctrl or Cmd+Enter work only while keyboard focus is inside this card, so
 * several cards can share a page. Needs the `reports.read` permission (and `reports.decide` to answer).
 *
 * `onOpenCase` and `onOpenReport` are told where to go next after a decision (the same person's next report, or the case Take next
 * took); without them the card stays as it is.
 *
 * ```tsx
 * <CaseCard reportId={id} onOpenReport={(next) => navigate(`/cases/${next}`)} />
 * ```
 * @experimental
 */
export function CaseCard({ reportId, className, onOpenCase, onOpenPerson, onOpenReport }: CaseCardProps) {
  const runtime = useRuntime();
  return (
    <Piece name="CaseCard" need="reports.read" className={className} links={{ onOpenCase, onOpenPerson, onOpenReport }} onEnter={() => runtime.enterCase(reportId)}>
      <Body reportId={reportId} />
    </Piece>
  );
}
