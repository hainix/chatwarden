import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { actorName } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { isWaiting, useDecisions } from '../decisions.js';
import { outcomeChoice, toInput } from '../decision.js';
import type { DecisionForm } from '../decision.js';
import { excerptLines, personName } from '../excerpt.js';
import type { ReportPerson } from '../excerpt.js';
import { personTag, relativeTime } from '../format.js';
import { useHubData } from '../hooks.js';
import { decideErrorText, outcomeLabel } from '../labels.js';
import { useKeyListener } from '../keyScope.js';
import { isTypingTarget } from '../shortcuts.js';
import { needsSenior, noActionForm, oneClickOf, ownLinesOf, recordLine, reporterDecided, reporterWarrants, stepLabel } from '../simple.js';
import type { OneClick } from '../simple.js';
import { UNDO_MS } from '../toasts.js';
import type { QueueGroup } from '../queue.js';
import type { ReporterRecord, StaffReport } from '../types.js';
import { Card, ErrorBlock, Fetched, Kbd, Notice, Skeleton } from '../ui.js';
import { useCase } from './CaseContext.js';
import { Field } from './ActionEditor.js';
import { DecisionBar } from './DecisionBar.js';
import { useRulePick } from './useRulePick.js';
import type { RulePick } from './useRulePick.js';
import { Line } from './Transcript.js';

// The Simple case view: one card per case. Who, why, what they said, their record, the ladder's suggestion and three ways to
// answer it. Everything underneath is the Detailed workbench's: the same case read, the same claim, the same decision hold (the five
// second Undo, sent at once when the page goes). One click and "No action needed" hand a form to `decisions.submit`, the call the
// decision bar makes; "Something else…" opens the decision bar itself, in place.

/** The uid of the one action a one-click decision holds. */
const UID = 'a1';
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
  if (!wants || record === undefined || record === null || !reporterWarrants(record)) return null;
  const who = people.find((p) => p.ref === ref);
  return (
    <Notice tone="warn">
      {t('hub.simple.reporterWarning', { name: who === undefined ? t('hub.person.unnamed', { tag: personTag(ref) }) : personName(who, people, t), upheld: record.actioned, count: reporterDecided(record) })}
    </Notice>
  );
}

/**
 * The rule the report breaks. When the reason points at one rule it is preselected and says what the report was filed as, so it can be
 * changed; when no rule is clear it asks, leading with the rules the reason usually means. Nothing is suggested until one is picked.
 */
function RuleField({ pick, rules, report }: { pick: RulePick; rules: ReadonlyArray<{ number: number; title: string }>; report: StaffReport & { reportedReasonLabel?: string | null } }) {
  const { t } = useHub();
  const id = useId();
  const ask = pick.mode === 'ask';
  const mapped = pick.choice?.kind === 'ask' ? pick.choice.mapped : [];
  const option = (r: { number: number; title: string }): ReactNode => (
    <option key={r.number} value={r.number}>
      {t('hub.guide.rule.named', { number: r.number, title: r.title })}
    </option>
  );
  const lead = rules.filter((r) => mapped.includes(r.number));
  const rest = rules.filter((r) => !mapped.includes(r.number));
  const hint = ask
    ? pick.picked === null
      ? t('hub.simple.rule.askHint')
      : undefined
    : t('hub.simple.rule.knownHint', { reason: report.reportedReasonLabel ?? report.reportedReason ?? '', rule: pick.picked ?? '' });
  return (
    <div className="cw-scard-rule">
      <Field id={`${id}-rule`} label={t(ask ? 'hub.simple.rule.ask' : 'hub.simple.rule.known')} {...(hint === undefined ? {} : { hint })}>
        {(a) => (
          <select {...a} value={pick.picked ?? ''} onChange={(e) => pick.pick(e.target.value === '' ? null : Number(e.target.value))}>
            {ask && <option value="">{t('hub.simple.rule.pick')}</option>}
            {lead.length > 0 ? (
              <>
                <optgroup label={t('hub.simple.rule.usual')}>{lead.map(option)}</optgroup>
                <optgroup label={t('hub.simple.rule.rest')}>{rest.map(option)}</optgroup>
              </>
            ) : (
              rules.map(option)
            )}
          </select>
        )}
      </Field>
      {pick.error !== null && (
        <p className="cw-field-error" role="alert">
          {t('hub.simple.rule.failed')}
        </p>
      )}
    </div>
  );
}

