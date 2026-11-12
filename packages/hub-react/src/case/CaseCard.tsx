import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { actorName } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { useDecisions } from '../decisions.js';
import { initialForm } from '../decision.js';
import { excerptLines, personName } from '../excerpt.js';
import type { ReportPerson } from '../excerpt.js';
import { personTag, relativeTime } from '../format.js';
import { useHubData } from '../hooks.js';
import { decideErrorText, outcomeLabel } from '../labels.js';
import { needsSenior, ownLinesOf, recordLine, reporterDecided, reporterWarrants, stepLabel } from '../simple.js';
import { UNDO_MS } from '../toasts.js';
import type { QueueGroup } from '../queue.js';
import type { ReporterRecord, StaffReport } from '../types.js';
import { Card, ErrorBlock, Fetched, Kbd, Notice, Skeleton } from '../ui.js';
import { useCase } from './CaseContext.js';
import { DecisionBar } from './DecisionBar.js';
import { useQuickKeys } from '../quickKeys.js';
import { QuickKeys } from './QuickKeys.js';
import { reporterRate } from './ReporterStanding.js';
import { RuleField } from './RuleField.js';
import { shapeOf, takeLastQuick, useQuickActions } from './useQuickActions.js';
import { Line } from './Transcript.js';

// The Simple case view: one card per case. Who, why, what they said, their record, the ladder's suggestion and three ways to
// answer it. Everything underneath is the Detailed workbench's: the same case read, the same claim, the same decision hold (the five
// second Undo, sent at once when the page goes). One click and "No action needed" hand a form to `decisions.submit`, the call the
// decision bar makes; "Something else…" opens the decision bar itself, in place.

/** The card names the writer by the handle on the line. */
const noName = (): string => '';
const SECONDS = UNDO_MS / 1000;

/** "Reported as Hate by Saffron, yesterday." One report; several read "3 reports: hate, no reason given." A report that gave no reason says so. */
function reportedLine(
  t: ReturnType<typeof useHub>['t'],
  locale: string,
  report: StaffReport & { reportedReasonLabel?: string | null },
  people: ReportPerson[],
  now: number,
  group: { reports: number; reasons: QueueGroup['reasons'] } | null,
): string {
  if (group !== null && group.reports > 1) {
    return t('hub.simple.reported', { count: group.reports, reasons: group.reasons.map((r) => r.label ?? t('hub.simple.reportedNoneItem')).join(', ') });
  }
  const reporter = people.find((p) => p.role === 'reporter');
  const params = { reporter: reporter === undefined ? '' : personName(reporter, people, t), time: relativeTime(report.createdAt, now, locale) };
  if (report.reportedReason == null) return t('hub.simple.reportedNone', params);
  return t('hub.simple.reported', { count: 1, reason: report.reportedReasonLabel ?? report.reportedReason, ...params });
}

/** What the reported person said, and, on request, the whole chat around it. */
function Said({ report, target, people }: { report: StaffReport; target: ReportPerson; people: ReportPerson[] }) {
  const { t } = useHub();
  const id = useId();
  const [whole, setWhole] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const all = useMemo(() => excerptLines(report), [report]);
  const mine = ownLinesOf(all, target.ref);
  const more = all.length - mine.length;
  const shown = whole ? all : mine;
  return (
    <section className="cw-scard-said" aria-labelledby={id}>
      <h3 id={id}>{t('hub.simple.said.title')}</h3>
      {mine.length === 0 && <p className="cw-hint">{t('hub.report.excerpt.silent', { name: personName(target, people, t) })}</p>}
      {shown.length > 0 && (
        <div className="cw-transcript cw-scard-lines">
          <ol className="cw-lines" aria-label={t('hub.report.excerpt.label')}>
            {shown.map((l) => (
              <Line key={l.id} line={l} picks={null} name={noName} simple={{ whole, theirs: l.person === target.ref }} />
            ))}
          </ol>
        </div>
      )}
      {(more > 0 || whole) && (
        <button
          ref={toggle}
          type="button"
          className="cw-linkbtn cw-scard-toggle"
          aria-expanded={whole}
          onClick={() => {
            setWhole(!whole);
            // The button changes its words and its place: keep keyboard focus on it.
            requestAnimationFrame(() => toggle.current?.focus());
          }}
        >
          {whole ? t('hub.simple.chat.hide') : t('hub.simple.chat.show', { count: more })}
        </button>
      )}
    </section>
  );
}

