import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { actorName } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { byId, isTypingTarget, modalIn, rootOf } from '../dom.js';
import { isWaiting, useDecisions } from '../decisions.js';
import { EVIDENCE_MAX, MAX_ACTIONS, REASON_MAX, resolveDraft, toInput } from '../decision.js';
import type { Problem, UiVerdict } from '../decision.js';
import { excerptLines, personName } from '../excerpt.js';
import { useHubData } from '../hooks.js';
import { useKeyListener } from '../keyScope.js';
import { useMode } from '../mode.js';
import { useQuickKeys } from '../quickKeys.js';
import { decideErrorText } from '../labels.js';
import { modKey, keyLabel } from '../shortcuts.js';
import type { Reason, ReportDetail } from '../types.js';
import { ErrorBlock, Kbd, Notice, Skeleton } from '../ui.js';
import { ActionCard, Field } from './ActionEditor.js';
import { ActionRow } from './ActionRow.js';
import { Decided } from './Decided.js';
import { DecisionResult } from './DecisionResult.js';
import { SuggestionCard } from './SuggestionCard.js';
import { useCase } from './CaseContext.js';
import { LazyAiParts, LazyBulkDismiss } from '../lazyParts.js';
import { actsBlocked, isRepeatClick } from './actGuard.js';
import { DetailedQuickKeys } from './QuickKeys.js';
import { takeLastQuick, useQuickActions } from './useQuickActions.js';
import { UNDO_MS } from '../toasts.js';

// The decision bar, docked under the evidence. It opens pre-filled: the ladder's suggestion as the reported person's action,
// their own lines chosen, the report's rule. A moderator chooses a verdict (1, 2 or 3), writes a reason (or taps a saved one) and
// presses Decide and take next (Ctrl or Cmd with Enter). The decision is then held for five seconds with an Undo before it is sent.
//
// There is no idempotency key to send: the server recognises a repeated decision by its content (report, verdict and actions)
// and answers `replay: true`, so the same body is always safe to send again.

const VERDICTS: ReadonlyArray<{ verdict: UiVerdict; key: string }> = [
  { verdict: 'fair', key: '1' },
  { verdict: 'not_a_problem', key: '2' },
  { verdict: 'bad_faith', key: '3' },
];
const SECONDS = UNDO_MS / 1000;

