import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

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
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = initialFocus?.current ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current;
    first?.focus();
    return () => {
      // Give focus back, unless what had it is gone (the page moved on while the window was open).
      if (before !== null && before.isConnected) before.focus();
    };
    // Once, when the window opens.
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      // preventDefault tells the hub's page-wide shortcuts that this key has been handled.
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
    const active = document.activeElement;
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