/** Their record, in one line. Not shown to a role that cannot read histories. */
function RecordSection() {
  const { t, locale } = useHub();
  const { history } = useCase();
  const id = useId();
  if (history === null) return null;
  return (
    <section className="cw-scard-record" aria-labelledby={id}>
      <h3 id={id}>{t('hub.simple.record.title')}</h3>
      <Fetched state={history} what={t('hub.state.what.record')}>
        {(h) => <p>{recordLine(t, locale, h === null ? [] : h.sanctions)}</p>}
      </Fetched>
    </section>
  );
}

/** Only when most of the reporter's past reports were not upheld. Plain, and about the numbers, not the person. */
function ReporterWarning({ report, people }: { report: StaffReport; people: ReportPerson[] }) {
  const { t, can, session } = useHub();
  const wants = can('history.read');
  const ref = report.reporterPerson;
  const state = useHubData<ReporterRecord | null>(wants ? `reporter:${ref}` : 'reporter:idle', () => (wants ? session.reporter(ref) : Promise.resolve(null)));
  const record = state.data;
  if (!wants || record === undefined || record === null) return null;
  const who = people.find((p) => p.ref === ref);
  const name = who === undefined ? t('hub.person.unnamed', { tag: personTag(ref) }) : personName(who, people, t);
  // A kit that sends the recent figure decides on it (too few decided reports: no line). One that does not keeps the all-time rule.
  if (record.accuracy !== undefined && record.accuracy !== null) {
    const rate = reporterRate(t, record, name);
    return rate === null ? null : (
      <Notice tone="warn">
        {rate.line}
        {rate.ranked !== null && ` ${rate.ranked}`}
      </Notice>
    );
  }
  if (!reporterWarrants(record)) return null;
  return <Notice tone="warn">{t('hub.simple.reporterWarning', { name, upheld: record.actioned, count: reporterDecided(record) })}</Notice>;
}

