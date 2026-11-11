import { useId } from 'react';
import type { ReactNode } from 'react';
import { Masked } from '../case/Transcript.js';
import { RecordItem } from '../case/Record.js';
import { ReporterStanding, ReporterTotals } from '../case/ReporterStanding.js';
import { useCase } from '../case/CaseContext.js';
import { useHub } from '../context.js';
import { personName, recordSummary } from '../excerpt.js';
import type { ReportPerson } from '../excerpt.js';
import { absoluteTime, listOf, personTag, timeOfDay } from '../format.js';
import { useHubData } from '../hooks.js';
import type { HubText } from '../i18n.js';
import type { ActionRecord, BlockedLine, SanctionKind } from '../types.js';
import { Empty, Fetched, Link, PersonChip, Skeleton, Tag } from '../ui.js';

// The pane beside the case: what a moderator weighs before deciding. The person's record, what they tried to say that was blocked,
// how the people who reported have fared, and who is in the case.

/** How many reporters are shown with a record (each is a read of their history). The rest are counted. */
export const REPORTERS_SHOWN = 5;
/** How many blocked lines are listed (the count is of all of them). */
const BLOCKED_SHOWN = 5;

const RECORD_KIND: Record<SanctionKind, HubText> = {
  warning: 'hub.report.record.kind.warning',
  chat: 'hub.report.record.kind.chat',
  area: 'hub.report.record.kind.area',
  ban: 'hub.report.record.kind.ban',
  note: 'hub.report.record.kind.note',
};
const KIND_ORDER: readonly SanctionKind[] = ['warning', 'chat', 'area', 'ban', 'note'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="cw-ctx-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** The reported person's actions in the last 90 days, with the referee card for each. */
function Record({ target, people }: { target: ReportPerson; people: ReportPerson[] }) {
  const { t } = useHub();
  const { history } = useCase();
  if (history === null) return null;
  return (
    <Section title={t('hub.record.title', { name: personName(target, people, t) })}>
      <Fetched state={history} what={t('hub.state.what.record')}>
        {(h) =>
          h === null || h.sanctions.length === 0 ? (
            <p className="cw-hint">{t('hub.record.none')}</p>
          ) : (
            <ul className="cw-recs">
              {h.sanctions.map((s) => (
                <RecordItem key={s.groupId} s={s} />
              ))}
            </ul>
          )
        }
      </Fetched>
    </Section>
  );
}

/** What the person tried to say in the last 7 days that the filter stopped: a count, and the latest, hidden until shown. */
function Blocked({ target, people }: { target: ReportPerson; people: ReportPerson[] }) {
  const { t, locale, can, session } = useHub();
  const { reveal } = useCase();
  const wants = can('blocked.read');
  const state = useHubData<BlockedLine[] | null>(wants ? 'blocked' : 'blocked:idle', () => (wants ? session.blocked() : Promise.resolve(null)));
  if (!wants) return null;
  return (
    <Section title={t('hub.blocked.title')}>
      <Fetched state={state} what={t('hub.state.what.blocked')}>
        {(items) => {
          const mine = (items ?? []).filter((b) => b.person === target.ref);
          if (mine.length === 0) return <p className="cw-hint">{t('hub.blocked.none')}</p>;
          return (
            <>
              <p>{t('hub.blocked.count', { count: mine.length, name: personName(target, people, t) })}</p>
              <ul className="cw-blocked-list">
                {mine.slice(0, BLOCKED_SHOWN).map((b) => {
                  const shown = reveal.shows(`blocked:${b.id}`);
                  return (
                    <li key={b.id}>
                      <time dateTime={new Date(b.at).toISOString()} title={absoluteTime(b.at, locale)} className="cw-hint">
                        {timeOfDay(b.at, locale)}
                      </time>
                      <span className="cw-blocked-text">{shown ? b.text : <Masked />}</span>
                      <button
                        type="button"
                        className="cw-linkbtn"
                        aria-pressed={shown}
                        aria-label={t(shown ? 'hub.mask.hideBlocked' : 'hub.mask.showBlocked', { time: timeOfDay(b.at, locale) })}
                        onClick={() => reveal.toggle(`blocked:${b.id}`)}
                      >
                        {t(shown ? 'hub.mask.hide' : 'hub.mask.show')}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {mine.length > BLOCKED_SHOWN && <p className="cw-hint">{t('hub.blocked.more', { count: mine.length - BLOCKED_SHOWN })}</p>}
            </>
          );
        }}
      </Fetched>
    </Section>
  );
}

/** One reporter's track record: how many reports they filed and how many held up, as a plain bar and the words. */
function Reporter({ refId, name }: { refId: string; name: string }) {
  const { t, session } = useHub();
  const state = useHubData(`reporter:${refId}`, () => session.reporter(refId));
  const r = state.data;
  return (
    <li className="cw-reporter">
      <div className="cw-reporter-head">
        <span className="cw-reporter-name">{name}</span>
        {r !== undefined && <ReporterTotals record={r} />}
      </div>
      {r === undefined ? state.error === null ? <Skeleton lines={1} /> : <p className="cw-hint">{t('hub.report.reporter.unavailable')}</p> : <ReporterStanding record={r} />}
    </li>
  );
}

/** The people who reported this case, each with how their reports have gone. */
function Reporters({ people }: { people: ReportPerson[] }) {
  const { t, can } = useHub();
  const { detail, group } = useCase();
  const report = detail.data?.report;
  if (report === undefined || !can('history.read')) return null;
  // This report's reporter first, then the others who reported the same person.
  const refs = [...new Set([report.reporterPerson, ...(group?.reporterPersons ?? [])])];
  const shown = refs.slice(0, REPORTERS_SHOWN);
  // A reporter on this report is named from it; one from an earlier report by the handle that report recorded; else by their tag.
  const nameOf = (ref: string): string => {
    const p = people.find((x) => x.ref === ref);
    if (p !== undefined) return personName(p, people, t);
    const recorded = group?.reporterHandles[ref];
    return recorded ?? t('hub.person.unnamed', { tag: personTag(ref) });
  };
  return (
    <Section title={t('hub.reporters.title')}>
      <ul className="cw-reporters" aria-label={t('hub.reporters.label')}>
        {shown.map((ref) => (
          <Reporter key={ref} refId={ref} name={nameOf(ref)} />
        ))}
      </ul>
      {refs.length > shown.length && <p className="cw-hint">{t('hub.reporters.more', { count: refs.length - shown.length })}</p>}
    </Section>
  );
}

/** One person's last 90 days as a sentence: what stands, by kind, and how many were revoked. */
function RecordLine({ history }: { history: readonly ActionRecord[] }) {
  const { t, locale } = useHub();
  const { counts, total, revoked } = recordSummary(history);
  const parts = KIND_ORDER.flatMap((k) => (counts[k] === undefined ? [] : [t(RECORD_KIND[k], { count: counts[k] })]));
  return (
    <>
      <p className="cw-person-record">{total === 0 ? t('hub.report.record.none') : t('hub.report.record.some', { list: listOf(parts, locale) })}</p>
      {revoked > 0 && <p className="cw-person-record">{t('hub.report.record.revoked', { count: revoked })}</p>}
    </>
  );
}

/** Everyone the case names: their short tag, role, lines written and last 90 days. */
function People({ people }: { people: ReportPerson[] }) {
  const { t, can } = useHub();
  const { detail } = useCase();
  const history = detail.data?.history ?? {};
  return (
    <Section title={t('hub.report.people.title')}>
      <ul className="cw-people" aria-label={t('hub.report.people.label')}>
        {people.map((p) => {
          const name = personName(p, people, t);
          return (
            <li key={p.ref} className="cw-person">
              <div className="cw-person-head">
                <span className="cw-person-name">{name}</span>
                <PersonChip person={p.ref} />
                {p.role === 'target' && <Tag tone="bad">{t('hub.report.role.target')}</Tag>}
                {p.role === 'reporter' && <Tag>{t('hub.report.role.reporter')}</Tag>}
              </div>
              <p className="cw-hint">{p.lines === 0 ? t('hub.report.person.silent') : t('hub.report.person.wrote', { count: p.lines })}</p>
              <RecordLine history={history[p.ref] ?? []} />
              {can('history.read') && (
                <Link to={{ name: 'person', ref: p.ref }} className="cw-link" omit aria-label={t('hub.reports.row.historyLabel', { who: name })}>
                  {t('hub.reports.row.history')}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** The pane beside an open case. */
export function CasePanel() {
  const { t } = useHub();
  const { detail, people, left } = useCase();
  const target = people.find((p) => p.role === 'target');
  return (
    <aside className="cw-ctx" aria-label={t('hub.case.label')} hidden={left}>
      {detail.data === undefined || target === undefined ? (
        detail.error === null ? (
          <Skeleton lines={4} />
        ) : (
          <Empty>{t('hub.case.unavailable')}</Empty>
        )
      ) : (
        <>
          <Record target={target} people={people} />
          <Blocked target={target} people={people} />
          <Reporters people={people} />
          <People people={people} />
        </>
      )}
    </aside>
  );
}
