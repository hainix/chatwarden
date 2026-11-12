import { useEffect, useRef } from 'react';
import { useHub } from '../context.js';
import { formatDuration } from '../format.js';
import { useHubData } from '../hooks.js';
import { groupName, ruleLabel, sanctionWhat } from '../labels.js';
import { useQueue } from '../liveQueue.js';
import { ErrorBlock, Link, PersonChip, Skeleton } from '../ui.js';

// The open appeals in the queue pane, oldest first (the Appeals view). One row per appeal: who, what was given and under which rule, and how long it has waited.
// A row opens the appeal card in the main pane. There is no claim: an appeal is decided by one write, and the second of two moderators is told so.

export function AppealList({ selected }: { selected: string | null }) {
  const { client, t, locale, now } = useHub();
  const queue = useQueue();
  const state = useHubData('appeals:open', () => client.appeals({ status: 'open' }));
  // The queue reads again when its change token moves (an appeal filed or decided): the list follows it.
  const seen = useRef(queue.revision);
  const reload = useRef(state.reload);
  reload.current = state.reload;
  useEffect(() => {
    if (queue.revision === seen.current) return;
    seen.current = queue.revision;
    reload.current();
  }, [queue.revision]);

  if (state.data === undefined) {
    if (state.error !== null) return <ErrorBlock error={state.error} what={t('hub.state.what.appeals')} onRetry={state.reload} />;
    return (
      <div className="cw-queue-state">
        <p role="status" className="cw-sr">
          {t('hub.appeals.queue.loading')}
        </p>
        <Skeleton lines={3} />
      </div>
    );
  }
  const items = state.data.items;
  return (
    <>
      {state.error !== null && <ErrorBlock error={state.error} what={t('hub.state.what.appeals')} onRetry={state.reload} />}
      {items.length === 0 ? (
        <div className="cw-empty">
          <p>{t('hub.appeals.empty')}</p>
        </div>
      ) : (
        <ul className="cw-case-list" aria-label={t('hub.appeals.list')}>
          {items.map((a) => {
            const waiting = Math.max(0, now() - a.createdAt);
            const current = selected === a.id ? { 'aria-current': 'true' as const } : {};
            return (
              <li key={a.id} className="cw-case" data-wait="ok" data-selected={selected === a.id ? 'true' : undefined}>
                <Link to={{ name: 'appeal', id: a.id }} className="cw-case-link" {...current}>
                  <span className="cw-case-main">
                    <span className="cw-case-who">
                      <span className="cw-case-name">{groupName(t, { handle: a.handle, person: a.person, handleFlagged: a.handleFlagged })}</span>
                      <PersonChip person={a.person} />
                    </span>
                    <span className="cw-case-cats">
                      <span className="cw-cat">{sanctionWhat(t, locale, a.sanction)}</span>
                      <span className="cw-cat">{ruleLabel(t, a.sanction.rule)}</span>
                    </span>
                  </span>
                  <span className="cw-case-side">
                    <span className="cw-case-wait">{t('hub.appeals.row.waiting', { duration: formatDuration(waiting, locale) })}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
