import { useHub } from '../context.js';
import { useFeatures } from '../features.js';
import { useOptionalQueue } from '../liveQueue.js';
import { Link, Skeleton } from '../ui.js';
import { Overview } from './Overview.js';

/**
 * The landing in Simple mode: how many people are waiting, and what to do. The list of them is the pane beside it, so this holds
 * nothing else (the team view and the numbers are the Detailed overview). A role that cannot read reports has no queue and gets the
 * overview as it is.
 */
export function SimpleHome() {
  const { t, can } = useHub();
  const queue = useOptionalQueue();
  const features = useFeatures();
  if (queue === null) return <Overview />;
  const ready = queue.status === 'ready';
  const waiting = queue.groups.length;
  return (
    <div className="cw-screen">
      <h2 className="cw-screen-title" tabIndex={-1}>
        {t('hub.simple.home.title')}
      </h2>
      {queue.status === 'loading' && (
        <div>
          <p role="status" className="cw-sr">
            {t('hub.queue.loading')}
          </p>
          <Skeleton lines={2} />
        </div>
      )}
      {ready && (
        <div className="cw-simple-home">
          <p>{t('hub.simple.home.waiting', { count: waiting })}</p>
          {waiting > 0 && can('reports.decide') && <p className="cw-hint">{t('hub.simple.home.pick')}</p>}
          {/* The one conditional line appeals add to Simple: only with appeals on, readable, and something waiting. */}
          {features.appeals && (queue.appeals ?? 0) > 0 && (
            <p className="cw-hint">
              <Link to={{ name: 'appeals' }} className="cw-link">
                {t('hub.simple.appeals.waiting', { count: queue.appeals ?? 0 })}
              </Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
