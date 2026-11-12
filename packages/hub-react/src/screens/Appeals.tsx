import { useHub } from '../context.js';
import { useOptionalQueue } from '../liveQueue.js';

/** The Appeals view's main pane when no appeal is open: the list is the pane beside it. (Deciding an appeal brings the moderator back here.) */
export function Appeals() {
  const { t } = useHub();
  const waiting = useOptionalQueue()?.appeals ?? 0;
  return (
    <div className="cw-screen">
      <h2 className="cw-screen-title" tabIndex={-1}>
        {t('hub.appeals.screen.title')}
      </h2>
      <div className="cw-simple-home">
        <p>{waiting === 0 ? t('hub.appeals.screen.none') : t('hub.appeals.queue.count', { count: waiting })}</p>
        {waiting > 0 && <p className="cw-hint">{t('hub.appeals.screen.pick')}</p>}
      </div>
    </div>
  );
}
