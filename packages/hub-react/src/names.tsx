import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from './context.js';
import { Masked } from './ui.js';

// Where a moderator is reading and a name the server flags (`names.maskInHub`) is drawn, it is the hidden label with a Show control, one place at a time. The
// reveal state is the case's own (`useCase().reveal`, so the case's "Show blocked words" shows every name at once and a new case starts hidden) or, on the
// Person page, the page's. Lists (queue rows, the command bar, the Actions and Blocked tables) draw the hidden label and no control: the name is a click away.

/** Which places show a flagged name. A place is a short id (`line:3`, `people:s_...`, `head`): the key is made here. */
export interface NameReveal {
  /** Every flagged name is on show. */
  all: boolean;
  shows: (key: string) => boolean;
  toggle: (key: string) => void;
  /** Show or hide every flagged name and statement at once ("Show blocked words"). */
  setAll?: (on: boolean) => void;
}

export const NameRevealContext = createContext<NameReveal | null>(null);

/** The case's reveal state, keyed so a name's place never meets a chat line's id. */
export const nameKey = (place: string): string => `name:${place}`;

/** Gives the page below it its own reveal state (nothing is on show at first, and it is gone with the page). */
export function LocalReveal({ children }: { children: ReactNode }) {
  const [on, setOn] = useState<ReadonlySet<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const toggle = useCallback((key: string): void => {
    setOn((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const value = useMemo<NameReveal>(() => ({ all, shows: (key) => on.has(key), toggle, setAll }), [all, on, toggle]);
  return <NameRevealContext.Provider value={value}>{children}</NameRevealContext.Provider>;
}

/** Whether a place shows its name. Without a reveal state around it (a part alone on a page) nothing is shown. */
export function useNameShown(place: string): boolean {
  const reveal = useContext(NameRevealContext);
  return reveal !== null && (reveal.all || reveal.shows(nameKey(place)));
}

/**
 * A name in a place: `text` as it reads when shown (build it with `personName(..., true)`), or the hidden label while the server flags it and
 * the place is not shown. An unflagged name is the plain text, so a page with no flagged name is what it was.
 */
export function NameValue({ text, flagged, place }: { text: string; flagged: boolean | undefined; place: string }) {
  const shown = useNameShown(place);
  return flagged === true && !shown ? <Masked /> : <>{text}</>;
}

/** The Show or Hide beside a flagged name, for its place; nothing for a name that is not flagged, or a page with nothing to keep the choice in. */
export function NameToggle({ flagged, place, time }: { flagged: boolean | undefined; place: string; time?: string }) {
  const { t } = useHub();
  const reveal = useContext(NameRevealContext);
  const shown = useNameShown(place);
  // "Show blocked words" shows every name: the one switch is the control, so no button stays that could not change anything.
  if (flagged !== true || reveal === null || reveal.all) return null;
  const label = time === undefined ? t(shown ? 'hub.mask.hideName' : 'hub.mask.showName') : t(shown ? 'hub.mask.hideNameLine' : 'hub.mask.showNameLine', { time });
  return (
    <button type="button" className="cw-linkbtn" aria-pressed={shown} aria-label={label} onClick={() => reveal.toggle(nameKey(place))}>
      {t(shown ? 'hub.mask.hide' : 'hub.mask.show')}
    </button>
  );
}
