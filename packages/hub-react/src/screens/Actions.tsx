import { useRef, useState } from 'react';
import { useHub } from '../context.js';
import { hasFocus } from '../dom.js';
import { usePagedList } from '../hooks.js';
import { errorText } from '../labels.js';
import type { SanctionSource } from '../types.js';
import { Empty, ErrorBlock, Loading, Notice, Panel, Segmented } from '../ui.js';
import { ActionRow } from './ActionRow.js';

/** Actions asked for per page. */
export const ACTIONS_PAGE = 25;

type Filter = 'all' | 'auto';
/** "Automatic only" is what the term filter did by itself: the kit's `auto_filter` source. */
const AUTO: SanctionSource = 'auto_filter';

/** Everything that was done to anyone, newest first, a page at a time, with a filter for what the filter did by itself. */
export function Actions() {
  const { client, t } = useHub();
  const [filter, setFilter] = useState<Filter>('all');
  const [announcement, setAnnouncement] = useState('');
  const pager = usePagedList(`actions:${filter}`, (cursor) =>
    client.listSanctions({ limit: ACTIONS_PAGE, ...(filter === 'auto' ? { source: AUTO } : {}), ...(cursor === undefined ? {} : { cursor }) }),
  );
  // Keyboard focus stays on the button while pages remain; when the last page makes it go away, it moves to the count.
  const moreRef = useRef<HTMLButtonElement>(null);
  const countRef = useRef<HTMLParagraphElement>(null);

  const loadMore = async (): Promise<void> => {
    if (pager.loadingMore) return;
    const hadFocus = hasFocus(moreRef.current);
    setAnnouncement('');
    const added = await pager.loadMore();
    if (added > 0) setAnnouncement(t('hub.actions.loadedMore', { count: added }));
    if (hadFocus) countRef.current?.focus({ preventScroll: true });
  };

  const what = t('hub.state.what.allActions');
  let body;
  if (pager.items.length === 0 && pager.loading) body = <Loading />;
  else if (pager.items.length === 0 && pager.error !== null) body = <ErrorBlock error={pager.error} what={what} onRetry={pager.reload} />;
  else if (pager.items.length === 0) body = <Empty>{t(filter === 'auto' ? 'hub.actions.empty.auto' : 'hub.actions.empty')}</Empty>;
  else {
    body = (
      <>
        <ul className="cw-alist" aria-label={t('hub.actions.list')}>
          {pager.items.map((s) => (
            <ActionRow key={s.groupId} sanction={s} />
          ))}
        </ul>
        <div className="cw-more cw-panel-pad">
          <p ref={countRef} tabIndex={-1}>
            {t('hub.actions.shown', { count: pager.items.length })}
          </p>
          {pager.next !== null && <p className="cw-hint">{t('hub.actions.moreHint')}</p>}
          {pager.error !== null && (
            <Notice tone="bad" role="alert">
              <strong>{t('hub.state.loadFailed', { what })}</strong> {errorText(t, pager.error)}
            </Notice>
          )}
          {pager.next !== null && (
            <button ref={moreRef} type="button" className="cw-btn" aria-disabled={pager.loadingMore} aria-busy={pager.loadingMore} onClick={() => void loadMore()}>
              {pager.loadingMore ? t('hub.actions.loadingMore') : t('hub.actions.loadMore')}
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>{t('hub.actions.title')}</h2>
        <Segmented
          label={t('hub.actions.filter.label')}
          value={filter}
          options={[
            { value: 'all', label: t('hub.actions.filter.all') },
            { value: 'auto', label: t('hub.actions.filter.auto') },
          ]}
          onChange={setFilter}
        />
      </div>
      <Panel title={t('hub.actions.list')}>{body}</Panel>
      <p className="cw-sr" role="status">
        {announcement}
      </p>
    </div>
  );
}
