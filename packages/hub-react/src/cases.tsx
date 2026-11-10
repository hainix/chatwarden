import { useEffect } from 'react';
import { useController } from './controllerContext.js';
import { useHub } from './context.js';
import { CLAIM_TTL_MS } from './claims.js';
import { CLAIM_BEAT_MS, TAKE_COOLDOWN_MS, VIEWING_BEAT_MS } from './headless/cases.js';
import { useOptionalQueue } from './liveQueue.js';

// Working a case: claiming it when it is opened, keeping the claim and the "viewing" hint alive while it stays open, and the
// three things a moderator does about a claim from the queue: take the next case, release one, open one. All of it is the headless
// controller's (`./headless/cases.ts`); this is the React side of it.

export { CLAIM_BEAT_MS, CLAIM_TTL_MS, TAKE_COOLDOWN_MS, VIEWING_BEAT_MS };

/**
 * Renders nothing. While the report page is open it makes the moderator the handler of that case if nobody is, renews the claim
 * every 60 seconds and the viewing hint every 20 while the tab is visible, and keeps their row in the queue while it is open.
 * A case someone else holds is opened to read, with a notice. Leaving the case (another case, another screen, closing the hub)
 * releases the claim, unless a decision on it is waiting: sending that releases it.
 */
export function CaseSession({ reportId }: { reportId: string }) {
  const controller = useController();
  // Another report of the same person is the same case: `open` moves to it and keeps the claim. Only unmounting leaves.
  useEffect(() => {
    controller.open(reportId);
  }, [controller, reportId]);
  useEffect(() => () => controller.leave(), [controller]);
  return null;
}

export type TakeResult = 'taken' | 'none' | 'busy' | 'failed';

export interface CaseActions {
  /** Claim and open the oldest unclaimed case that matches the category filter. Says how it went. */
  takeNext: () => Promise<TakeResult>;
  /**
   * What to do once `decided` is on its way: go on to the same person's next open report (they are one case: the claim is kept and
   * `/cases/next` is not asked), and only when there is none take the next case, or open the team view when nobody is waiting.
   * The one place that rule lives. Answers `same` for the first, else how Take next went.
   */
  continueFrom: (decided: { reportId: string; person: string }) => Promise<'same' | TakeResult>;
  /** Claim a free case (after you let it go). */
  claim: (person: string) => Promise<void>;
  /** A senior or owner moving another moderator's live claim to themselves. The server audits it. */
  takeOver: (person: string) => Promise<void>;
  /** Release your claim on a case. The toast offers Undo, which claims it again. */
  release: (person: string) => Promise<void>;
}

/** What a moderator does about claims from anywhere in the hub: the queue pane, the case panel, the command bar, a shortcut. */
export function useCaseActions(): CaseActions {
  const controller = useController();
  const { go } = useHub();
  // A role that cannot read reports has no queue: there is nothing to take.
  const hasQueue = useOptionalQueue() !== null;

  const takeNext = async (): Promise<TakeResult> => {
    if (!hasQueue) return 'busy';
    return (await controller.takeNext()).status;
  };
  const continueFrom = async (decided: { reportId: string; person: string }): Promise<'same' | TakeResult> => {
    const out = await controller.continueFrom(decided);
    // Nobody is waiting: the team view says so.
    if (out.status === 'none') go({ name: 'overview' });
    return out.status;
  };
  return {
    takeNext,
    continueFrom,
    release: async (person) => void (await controller.release(person)),
    claim: async (person) => void (await controller.claim(person)),
    takeOver: async (person) => void (await controller.takeOver(person)),
  };
}