/** The saved reasons, as chips: one press puts the text in the reason box. */
export function ReasonChips({ reasons, onPick }: { reasons: readonly Reason[]; onPick: (r: Reason) => void }) {
  const { t } = useHub();
  if (reasons.length === 0) return null;
  return (
    <div className="cw-chips" role="group" aria-label={t('hub.decide.reasons.label')}>
      {reasons.map((r) => (
        <button key={r.id} type="button" className="cw-chip" title={r.text} onClick={() => onPick(r)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** The dock: verdict, plan, reason, and the buttons. All of the case's decision lives here. */
export function DecisionBar() {
  const { t, can, session, shortcuts, go } = useHub();
  const listen = useKeyListener();
  const c = useCase();
  const decisions = useDecisions();
  const actions = useCaseActions();
  const { detail, entry, holder, people, left: gone } = c;
  const draft = c.draft;
  // "Nothing wrong here" is one button in the bar in every mode. The digits act at once only in Detailed, and only when the moderator
  // turned Quick keys on (otherwise they choose a verdict, as they always did).
  const lite = useQuickActions({ enabled: false });
  const { mode } = useMode();
  const quickKeys = useQuickKeys();
  const quickActive = shortcuts && mode === 'detailed' && quickKeys.on;
  const dismissId = `${useId()}-dismiss`;
  const report = detail.data?.report;
  const base = useId();
  const bodyId = `${base}-body`;
  const [attempted, setAttempted] = useState(false);
  const [failedTries, setFailedTries] = useState(0);
  const [editing, setEditing] = useState(false);
  c.aiBus.edit.current = () => setEditing(true);
  const [sheet, setSheet] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  // A field of this bar, looked up in the root the bar is in (the page's document or a shadow root).
  const field = (id: string): HTMLElement | null => (dock.current === null ? null : byId(rootOf(dock.current), id));
  const heldRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);

  const status = entry?.state.status;
  const waiting = isWaiting(entry);
  // Decided (waiting or sent): the case is off the screen and this is all that is left of it.
  const open = report?.status === 'open';
  const canDecide = can('reports.decide');
  const readOnly = holder.kind === 'other';
  const editable = open && canDecide && draft.status === 'ready' && !waiting && status !== 'done' && status !== 'conflict';

  const reasons = useHubData<Reason[] | null>(open && canDecide && can('reasons.read') ? 'reasons' : 'reasons:idle', () =>
    open && canDecide && can('reasons.read') ? session.reasons() : Promise.resolve(null),
  );

  const lineList = useMemo(() => (report === undefined ? [] : excerptLines(report)), [report]);
  const target = report?.targetPerson ?? '';
  const targetPerson = people.find((p) => p.ref === target);
  const nameOfTarget = targetPerson === undefined ? '' : personName(targetPerson, people, t);
  const form = draft.form;
  const dismissal = form.verdict === 'not_a_problem' || form.verdict === 'bad_faith';
  const plainDismissal = form.verdict === 'not_a_problem' && form.actions.length === 0;
  const shown = attempted ? draft.problems : { actions: {}, count: 0 };
  const sendError = status === 'failed' && entry?.state.status === 'failed' ? entry.state.error : null;
  const addId = `${base}-add`;
  const submitId = `${base}-submit`;

  useEffect(() => {
    if (focusId === null) return;
    field(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);
  useEffect(() => {
    if (failedTries > 0) {
      setSheet(true);
      summary.current?.focus();
    }
  }, [failedTries]);
  // Focus moves in a microtask, not inside the effect: the decision store can change from a page event or a timer, and that
  // commit runs its effects at once. Moving focus there would dispatch focus events (and whatever wraps them) in the middle of the
  // commit; a microtask lands in the same place a moment later.
  useEffect(() => {
    if (status === 'held') queueMicrotask(() => heldRef.current?.focus());
    else if (status === 'done' && entry?.state.status === 'done') {
      draft.announce(entry.state.replay ? t('hub.decide.result.replay') : t('hub.decide.result.done'));
      queueMicrotask(() => resultRef.current?.focus());
    } else if (status === 'failed') {
      // On a phone the sheet was closed when the decision was queued: open it, or the error and Try again are out of sight.
      setSheet(true);
      queueMicrotask(() => failedRef.current?.focus());
    } else if (status === 'undone') {
      // Undone: the case is back and the sheet with it, with focus on the button that sends it again.
      setSheet(true);
      setFocusId(report !== undefined && takeLastQuick(report.id) === 'none' ? dismissId : submitId);
    } else if (status === 'conflict') {
      draft.announce(t('hub.decide.already'));
      queueMicrotask(() => conflictRef.current?.focus());
      detail.reload();
    }
    if (status === 'held' || status === 'done') setSheet(false);
  }, [status]);

  // The same words, said twice, must be heard twice: the live region is keyed by the announcement's number.
  const live = draft.announcement;

  /** `click` is the click that asked, if one did: a click obeys the same guards as every act key (the case has aged; the second click of a double click is the first one's echo). */
  const decide = (andNext: boolean, click?: { detail?: number }): void => {
    if (!editable || readOnly || report === undefined) return;
    if (click !== undefined && (isRepeatClick(click) || !c.settled())) return;
    setAttempted(true);
    if (draft.problems.count > 0) {
      setFailedTries((n) => n + 1);
      return;
    }
    // What the AI's read was, if one was shown, and whether this is its suggestion as it stood (the server checks it against the decision).
    const ai = c.echo(undefined, form);
    const input = toInput(form);
    decisions.submit({ reportId: report.id, person: report.targetPerson, name: nameOfTarget, input: ai === undefined ? input : { ...input, ai }, snapshot: form });
    // On to the same person's next report, or the next case: one rule, in `continueFrom`.
    if (andNext) void actions.continueFrom({ reportId: report.id, person: report.targetPerson });
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const stateRef = useRef({ editable: editable && !readOnly, setVerdict: draft.setVerdict, quickActive, settled: c.settled });
  stateRef.current = { editable: editable && !readOnly, setVerdict: draft.setVerdict, quickActive, settled: c.settled };

  // 1, 2 and 3 choose the verdict; Ctrl or Cmd with Enter decides and takes the next case. Neither fires while typing (except
  // Ctrl+Enter, which is made for the reason box), under a window, or when the adopter turned shortcuts off.
  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (e: KeyboardEvent, hub: HTMLElement): void => {
      if (e.defaultPrevented || e.isComposing || !stateRef.current.editable) return;
      if (modalIn(hub) !== null) return;
      if (e.key === 'Enter' && (e.ctrlKey !== e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        // The same guards as every act key: a held key is one action, and a case that has just appeared (or a move to another one that
        // is on its way) is not decided by a key meant for the one before.
        if (e.repeat || !stateRef.current.settled() || actsBlocked(hub)) return;
        decideRef.current(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e)) return;
      // With Quick keys on the digits act at once (QuickKeys): they no longer choose a verdict, and are never both.
      if (stateRef.current.quickActive) return;
      const hit = VERDICTS.find((v) => v.key === e.key);
      if (hit !== undefined) {
        e.preventDefault();
        stateRef.current.setVerdict(hit.verdict);
      }
    };
    // Heard on the hub's root in the shell, and on the piece's own root in a piece (see `keyScope.ts`).
    return listen(onKeyDown);
  }, [shortcuts]);

  if (report === undefined) return null;

  // The list of problems, each a button that takes the person to the field.
  const items: Array<{ id: string; problem: Problem }> = [];
  if (shown.verdict !== undefined) items.push({ id: `${base}-verdict-fair`, problem: shown.verdict });
  if (shown.evidence !== undefined) items.push({ id: `${base}-evidence`, problem: shown.evidence });
  form.actions.forEach((a) => {
    const p = shown.actions[a.uid];
    if (p === undefined) return;
    const where = (field: string): string => `${base}-${a.uid}-${field}`;
    if (p.person !== undefined) items.push({ id: where('person'), problem: p.person });
    if (p.what !== undefined) items.push({ id: where('what'), problem: p.what });
    if (p.length !== undefined) items.push({ id: `${where('length')}-number`, problem: p.length });
    if (p.rule !== undefined) items.push({ id: where('rule'), problem: p.rule });
    if (p.gapNote !== undefined) items.push({ id: where('gap'), problem: p.gapNote });
    if (p.lines !== undefined) items.push({ id: where('person'), problem: p.lines });
  });
  if (shown.list !== undefined) items.push({ id: addId, problem: shown.list });
  if (shown.reason !== undefined) items.push({ id: `${base}-reason`, problem: shown.reason });

  const atLimit = form.actions.length >= MAX_ACTIONS;
  // A problem on an action that is shown in short opens the editor, where the field is.
  const goTo = (id: string): void => {
    if (field(id) === null) {
      setEditing(true);
      setFocusId(id);
    } else field(id)?.focus();
  };
  const problemsOf = (uid: string): { rule?: Problem } | undefined => shown.actions[uid];

  // While the decision is waiting (held or sending) there is a way on: the next case, without waiting for the answer.
  // One case per person: when they have other open reports the way on is their next one (the claim stays), and Take next case
  // is the other choice.
  const nextReport = c.next;
  const wayOn = (finished: boolean): ReactNode => (
    <>
      {nextReport !== null && (
        <button
          type="button"
          className="cw-btn cw-btn--primary"
          onClick={() => void actions.continueFrom({ reportId: report.id, person: report.targetPerson })}
        >
          {t('hub.decide.nextReport', { name: nameOfTarget, count: nextReport.left })}
        </button>
      )}
      <button
        type="button"
        className={finished && nextReport === null ? 'cw-btn cw-btn--primary' : 'cw-btn'}
        onClick={() => void actions.takeNext().then((r) => r === 'none' && go({ name: 'overview' }))}
      >
        {t('hub.queue.takeNext')}
      </button>
    </>
  );
  let body: ReactNode;
  if (!open) {
    body = (
      <>
        {entry?.state.status === 'done' && <DecisionResult state={entry.state} />}
        {status === 'conflict' && (
          <Notice tone="warn" role="alert">
            <div ref={conflictRef} tabIndex={-1}>
              {t('hub.decide.already')}
            </div>
          </Notice>
        )}
        <Decided detail={detail.data as ReportDetail} />
      </>
    );
  } else if (!canDecide) {
    body = <p className="cw-hint">{t('hub.decide.denied')}</p>;
  } else {
    const verdictChosen = form.verdict;
    body = (
      <>
        {gone && (
          <h2 className="cw-gone-title" tabIndex={-1}>
            {t('hub.decide.gone.title', { who: nameOfTarget })}
          </h2>
        )}
        {status === 'held' && (
          <div className="cw-queued" role="status" tabIndex={-1} ref={heldRef}>
            <p>
              <strong>{t('hub.decide.queued')}</strong> <span>{t('hub.decide.queued.note', { seconds: SECONDS })}</span>
            </p>
            <button type="button" className="cw-btn" onClick={() => decisions.undo(report.id)}>
              {t('hub.toast.undo')}
            </button>
            {wayOn(false)}
          </div>
        )}
        {status === 'sending' && (
          <div className="cw-queued" role="status" aria-busy="true">
            <p>
              <strong>{t('hub.decide.submitting')}</strong>
            </p>
            {wayOn(false)}
          </div>
        )}
        {status === 'done' && entry?.state.status === 'done' && (
          <DecisionResult state={entry.state} innerRef={resultRef}>
            {wayOn(true)}
          </DecisionResult>
        )}
        {status === 'conflict' && (
          <Notice tone="warn" role="alert">
            <div ref={conflictRef} tabIndex={-1}>
              {t('hub.decide.already')}
            </div>
          </Notice>
        )}
        {readOnly && holder.kind === 'other' && (
          <div className="cw-queued" role="status" data-readonly="true">
            <p>
              <strong>{t('hub.decide.readOnly', { name: actorName(holder.by) })}</strong>{' '}
              <span>{t(can('claims.override') ? 'hub.decide.readOnly.senior' : 'hub.decide.readOnly.note')}</span>
            </p>
          </div>
        )}
        {draft.status === 'loading' ? (
          <div className="cw-loading">
            <p role="status">{t('hub.state.loading')}</p>
            <Skeleton lines={3} />
          </div>
        ) : (
          <form className="cw-form" noValidate hidden={!editable} onSubmit={(e) => e.preventDefault()}>
            <fieldset className="cw-readonly" disabled={readOnly}>
              {c.aiRead?.recommendation != null && <LazyAiParts part="bar" />}
              <fieldset className="cw-verdicts">
                <legend className="cw-sr">{t('hub.decide.verdict.legend')}</legend>
                <div className="cw-verdict-grid">
                  {VERDICTS.map(({ verdict, key }) => (
                    <div key={verdict} className="cw-radio">
                      <input
                        type="radio"
                        id={`${base}-verdict-${verdict}`}
                        name={`${base}-verdict`}
                        value={verdict}
                        checked={verdictChosen === verdict}
                        aria-describedby={`${base}-verdict-${verdict}-hint`}
                        {...(shortcuts ? { 'aria-keyshortcuts': key } : {})}
                        onChange={() => draft.setVerdict(verdict)}
                      />
                      <label htmlFor={`${base}-verdict-${verdict}`}>
                        <span>{t(`hub.decide.verdict.${verdict}`)}</span>
                        {shortcuts && (
                          <span aria-hidden="true">
                            <Kbd>{key}</Kbd>
                          </span>
                        )}
                      </label>
                      <p id={`${base}-verdict-${verdict}-hint`} className="cw-sr">
                        {t(`hub.decide.verdict.${verdict}.hint`)}
                      </p>
                    </div>
                  ))}
                </div>
                {shown.verdict !== undefined && <p className="cw-field-error">{t(shown.verdict.key, shown.verdict.params)}</p>}
              </fieldset>

              {form.verdict === 'bad_faith' && (
                <Field
                  id={`${base}-evidence`}
                  label={t('hub.decide.evidence.label')}
                  hint={t('hub.decide.evidence.hint')}
                  counter={t('hub.decide.counter', { count: form.evidence.trim().length, max: EVIDENCE_MAX })}
                  problem={shown.evidence}
                >
                  {(a) => <textarea {...a} rows={3} value={form.evidence} onChange={(e) => draft.setForm((f) => ({ ...f, evidence: e.target.value }))} />}
                </Field>
              )}

              <fieldset className="cw-actions" id={`${base}-panel`}>
                <legend className="cw-sr">{t('hub.decide.actions.legend')}</legend>
                {draft.rulesState === 'denied' && <p className="cw-hint">{t('hub.decide.rules.denied')}</p>}
                {draft.rulesState === 'failed' && draft.rulesError !== null && (
                  <ErrorBlock error={draft.rulesError} what={t('hub.state.what.rules')} onRetry={draft.reloadRules} />
                )}
                {draft.rulesState === 'ok' && !can('sanctions.apply') && <p className="cw-hint">{t('hub.decide.noApply')}</p>}
                {draft.ctx.canApply && (
                  <>
                    {!dismissal && (
                      <SuggestionCard
                        draft={draft}
                        editing={editing}
                        setEditing={setEditing}
                        dismissal={dismissal}
                        panelId={`${base}-panel`}
                        problemsOf={problemsOf}
                        nameOfTarget={nameOfTarget}
                      />
                    )}
                    {form.actions.length === 0 && !dismissal && <p className="cw-hint">{t('hub.decide.actions.hint')}</p>}
                    {dismissal && <p className="cw-hint">{t('hub.decide.actions.dismissalHint')}</p>}
                    {form.actions.map((a, i) => {
                      const matched = !dismissal && i === draft.suggestionIndex;
                      if (!editing && matched) return null;
                      return editing || resolveDraft(a) === null ? (
                        <ActionCard
                          key={a.uid}
                          n={i + 1}
                          base={base}
                          draft={a}
                          people={people}
                          target={target}
                          dismissal={dismissal}
                          rules={draft.rules}
                          choices={draft.choices}
                          lengths={draft.lengths}
                          canPermanent={draft.ctx.canPermanent}
                          lines={lineList.filter((l) => l.person === a.person)}
                          problems={shown.actions[a.uid]}
                          onChange={(patch) => draft.patchAction(a.uid, patch)}
                          onToggleLine={(id) => draft.toggleLine(a.uid, id)}
                          onRemove={() => {
                            draft.removeAction(a.uid, i + 1);
                            setFocusId(addId);
                          }}
                        />
                      ) : (
                        <ActionRow
                          key={a.uid}
                          n={i + 1}
                          draft={a}
                          base={base}
                          people={people}
                          rules={draft.rules}
                          problems={problemsOf(a.uid)}
                          onChange={(patch) => draft.patchAction(a.uid, patch)}
                          onEdit={() => {
                            setEditing(true);
                            setFocusId(`${base}-${a.uid}-person`);
                          }}
                          onRemove={() => {
                            draft.removeAction(a.uid, i + 1);
                            setFocusId(addId);
                          }}
                        />
                      );
                    })}
                    <div className="cw-add">
                      <button
                        id={addId}
                        type="button"
                        className="cw-btn"
                        aria-disabled={atLimit}
                        onClick={() => {
                          const uid = draft.addEmptyAction();
                          if (uid !== null) {
                            setEditing(true);
                            setFocusId(`${base}-${uid}-person`);
                          }
                        }}
                      >
                        {t('hub.decide.add')}
                      </button>
                      {atLimit && <p className="cw-hint">{t('hub.decide.add.limit', { max: MAX_ACTIONS })}</p>}
                    </div>
                  </>
                )}
              </fieldset>

              <ReasonChips
                reasons={reasons.data ?? []}
                onPick={(r) => {
                  draft.setForm((f) => ({ ...f, reason: f.reason.trim() === '' ? r.text : `${f.reason.trimEnd()} ${r.text}` }));
                  draft.announce(t('hub.decide.reasons.added', { label: r.label }));
                }}
              />
              <Field
                id={`${base}-reason`}
                label={t('hub.decide.reason.label')}
                hint={plainDismissal ? `${t('hub.decide.reason.hint.dismissal')} ${t('hub.decide.reason.hint')}` : t('hub.decide.reason.hint')}
                counter={t('hub.decide.counter', { count: form.reason.trim().length, max: REASON_MAX })}
                problem={shown.reason}
              >
                {(a) => <textarea {...a} rows={1} value={form.reason} onChange={(e) => draft.setForm((f) => ({ ...f, reason: e.target.value }))} />}
              </Field>

              {attempted && items.length > 0 && (
                <div className="cw-problems" role="alert" tabIndex={-1} ref={summary}>
                  <p>
                    <strong>{t('hub.decide.problems', { count: draft.problems.count })}</strong>
                  </p>
                  <ul>
                    {items.map((item, i) => (
                      <li key={`${item.id}-${i}`}>
                        <button type="button" className="cw-linkbtn" onClick={() => goTo(item.id)}>
                          {t(item.problem.key, item.problem.params)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

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

              <div className="cw-submit">
                <button id={submitId} type="button" className="cw-btn cw-btn--primary" aria-disabled={readOnly || !c.cooled} {...(!readOnly && !c.cooled ? { 'data-cooling': 'true' } : {})} {...(shortcuts ? { 'aria-keyshortcuts': 'Control+Enter Meta+Enter' } : {})} onClick={(e) => decide(true, e)}>
                  <span>{t('hub.decide.submitNext')}</span>
                  {shortcuts && (
                    <span className="cw-submit-keys" aria-hidden="true">
                      <Kbd>{keyLabel(t, modKey())}</Kbd>
                      <Kbd>{t('hub.key.enter')}</Kbd>
                    </span>
                  )}
                </button>
                <button
                  id={dismissId}
                  type="button"
                  className="cw-btn"
                  aria-disabled={!lite.usable || !lite.cooled}
                  {...(lite.usable && !lite.cooled ? { 'data-cooling': 'true' } : {})}
                  aria-describedby={`${dismissId}-hint`}
                  {...(quickActive ? { 'aria-keyshortcuts': '2' } : {})}
                  onClick={(e) => lite.sendDismiss(e)}
                >
                  {t('hub.quick.dismiss')}
                </button>
                <p id={`${dismissId}-hint`} className="cw-sr">
                  {t('hub.quick.dismiss.hint')}
                </p>
                <button type="button" className="cw-btn" aria-disabled={readOnly || !c.cooled} {...(!readOnly && !c.cooled ? { 'data-cooling': 'true' } : {})} onClick={(e) => decide(false, e)}>
                  {t('hub.decide.submit')}
                </button>
                <p className="cw-hint">{t('hub.decide.undoHint', { seconds: SECONDS })}</p>
              </div>
            </fieldset>
            {can('reports.decide.bulk') && <LazyBulkDismiss />}
          </form>
        )}
      </>
    );
  }

  return (
    <section
      ref={dock}
      className="cw-dock"
      aria-label={t('hub.decide.title')}
      data-open={sheet ? 'true' : 'false'}
      {...(readOnly ? { 'data-readonly': 'true' } : {})}
      {...(gone ? { 'data-gone': 'true' } : {})}
    >
      <div className="cw-dock-bar">
        <p className="cw-dock-title" aria-hidden="true">
          {t('hub.decide.title')}
        </p>
        <button type="button" className="cw-btn cw-btn--primary cw-dock-toggle" aria-expanded={sheet} aria-controls={bodyId} onClick={() => setSheet((s) => !s)}>
          {t(sheet ? 'hub.decide.sheet.close' : 'hub.decide.sheet.open')}
        </button>
      </div>
      <div className="cw-dock-body" id={bodyId}>
        {quickActive && <DetailedQuickKeys />}
        <div className="cw-sr" role="status" aria-label={t('hub.decide.live')}>
          <span key={live.n}>{live.text}</span>
        </div>
        {body}
      </div>
    </section>
  );
}