/** The card for a case. Read through `<CaseProvider>`, the one the hub wraps a case in. */
export function CaseCard() {
  const { t, locale, can, shortcuts, now } = useHub();
  const c = useCase();
  const decisions = useDecisions();
  const actions = useCaseActions();
  const { reportId, detail, entry, holder, people, group, left, draft } = c;
  const report = detail.data?.report;
  const [elseOpen, setElseOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const noActionRef = useRef<HTMLButtonElement>(null);
  const elseRef = useRef<HTMLButtonElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);
  const quickRef = useRef<HTMLButtonElement>(null);
  const titleFocused = useRef(false);
  const base = useId();

  // The loading title and the card's own are different elements: when the title had keyboard focus (the hub puts it there on
  // arrival), the new one takes it.
  const loaded = detail.data !== undefined;
  useEffect(() => {
    if (loaded && titleFocused.current) {
      titleFocused.current = false;
      root.current?.querySelector<HTMLElement>('.cw-scard-head .cw-screen-title')?.focus();
    }
  }, [loaded]);

  const status = entry?.state.status;
  const open = report?.status === 'open';
  const canDecide = can('reports.decide');
  const readOnly = holder.kind === 'other';
  // What the card offers as one tap, and when it may be sent (the case is open, read, fresh, and nothing is waiting). The same rule the
  // Detailed bar uses; the card sends each through the hold and goes on to the next case.
  const q = useQuickActions({ paused: elseOpen, refresh: true });
  // Simple's digits act at once unless the moderator turned Quick keys off (Ctrl+Enter stays the suggested step either way).
  const digits = useQuickKeys('simple').on;
  const keyed = shortcuts && digits;
  const { pick, fresh, suggest, choice } = q;
  const one = q.primary;
  const quick = q.warning;

  const target = people.find((p) => p.role === 'target');
  const name = target === undefined ? '' : personName(target, people, t);
  const sendError = status === 'failed' && entry?.state.status === 'failed' ? entry.state.error : null;

  /**
   * "Something else" opens the decision bar. When a rule was picked on the card, the bar opens on that rule and the step the ladder suggests
   * for it, unless the moderator has already changed the bar's form (what was filled in from the case, or from an earlier pick, is replaced).
   */
  const seeded = useRef<string | null>(null);
  const openElse = (): void => {
    const suggestion = pick.suggestion;
    if (pick.mode !== 'none' && pick.picked !== null && suggestion !== null && detail.data !== undefined) {
      const first = initialForm(draft.ctx, detail.data.suggest.outcome, detail.data.rule, detail.data.report.lineId, 'a0');
      const untouched = shapeOf(draft.form) === shapeOf(first) || shapeOf(draft.form) === seeded.current;
      if (untouched) {
        const next = initialForm(draft.ctx, suggestion.outcome, pick.picked, detail.data.report.lineId, 'a0');
        seeded.current = shapeOf(next);
        draft.setForm(() => next);
      }
    }
    setElseOpen(true);
  };

  // Undone: the card is back (a new view, when the moderator had gone on, whose buttons come with the read), with keyboard focus on the
  // button that sent it, as soon as it is there. Failed: on the message.
  // (In a microtask: the decision store can change from a page event or a timer, and that commit runs its effects at once.)
  const refocus = useRef<'primary' | 'none' | 'warning' | null>(null);
  useEffect(() => {
    if (status === 'undone') refocus.current = takeLastQuick(reportId) ?? 'primary';
    else if (status === 'failed') queueMicrotask(() => failedRef.current?.focus());
  }, [status]);
  useEffect(() => {
    if (refocus.current === null) return;
    const back = refocus.current === 'warning' ? quickRef.current : refocus.current === 'none' ? noActionRef.current : primaryRef.current;
    const target = back ?? noActionRef.current;
    if (target === null) return;
    refocus.current = null;
    queueMicrotask(() => target.focus());
  });

  // Something else opens the bar in place, with focus on its first control.
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current && !elseOpen) return;
    if (elseOpen) root.current?.querySelector<HTMLElement>('.cw-dock input[type="radio"]')?.focus();
    else elseRef.current?.focus();
    opened.current = true;
  }, [elseOpen]);

  if (detail.data === undefined || report === undefined || target === undefined) {
    return (
      <section className="cw-scard" ref={root}>
        <div className="cw-screen">
          <h2 className="cw-screen-title" tabIndex={-1} onFocus={() => (titleFocused.current = true)}>
            {t('hub.report.heading')}
          </h2>
          <Fetched state={detail} what={t('hub.state.what.report')}>
            {() => null}
          </Fetched>
        </div>
      </section>
    );
  }

  // The card's decision area, by what the case is doing.
  let decision: ReactNode;
  if (left || !open || !canDecide || elseOpen || status === 'conflict') {
    // A decision waiting or sent, someone else's decision first, a case already closed, a role that cannot decide, or Something else:
    // the decision bar, as it is.
    decision = (
      <>
        {elseOpen && !left && (
          <div className="cw-scard-back">
            <button type="button" className="cw-linkbtn" onClick={() => setElseOpen(false)}>
              {t('hub.simple.else.close')}
            </button>
          </div>
        )}
        <DecisionBar />
      </>
    );
  } else if (readOnly && holder.kind === 'other') {
    decision = (
      <section className="cw-scard-decision" aria-label={t('hub.decide.title')}>
        <Notice role="status">
          <p>
            <strong>{t('hub.simple.claim.theirs', { name: actorName(holder.by) })}</strong> {t(can('claims.override') ? 'hub.claim.theirsSenior' : 'hub.claim.theirsRead')}
          </p>
          {can('claims.override') && (
            <button type="button" className="cw-btn" onClick={() => void actions.takeOver(report.targetPerson)}>
              {t('hub.claim.takeOver')}
            </button>
          )}
        </Notice>
      </section>
    );
  } else {
    let suggestion: ReactNode;
    if (draft.status === 'loading') {
      suggestion = (
        <div className="cw-loading">
          <p role="status">{t('hub.state.loading')}</p>
          <Skeleton lines={2} />
        </div>
      );
    } else if (draft.rulesState === 'failed' && draft.rulesError !== null) {
      suggestion = <ErrorBlock error={draft.rulesError} what={t('hub.state.what.rules')} onRetry={draft.reloadRules} />;
    } else if (draft.rulesState === 'denied') {
      suggestion = <p className="cw-hint">{t('hub.decide.rules.denied')}</p>;
    } else if (!can('sanctions.apply')) {
      suggestion = <p className="cw-hint">{t('hub.decide.noApply')}</p>;
    } else if (pick.mode !== 'none' && (pick.picked === null || pick.error !== null)) {
      // Asking which rule: the field below is the whole card until a rule is picked.
      suggestion = null;
    } else if (pick.mode !== 'none' && pick.busy) {
      suggestion = (
        <p className="cw-hint" role="status">
          {t('hub.state.loading')}
        </p>
      );
    } else if (one !== null || (suggest !== undefined && needsSenior(choice, draft.ctx.canPermanent))) {
      suggestion = (
        <div className="cw-suggest" role="group" aria-labelledby={`${base}-title`}>
          <h3 id={`${base}-title`} className="cw-sr">
            {t('hub.decide.suggest.title')}
          </h3>
          <div className="cw-suggest-main">
            {choice !== null && <Card kind={choice.kind} />}
            <div className="cw-suggest-text">
              <p className="cw-suggest-label">{suggest === undefined ? '' : outcomeLabel(t, locale, suggest.outcome)}</p>
              <p className="cw-hint">{suggest?.why}</p>
            </div>
          </div>
          {one === null && <p className="cw-hint">{t('hub.decide.suggest.needsSenior')}</p>}
        </div>
      );
    } else {
      suggestion = <p className="cw-scard-none">{t('hub.simple.suggest.none')}</p>;
    }
    const kbd = (key: string) =>
      keyed && (
        <span className="cw-scard-key" aria-hidden="true">
          <Kbd>{key}</Kbd>
        </span>
      );
    decision = (
      <section className="cw-scard-decision" aria-label={t('hub.decide.title')}>
        {pick.mode !== 'none' && draft.status === 'ready' && <RuleField pick={pick} rules={draft.rules} report={report} />}
        {suggestion}
        {sendError !== null && (
          <div className="cw-error" role="alert" tabIndex={-1} ref={failedRef}>
            <p>{decideErrorText(t, sendError)}</p>
            {sendError.code !== 'claimed' && (
              <button type="button" className="cw-btn" onClick={() => decisions.retry(report.id)}>
                {t('hub.state.retry')}
              </button>
            )}
          </div>
        )}
        {draft.status === 'ready' && (
          <div className="cw-scard-actions">
            {one !== null && (
              <button ref={primaryRef} type="button" className="cw-btn cw-btn--primary" aria-disabled={!fresh || !q.cooled} {...(keyed ? { 'aria-keyshortcuts': '1' } : {})} onClick={(e) => q.sendPrimary(e)}>
                <span>{stepLabel(t, locale, one.choice)}</span>
                {kbd('1')}
              </button>
            )}
            <button ref={noActionRef} type="button" className="cw-btn" aria-disabled={!fresh || !q.cooled} {...(keyed ? { 'aria-keyshortcuts': '2' } : {})} onClick={(e) => q.sendDismiss(e)}>
              <span>{t('hub.simple.noAction')}</span>
              {kbd('2')}
            </button>
            {quick !== null && (
              <button ref={quickRef} type="button" className="cw-btn" aria-disabled={!fresh || !q.cooled} {...(keyed ? { 'aria-keyshortcuts': '3' } : {})} onClick={(e) => q.sendWarning(e)}>
                <span>{stepLabel(t, locale, quick.choice)}</span>
                {kbd('3')}
              </button>
            )}
            <button ref={elseRef} type="button" className={one === null ? 'cw-btn cw-btn--primary' : 'cw-btn'} onClick={openElse}>
              {t('hub.simple.else')}
            </button>
          </div>
        )}
        {one !== null && (
          <p className="cw-hint cw-scard-fine">
            {one.choice.kind === 'note'
              ? t('hub.simple.sees.note', { name, seconds: SECONDS })
              : t('hub.simple.sees', { name, rule: one.rule, count: one.lineCount, seconds: SECONDS })}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="cw-scard" ref={root} aria-label={t('hub.simple.case.label', { who: name })} {...(left ? { 'data-gone': 'true' } : {})}>
      <QuickKeys quick={q} digits={digits} />
      {!left && (
        <>
          <header className="cw-scard-head">
            <h2 className="cw-screen-title" tabIndex={-1}>
              {name}
            </h2>
            <p className="cw-scard-sub">
              {reportedLine(t, locale, report, people, now(), group === null ? null : { reports: group.reports, reasons: group.reasons })}
            </p>
          </header>
          <ReporterWarning report={report} people={people} />
          <Said report={report} target={target} people={people} />
          <RecordSection />
        </>
      )}
      {decision}
    </section>
  );
}
