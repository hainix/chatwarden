import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, ReactNode } from 'react';
import { actorName, holderOf } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { absoluteTime, formatDuration, listOf, waitTone } from '../format.js';
import { Icon } from '../icons.js';
import { errorText, groupName, reasonChip } from '../labels.js';
import { useQueue } from '../liveQueue.js';
import { useFeatures } from '../features.js';
import { LazyAiParts, LazyAppealList } from '../lazyParts.js';
import { hasAiRead } from '../queue.js';
import { useMode } from '../mode.js';
import type { ShownRow } from '../live.js';
import type { Route } from '../router.js';
import { Avatar, Kbd, Link, PersonChip, Segmented, Skeleton } from '../ui.js';

/** The people shown by name on a row before it says "and N more". */
const VIEWERS_NAMED = 1;
/** Skeleton rows while the first read is out. */
const SKELETON_ROWS = 5;

/** How a `CaseList` piece (no router, no shell) opens a row: the open case to mark, and where a click goes, if anywhere. */
export interface PieceRows {
  selected: string | null;
  onOpenCase: ((person: string, reportId: string) => void) | undefined;
}

/**
 * The queue pane: the open cases, one row per person, longest wait first. Each row says who is handling it (you in blue,
 * others plain), who is looking, the categories and how long it has waited (red only once it is overdue, over 24 hours). The
 * list never moves under the pointer or the keyboard focus: new cases wait behind a pill.
 */
