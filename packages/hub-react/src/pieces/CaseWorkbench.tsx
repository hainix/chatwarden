import { CaseProvider } from '../case/CaseContext.js';
import { useCaseShown, useQueueRunning, useRuntime } from '../pieceRuntime.js';
import { Report } from '../screens/Report.js';
import { CasePanel } from '../shell/CasePanel.js';
import { Piece } from './Piece.js';
import type { PieceLinks, PieceProps } from './Piece.js';

/**
 * The props of `CaseWorkbench`.
 * @experimental
 */
export interface CaseWorkbenchProps extends PieceProps, PieceLinks {
  /** The report to show: the person's case is its newest open report. */
  reportId: string;
}

function Body({ reportId }: { reportId: string }) {
  useQueueRunning();
  useCaseShown(reportId);
  return (
    <CaseProvider key={reportId} reportId={reportId}>
      <div className="cw-wb">
        <Report />
        <CasePanel />
      </div>
    </CaseProvider>
  );
}

/**
 * One case as the full workbench: the header and who is handling it, the evidence in tabs (the transcript, the person's reports and
 * their history), the decision bar, and beside it the person's record, what they tried to say that was blocked, how the reporters
 * have fared and who is in the case. Everything the Detailed hub shows for a case, without the queue or the nav. The hub holds one case
 * at a time: the workbench for the case you last entered is claimed; with several people's cases on one page the others are shown
 * unclaimed, with no heartbeat, but reading and deciding on them work. The keys (1, 2, 3 and Ctrl or Cmd+Enter) work only while
 * focus is inside this piece. Without `onOpenCase` or `onOpenReport`, "decide and next" only decides.
 *
 * `onOpenPerson` and `onOpenReport` make the person's History button and the other reports of the case open where you say; without
 * them they are plain text.
 *
 * ```tsx
 * <CaseWorkbench reportId={id} onOpenPerson={(person) => navigate(`/people/${person}`)} />
 * ```
 * @experimental
 */
export function CaseWorkbench({ reportId, className, onOpenCase, onOpenPerson, onOpenReport }: CaseWorkbenchProps) {
  const runtime = useRuntime();
  return (
    <Piece name="CaseWorkbench" need="reports.read" className={className} links={{ onOpenCase, onOpenPerson, onOpenReport }} onEnter={() => runtime.enterCase(reportId)}>
      <Body reportId={reportId} />
    </Piece>
  );
}
