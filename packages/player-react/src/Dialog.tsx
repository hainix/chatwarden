import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

// A modal window: it takes focus when it opens, keeps Tab inside, and hands focus back to what had it. It is a plain ARIA dialog
// (not <dialog>), so it works the same in every embedded browser a game may use. A click outside never closes it: a notice has to
// be acknowledged, and a half-written report is not lost by a stray click.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  labelledBy,
  initialFocus,
  onEscape,
  children,
}: {
  /** The id of the heading that names the window. */
  labelledBy: string;
  /** What takes focus when it opens: the heading. */
  initialFocus: RefObject<HTMLElement | null>;
  /** Called on Escape. Leave it out when the window must not be dismissed. */
  onEscape?: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // What had focus before the window opened, read while rendering for the first time: a child's own effect (which moves focus to
  // its heading) runs before this component's effects, so reading it in an effect would find the heading.
  const [before] = useState<Element | null>(() => (typeof document === 'undefined' ? null : document.activeElement));

  useEffect(() => {
    (initialFocus.current ?? box.current)?.focus();
    return () => {
      // Give focus back, unless what had it is gone (the page moved on while the window was open).
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
    // Once, when the window opens.
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      if (onEscape === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement;
    // From the heading (or the box), which is not in the list, Tab goes to the first control and Shift+Tab to the last.
    const inList = items.includes(active as HTMLElement);
    if (e.shiftKey && (active === first || !inList)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inList)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="cw-scrim">
      <div ref={box} className="cw-dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}
