import { useEffect, useMemo, useState } from 'react';
import { useHub } from '../context.js';
import { usePagedList } from '../hooks.js';
import { errorText } from '../labels.js';
import { groupQueue } from '../queue.js';
import { QueueRow } from '../QueueRow.js';
import type { QueueStatus } from '../router.js';
import { Empty, ErrorBlock, Loading, Notice, Segmented } from '../ui.js';

/** Reports asked for per page. */
export const REPORTS_PAGE = 50;

const STATUSES = ['open', 'actioned', 'dismissed', 'all'] as const satisfies readonly QueueStatus[];

/**
 * The queue, grouped by reported person. The kit pages the queue by report, so the groups are built from the pages loaded so
 * far; "Load more" adds older reports and the groups grow. The status filter lives in the address (`#/reports?status=...`).
 */
export function Reports({ status }: { status: QueueStatus }) {
  const { client, t, go } = useHub();
  const pager = usePagedList(`reports:${status}`, (cursor) =>
    client.listReports({
      ...(status === 'all' ? {} : { status }),
      limit: REPORTS_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const groups = useMemo(() => groupQueue(pager.items), [pager.items]);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => setAnnouncement(''), [status]);

  const loadMore = async (): Promise<void> => {
    setAnnouncement('');
    const added = await pager.loadMore();
    if (added > 0) setAnnouncement(t('hub.reports.loadedMore', { count: added }));
  };

  const what = t('hub.state.what.reports');
  let body;
  if (pager.items.length === 0 && pager.loading) body = <Loading />;
  else if (pager.items.length === 0 && pager.error !== null) body = <ErrorBlock error={pager.error} what={what} onRetry={pager.reload} />;
  else if (pager.items.length === 0) body = <Empty>{t(`hub.reports.empty.${status}`)}</Empty>;
  else {
    body = (
      <>
        <ul className="cw-qlist" aria-label={t('hub.reports.list.label')}>
          {groups.map((g) => (
            <QueueRow key={g.person} group={g} showStatus={status !== 'open'} />
          ))}
        </ul>
        <div className="cw-more">
          <p>{t('hub.reports.shown', { count: pager.items.length })}</p>
          {pager.next !== null && <p className="cw-hint">{t('hub.reports.moreHint')}</p>}
          {pager.error !== null && (
            <Notice tone="bad" role="alert">
              <strong>{t('hub.state.loadFailed', { what })}</strong> {errorText(t, pager.error)}
            </Notice>
          )}
          {pager.next !== null && (
            <button type="button" className="cw-btn" disabled={pager.loadingMore} aria-busy={pager.loadingMore} onClick={() => void loadMore()}>
              {pager.loadingMore ? t('hub.reports.loadingMore') : t('hub.reports.loadMore')}
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title">{t('hub.reports.title')}</h2>
        <Segmented
          label={t('hub.reports.status.label')}
          value={status}
          options={STATUSES.map((s) => ({ value: s, label: t(`hub.reports.status.${s}`) }))}
          onChange={(next) => go({ name: 'reports', status: next })}
        />
      </div>
      {body}
      <p className="cw-sr" role="status">
        {announcement}
      </p>
    </div>
  );
}
