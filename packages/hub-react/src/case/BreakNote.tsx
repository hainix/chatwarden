import { useEffect } from 'react';
import { useHub } from '../context.js';
import { onPageFirst } from '../dom.js';
import { useOptionalCase } from './CaseContext.js';

// The break note (design 7 and 16): one line in the case, "You have opened N excerpts today. A short break may help.", when N excerpts have been opened in a day and again at each multiple.
// A polite status: it takes no focus, blocks nothing and is not a dialog. It closes with its button or with Escape (the note's own Escape: the hub's, back to the queue, does not also run).

export function BreakNote() {
  const { t } = useHub();
  const care = useOptionalCase()?.care;
  const at = care?.breakAt ?? null;
  const dismiss = care?.dismissBreak;
  useEffect(() => {
    if (at === null || dismiss === undefined) return undefined;
    // Heard before the hub's own handler (back to the queue): while the note is up, this Escape is the note's.
    return onPageFirst('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Escape' || e.defaultPrevented) return;
      // An Escape pressed inside an OPEN menu (the case's or a line's) or a dialog is theirs: they close themselves and give the focus back, and the note waits for the next one.
      const origin = e.composedPath()[0];
      if (origin instanceof Element) {
        const menu = origin.closest('.cw-case-menu, .cw-line-menu');
        if (menu?.querySelector('[aria-expanded="true"]') != null || origin.closest('[role="dialog"]') !== null) return;
      }
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    });
  }, [at, dismiss]);
  if (at === null || dismiss === undefined) return null;
  return (
    <div className="cw-break-note" role="status">
      <p>{t('hub.care.break', { count: at })}</p>
      <button type="button" className="cw-btn" onClick={dismiss}>
        {t('hub.care.break.dismiss')}
      </button>
    </div>
  );
}
