import { actorName, holderOf } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { useQueue } from '../liveQueue.js';
import { Avatar, Link, Skeleton } from '../ui.js';

/**
 * The pane beside an open case: who is handling it, who else is looking, and the way to the person's record. A case someone
 * else holds can be read, not decided; a claim you hold is released after 10 minutes without activity, or when you let go.
 */
export function CasePanel({ reportId }: { reportId: string }) {
  const { t, can, me, now } = useHub();
  const queue = useQueue();
  const actions = useCaseActions();
  const group = queue.groups.find((g) => g.reportIds.includes(reportId)) ?? null;

  let body;
  if (queue.status === 'loading') body = <Skeleton lines={3} />;
  else if (group === null) body = <p className="cw-hint">{t('hub.case.closed')}</p>;
  else {
    const holder = holderOf(group.claim, me.actor, now());
    body = (
      <>
        <div className="cw-case-state" data-claim={holder.kind}>
          {holder.kind !== 'none' && <Avatar actor={holder.by} you={holder.kind === 'you'} />}
          <p>
            {holder.kind === 'you'
              ? t('hub.case.handling.you')
              : holder.kind === 'other'
                ? t('hub.case.handling.byName', { name: actorName(holder.by) })
                : t('hub.case.handling.none')}
          </p>
        </div>
        {holder.kind === 'you' && (
          <>
            <p className="cw-hint">{t('hub.case.idle')}</p>
            <button type="button" className="cw-btn" onClick={() => void actions.release(group.person)}>
              {t('hub.case.release')}
            </button>
          </>
        )}
        {holder.kind === 'other' && can('reports.decide') && <p className="cw-hint">{t('hub.case.readOnly')}</p>}
        {group.viewing.length > 0 && (
          <div className="cw-case-viewers">
            <h3>{t('hub.case.viewing')}</h3>
            <ul>
              {group.viewing.map((v) => (
                <li key={v}>
                  <Avatar actor={v} size="s" />
                  <span>{actorName(v)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Link to={{ name: 'person', ref: group.person }} className="cw-link">
          {t('hub.case.person')}
        </Link>
      </>
    );
  }

  return (
    <aside className="cw-ctx" aria-label={t('hub.case.label')}>
      <h2 className="cw-ctx-title">{t('hub.case.title')}</h2>
      {body}
    </aside>
  );
}
