import { useMemo, useState } from 'react';
import { useHub } from '../context.js';
import { DecisionPanel } from '../DecisionPanel.js';
import { excerptLines, filterLines, peopleOfReport, personName, recordSummary } from '../excerpt.js';
import type { ExcerptLine, ReportPerson } from '../excerpt.js';
import { absoluteTime, listOf, relativeTime, timeOfDay } from '../format.js';
import { useHubData } from '../hooks.js';
import { categoryLabel } from '../labels.js';
import type { HubText } from '../i18n.js';
import type { ActionRecord, ReportDetail, SanctionKind, StaffReport } from '../types.js';
import { Empty, Fetched, Link, Notice, Panel, PersonChip, Segmented, Tag } from '../ui.js';

// The report page: what was reported and by whom, who is in it, what was said, and (beside it) the decision.

const RECORD_KIND: Record<SanctionKind, HubText> = {
  warning: 'hub.report.record.kind.warning',
  chat: 'hub.report.record.kind.chat',
  area: 'hub.report.record.kind.area',
  ban: 'hub.report.record.kind.ban',
  note: 'hub.report.record.kind.note',
};
const KIND_ORDER: readonly SanctionKind[] = ['warning', 'chat', 'area', 'ban', 'note'];

/** One person's last 90 days as a sentence: what stands, by kind, and how many were revoked. */
function RecordLine({ history }: { history: readonly ActionRecord[] }) {
  const { t, locale } = useHub();
  const { counts, total, revoked } = recordSummary(history);
  const parts = KIND_ORDER.flatMap((k) => (counts[k] === undefined ? [] : [t(RECORD_KIND[k], { count: counts[k] })]));
  const lead = total === 0 ? t('hub.report.record.none') : t('hub.report.record.some', { list: listOf(parts, locale) });
  return <p className="cw-person-record">{revoked > 0 ? `${lead} ${t('hub.report.record.revoked', { count: revoked })}` : lead}</p>;
}

/** How the reports this person filed stand. A failure here never takes the page down. */
function ReporterLine({ person, version }: { person: string; version: number }) {
  const { client, t, locale, now } = useHub();
  const state = useHubData(`reporter:${person}:${version}`, () => client.personHistory(person, { limit: 1 }));
  if (state.data === undefined) {
    return state.error === null ? null : <p className="cw-hint">{t('hub.report.reporter.unavailable')}</p>;
  }
  const r = state.data.asReporter;
  const filed = t('hub.report.reporter.filed', { count: r.reports, open: r.open, actioned: r.actioned, dismissed: r.dismissed });
  const suspended = r.suspendedUntil !== null && r.suspendedUntil > now();
  return (
    <>
      <p className="cw-person-record">{r.badFaith > 0 ? `${filed} ${t('hub.report.reporter.badFaith', { count: r.badFaith })}` : filed}</p>
      {suspended && r.suspendedUntil !== null && (
        <p>
          <Tag tone="warn">{t('hub.report.reporter.suspended', { time: absoluteTime(r.suspendedUntil, locale) })}</Tag>
        </p>
      )}
    </>
  );
}

