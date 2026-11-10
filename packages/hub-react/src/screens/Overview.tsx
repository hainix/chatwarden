import { useMemo } from 'react';
import { fetchAll } from '../client.js';
import { useHub } from '../context.js';
import { formatDuration, personTag, waitTone } from '../format.js';
import { useHubData } from '../hooks.js';
import type { HubData } from '../hooks.js';
import { kindLabel, ruleLabel, sanctionLength, sanctionState, sourceLabel } from '../labels.js';
import { groupQueue, queueStats } from '../queue.js';
import type { QueueGroup } from '../queue.js';
import { QueueRow } from '../QueueRow.js';
import type { Page, ReportSummary, SanctionRow } from '../types.js';
import { Empty, Fetched, Link, Panel, PersonChip, Tag, Time } from '../ui.js';
import type { Tone } from '../ui.js';

/** The open queue is read 200 reports a page, up to 5 pages: 1,000 reports. Past that the numbers say they are partial. */
export const OVERVIEW_PAGE = 200;
export const OVERVIEW_MAX_PAGES = 5;
/** Groups shown under "Needs review". */
export const REVIEW_SHOWN = 5;
/** Sanctions shown under "Recent actions". */
export const RECENT_SHOWN = 10;

interface OpenQueue {
  groups: QueueGroup[];
  reports: number;
  partial: boolean;
}

/**
 * The landing screen: what is waiting (the numbers and the people who have waited longest), and what was done lately. The
 * numbers come from the open queue alone, grouped here; no single report is opened, because opening one is an audited read.
 * Each panel loads and fails on its own, and a panel the role cannot read is left out.
 */
export function Overview() {
  const { t, can } = useHub();
  const showQueue = can('reports.read');
  const showRecent = can('history.read');
  return (
    <div className="cw-screen">
      <h2 className="cw-screen-title">{t('hub.overview.title')}</h2>
      {showQueue && <QueueSection withRecent={showRecent} />}
      {!showQueue && showRecent && <RecentActions />}
    </div>
  );
}

function QueueSection({ withRecent }: { withRecent: boolean }) {
  const { client, t } = useHub();
  const state: HubData<OpenQueue> = useHubData('overview:queue', async () => {
    const all: Page<ReportSummary> = await fetchAll(
      (cursor) => client.listReports({ status: 'open', limit: OVERVIEW_PAGE, ...(cursor === undefined ? {} : { cursor }) }),
      { maxPages: OVERVIEW_MAX_PAGES },
    );
    return { groups: groupQueue(all.items, { sort: 'oldest' }), reports: all.items.length, partial: all.next !== null };
  });
  return (
    <>
      <Stats queue={state.data} />
      <div className={withRecent ? 'cw-cols' : undefined}>
        <Panel
          title={t('hub.overview.review.title')}
          action={
            <Link to={{ name: 'reports', status: 'open' }} className="cw-link">
              {t('hub.overview.review.all')}
            </Link>
          }
        >
          <Fetched state={state} what={t('hub.state.what.reports')}>
            {(queue) =>
              queue.groups.length === 0 ? (
                <Empty title={t('hub.overview.review.empty.title')}>{t('hub.overview.review.empty.body')}</Empty>
              ) : (
                <ul className="cw-qlist" aria-label={t('hub.reports.list.label')}>
                  {queue.groups.slice(0, REVIEW_SHOWN).map((g) => (
                    <QueueRow key={g.person} group={g} earlier={false} />
                  ))}
                </ul>
              )
            }
          </Fetched>
        </Panel>
        {withRecent && <RecentActions />}
      </div>
    </>
  );
}

function Stats({ queue }: { queue: OpenQueue | undefined }) {
  const { t, locale, now } = useHub();
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const stats = queue === undefined ? null : queueStats(queue.groups, now());
  const dash = '–';
  const wait = stats?.longestWaitMs ?? null;
  const oldest = stats?.oldestGroup ?? null;

  let longest = dash;
  let note = '';
  if (stats !== null) {
    longest = wait === null ? t('hub.overview.stat.none') : formatDuration(wait, locale);
    const who = oldest === null ? '' : (oldest.handle ?? `${t('hub.person.prefix')} ${personTag(oldest.person)}`);
    note = oldest === null ? t('hub.overview.stat.nobody') : t('hub.overview.stat.longestNote', { who });
  }

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
          {queue?.partial === true && <dd className="cw-stat-note">{t('hub.overview.stat.partial', { count: queue.reports })}</dd>}
        </div>
        <div className="cw-stat" data-wait={wait === null ? undefined : waitTone(wait)}>
          <dt>{t('hub.overview.stat.longest')}</dt>
          <dd className="cw-stat-value">{longest}</dd>
          <dd className="cw-stat-note">{note}</dd>
        </div>
      </dl>
    </section>
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

const STATE_TONE: Record<ReturnType<typeof sanctionState>, Tone> = { active: 'accent', pending: 'idle', ended: 'idle', revoked: 'idle' };
const STATE_KEY = {
  active: 'hub.sanction.status.active',
  pending: 'hub.sanction.status.pending',
  ended: 'hub.sanction.status.ended',
  revoked: 'hub.sanction.status.revoked',
} as const;

/** One sanction: what and how long, its state, who it is on, the rule, who made it, and when. */
function ActionRow({ sanction: s }: { sanction: SanctionRow }) {
  const { t, locale } = useHub();
  const state = sanctionState(s);
  const length = sanctionLength(t, locale, s);
  return (
    <li className="cw-arow">
      <div className="cw-arow-head">
        <strong>{kindLabel(t, s.kind)}</strong>
        {length !== '' && <span className="cw-arow-length">{length}</span>}
        <Tag tone={STATE_TONE[state]}>{t(STATE_KEY[state])}</Tag>
        {s.source !== 'moderator' && <Tag tone="accent">{sourceLabel(t, s.source)}</Tag>}
      </div>
      <div className="cw-facts">
        <Link to={{ name: 'person', ref: s.person }} className="cw-link">
          <PersonChip person={s.person} />
        </Link>
        <span>{ruleLabel(t, s.rule)}</span>
        <span>{s.automated ? t('hub.sanction.automatic') : t('hub.sanction.by', { actor: s.actor })}</span>
        <Time at={s.startsAt} />
      </div>
    </li>
  );
}
