import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AiReadSlot } from '../case/AiRead.js';
import { ClaimBanner, Viewing } from '../case/Claim.js';
import { useCase } from '../case/CaseContext.js';
import { DecisionBar } from '../case/DecisionBar.js';
import { RecordItem } from '../case/Record.js';
import { Transcript } from '../case/Transcript.js';
import type { LinePicks } from '../case/Transcript.js';
import { useHub } from '../context.js';
import { LINES_MAX } from '../decision.js';
import { personName } from '../excerpt.js';
import { absoluteTime, relativeTime } from '../format.js';
import { categoryLabel } from '../labels.js';
import type { ReportDetail } from '../types.js';
import { Empty, Fetched, Link, PersonChip, Tag, Time } from '../ui.js';

// The case pane: who the case is about, who is handling it, the evidence in tabs (the transcript first), and the decision bar
// docked under it. The person's record and who reported live in the pane beside it (`shell/CasePanel.tsx`).

type TabId = 'evidence' | 'reports' | 'history';

function Header({ detail }: { detail: ReportDetail }) {
  const { t, locale, now } = useHub();
  const { people, group, entry } = useCase();
  const { report } = detail;
  const target = people.find((p) => p.role === 'target');
  const name = target === undefined ? '' : personName(target, people, t);
  const categories = group === null ? [report.category] : group.categories;
  const entries = Object.entries(report.tags);
  // A decision that went through closes the report: the header says so without reading the report again.
  const verdict = entry?.state.status === 'done' ? entry.input.verdict : null;
  const status = verdict === null ? report.status : verdict === 'upheld' || verdict === 'noted' ? 'actioned' : 'dismissed';
  return (
    <header className="cw-casehead">
      <div className="cw-casehead-row">
        <h2 className="cw-screen-title" tabIndex={-1}>
          <span aria-hidden="true" className="cw-casename">
            {name}
          </span>
          <span className="cw-sr">{t('hub.report.title', { category: categoryLabel(t, report.category), who: name })}</span>
        </h2>
        {target !== undefined && <PersonChip person={target.ref} />}
        <span className="cw-casecats">
          {categories.map((c) => (
            <Tag key={c}>{categoryLabel(t, c)}</Tag>
          ))}
        </span>
        <span className="cw-casehead-gap" />
        <Viewing />
      </div>
      <div className="cw-facts" role="group" aria-label={t('hub.report.facts.label')}>
        <Tag>{t(`hub.reports.tag.${status}`)}</Tag>
        {report.badFaith && <Tag tone="warn">{t('hub.report.tag.badFaith')}</Tag>}
        <span title={absoluteTime(report.createdAt, locale)}>{t('hub.report.fact.filed', { time: relativeTime(report.createdAt, now(), locale) })}</span>
        {report.roomId !== '' && <span>{t('hub.report.fact.room', { room: report.roomId })}</span>}
        {entries.map(([key, value]) => (
          <span key={key}>{t('hub.report.fact.tag', { key, value })}</span>
        ))}
        <Link to={{ name: 'reports', status: 'open' }} className="cw-link">
          {t('hub.report.back')}
        </Link>
      </div>
    </header>
  );
}

function Evidence({ detail }: { detail: ReportDetail }) {
  const { t, can } = useHub();
  const { people, draft, holder, entry } = useCase();
  const { report } = detail;
  const target = people.find((p) => p.role === 'target');
  const state = entry?.state.status;
  const usable = report.status === 'open' && can('reports.decide') && draft.status === 'ready' && holder.kind !== 'other' && state !== 'held' && state !== 'sending' && state !== 'done' && state !== 'conflict';
  const primary = draft.primary;
  const picks: LinePicks | null =
    usable && primary !== null && target !== undefined
      ? {
          person: target.ref,
          name: personName(target, people, t),
          chosen: primary.lineIds,
          max: LINES_MAX,
          onToggle: (id) => draft.toggleLine(primary.uid, id),
        }
      : null;
  return (
    <>
      <AiReadSlot read={null} />
      <div className="cw-note">
        <h3>{t('hub.report.note.label')}</h3>
        {report.note === null || report.note.trim() === '' ? <p className="cw-hint">{t('hub.report.note.none')}</p> : <p className="cw-note-text">{report.note}</p>}
      </div>
      <Transcript report={report} people={people} picks={picks} />
    </>
  );
}

