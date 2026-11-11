import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

// A modal window: it takes focus when it opens, keeps focus inside, and hands focus back to what had it. It is a plain ARIA dialog
// (not <dialog>), so it works the same in every embedded browser a game may use. A click outside never closes it: a notice has to
// be acknowledged, and a half-written report is not lost by a stray click.
//
// Focus is kept in three ways, because Tab alone is not enough: the keydown handler wraps Tab at the ends, a click on the backdrop
// does not move focus (mousedown is cancelled), and a document-wide `focusin` guard pulls focus back if anything outside the window
// gets it (a script, a click on a game control that is still reachable).

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab visits, in order. */
const tabStops = (box: HTMLElement): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];

export function Dialog({
  labelledBy,
  initialFocus,
  onEscape,
  returnFocusTo,
  children,
}: {
  /** The id of the heading that names the window. */
  labelledBy: string;
  /** What takes focus when it opens: the heading. */
  initialFocus: RefObject<HTMLElement | null>;
  /** Called on Escape. Leave it out when the window must not be dismissed. */
  onEscape?: () => void;
  /** Where focus goes on close when the element that had it before is gone. */
  returnFocusTo?: () => HTMLElement | null;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const fallback = useRef(returnFocusTo);
  fallback.current = returnFocusTo;
  // What had focus before the window opened, read while rendering for the first time: a child's own effect (which moves focus to
  // its heading) runs before this component's effects, so reading it in an effect would find the heading.
  const [before] = useState<Element | null>(() => (typeof document === 'undefined' ? null : document.activeElement));

  useEffect(() => {
    (initialFocus.current ?? box.current)?.focus();
    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target;
      const inner = box.current;
      if (inner !== null && target instanceof Node && !inner.contains(target)) (initialFocus.current ?? inner).focus();
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      // Stop guarding first, so giving focus back is not pulled in again.
      document.removeEventListener('focusin', onFocusIn);
      // Give focus back, unless what had it is gone (the page moved on while the window was open): then to `returnFocusTo()`, if
      // the host gave one, and otherwise to wherever the browser leaves it (the page body).
      if (before instanceof HTMLElement && before.isConnected) before.focus();
      else {
        try {
          fallback.current?.()?.focus();
        } catch {
          // A host callback that throws must not stop the window closing.
        }
      }
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
    if (e.key !== 'Tab' || box.current === null) return;
    const items = tabStops(box.current);
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
    <div
      className="cw-scrim"
      onMouseDown={(e) => {
        // A press on the backdrop would drop focus to the page body, and the next Tab would leave the window: keep it where it is.
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div ref={box} className="cw-dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}