/** The card for a case. Read through `<CaseProvider>`, the one the hub wraps a case in. */
export function CaseCard() {
  const { t, locale, can, shortcuts, now } = useHub();
  const c = useCase();
  const decisions = useDecisions();
  const actions = useCaseActions();
  const { detail, entry, holder, people, group, left, draft } = c;
  const report = detail.data?.report;
  const [elseOpen, setElseOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const noActionRef = useRef<HTMLButtonElement>(null);
  const elseRef = useRef<HTMLButtonElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);
  const lastUsed = useRef<'primary' | 'none' | 'quick'>('primary');
  const quickRef = useRef<HTMLButtonElement>(null);
  const titleFocused = useRef(false);
  const base = useId();
  const listen = useKeyListener();

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
  const waiting = isWaiting(entry);
  const readOnly = holder.kind === 'other';
  const editable = open && canDecide && draft.status === 'ready' && !waiting && status !== 'done' && status !== 'conflict';
  // Which rule the card works from: the reason's one rule (preselected), or the one the moderator picks when none is clear.
  const pick = useRulePick({
    detail: detail.data,
    reasons: draft.reportReasons,
    active: draft.rules.map((r) => r.number),
    enabled: draft.rulesState === 'ok' && can('sanctions.apply'),
  });
  // The suggestion and the rule come from the read of the case. A newer report about the person means the ladder may have moved
  // (and the case with it), so the case is read again, and until that read is in, one click offers nothing it could send stale.
  // A decision of your own that is on its way changes the count too: that is not news, so it reads nothing.
  const count = group?.reports ?? null;
  const readAt = useRef<number | null>(count);
  const behind = readAt.current !== null && count !== null && readAt.current !== count;
  const fresh = !behind && !detail.loading;
  const settled = useRef(left);
  settled.current = left;
  useEffect(() => {
    if (count === null) return;
    const before = readAt.current;
    readAt.current = count;
    if (before !== null && before !== count && !settled.current) detail.reload();
  }, [count]);
  const usable = editable && !readOnly && !elseOpen && fresh;

  const target = people.find((p) => p.role === 'target');
  const name = target === undefined ? '' : personName(target, people, t);
  const suggest = pick.mode === 'none' ? detail.data?.suggest : (pick.suggestion ?? undefined);
  const ruleCited = pick.mode === 'none' ? detail.data?.rule : pick.picked;
  const choice = suggest === undefined ? null : outcomeChoice(suggest.outcome);
  const one: OneClick | null = useMemo(
    () => (suggest === undefined || detail.data === undefined || ruleCited === undefined || ruleCited === null ? null : oneClickOf(draft.ctx, draft.rules, suggest.outcome, ruleCited, detail.data.report.lineId, UID)),
    [draft.ctx, draft.rules, suggest, detail.data, ruleCited],
  );
  // The light tap: when the ladder suggests more than a warning, a warning is one click too (same hold, same Undo, the rule's title as the reason).
  const quick: OneClick | null = useMemo(
    () =>
      detail.data === undefined || choice === null || choice.kind === 'warning' || choice.kind === 'note' || ruleCited === undefined || ruleCited === null
        ? null
        : oneClickOf(draft.ctx, draft.rules, 'warning', ruleCited, detail.data.report.lineId, UID),
    [draft.ctx, draft.rules, choice, detail.data, ruleCited],
  );
  const sendError = status === 'failed' && entry?.state.status === 'failed' ? entry.state.error : null;

  /** Hands a form to the hold the decision bar uses; `andNext` goes on to the person's next report or the next case. */
  const send = (form: DecisionForm, andNext: boolean): void => {
    if (!usable || report === undefined) return;
    decisions.submit({ reportId: report.id, person: report.targetPerson, name, input: toInput(form), snapshot: form });
    if (andNext) void actions.continueFrom({ reportId: report.id, person: report.targetPerson });
  };
  const sendPrimary = (andNext: boolean): void => {
    if (one === null) return;
    lastUsed.current = 'primary';
    send(one.form, andNext);
  };
  const sendQuick = (): void => {
    if (quick === null) return;
    lastUsed.current = 'quick';
    send(quick.form, false);
  };
  const sendNoAction = (): void => {
    lastUsed.current = 'none';
    send(noActionForm(t('hub.simple.noAction.reason')), false);
  };

  const latest = useRef({ usable, one, quick, sendPrimary, sendNoAction, sendQuick });
  latest.current = { usable, one, quick, sendPrimary, sendNoAction, sendQuick };
  // 1 is the primary button, 2 is No action needed, 3 is Send a warning (when it is offered), Ctrl or Cmd with Enter is the primary button and then the next case. Not while
  // typing, under a window, or when the adopter turned shortcuts off. (With Something else open the decision bar's own keys apply.)
  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      const s = latest.current;
      if (e.defaultPrevented || e.isComposing || !s.usable) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      if (e.key === 'Enter' && e.ctrlKey !== e.metaKey && !e.altKey && !e.shiftKey) {
        if (s.one === null) return;
        e.preventDefault();
        s.sendPrimary(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === '1' && s.one !== null) {
        e.preventDefault();
        s.sendPrimary(false);
      } else if (e.key === '2') {
        e.preventDefault();
        s.sendNoAction();
      } else if (e.key === '3' && s.quick !== null) {
        e.preventDefault();
        s.sendQuick();
      }
    };
    // In the shell this listens on the page; in a piece, on the piece's own root (see `keyScope.ts`).
    return listen(onKeyDown);
  }, [shortcuts]);

  // Undone: the card is back, with keyboard focus on the button that sent it. Failed: on the message.
  // (In a microtask: the decision store can change from a page event or a timer, and that commit runs its effects at once.)
  useEffect(() => {
    if (status === 'undone') {
      queueMicrotask(() => {
        const back = lastUsed.current === 'quick' ? quickRef.current : lastUsed.current === 'primary' ? primaryRef.current : noActionRef.current;
        (back ?? noActionRef.current)?.focus();
      });
    } else if (status === 'failed') queueMicrotask(() => failedRef.current?.focus());
  }, [status]);

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
      shortcuts && (
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
              <button ref={primaryRef} type="button" className="cw-btn cw-btn--primary" aria-disabled={!fresh} {...(shortcuts ? { 'aria-keyshortcuts': '1' } : {})} onClick={() => sendPrimary(false)}>
                <span>{stepLabel(t, locale, one.choice)}</span>
                {kbd('1')}
              </button>
            )}
            <button ref={noActionRef} type="button" className="cw-btn" aria-disabled={!fresh} {...(shortcuts ? { 'aria-keyshortcuts': '2' } : {})} onClick={sendNoAction}>
              <span>{t('hub.simple.noAction')}</span>
              {kbd('2')}
            </button>
            {quick !== null && (
              <button ref={quickRef} type="button" className="cw-btn" aria-disabled={!fresh} {...(shortcuts ? { 'aria-keyshortcuts': '3' } : {})} onClick={sendQuick}>
                <span>{stepLabel(t, locale, quick.choice)}</span>
                {kbd('3')}
              </button>
            )}
            <button ref={elseRef} type="button" className={one === null ? 'cw-btn cw-btn--primary' : 'cw-btn'} onClick={() => setElseOpen(true)}>
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