export function QueuePane({ route, shortcuts, piece }: { route: Route | null; shortcuts: boolean; piece?: PieceRows }) {
  const { t, locale, can, go } = useHub();
  const simple = useMode().mode === 'simple';
  const queue = useQueue();
  // The Appeals view: the list source swaps (GET /appeals?status=open). It follows the route, so an address, the back button and Simple's line all agree.
  const features = useFeatures();
  const appealsView = features.appeals && piece === undefined && (route?.name === 'appeals' || route?.name === 'appeal');
  const openAppeal = route?.name === 'appeal' ? route.id : null;
  const waitingAppeals = queue.appeals ?? 0;
  const actions = useCaseActions();
  const titleId = useId();
  const canTake = can('reports.decide');
  const openReport = piece !== undefined ? piece.selected : route?.name === 'report' ? route.id : null;
  // While a case or a person is open the queue can fold to one row (on a phone, where it would sit above the open pane). Each
  // screen starts folded; the fold is the stylesheet's, so a desktop never sees it.
  const paneKey = route === null ? null : route.name === 'report' ? `report:${route.id}` : route.name === 'person' ? `person:${route.ref}` : route.name === 'appeal' ? `appeal:${route.id}` : null;
  const [unfolded, setUnfolded] = useState(false);
  useEffect(() => setUnfolded(false), [paneKey]);

  // Pointer and focus both count as "the cursor is in the list".
  const pointerIn = useRef(false);
  const focusIn = useRef(false);
  const sync = (): void => queue.setInteracting(pointerIn.current || focusIn.current);

  const people = queue.groups.length;
  const summary = listOf([t('hub.queue.people', { count: people }), t('hub.reports.row.reports', { count: queue.reports })], locale);

  let body;
  if (appealsView) {
    body = <LazyAppealList selected={openAppeal} />;
  } else if (queue.status === 'loading') {
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
        <button type="button" className="cw-linkbtn" onClick={() => queue.setFilter({ claim: 'all', category: 'all', reason: 'all' })}>
          {t('hub.queue.clearFilters')}
        </button>
      </div>
    );
  } else {
    body = (
      <ul className="cw-case-list" aria-label={t('hub.queue.list')}>
        {queue.visible.map((row) => (
          <CaseRow key={row.group.person} row={row} simple={simple} selected={openReport !== null && row.group.reportIds.includes(openReport)} piece={piece} onRelease={() => void actions.release(row.group.person)} />
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
          <h2 id={titleId}>{t(appealsView ? 'hub.appeals.queue.title' : 'hub.queue.title')}</h2>
          {appealsView ? <span>{t('hub.appeals.queue.count', { count: waitingAppeals })}</span> : queue.status === 'ready' && <span>{summary}</span>}
        </div>
        {features.appeals && !simple && piece === undefined && (
          <Segmented
            label={t('hub.appeals.switch.label')}
            value={appealsView ? 'appeals' : 'reports'}
            options={[
              { value: 'reports', label: t('hub.appeals.switch.reports') },
              { value: 'appeals', label: t('hub.appeals.switch.appeals', { count: waitingAppeals }) },
            ]}
            onChange={(v) => go(v === 'appeals' ? { name: 'appeals' } : { name: 'reports', status: 'open' })}
          />
        )}
        {canTake && !appealsView && (
          <button type="button" className="cw-take" onClick={() => void actions.takeNext()} {...(shortcuts ? { 'aria-keyshortcuts': 'N' } : {})}>
            <span className="cw-take-text">
              {queue.ranked ? (
                t('hub.queue.takeNext.priority')
              ) : (
                <>
                  {t('hub.queue.takeNext')}
                  <small>{t('hub.queue.takeNextHint')}</small>
                </>
              )}
            </span>
            {shortcuts && <Kbd>N</Kbd>}
          </button>
        )}
        {!simple && !appealsView && (
          <div className="cw-seg" role="group" aria-label={t('hub.queue.filter.claim')}>
            {(['all', 'unclaimed', 'mine'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={queue.filter.claim === v} onClick={() => queue.setFilter({ claim: v })}>
                {t(`hub.queue.claim.${v}`)}
              </button>
            ))}
          </div>
        )}
        {!simple && !appealsView && <ReasonFilter />}
      </div>
      <div className="cw-newbar" role="status">
        {!appealsView && queue.incoming > 0 && (
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
        {!appealsView && queue.partial && queue.status === 'ready' && <p className="cw-hint cw-queue-note">{t('hub.overview.stat.partial', { count: queue.reports })}</p>}
      </div>
    </section>
  );
}

/** The reasons in the queue (and "No reason given") to filter by: a person with any report that said so stays. */
function ReasonFilter() {
  const { t } = useHub();
  const queue = useQueue();
  const seen: Array<{ id: string; label: string }> = [];
  let none = false;
  for (const g of queue.groups) {
    for (const r of g.reasons) {
      if (r.id === null) none = true;
      else if (!seen.some((x) => x.id === r.id)) seen.push({ id: r.id, label: r.label ?? r.id });
    }
  }
  const value = queue.filter.reason ?? 'all';
  return (
    <label className="cw-select">
      <span className="cw-sr">{t('hub.queue.filter.reason')}</span>
      <select value={value} onChange={(e) => queue.setFilter({ reason: e.target.value })}>
        <option value="all">{t('hub.queue.reason.all')}</option>
        {seen.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
        {none && <option value="none">{t('hub.reason.none')}</option>}
        {value !== 'all' && value !== 'none' && !seen.some((r) => r.id === value) && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

/**
 * One case. The link opens it (and so claims it); the row's own button releases your claim. In Simple mode a claim is not shown
 * unless someone else holds the case ("maya is on it"), and nothing offers a release: leaving a case lets it go.
 */
function CaseRow({ row, simple, selected, piece, onRelease }: { row: ShownRow; simple: boolean; selected: boolean; piece: PieceRows | undefined; onRelease: () => void }) {
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

  const inner = (
    <>
      <span className="cw-case-main">
        <span className="cw-case-who">
          <span className="cw-case-name">{name}</span>
          {!simple && <PersonChip person={g.person} />}
        </span>
        <span className="cw-case-cats">
          {g.reasons.map((r) => (
            <span key={r.id ?? 'none'} className="cw-cat">
              {reasonChip(t, r.label)}
            </span>
          ))}
          {!simple && hasAiRead(g) && <LazyAiParts part="chip" group={g} />}
        </span>
        <span className="cw-case-facts">
          {t('hub.queue.reports', { count: g.reports, reporters: t('hub.queue.reporters', { count: g.reporters }) })}
          {row.gone && <span className="cw-case-closed"> {t('hub.queue.row.gone')}</span>}
          {g.rankedLow === true && <span className="cw-sr"> {t('hub.queue.row.rankedLow')}</span>}
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
    </>
  );
  const current = selected ? { 'aria-current': 'true' as const } : {};
  // In the hub a row is a link to the case. In a piece there is no router: a button that tells the adopter's callback, or plain text.
  const rowFor = (body: ReactNode): ReactNode => {
    if (piece === undefined) {
      return (
        <Link to={route} className="cw-case-link" {...current}>
          {body}
        </Link>
      );
    }
    const open = piece.onOpenCase;
    if (open === undefined) return <div className="cw-case-link" {...current}>{body}</div>;
    return (
      <button type="button" className="cw-case-link" {...current} onClick={() => open(g.person, g.reportIds[0] as string)}>
        {body}
      </button>
    );
  };

  return (
    <li
      className="cw-case"
      data-wait={overdue ? 'overdue' : 'ok'}
      data-claim={holder.kind}
      data-selected={selected ? 'true' : undefined}
      data-gone={row.gone ? 'true' : undefined}
      data-ranked={g.rankedLow === true ? 'low' : undefined}
    >
      {rowFor(inner)}
      {!simple && holder.kind === 'you' && (
        <button type="button" className="cw-case-release" aria-label={t('hub.queue.row.releaseLabel', { who: name })} onClick={onRelease}>
          {t('hub.queue.row.release')}
        </button>
      )}
    </li>
  );
}
