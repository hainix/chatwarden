import { useLayoutEffect, useRef, useState } from 'react';
import type { DemoSeat, EvidenceLine, PlayerNotice, StaffReport, Suggestion } from './engine';
import { StarIcon } from './icons';
import { clock } from './GamePane';
import { noticeKindLabel, shortDuration, timeoutMs } from './notice';
import { CATEGORY_LABEL } from './ReportDialog';

export type DecideKind = 'warning' | 'timeout' | 'note' | 'none';

const AVATAR: Record<string, string> = { you: 'avatar-you', ada: 'avatar-a', bo: 'avatar-b' };

/**
 * The decide button that matches what the kit suggested. A chat timeout is the Timeout button (as long as the kit said);
 * a ban from public rooms or a full ban has no button here, so nothing is starred and the line above says what it is.
 */
function suggestedKind(s: Suggestion | null): DecideKind | null {
  if (s === null) return null;
  const o = s.outcome;
  if (o === 'none') return 'none';
  if (o === 'note') return 'note';
  if (o === 'warning') return 'warning';
  return o.kind === 'chat' && typeof o.durationMs === 'number' ? 'timeout' : null;
}

function Evidence({ lines, reportedId }: { lines: EvidenceLine[]; reportedId: string | null }) {
  // The kit keeps up to 100 lines (15 minutes) of the room as evidence, so the list can be long: it scrolls inside its box, and
  // opens with the reported line in view.
  const box = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const mark = el?.querySelector<HTMLElement>('[data-reported="true"]');
    if (el && mark) el.scrollTop = Math.max(0, mark.offsetTop - el.clientHeight / 2 + mark.offsetHeight / 2);
  }, [lines, reportedId]);
  return (
    <ol className="evidence" aria-label="Evidence: the last lines in the room" ref={box} tabIndex={0}>
      {lines.map((l) => {
        const reported = l.lineId === reportedId;
        return (
          <li key={l.lineId} data-reported={reported ? 'true' : undefined} data-blocked={l.blocked ? 'true' : undefined}>
            <span className={`avatar avatar-sm ${AVATAR[l.seatId] ?? ''}`} aria-hidden="true">
              {l.handle.slice(0, 1)}
            </span>
            <span className="ev-who">{l.handle}</span>
            <span className="ev-text">{l.raw}</span>
            {reported && <span className="ev-tag ev-tag-reported">reported</span>}
            {l.blocked && <span className="ev-tag ev-tag-blocked">refused, only {l.handle} saw it</span>}
          </li>
        );
      })}
    </ol>
  );
}

interface DetailProps {
  report: StaffReport;
  suggestion: Suggestion | null;
  busy: boolean;
  onDecide: (kind: DecideKind, quoteId: string | null, reason: string) => void;
}

/** One report: who, why, the evidence, the ladder suggestion, the line to quote, and the four decisions. */
function ReportDetail({ report, suggestion, busy, onDecide }: DetailProps) {
  const own = report.ownLineIds[report.targetPerson] ?? [];
  // The kit lets the notice quote up to five lines, and the evidence can hold many of the player's lines: offer the reported
  // line and their five latest.
  const recent = new Set(own.slice(-5));
  if (report.lineId !== null && own.includes(report.lineId)) recent.add(report.lineId);
  const ownLines = report.excerpt.filter((l) => recent.has(l.lineId));
  const [quote, setQuote] = useState<string | null>(report.lineId !== null && own.includes(report.lineId) ? report.lineId : null);
  const [reason, setReason] = useState(`Report: ${CATEGORY_LABEL[report.category].toLowerCase()}`);
  const sug = suggestedKind(suggestion);
  const mark = (k: DecideKind) => (sug === k ? { 'data-suggested': 'true' } : {});
  const decide = (k: DecideKind) => onDecide(k, quote, reason);

  return (
    <section className="report" aria-label={`Report from ${report.reporterHandle} about ${report.targetHandle}`}>
      <div className="report-top">
        <span className="cat-chip">{CATEGORY_LABEL[report.category]}</span>
        <span className="report-who">
          from <b>{report.reporterHandle}</b> about <b>{report.targetHandle}</b>
        </span>
      </div>
      {report.note !== null && <p className="report-note">“{report.note}”</p>}
      <Evidence lines={report.excerpt} reportedId={report.lineId} />
      <p className="suggest" id="demo-suggest">
        <StarIcon />
        {suggestion === null ? (
          <span>Reading the record…</span>
        ) : (
          <>
            <strong>Suggested: {suggestion.label}</strong>
            <span> — {suggestion.why}</span>
          </>
        )}
      </p>
      <fieldset className="picker">
        <legend>Line to show the player</legend>
        <label>
          <input type="radio" name="quote" checked={quote === null} onChange={() => setQuote(null)} />
          <span>Don’t quote a line</span>
        </label>
        {ownLines.map((l) => (
          <label key={l.lineId}>
            <input type="radio" name="quote" checked={quote === l.lineId} onChange={() => setQuote(l.lineId)} />
            <span>
              {l.raw}
              {l.blocked ? <em> (refused)</em> : null}
            </span>
          </label>
        ))}
        <p className="picker-hint">Blocked words are starred out before the player sees them.</p>
      </fieldset>
      <label className="private">
        <span>Private note (players never see it)</span>
        <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="decide-bar">
      <div className="decide" role="group" aria-label="Decide" aria-describedby="demo-suggest" data-tour="decide">
        <button type="button" className="dec dec-warn" disabled={busy} onClick={() => decide('warning')} {...mark('warning')}>
          Warn
        </button>
        <button type="button" className="dec dec-time" disabled={busy} onClick={() => decide('timeout')} {...mark('timeout')}>
          Timeout {shortDuration(timeoutMs(suggestion))}
        </button>
        <button type="button" className="dec dec-note" disabled={busy} onClick={() => decide('note')} {...mark('note')}>
          Note
        </button>
        <button type="button" className="dec dec-none" disabled={busy} onClick={() => decide('none')} {...mark('none')}>
          No action
        </button>
      </div>
      </div>
    </section>
  );
}