/** The reports in this case: every open report about the person, newest first, and which one this is. */
function Reports({ detail }: { detail: ReportDetail }) {
  const { t } = useHub();
  const { group } = useCase();
  const list = group === null ? [{ id: detail.report.id, category: detail.report.category, createdAt: detail.report.createdAt }] : group.entries;
  return (
    <ul className="cw-case-reports" aria-label={t('hub.case.reports.label')}>
      {list.map((e) => (
        <li key={e.id} className="cw-case-report">
          <Tag>{categoryLabel(t, e.category)}</Tag>
          <span className="cw-hint">
            <Time at={e.createdAt} />
          </span>
          {e.id === detail.report.id ? (
            <span className="cw-hint">{t('hub.case.reports.current')}</span>
          ) : (
            <Link to={{ name: 'report', id: e.id }} className="cw-link">
              {t('hub.case.reports.open')}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The person's whole record, newest first: the same cards as the pane beside it, with the moderator's reason. */
function History() {
  const { t } = useHub();
  const { history, people } = useCase();
  const target = people.find((p) => p.role === 'target');
  if (history === null || target === undefined) return null;
  return (
    <Fetched state={history} what={t('hub.state.what.record')}>
      {(h) =>
        h === null || h.sanctions.length === 0 ? (
          <Empty>{t('hub.record.empty')}</Empty>
        ) : (
          <ul className="cw-recs" aria-label={t('hub.record.label', { name: personName(target, people, t) })}>
            {h.sanctions.map((s) => (
              <RecordItem key={s.groupId} s={s} withReason />
            ))}
          </ul>
        )
      }
    </Fetched>
  );
}

function Tabs({ detail }: { detail: ReportDetail }) {
  const { t, can } = useHub();
  const { group } = useCase();
  const id = useId();
  const [tab, setTab] = useState<TabId>('evidence');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'evidence', label: t('hub.case.tab.evidence') },
    { id: 'reports', label: t('hub.case.tab.reports', { count: group === null ? 1 : group.reports }) },
    ...(can('history.read') ? [{ id: 'history' as const, label: t('hub.case.tab.history') }] : []),
  ];
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const at = tabs.findIndex((x) => x.id === tab);
    const to = e.key === 'ArrowRight' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = tabs[to] as (typeof tabs)[number];
    setTab(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <>
      <div className="cw-tabs" role="tablist" aria-label={t('hub.case.tabs.label')}>
        {tabs.map((x) => (
          <button
            key={x.id}
            ref={(el) => {
              refs.current[x.id] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`${id}-panel-${x.id}`}
            tabIndex={tab === x.id ? 0 : -1}
            onClick={() => setTab(x.id)}
            onKeyDown={onKeyDown}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="cw-case-scroll">
        <div className="cw-tabpanel" role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`}>
          {tab === 'evidence' && <Evidence detail={detail} />}
          {tab === 'reports' && <Reports detail={detail} />}
          {tab === 'history' && <History />}
        </div>
      </div>
    </>
  );
}

/** `#/reports/:id`: the case pane. The report is read once, by the case provider the hub wraps this in. */
export function Report() {
  const { t } = useHub();
  const { detail } = useCase();
  const root = useRef<HTMLDivElement>(null);
  // The loading title and the case header are different elements: when the title had keyboard focus (the hub puts it there on
  // arrival), the new one takes it, so focus does not fall to the page.
  const titleFocused = useRef(false);
  const loaded = detail.data !== undefined;
  useEffect(() => {
    if (loaded && titleFocused.current) {
      titleFocused.current = false;
      root.current?.querySelector<HTMLElement>('.cw-casehead .cw-screen-title')?.focus();
    }
  }, [loaded]);
  return (
    <div className="cw-casepane" ref={root}>
      {detail.data === undefined ? (
        <div className="cw-screen">
          <h2 className="cw-screen-title" tabIndex={-1} onFocus={() => (titleFocused.current = true)}>
            {t('hub.report.heading')}
          </h2>
          <Fetched state={detail} what={t('hub.state.what.report')}>
            {() => null}
          </Fetched>
        </div>
      ) : (
        <>
          <Header detail={detail.data} />
          <ClaimBanner />
          <Tabs detail={detail.data} />
          <DecisionBar />
        </>
      )}
    </div>
  );
}
