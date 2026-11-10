import { useHub } from '../context.js';
import { useOptionalQueue } from '../liveQueue.js';

/** Says when the connection is lost or the browser is offline. It goes away on its own when the hub reconnects (a toast says so). */
export function ConnectionBanner() {
  const { t } = useHub();
  const queue = useOptionalQueue();
  if (queue === null || queue.connection === 'live') return null;
  return (
    <div className="cw-banner" role="alert" data-state={queue.connection}>
      <p>{queue.connection === 'offline' ? t('hub.banner.offline') : t('hub.banner.lost')}</p>
      {queue.connection === 'lost' && (
        <button type="button" className="cw-btn" onClick={queue.retryNow}>
          {t('hub.banner.retry')}
        </button>
      )}
    </div>
  );
}
