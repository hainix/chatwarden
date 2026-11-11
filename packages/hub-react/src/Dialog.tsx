import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { activeOf } from './dom.js';

// A modal window: it takes focus when it opens, keeps Tab inside, closes on Escape or a click outside, and hands focus back to
// what had it. The command bar and the shortcut sheet are built on it.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  label,
  onClose,
  initialFocus,
  className,
  children,
}: {
  /** The accessible name of the window. */
  label: string;
  onClose: () => void;
  /** What takes focus when it opens (default: the first control in the window). */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // What had focus in the hub's own root (inside a shadow root the page only sees the host).
    const had = activeOf(box.current);
    const before = had instanceof HTMLElement ? had : null;
    // The hub's root, to fall back on (the shell's root takes focus; an embedded root does not, and then this does nothing).
    const hubRoot = box.current?.closest<HTMLElement>('.cw-hub') ?? null;
    const first = initialFocus?.current ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current;
    first?.focus();
    return () => {
      // Give focus back. If what had it is gone (the page moved on while the window was open), or nothing in the hub had it (the
      // window was opened from the page body), it goes to the hub's root: left on the body, the hub's keys would be dead until a click.
      if (before !== null && before.isConnected && before !== before.ownerDocument.body) before.focus();
      else hubRoot?.focus();
    };
    // Once, when the window opens.
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      // preventDefault says the key is handled; stopPropagation keeps it from the hub's root, whose own Escape (back to the queue)
      // must not also run (a React stop means the hub's key bus never sees this key; see keyScope.ts).
      e.preventDefault();
      e.stopPropagation();
      onClose();
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
    const active = activeOf(box.current);
    if (e.shiftKey && (active === first || active === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="cw-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={box} className={className === undefined ? 'cw-dialog' : `cw-dialog ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}
