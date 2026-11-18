import { useState } from 'react';
import { useHub } from '../context.js';
import { useHubAction } from '../hooks.js';
import type { HubAction } from '../hooks.js';
import { useOptionalQueue } from '../liveQueue.js';
import { useCase } from './CaseContext.js';

// What the urgent lane does to the open case: mark it urgent or not, and mark it as passed to the game's safety team. Each writes once,
// then reads the case again (the strip, the menu and the queue are all drawn from what the server now says). Shared by the case menu
// (eager) and the "What to do" panel (lazy). Neither contacts anyone: the server only records the mark.

export interface UrgentActions {
  setUrgent: HubAction<[boolean], void>;
  handoff: HubAction<[], void>;
}

export function useUrgentActions(): UrgentActions {
  const { client } = useHub();
  const c = useCase();
  const queue = useOptionalQueue();
  // The moderator asked for the change, so the queue is read again and put on screen as it is: the chip and the row word follow at once.
  const setUrgent = useHubAction(async (on: boolean): Promise<void> => {
    await client.setUrgent(c.reportId, on);
    c.detail.reload();
    if (queue !== null) await queue.reload();
  });
  const handoff = useHubAction(async (): Promise<void> => {
    await client.handoff(c.reportId);
    c.detail.reload();
  });
  return { setUrgent, handoff };
}

const KEY = 'chatwarden.hub.urgentPanel';

/**
 * Whether the "What to do" panel is open: open until the moderator collapses it, and the choice is kept in the browser. Storage that is blocked or full is not an error: the choice
 * lasts for the visit.
 */
export function useUrgentPanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  const set = (next: boolean): void => {
    setOpen(next);
    try {
      if (next) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, 'closed');
    } catch {
      // The choice is for this visit only.
    }
  };
  return [open, set];
}
