import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import { actorName, holderOf } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { absoluteTime, formatDuration, listOf, waitTone } from '../format.js';
import { Icon } from '../icons.js';
import { CATEGORY_LIST, categoryLabel, errorText, groupName } from '../labels.js';
import { useQueue } from '../liveQueue.js';
import { useMode } from '../mode.js';
import type { ShownRow } from '../live.js';
import type { Route } from '../router.js';
import { Avatar, Kbd, Link, PersonChip, Skeleton } from '../ui.js';

/** The people shown by name on a row before it says "and N more". */
const VIEWERS_NAMED = 1;
/** Skeleton rows while the first read is out. */
const SKELETON_ROWS = 5;

/**
 * The queue pane: the open cases, one row per person, longest wait first. Each row says who is handling it (you in blue,
 * others plain), who is looking, the categories and how long it has waited (red only once it is overdue, over 24 hours). The
 * list never moves under the pointer or the keyboard focus: new cases wait behind a pill.
 */
export function QueuePane({ route, shortcuts }: { route: Route; shortcuts: boolean }) {
  const { t, locale, can } = useHub();
  const simple = useMode().mode === 'simple';
  const queue = useQueue();
  const actions = useCaseActions();
  const titleId = useId();
  const canTake = can('reports.decide');
  const openReport = route.name === 'report' ? route.id : null;
  // While a case or a person is open the queue can fold to one row (on a phone, where it would sit above the open pane). Each
  // screen starts folded; the fold is the stylesheet's, so a desktop never sees it.
  const paneKey = route.name === 'report' ? `report:${route.id}` : route.name === 'person' ? `person:${route.ref}` : null;
  const [unfolded, setUnfolded] = useState(false);
  useEffect(() => setUnfolded(false), [paneKey]);

  // Pointer and focus both count as "the cursor is in the list".
  const pointerIn = useRef(false);
  const focusIn = useRef(false);
  const sync = (): void => queue.setInteracting(pointerIn.current || focusIn.current);

  const people = queue.groups.length;
  const summary = listOf([t('hub.queue.people', { count: people }), t('hub.reports.row.reports', { count: queue.reports })], locale);

  let body;
  if (queue.status === 'loading') {
    body = (
      <div className="cw-queue-state">
        <p role="status" className="cw-sr">
          {t('hub.queue.loading')}
        </p>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="cw-case cw-case--skeleton">
            <Skeleton lines={3} />
          </div>
        ))}
      </div>
    );
  } else if (queue.status === 'error' && queue.error !== null) {
    body = (
      <div className="cw-error" role="alert">
        <p>
          <strong>{t('hub.state.loadFailed', { what: t('hub.state.what.reports') })}</strong> {errorText(t, queue.error)}
        </p>
        <button type="button" className="cw-btn" onClick={() => void queue.reload()}>
          {t('hub.state.retry')}
        </button>
      </div>
    );
  } else if (queue.rows.length === 0) {
    body = (
      <div className="cw-empty">
        <strong>{t('hub.queue.empty.title')}</strong>
        <p>{t('hub.queue.empty.body')}</p>
      </div>
    );
  } else if (queue.visible.length === 0) {
    body = (
      <div className="cw-empty">
        <p>{t('hub.queue.empty.filtered')}</p>
        <button type="button" className="cw-linkbtn" onClick={() => queue.setFilter({ claim: 'all', category: 'all' })}>
          {t('hub.queue.clearFilters')}
        </button>
      </div>
    );
  } else {
    body = (
      <ul className="cw-case-list" aria-label={t('hub.queue.list')}>
        {queue.visible.map((row) => (
          <CaseRow key={row.group.person} row={row} simple={simple} selected={openReport !== null && row.group.reportIds.includes(openReport)} onRelease={() => void actions.release(row.group.person)} />
        ))}
      </ul>
    );
  }

  return (
    <section className="cw-queue" aria-labelledby={titleId} {...(paneKey === null ? {} : { 'data-collapsed': unfolded ? 'false' : 'true' })}>
      {paneKey !== null && (
        <button type="button" className="cw-queue-toggle" aria-expanded={unfolded} onClick={() => setUnfolded((v) => !v)}>
          <span>{queue.status === 'ready' ? t('hub.queue.toggle', { count: people }) : t('hub.queue.title')}</span>
          <span className="cw-queue-toggle-state" aria-hidden="true">
            {t(unfolded ? 'hub.queue.toggle.hide' : 'hub.queue.toggle.show')}
          </span>
        </button>
      )}
      <div className="cw-queue-head">
        <div className="cw-queue-title">
          <h2 id={titleId}>{t('hub.queue.title')}</h2>
          {queue.status === 'ready' && <span>{summary}</span>}
        </div>
        {canTake && (
          <button type="button" className="cw-take" onClick={() => void actions.takeNext()} {...(shortcuts ? { 'aria-keyshortcuts': 'N' } : {})}>
            <span className="cw-take-text">
              {t('hub.queue.takeNext')}
              <small>{t('hub.queue.takeNextHint')}</small>
            </span>
            {shortcuts && <Kbd>N</Kbd>}
          </button>
        )}
        {!simple && (
          <div className="cw-seg" role="group" aria-label={t('hub.queue.filter.claim')}>
            {(['all', 'unclaimed', 'mine'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={queue.filter.claim === v} onClick={() => queue.setFilter({ claim: v })}>
                {t(`hub.queue.claim.${v}`)}
              </button>
            ))}
          </div>
        )}
        {!simple && (
          <label className="cw-select">
            <span className="cw-sr">{t('hub.queue.filter.category')}</span>
            <select value={queue.filter.category} onChange={(e) => queue.setFilter({ category: e.target.value as typeof queue.filter.category })}>
              <option value="all">{t('hub.queue.category.all')}</option>
              {CATEGORY_LIST.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(t, c)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="cw-newbar" role="status">
        {queue.incoming > 0 && (
          <button type="button" className="cw-newpill" title={t('hub.queue.newTitle')} onClick={queue.showIncoming}>
            {t('hub.queue.new', { count: queue.incoming })}
          </button>
        )}
      </div>
      <div
        className="cw-queue-list"
        onPointerEnter={() => {
          pointerIn.current = true;
          sync();
        }}
        onPointerLeave={() => {
          pointerIn.current = false;
          sync();
        }}
        onFocus={() => {
          focusIn.current = true;
          sync();
        }}
        onBlur={(e: FocusEvent<HTMLDivElement>) => {
          if (e.currentTarget.contains(e.relatedTarget)) return;
          focusIn.current = false;
          sync();
        }}
      >
        {body}
        {queue.partial && queue.status === 'ready' && <p className="cw-hint cw-queue-note">{t('hub.overview.stat.partial', { count: queue.reports })}</p>}
      </div>
    </section>
  );
}

/**
 * One case. The link opens it (and so claims it); the row's own button releases your claim. In Simple mode a claim is not shown
 * unless someone else holds the case ("maya is on it"), and nothing offers a release: leaving a case lets it go.
 */
function CaseRow({ row, simple, selected, onRelease }: { row: ShownRow; simple: boolean; selected: boolean; onRelease: () => void }) {
  const { t, locale, now, me } = useHub();
  const g = row.group;
  const name = groupName(t, g);
  const waiting = g.oldestOpenAt === null ? null : Math.max(0, now() - g.oldestOpenAt);
  const overdue = waiting !== null && waitTone(waiting) === 'stale';
  const holder = holderOf(g.claim, me.actor, now());
  const route: Route = { name: 'report', id: g.reportIds[0] as string };
  const viewers = g.viewing.map(actorName);
  const named = viewers.slice(0, VIEWERS_NAMED);
  const more = viewers.length - named.length;
  const viewerText = more > 0 ? t('hub.queue.row.viewingMore', { name: named[0] as string, count: more }) : (named[0] ?? '');

  return (
    <li className="cw-case" data-wait={overdue ? 'overdue' : 'ok'} data-claim={holder.kind} data-selected={selected ? 'true' : undefined} data-gone={row.gone ? 'true' : undefined}>
      <Link to={route} className="cw-case-link" {...(selected ? { 'aria-current': 'true' as const } : {})}>
        <span className="cw-case-main">
          <span className="cw-case-who">
            <span className="cw-case-name">{name}</span>
            {!simple && <PersonChip person={g.person} />}
          </span>
          <span className="cw-case-cats">
            {g.categories.map((c) => (
              <span key={c} className="cw-cat">
                {categoryLabel(t, c)}
              </span>
            ))}
          </span>
          <span className="cw-case-facts">
            {t('hub.queue.reports', { count: g.reports, reporters: t('hub.queue.reporters', { count: g.reporters }) })}
            {row.gone && <span className="cw-case-closed"> {t('hub.queue.row.gone')}</span>}
          </span>
        </span>
        <span className="cw-case-side">
          <span className="cw-case-wait" title={g.oldestOpenAt === null ? undefined : absoluteTime(g.oldestOpenAt, locale)}>
            {waiting === null ? '' : t('hub.reports.row.waiting', { duration: formatDuration(waiting, locale) })}
            {overdue && <span className="cw-sr"> {t('hub.queue.row.overdue')}</span>}
          </span>
          {simple ? (
            holder.kind === 'other' && (
              <span className="cw-case-claim">
                <span>{t('hub.simple.claim.rowTheirs', { name: actorName(holder.by) })}</span>
              </span>
            )
          ) : (
            <span className="cw-case-claim">
              {holder.kind === 'none' ? (
                <span className="cw-case-free">
                  {t('hub.queue.row.unclaimed')}
                  <span className="cw-sr"> {t('hub.queue.row.notHandled')}</span>
                </span>
              ) : (
                <>
                  <Avatar actor={holder.by} you={holder.kind === 'you'} size="s" />
                  <span aria-hidden="true">{holder.kind === 'you' ? t('hub.queue.row.you') : actorName(holder.by)}</span>
                  <span className="cw-sr">{holder.kind === 'you' ? t('hub.queue.row.handledByYou') : t('hub.queue.row.handledBy', { name: actorName(holder.by) })}</span>
                </>
              )}
            </span>
          )}
          {!simple && viewers.length > 0 && (
            <span className="cw-case-viewing">
              <Icon name="eye" />
              <span aria-hidden="true">{viewerText}</span>
              <span className="cw-sr">{t('hub.queue.row.viewing', { count: viewers.length, names: listOf(viewers, locale) })}</span>
            </span>
          )}
        </span>
      </Link>
      {!simple && holder.kind === 'you' && (
        <button type="button" className="cw-case-release" aria-label={t('hub.queue.row.releaseLabel', { who: name })} onClick={onRelease}>
          {t('hub.queue.row.release')}
        </button>
      )}
    </li>
  );
}
