import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { useCareOpen } from './useCare.js';
import { useOptionalCase } from './CaseContext.js';

// What stands in for an excerpt while the careful view hides it (design 7): one button that says how much is behind it. The text is NOT rendered at all while it is hidden (not
// blurred, not clipped), so a screen reader never reads it. Opening is for the whole case: any of the case's buttons opens all of them. With the setting off this draws exactly its
// children (no wrapper, no element), so a page with the feature off is the page it was. A case's state is the case's; a part outside a case (an appeal) keeps its own.

type What = 'chat' | 'note' | 'ai' | 'appeal';

export function HiddenExcerpt({ what, lines, children }: { what: What; lines?: number; children: ReactNode }) {
  const { t, now } = useHub();
  const inCase = useOptionalCase();
  // A part with no case around it (an appeal) keeps its own; the hook is called either way so the order of hooks never changes.
  const own = useCareOpen(now);
  const care = inCase?.care ?? own;
  const [pressed, setPressed] = useState(false);
  const revealed = useRef<HTMLDivElement>(null);
  // The button took the focus with it when it went: it goes to the content that took its place.
  useEffect(() => {
    if (pressed && !care.hidden) revealed.current?.focus();
  }, [pressed, care.hidden]);
  if (!care.on) return <>{children}</>;
  if (!care.hidden) {
    return (
      <div className="cw-revealed" ref={revealed} tabIndex={-1}>
        {children}
      </div>
    );
  }
  const label =
    what === 'chat' ? t('hub.care.show.chat', { count: lines ?? 0 }) : what === 'note' ? t('hub.care.show.note') : what === 'ai' ? t('hub.care.show.ai') : t('hub.care.show.appeal');
  return (
    <div className="cw-hidden-excerpt">
      <button
        type="button"
        className="cw-btn"
        onClick={() => {
          setPressed(true);
          care.open();
        }}
      >
        {label}
      </button>
    </div>
  );
}
