import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { Dialog } from '../Dialog.js';
import { useLeaveGuard } from '../leaveGuard.js';

/**
 * Leaving a settings screen with unsaved edits: the hub's own navigation asks first (an in-page dialog, never `confirm()`), and closing the
 * tab gets the browser's question while there is something to lose. Returns the dialog to draw (null when none is open).
 */
export function useUnsavedGuard(dirty: boolean): ReactNode {
  const { t } = useHub();
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  useLeaveGuard((proceed) => {
    if (!dirtyNow.current) return false;
    setLeaving(() => proceed);
    return true;
  });
  useEffect(() => {
    if (!dirty) return undefined;
    // Closing the tab: the browser asks, in its own words.
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  if (leaving === null) return null;
  return (
    <Dialog label={t('hub.settings.leave.title')} onClose={() => setLeaving(null)}>
      <h2>{t('hub.settings.leave.title')}</h2>
      <p>{t('hub.settings.leave.body')}</p>
      <div className="cw-action-foot">
        <button type="button" className="cw-btn cw-btn--primary" onClick={() => setLeaving(null)}>
          {t('hub.settings.leave.stay')}
        </button>
        <button
          type="button"
          className="cw-btn"
          onClick={() => {
            const go = leaving;
            setLeaving(null);
            go();
          }}
        >
          {t('hub.settings.leave.go')}
        </button>
      </div>
    </Dialog>
  );
}
