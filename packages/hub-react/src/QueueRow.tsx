import { useState } from 'react';
import { useHub } from './context.js';
import { absoluteTime, formatDuration, personTag, relativeTime, waitTone } from './format.js';
import { categoryLabel } from './labels.js';
import type { QueueGroup } from './queue.js';
import { Link, PersonChip, Tag } from './ui.js';

/** How many earlier reports show before the "N more" toggle. */
export const EARLIER_SHOWN = 3;

/**
 * One reported person in a queue: who, how much is waiting, how long, and the two ways in (their newest report, their history).
 * The left edge carries the wait: its colour follows how long the oldest open report has waited, and the words say the same.
 * Used by the Reports screen and the Overview's "Needs review".
 */
export function QueueRow({ group, showStatus = false, earlier = true }: { group: QueueGroup; showStatus?: boolean; earlier?: boolean }) {
  const { t, locale, now } = useHub();
  const [expanded, setExpanded] = useState(false);
  const name = group.handle ?? t('hub.reports.row.unnamed');
  const who = group.handle ?? `${t('hub.person.prefix')} ${personTag(group.person)}`;
  const waiting = group.oldestOpenAt === null ? null : Math.max(0, now() - group.oldestOpenAt);
  const older = group.reportIds.slice(1);
  const shown = expanded ? older : older.slice(0, EARLIER_SHOWN);
  const hidden = older.length - EARLIER_SHOWN;

  return (
    <li className="cw-qrow" data-wait={waiting === null ? 'none' : waitTone(waiting)}>
      <div className="cw-qrow-main">
        <div className="cw-qrow-who">
          <span className="cw-qrow-name">{name}</span>
          <PersonChip person={group.person} />
          {group.categories.map((c) => (
            <Tag key={c} tone="bad">
              {categoryLabel(t, c)}
            </Tag>
          ))}
          {showStatus && group.open > 0 && <Tag tone="warn">{t('hub.reports.tag.open')}</Tag>}
          {showStatus && group.actioned > 0 && <Tag tone="ok">{t('hub.reports.tag.actioned')}</Tag>}
          {showStatus && group.dismissed > 0 && <Tag>{t('hub.reports.tag.dismissed')}</Tag>}
        </div>
        <div className="cw-facts">
          <span>{t('hub.reports.row.reports', { count: group.reports })}</span>
          <span>{t('hub.reports.row.rooms', { count: group.rooms.length })}</span>
          <span>{t('hub.reports.row.reporters', { count: group.reporters })}</span>
          {group.handles.length > 1 && <span>{t('hub.reports.row.alsoSeenAs', { names: group.handles.slice(1).join(', ') })}</span>}
        </div>
        {earlier && older.length > 0 && (
          <div className="cw-earlier">
            <ul aria-label={t('hub.reports.row.earlier')}>
              {shown.map((id) => (
                <li key={id}>
                  <Link to={{ name: 'report', id }} aria-label={t('hub.reports.row.earlierLabel', { id: id.slice(0, 8) })}>
                    {id.slice(0, 8)}
                  </Link>
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <button type="button" className="cw-linkbtn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? t('hub.reports.row.lessEarlier') : t('hub.reports.row.moreEarlier', { count: hidden })}
              </button>
            )}
          </div>
        )}
      </div>
      <p className="cw-qrow-age" title={absoluteTime(group.oldestOpenAt ?? group.latestAt, locale)}>
        {waiting === null
          ? t('hub.reports.row.latest', { time: relativeTime(group.latestAt, now(), locale) })
          : t('hub.reports.row.waiting', { duration: formatDuration(waiting, locale) })}
      </p>
      <div className="cw-qrow-actions">
        <Link
          to={{ name: 'report', id: group.reportIds[0] as string }}
          className="cw-btn cw-btn--primary"
          aria-label={t('hub.reports.row.reviewLabel', { who })}
        >
          {t('hub.reports.row.review')}
        </Link>
        <Link to={{ name: 'person', ref: group.person }} className="cw-btn" aria-label={t('hub.reports.row.historyLabel', { who })}>
          {t('hub.reports.row.history')}
        </Link>
      </div>
    </li>
  );
}
