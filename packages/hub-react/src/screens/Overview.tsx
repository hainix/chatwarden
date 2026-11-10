import { useMemo } from 'react';
import { actorName, liveClaim, teamOf } from '../claims.js';
import { useHub } from '../context.js';
import { formatDuration, waitTone } from '../format.js';
import { useHubData } from '../hooks.js';
import { groupName, kindLabel, ruleLabel, sanctionLength, sanctionState, sourceLabel } from '../labels.js';
import { useOptionalQueue } from '../liveQueue.js';
import type { LiveQueue } from '../liveQueue.js';
import { queueStats } from '../queue.js';
import type { SanctionRow } from '../types.js';
import { Avatar, Card, Empty, Fetched, Link, Panel, PersonChip, Skeleton, Tag, Time } from '../ui.js';

/** Sanctions shown under "Recent actions". */
export const RECENT_SHOWN = 10;

/**
 * The landing screen, now the team view: what is waiting (the numbers and the oldest wait), who is on and what each person is
 * holding, and what was done lately. The numbers come from the live queue the shell already keeps, so this screen asks the
 * server for nothing of its own except the recent actions. There is no ranking of moderators: load is shown so a team can
 * share it out, and speed is not shown because it rewards the wrong thing.
 */
export function Overview() {
  const { t, can } = useHub();
  const queue = useOptionalQueue();
  const showRecent = can('history.read');
  return (
    <div className="cw-screen">
      <h2 className="cw-screen-title" tabIndex={-1}>{t('hub.overview.title')}</h2>
      {queue !== null && <Stats queue={queue} />}
      <div className={queue !== null && showRecent ? 'cw-cols' : undefined}>
        {queue !== null && <Team queue={queue} />}
        {showRecent && <RecentActions />}
      </div>
    </div>
  );
}

function Stats({ queue }: { queue: LiveQueue }) {
  const { t, locale, now } = useHub();
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const ready = queue.status === 'ready';
  const stats = ready ? queueStats(queue.groups, now()) : null;
  const unclaimed = ready ? queue.groups.filter((g) => liveClaim(g.claim, now()) === null).length : 0;
  const dash = '–';
  const wait = stats?.longestWaitMs ?? null;
  const oldest = stats?.oldestGroup ?? null;

  let longest = dash;
  let note = '';
  if (stats !== null) {
    longest = wait === null ? t('hub.overview.stat.none') : formatDuration(wait, locale);
    note = oldest === null ? t('hub.overview.stat.nobody') : t('hub.overview.stat.longestNote', { who: groupName(t, oldest) });
  }
  const overdue = wait !== null && waitTone(wait) === 'stale';

  return (
    <section className="cw-stats" aria-label={t('hub.overview.stats.label')}>
      <dl>
        <div className="cw-stat">
          <dt>{t('hub.overview.stat.people')}</dt>
          <dd className="cw-stat-value">{stats === null ? dash : numbers.format(stats.people)}</dd>
        </div>
        <div className="cw-stat">
          <dt>{t('hub.overview.stat.reports')}</dt>
          <dd className="cw-stat-value">{stats === null ? dash : numbers.format(stats.reports)}</dd>
          {queue.partial && <dd className="cw-stat-note">{t('hub.overview.stat.partial', { count: queue.reports })}</dd>}
        </div>
        <div className="cw-stat" data-wait={wait === null ? undefined : overdue ? 'overdue' : 'ok'}>
          <dt>{t('hub.overview.stat.longest')}</dt>
          <dd className="cw-stat-value">{longest}</dd>
          <dd className="cw-stat-note">{note}</dd>
          {queue.partial && wait !== null && <dd className="cw-stat-note">{t('hub.overview.stat.longestPartial')}</dd>}
        </div>
        <div className="cw-stat">
          <dt>{t('hub.overview.stat.unclaimed')}</dt>
          <dd className="cw-stat-value">{stats === null ? dash : numbers.format(unclaimed)}</dd>
          <dd className="cw-stat-note">{stats === null ? '' : unclaimed === 0 ? t('hub.overview.stat.unclaimedNone') : t('hub.overview.stat.unclaimedNote')}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Who is on, from who holds or views a case, with what each is carrying. */
function Team({ queue }: { queue: LiveQueue }) {
  const { t, me, now } = useHub();
  const team = teamOf(queue.groups, me.actor, now());
  return (
    <Panel title={t('hub.team.title')}>
      {queue.status === 'loading' ? (
        <div className="cw-panel-pad">
          <p role="status" className="cw-sr">
            {t('hub.queue.loading')}
          </p>
          <Skeleton lines={3} />
        </div>
      ) : (
        <>
          <ul className="cw-team" aria-label={t('hub.team.list')}>
            {team.map((m) => (
              <li key={m.actor} className="cw-member">
                <Avatar actor={m.actor} you={m.you} />
                <div className="cw-member-text">
                  <strong>
                    {actorName(m.actor)}
                    {m.you && <span className="cw-member-you"> {t('hub.team.you')}</span>}
                  </strong>
                  <span>{t('hub.team.handling', { count: m.handling })}</span>
                  {m.viewing > 0 && <span>{t('hub.team.viewing', { count: m.viewing })}</span>}
                </div>
              </li>
            ))}
          </ul>
          {team.length === 1 && <p className="cw-hint cw-panel-pad">{t('hub.team.alone')}</p>}
        </>
      )}
    </Panel>
  );
}

function RecentActions() {
  const { client, t } = useHub();
  const state = useHubData('overview:recent', () => client.listSanctions({ limit: RECENT_SHOWN }));
  return (
    <Panel title={t('hub.overview.recent.title')}>
      <Fetched state={state} what={t('hub.state.what.actions')}>
        {(page) =>
          page.items.length === 0 ? (
            <Empty>{t('hub.overview.recent.empty')}</Empty>
          ) : (
            <ul className="cw-alist">
              {page.items.slice(0, RECENT_SHOWN).map((s) => (
                <ActionRow key={s.groupId} sanction={s} />
              ))}
            </ul>
          )
        }
      </Fetched>
    </Panel>
  );
}

const STATE_KEY = {
  active: 'hub.sanction.status.active',
  pending: 'hub.sanction.status.pending',
  ended: 'hub.sanction.status.ended',
  revoked: 'hub.sanction.status.revoked',
} as const;

/** One sanction: the referee card for its kind, what and how long, its state, who it is on, the rule, who made it, and when. */
function ActionRow({ sanction: s }: { sanction: SanctionRow }) {
  const { t, locale } = useHub();
  const state = sanctionState(s);
  const length = sanctionLength(t, locale, s);
  return (
    <li className="cw-arow">
      <Card kind={s.kind} />
      <div className="cw-arow-body">
        <div className="cw-arow-head">
          <strong>{kindLabel(t, s.kind)}</strong>
          {length !== '' && <span className="cw-arow-length">{length}</span>}
          <Tag>{t(STATE_KEY[state])}</Tag>
          {s.source !== 'moderator' && <Tag>{sourceLabel(t, s.source)}</Tag>}
        </div>
        <div className="cw-facts">
          <Link to={{ name: 'person', ref: s.person }} className="cw-link">
            <PersonChip person={s.person} />
          </Link>
          <span>{ruleLabel(t, s.rule)}</span>
          <span>{s.automated ? t('hub.sanction.automatic') : t('hub.sanction.by', { actor: s.actor })}</span>
          <Time at={s.startsAt} />
        </div>
      </div>
    </li>
  );
}