function PeopleList({ people, history, version }: { people: ReportPerson[]; history: ReportDetail['history']; version: number }) {
  const { t, can } = useHub();
  return (
    <ul className="cw-people" aria-label={t('hub.report.people.label')}>
      {people.map((p) => {
        const name = personName(p, people, t('hub.person.prefix'));
        return (
          <li key={p.ref} className="cw-person">
            <div className="cw-person-head">
              <span className="cw-person-name">{name}</span>
              <PersonChip person={p.ref} />
              {p.role === 'target' && <Tag tone="bad">{t('hub.report.role.target')}</Tag>}
              {p.role === 'reporter' && <Tag tone="accent">{t('hub.report.role.reporter')}</Tag>}
            </div>
            <p className="cw-hint">{p.lines === 0 ? t('hub.report.person.silent') : t('hub.report.person.wrote', { count: p.lines })}</p>
            <RecordLine history={history[p.ref] ?? []} />
            {p.role === 'reporter' && can('history.read') && <ReporterLine person={p.ref} version={version} />}
            {can('history.read') && (
              <Link to={{ name: 'person', ref: p.ref }} className="cw-link" aria-label={t('hub.reports.row.historyLabel', { who: name })}>
                {t('hub.reports.row.history')}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Line({ line }: { line: ExcerptLine }) {
  const { t, locale } = useHub();
  const showDelivered = line.delivered !== null && line.delivered !== line.raw;
  return (
    <li className="cw-line" {...(line.reported ? { 'data-reported': 'true' } : {})} {...(line.blocked ? { 'data-blocked': 'true' } : {})}>
      <time className="cw-line-time" dateTime={new Date(line.ts).toISOString()}>
        {timeOfDay(line.ts, locale)}
      </time>
      <span className="cw-line-who">{line.handle}</span>
      <span className="cw-line-text">{line.raw}</span>
      {(line.reported || line.blocked || line.audience !== null || showDelivered) && (
        <span className="cw-line-meta">
          {line.reported && <Tag tone="accent">{t('hub.report.line.reported')}</Tag>}
          {line.blocked && <Tag tone="bad">{t('hub.report.line.blocked')}</Tag>}
          {line.audience !== null && <Tag>{t('hub.report.line.audience', { count: line.audience.length })}</Tag>}
          {showDelivered && <span className="cw-hint">{t('hub.report.line.delivered', { text: line.delivered ?? '' })}</span>}
        </span>
      )}
    </li>
  );
}

/** The saved chat around the report, with a filter to one person and a warning when someone sent nothing. */
function Excerpt({ report, people }: { report: StaffReport; people: ReportPerson[] }) {
  const { t } = useHub();
  const [only, setOnly] = useState('');
  const all = useMemo(() => excerptLines(report), [report]);
  const shown = filterLines(all, only === '' ? null : only);
  // The person to warn about: whoever is picked, else (with Everyone) the reported person. Either may have written nothing.
  const focus = only === '' ? people.find((p) => p.role === 'target') : people.find((p) => p.ref === only);
  const quiet = focus !== undefined && focus.lines === 0 ? focus : undefined;

  return (
    <Panel title={t('hub.report.excerpt.title')}>
      {all.length === 0 ? (
        <Empty>{t('hub.report.excerpt.empty')}</Empty>
      ) : (
        <div className="cw-excerpt">
          <div className="cw-bar">
            <Segmented
              label={t('hub.report.excerpt.filter')}
              value={only}
              options={[
                { value: '', label: t('hub.report.excerpt.everyone') },
                ...people.map((p) => ({ value: p.ref, label: t('hub.report.excerpt.only', { name: personName(p, people, t('hub.person.prefix')) }) })),
              ]}
              onChange={setOnly}
            />
            <p className="cw-hint">{t('hub.report.excerpt.count', { count: all.length })}</p>
          </div>
          {quiet !== undefined && <Notice tone="warn">{t('hub.report.excerpt.silent', { name: personName(quiet, people, t('hub.person.prefix')) })}</Notice>}
          {shown.length > 0 && (
            <ol className="cw-lines" aria-label={t('hub.report.excerpt.label')}>
              {shown.map((l) => (
                <Line key={l.id} line={l} />
              ))}
            </ol>
          )}
        </div>
      )}
    </Panel>
  );
}

function ReportBody({ detail, reload }: { detail: ReportDetail; reload: () => void }) {
  const { t, locale, now } = useHub();
  const [version, setVersion] = useState(0);
  const { report } = detail;
  const people = useMemo(() => peopleOfReport(report), [report]);
  const entries = Object.entries(report.tags);

  return (
    <>
      <div className="cw-facts" role="group" aria-label={t('hub.report.facts.label')}>
        <Tag tone="bad">{categoryLabel(t, report.category)}</Tag>
        <Tag tone={report.status === 'open' ? 'warn' : report.status === 'actioned' ? 'ok' : 'idle'}>{t(`hub.reports.tag.${report.status}`)}</Tag>
        {report.badFaith && <Tag tone="bad">{t('hub.report.tag.badFaith')}</Tag>}
        <span title={absoluteTime(report.createdAt, locale)}>{t('hub.report.fact.filed', { time: relativeTime(report.createdAt, now(), locale) })}</span>
        {report.roomId !== '' && <span>{t('hub.report.fact.room', { room: report.roomId })}</span>}
        {entries.map(([key, value]) => (
          <span key={key}>{t('hub.report.fact.tag', { key, value })}</span>
        ))}
      </div>
      <div className="cw-cols cw-cols--report">
        <div className="cw-report-main">
          <Panel title={t('hub.report.what.title')}>
            <div className="cw-note">
              <h3>{t('hub.report.note.label')}</h3>
              {report.note === null || report.note.trim() === '' ? <p className="cw-hint">{t('hub.report.note.none')}</p> : <p className="cw-note-text">{report.note}</p>}
            </div>
          </Panel>
          <Panel title={t('hub.report.people.title')}>
            <PeopleList people={people} history={detail.history} version={version} />
          </Panel>
          <Excerpt report={report} people={people} />
        </div>
        <DecisionPanel
          detail={detail}
          people={people}
          onDecided={() => {
            setVersion((v) => v + 1);
            reload();
          }}
          onConflict={reload}
        />
      </div>
    </>
  );
}

/** `#/reports/:id`. */
export function Report({ id }: { id: string }) {
  const { client, t } = useHub();
  const state = useHubData(`report:${id}`, () => client.getReport(id));
  const report = state.data?.report;
  let title = t('hub.report.heading');
  if (report !== undefined) {
    const people = peopleOfReport(report);
    const target = people.find((p) => p.role === 'target') as ReportPerson;
    title = t('hub.report.title', { category: categoryLabel(t, report.category), who: personName(target, people, t('hub.person.prefix')) });
  }
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {title}
        </h2>
        <Link to={{ name: 'reports', status: 'open' }} className="cw-link">
          {t('hub.report.back')}
        </Link>
      </div>
      <Fetched state={state} what={t('hub.state.what.report')}>
        {(detail) => <ReportBody detail={detail} reload={state.reload} />}
      </Fetched>
    </div>
  );
}