function RecordList({ seat, notices }: { seat: DemoSeat; notices: PlayerNotice[] }) {
  return (
    <>
      <ul className="record" aria-label={`${seat.name}'s record`}>
        {notices.map((n) => (
          <li key={n.id}>
            <b>{noticeKindLabel(n.kind)}</b>
            {n.until !== null && <span> until {clock(n.until)}</span>}
            <span className="record-rule">{n.ruleLabel}</span>
            {n.excerpt.map((e, i) => (
              <q key={i}>{e.text}</q>
            ))}
            <code>{n.refCode}</code>
          </li>
        ))}
      </ul>
      {notices.length === 0 && <p className="empty">Nothing on {seat.name}’s record.</p>}
    </>
  );
}

interface Props {
  hidden: boolean;
  tab: 'reports' | 'record';
  setTab: (t: 'reports' | 'record') => void;
  reports: StaffReport[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  suggestion: Suggestion | null;
  busy: boolean;
  onDecide: (kind: DecideKind, quoteId: string | null, reason: string) => void;
  seats: readonly DemoSeat[];
  recordSeat: string;
  setRecordSeat: (s: string) => void;
  record: PlayerNotice[];
}

export function ModPane({
  hidden,
  tab,
  setTab,
  reports,
  selectedId,
  onSelect,
  suggestion,
  busy,
  onDecide,
  seats,
  recordSeat,
  setRecordSeat,
  record,
}: Props) {
  const selected = reports.find((r) => r.id === selectedId) ?? null;
  const seat = seats.find((s) => s.id === recordSeat) ?? (seats[0] as DemoSeat);
  return (
    <section className="pane pane-mod" data-pane="mod" aria-labelledby="pane-mod-title" hidden={hidden}>
      <header className="pane-head">
        <h3 id="pane-mod-title" tabIndex={-1}>
          Your moderator
        </h3>
        <div className="mod-tabs" role="group" aria-label="Moderator console views">
          <button
            type="button"
            aria-pressed={tab === 'reports'}
            data-tour="queue-tab"
            onClick={() => setTab('reports')}
          >
            Reports
            <span className="badge" data-n={reports.length} key={reports.length} aria-hidden="true">
              {reports.length}
            </span>
            {/* The name comes from the content ("Reports, 2 open"), so it also contains the visible words (axe: label-content-name-mismatch). */}
            <span className="sr-only">, {reports.length} open</span>
          </button>
          <button type="button" aria-pressed={tab === 'record'} onClick={() => setTab('record')}>
            My record
          </button>
        </div>
      </header>
      <div className="mod-body">
        {tab === 'reports' ? (
          <>
            {reports.length === 0 && (
              <div className="empty-queue">
                <p className="empty">No open reports.</p>
                <p className="empty-sub">Report a line in the game and it lands here, with the evidence.</p>
              </div>
            )}
            {reports.length > 1 && (
              <ul className="queue" aria-label="Open reports">
                {reports.map((r) => (
                  <li key={r.id}>
                    <button type="button" aria-current={r.id === selectedId ? 'true' : undefined} onClick={() => onSelect(r.id)}>
                      {CATEGORY_LABEL[r.category]} · {r.targetHandle}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selected && <ReportDetail key={selected.id} report={selected} suggestion={suggestion} busy={busy} onDecide={onDecide} />}
          </>
        ) : (
          <>
            <p className="record-intro">The player’s “My record”: the warnings and timeouts that still apply to them.</p>
            <div className="record-seats" role="radiogroup" aria-label="Whose record">
              {seats.map((s) => (
                <label key={s.id} data-on={s.id === recordSeat ? 'true' : undefined}>
                  <input type="radio" name="record-seat" checked={s.id === recordSeat} onChange={() => setRecordSeat(s.id)} />
                  <span>{s.name}</span>
                </label>
              ))}
            </div>
            <RecordList seat={seat} notices={record} />
          </>
        )}
      </div>
    </section>
  );
}
