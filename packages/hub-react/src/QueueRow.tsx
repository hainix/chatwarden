import { useState } from 'react';
import { useHub } from './context.js';
import { absoluteTime, formatDuration, personTag, relativeTime, waitTone } from './format.js';
import { reasonChip } from './labels.js';
import type { QueueGroup } from './queue.js';
import type { AiBrief } from './types.js';
import { Link, PersonChip, Tag } from './ui.js';

/**
 * The queue's one AI chip: the conduct level the AI read, in a word, neutral with a dashed outline (machine-written). It says nothing of the
 * evidence; a stale read or a flagged line shows only in the case's AI details.
 */
export function AiChip({ ai }: { ai: AiBrief | null | undefined }) {
  const { t } = useHub();
  if (ai == null) return null;
  return (
    <span className="cw-aichip" title={t('hub.ai.label')}>
      <span className="cw-sr">{t('hub.ai.chip')} </span>
      {t(`hub.decide.suggest.level.${ai.severity}`)}
    </span>
  );
}

/** How many earlier reports the disclosure lists; older ones are in the person's history. */
export const EARLIER_SHOWN = 10;

/**
 * One reported person in a queue: who, how much is waiting, how long, and the two ways in (their newest report, their history).
 * The left edge carries the wait: its colour follows how long the oldest open report has waited, and the words say the same.
 * Used by the Reports screen and the Overview's "Needs review".
 */
export function QueueRow({ group, showStatus = false, earlier = true }: { group: QueueGroup; showStatus?: boolean; earlier?: boolean }) {
  const { t, locale, now } = useHub();
  const [expanded, setExpanded] = useState(false);
  const name = group.handle ?? t('hub.reports.row.unnamed');
  const who = group.handle ?? t('hub.person.unnamed', { tag: personTag(group.person) });
  const waiting = group.oldestOpenAt === null ? null : Math.max(0, now() - group.oldestOpenAt);
  const older = group.entries.slice(1);
  const shown = older.slice(0, EARLIER_SHOWN);
  const hidden = older.length - shown.length;

  return (
    <li className="cw-qrow" data-wait={waiting === null ? 'none' : waitTone(waiting)}>
      <div className="cw-qrow-main">
        <div className="cw-qrow-who">
          <span className="cw-qrow-name">{name}</span>
          <PersonChip person={group.person} />
          {group.reasons.map((r) => (
            <Tag key={r.id ?? 'none'}>{reasonChip(t, r.label)}</Tag>
          ))}
          <AiChip ai={group.ai} />
          {showStatus && group.open > 0 && <Tag>{t('hub.reports.tag.open')}</Tag>}
          {showStatus && group.actioned > 0 && <Tag>{t('hub.reports.tag.actioned')}</Tag>}
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
            <button type="button" className="cw-linkbtn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? t('hub.reports.row.earlierHide') : t('hub.reports.row.earlierShow', { count: older.length })}
            </button>
            {expanded && (
              <ul aria-label={t('hub.reports.row.earlier')}>
                {shown.map((e) => (
                  <li key={e.id}>
                    <Link to={{ name: 'report', id: e.id }} className="cw-link">
                      {t('hub.reports.row.earlierItem', { category: reasonChip(t, e.reasonLabel), time: relativeTime(e.createdAt, now(), locale) })}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {expanded && hidden > 0 && <p className="cw-hint">{t('hub.reports.row.earlierMore', { count: hidden })}</p>}
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
