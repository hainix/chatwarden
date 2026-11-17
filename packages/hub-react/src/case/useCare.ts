import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { addOpened, careSettings, subscribeCare } from '../care.js';
import type { Care } from '../care.js';

// The careful view for one case (design 7): whether its excerpts are hidden until the moderator opens them, what opening counts, and the break note at N. The settings live in the browser
// (`care.ts`) and are read here so a change (the panel, the command bar) applies at once; what was opened lives in this hook's state, so it belongs to this case for this visit and is
// gone when the case is left or the page reloaded.

/** The care settings, as a snapshot that follows changes. */
export function useCareSettings(): Care {
  return useSyncExternalStore(subscribeCare, careSettings, careSettings);
}

export interface CareOpen {
  /** The excerpts are hidden now: the setting is on and this case has not been opened. */
  hidden: boolean;
  /** The setting is on (hidden or already opened): the places that hide draw their wrapper only then, so with it off the page is what it was. */
  on: boolean;
  /** Open the case's excerpts, all of them. Counts one (when counting is on), once per case. */
  open: () => void;
  /** The count a break note is for (`You have opened N excerpts today`), or null. */
  breakAt: number | null;
  dismissBreak: () => void;
}

/** The careful view of one case (or one appeal). `now` is the hub's clock: the day the count belongs to is the browser's local date at that moment. */
export function useCareOpen(now: () => number): CareOpen {
  const care = useCareSettings();
  const [opened, setOpened] = useState(false);
  const [breakAt, setBreakAt] = useState<number | null>(null);
  // Counted once per case, even when the open button is pressed twice in the same moment.
  const counted = useRef(false);
  const open = useCallback((): void => {
    setOpened(true);
    if (counted.current) return;
    counted.current = true;
    const c = careSettings();
    if (!c.countOpened) return;
    const n = addOpened(now());
    if (c.breakAfter > 0 && n % c.breakAfter === 0) setBreakAt(n);
  }, [now]);
  return { hidden: care.hideExcerpts && !opened, on: care.hideExcerpts, open, breakAt, dismissBreak: () => setBreakAt(null) };
}
