import { useEffect, useMemo, useRef, useState } from 'react';
import { RecordItem } from '../case/Record.js';
import { ReporterStanding, ReporterTotals } from '../case/ReporterStanding.js';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { categoryLabel, groupName } from '../labels.js';
import { Revoke } from '../person/Revoke.js';
import { SanctionForm } from '../person/SanctionForm.js';
import type { SanctionGroupView, PersonHistory } from '../types.js';
import { Empty, Fetched, Link, Panel, PersonChip, Tag, Time } from '../ui.js';

type Form = null | 'sanction' | 'note';

/** One line of the timeline: a report about them, or a sanction. */
type Entry = { kind: 'sanction'; at: number; key: string; s: SanctionGroupView } | { kind: 'report'; at: number; key: string; r: PersonHistory['reports'][number] };

/**
 * Reports and sanctions as one list, newest first. At the same moment a sanction comes before the report it followed (a decision
 * files both at once); otherwise the order the kit sent each in is kept.
 */
export function timelineOf(history: Pick<PersonHistory, 'reports' | 'sanctions'>): Entry[] {
  const all: Entry[] = [
    ...history.sanctions.map((s): Entry => ({ kind: 'sanction', at: s.startsAt, key: `s:${s.groupId}`, s })),
    ...history.reports.map((r): Entry => ({ kind: 'report', at: r.createdAt, key: `r:${r.id}`, r })),
  ];
  return all.map((e, i) => ({ e, i })).sort((a, b) => b.e.at - a.e.at || (a.e.kind === b.e.kind ? a.i - b.i : a.e.kind === 'sanction' ? -1 : 1)).map((x) => x.e);
}

/**
 * One person, in the middle pane of the workbench: what is in force now (each with a Revoke), their timeline (reports about them
 * and every sanction, with where it stands), and how the reports they filed have gone. A moderator can sanction them or add a
 * note from the buttons at the top. One read of their history opens the page (audited as one `history.view`); a write reads it
 * once more, never on a timer.
 */
export function Person({ person }: { person: string }) {
  const { client, t, can } = useHub();
  const history = useHubData(`person:${person}`, () => client.personHistory(person));
  const [form, setForm] = useState<Form>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sanctionButton = useRef<HTMLButtonElement>(null);
  const noteButton = useRef<HTMLButtonElement>(null);
  // After a write, the page is read again and keyboard focus goes to the title (the row or form that had it is gone).
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || history.loading) return;
    refocus.current = false;
    headingRef.current?.focus();
  }, [history.loading, history.data]);

  const data = history.data;
  const handle = data?.handle ?? null;
  const name = groupName(t, { handle, person });
  const canApply = can('sanctions.apply');
  const wrote = (): void => {
    refocus.current = true;
    history.reload();
  };

  const toggle = (which: Exclude<Form, null>): void => setForm((f) => (f === which ? null : which));
  const closeForm = (): void => {
    const was = form;
    setForm(null);
    queueMicrotask(() => (was === 'note' ? noteButton : sanctionButton).current?.focus());
  };

  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <div className="cw-personhead">
          <h2 className="cw-screen-title" tabIndex={-1} ref={headingRef}>
            {name}
          </h2>
          {handle !== null && <PersonChip person={person} />}
        </div>
        {canApply && (
          <div className="cw-bar-actions">
            <button ref={sanctionButton} type="button" className="cw-btn cw-btn--primary" aria-expanded={form === 'sanction'} onClick={() => toggle('sanction')}>
              {t('hub.person.sanction')}
            </button>
            <button ref={noteButton} type="button" className="cw-btn" aria-expanded={form === 'note'} onClick={() => toggle('note')}>
              {t('hub.person.addNote')}
            </button>
          </div>
        )}
      </div>
      {form !== null && (
        <SanctionForm
          key={form}
          person={person}
          name={name}
          mode={form}
          onDone={() => {
            setForm(null);
            wrote();
          }}
          onCancel={closeForm}
        />
      )}
      <Fetched state={history} what={t('hub.state.what.history')}>
        {(h) => (
          <PersonBody
            history={h}
            revoking={revoking}
            setRevoking={setRevoking}
            onRevoked={() => {
              setRevoking(null);
              wrote();
            }}
          />
        )}
      </Fetched>
    </div>
  );
}

function PersonBody({ history, revoking, setRevoking, onRevoked }: { history: PersonHistory; revoking: string | null; setRevoking: (id: string | null) => void; onRevoked: () => void }) {
  const { t, can } = useHub();
  const standing = history.sanctions.filter((s) => s.active && s.revokedAt === null);
  const entries = useMemo(() => timelineOf(history), [history]);
  const canRevoke = can('sanctions.revoke');
  return (
    <>
      <Panel title={t('hub.person.inForce.title')}>
        {standing.length === 0 ? (
          <Empty>{t('hub.person.inForce.none')}</Empty>
        ) : (
          <ul className="cw-recs cw-panel-pad">
            {standing.map((s) => (
              <RecordItem key={s.groupId} s={s} detail>
                {canRevoke && <Revoke s={s} open={revoking === s.groupId} onOpen={() => setRevoking(s.groupId)} onClose={() => setRevoking(null)} onRevoked={onRevoked} />}
              </RecordItem>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={t('hub.person.timeline.title')}>
        {entries.length === 0 ? (
          <Empty>{t('hub.person.timeline.none')}</Empty>
        ) : (
          <>
            <p className="cw-hint cw-panel-pad">{t('hub.person.timeline.hint')}</p>
            <ul className="cw-recs cw-panel-pad">
              {entries.map((e) => (e.kind === 'sanction' ? <RecordItem key={e.key} s={e.s} detail /> : <ReportEntry key={e.key} report={e.r} />))}
            </ul>
          </>
        )}
      </Panel>
      <Panel title={t('hub.person.reporter.title')}>
        <div className="cw-panel-pad">
          <p>
            <ReporterTotals record={history.asReporter} />
          </p>
          {history.asReporter.reports > 0 && <ReporterStanding record={history.asReporter} />}
        </div>
      </Panel>
    </>
  );
}

/** A report about them: when, what it was for, and a way to open it. It has no referee card: nothing was done to them by it. */
function ReportEntry({ report }: { report: PersonHistory['reports'][number] }) {
  const { t, can } = useHub();
  return (
    <li className="cw-rec cw-rec--report">
      <span className="cw-rec-mark" aria-hidden="true" />
      <div className="cw-rec-body">
        <p className="cw-rec-head">
          <strong>{t('hub.person.report')}</strong>
          <Tag>{categoryLabel(t, report.category)}</Tag>
        </p>
        <p className="cw-facts cw-rec-meta">
          <Time at={report.createdAt} />
          {can('reports.read') && (
            <Link to={{ name: 'report', id: report.id }} className="cw-link" aria-label={t('hub.person.report.openLabel', { category: categoryLabel(t, report.category) })}>
              {t('hub.person.report.open')}
            </Link>
          )}
        </p>
      </div>
    </li>
  );
}
