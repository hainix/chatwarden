import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { actorName } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { useDecisions } from '../decisions.js';
import {
  EVIDENCE_MAX,
  MAX_ACTIONS,
  REASON_MAX,
  needsBanPermission,
  outcomeChoice,
  resolveDraft,
  toInput,
} from '../decision.js';
import type { Draft, Problem, UiVerdict } from '../decision.js';
import { excerptLines, personName } from '../excerpt.js';
import type { ReportPerson } from '../excerpt.js';
import { absoluteTime, relativeTime } from '../format.js';
import { useHubData } from '../hooks.js';
import { decideErrorText, kindLabel, outcomeLabel } from '../labels.js';
import { modKey, keyLabel, isTypingTarget } from '../shortcuts.js';
import type { Reason, ReportDetail } from '../types.js';
import { Card, ErrorBlock, Kbd, Notice, Segmented, Skeleton, Tag } from '../ui.js';
import { ActionCard, ActionTitle, Field, RuleOptions } from './ActionEditor.js';
import { useCase } from './CaseContext.js';
import type { DecisionDraft } from './useDecisionForm.js';
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
const LEVELS = ['banter', 'rude', 'hostile', 'severe'] as const;
const SECONDS = UNDO_MS / 1000;

/** What was decided, for a report that is closed. */
function Decided({ detail }: { detail: ReportDetail }) {
  const { t, locale, now } = useHub();
  const r = detail.report;
  return (
    <div className="cw-decided">
      <div className="cw-decided-head">
        <Tag>{t(`hub.reports.tag.${r.status}`)}</Tag>
        {r.badFaith && <Tag tone="warn">{t('hub.report.tag.badFaith')}</Tag>}
      </div>
      {r.actionedBy !== null && r.actionedAt !== null && (
        <p title={absoluteTime(r.actionedAt, locale)}>{t('hub.decide.decided.by', { actor: r.actionedBy, time: relativeTime(r.actionedAt, now(), locale) })}</p>
      )}
      <dl className="cw-decided-notes">
        {r.modNote !== null && (
          <>
            <dt>{t('hub.decide.decided.reason')}</dt>
            <dd>{r.modNote}</dd>
          </>
        )}
        {r.badFaithEvidence !== null && (
          <>
            <dt>{t('hub.decide.decided.evidence')}</dt>
            <dd>{r.badFaithEvidence}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The saved reasons, as chips: one press puts the text in the reason box. */
function ReasonChips({ reasons, onPick }: { reasons: readonly Reason[]; onPick: (r: Reason) => void }) {
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

/** The ladder's suggestion as a card, with the rule of its action, and Change, which opens the full editor. */
function SuggestionCard({
  draft,
  editing,
  setEditing,
  dismissal,
  panelId,
  problemsOf,
  nameOfTarget,
}: {
  draft: DecisionDraft;
  editing: boolean;
  setEditing: (on: boolean) => void;
  dismissal: boolean;
  panelId: string;
  problemsOf: (uid: string) => { rule?: Problem } | undefined;
  nameOfTarget: string;
}) {
  const { t, locale } = useHub();
  const id = useId();
  const choice = outcomeChoice(draft.suggestion.outcome);
  const added = draft.suggestionIndex >= 0 ? draft.form.actions[draft.suggestionIndex] : undefined;
  const permanentBlocked = choice !== null && needsBanPermission(choice) && !draft.ctx.canPermanent;
  const canAdd = choice !== null && draft.ctx.canApply && added === undefined && !permanentBlocked && !dismissal && draft.cannotAdd === null;

  let why: string | null = null;
  if (choice !== null && added === undefined && draft.ctx.canApply) {
    if (dismissal) why = t('hub.decide.suggest.fairOnly');
    else if (permanentBlocked) why = t('hub.decide.suggest.needsSenior');
    else if (draft.cannotAdd === 'limit') why = t('hub.decide.suggest.cannot.limit', { max: MAX_ACTIONS });
    else if (draft.cannotAdd === 'unsupported') why = t('hub.decide.suggest.cannot.unsupported');
  }

  return (
    <div className="cw-suggest" role="group" aria-labelledby={`${id}-title`} data-added={added === undefined ? 'false' : 'true'}>
      <h3 id={`${id}-title`} className="cw-sr">
        {t('hub.decide.suggest.title')}
      </h3>
      <div className="cw-suggest-main">
        {choice !== null && <Card kind={choice.kind} />}
        <div className="cw-suggest-text">
          <p className="cw-suggest-label">{outcomeLabel(t, locale, draft.suggestion.outcome)}</p>
          <p className="cw-hint">{draft.suggestion.why}</p>
        </div>
        <button type="button" className="cw-btn" aria-expanded={editing} aria-controls={panelId} onClick={() => setEditing(!editing)}>
          {t(editing ? 'hub.decide.done' : 'hub.decide.change')}
        </button>
      </div>
      {added !== undefined && !editing && (
        <div className="cw-suggest-rule">
          <Field id={`${id}-rule`} label={t('hub.decide.action.rule')} problem={problemsOf(added.uid)?.rule}>
            {(a) => (
              <select {...a} value={added.rule} onChange={(e) => draft.patchAction(added.uid, { rule: e.target.value })}>
                <RuleOptions rules={draft.rules} />
              </select>
            )}
          </Field>
          <p className="cw-hint">{added.lineIds.length === 0 ? t('hub.decide.action.lines.noneChosen', { name: nameOfTarget }) : t('hub.decide.action.lines.summary', { count: added.lineIds.length, name: nameOfTarget })}</p>
        </div>
      )}
      {editing && (
        <div className="cw-suggest-level" aria-busy={draft.levelBusy}>
          <Segmented
            label={t('hub.decide.suggest.level')}
            value={draft.level ?? ''}
            options={LEVELS.map((l) => ({ value: l as string, label: t(`hub.decide.suggest.level.${l}`) }))}
            onChange={(v) => draft.pickLevel(v as (typeof LEVELS)[number])}
          />
        </div>
      )}
      {draft.levelError !== null && (
        <Notice tone="bad" role="alert">
          <span>{t('hub.decide.suggest.failed')}</span> <span>{decideErrorText(t, draft.levelError)}</span>
        </Notice>
      )}
      {canAdd && (
        <button type="button" className="cw-btn" aria-disabled={draft.levelBusy} onClick={() => !draft.levelBusy && draft.useSuggestion()}>
          {t('hub.decide.suggest.use')}
        </button>
      )}
      {why !== null && <p className="cw-hint">{why}</p>}
    </div>
  );
}

/** One action in short: what, who, which rule, how many lines. Change opens the full editor. */
function ActionRow({
  n,
  draft: d,
  base,
  people,
  rules,
  problems,
  onChange,
  onEdit,
  onRemove,
}: {
  n: number;
  draft: Draft;
  base: string;
  people: readonly ReportPerson[];
  rules: ReadonlyArray<{ number: number; title: string }>;
  problems: { rule?: Problem } | undefined;
  onChange: (patch: Partial<Draft>) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useHub();
  const person = people.find((p) => p.ref === d.person);
  const name = person === undefined ? '' : personName(person, people, t);
  const choice = resolveDraft(d);
  const labelId = `${base}-${d.uid}-row`;
  return (
    <div className="cw-sumrow" role="group" aria-labelledby={labelId}>
      <div className="cw-sumrow-head">
        <span id={labelId} className="cw-sr">
          {t('hub.decide.action.title', { n })}
        </span>
        <ActionTitle draft={d} />
        <span className="cw-hint">{t('hub.decide.action.for', { name })}</span>
        <span className="cw-sumrow-buttons">
          <button type="button" className="cw-btn" aria-label={t('hub.decide.action.changeLabel', { n })} onClick={onEdit}>
            {t('hub.decide.change')}
          </button>
          <button type="button" className="cw-btn" aria-label={t('hub.decide.action.removeLabel', { n })} onClick={onRemove}>
            {t('hub.decide.action.remove')}
          </button>
        </span>
      </div>
      <Field id={`${base}-${d.uid}-rule`} label={t('hub.decide.action.rule')} problem={problems?.rule}>
        {(a) => (
          <select {...a} value={d.rule} onChange={(e) => onChange({ rule: e.target.value })}>
            <RuleOptions rules={rules} />
          </select>
        )}
      </Field>
      {choice !== null && choice.kind !== 'note' && (
        <p className="cw-hint">{d.lineIds.length === 0 ? t('hub.decide.action.lines.noneChosen', { name }) : t('hub.decide.action.lines.summary', { count: d.lineIds.length, name })}</p>
      )}
    </div>
  );
}

/** The dock: verdict, plan, reason, and the buttons. All of the case's decision lives here. */
export function DecisionBar() {
  const { t, can, session, shortcuts, go } = useHub();
  const c = useCase();
  const decisions = useDecisions();
  const actions = useCaseActions();
  const { detail, entry, holder, people } = c;
  const draft = c.draft;
  const report = detail.data?.report;
  const base = useId();
  const bodyId = `${base}-body`;
  const [attempted, setAttempted] = useState(false);
  const [failedTries, setFailedTries] = useState(0);
  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const heldRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const failedRef = useRef<HTMLDivElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);

  const status = entry?.state.status;
  const waiting = status === 'held' || status === 'sending';
  const open = report?.status === 'open';
  const canDecide = can('reports.decide');
  const readOnly = holder.kind === 'other';
  const editable = open && canDecide && draft.status === 'ready' && !waiting && status !== 'done' && status !== 'conflict';

  const reasons = useHubData<Reason[] | null>(open && canDecide && can('reasons.read') ? 'reasons' : 'reasons:idle', () =>
    open && canDecide && can('reasons.read') ? session.reasons() : Promise.resolve(null),
  );

  const lineList = excerptLines(report ?? ({ excerpt: [], people: [], lineId: null } as unknown as NonNullable<typeof report>));
  const target = report?.targetPerson ?? '';
  const targetPerson = people.find((p) => p.ref === target);
  const nameOfTarget = targetPerson === undefined ? '' : personName(targetPerson, people, t);
  const form = draft.form;
  const dismissal = form.verdict === 'not_a_problem' || form.verdict === 'bad_faith';
  const shown = attempted ? draft.problems : { actions: {}, count: 0 };
  const sendError = status === 'failed' && entry?.state.status === 'failed' ? entry.state.error : null;
  const addId = `${base}-add`;

  useEffect(() => {
    if (focusId === null) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);
  useEffect(() => {
    if (failedTries > 0) {
      setSheet(true);
      summary.current?.focus();
    }
  }, [failedTries]);
  useEffect(() => {
    if (status === 'held') heldRef.current?.focus();
    else if (status === 'done' && entry?.state.status === 'done') {
      draft.announce(entry.state.replay ? t('hub.decide.result.replay') : t('hub.decide.result.done'));
      resultRef.current?.focus();
    } else if (status === 'failed') failedRef.current?.focus();
    else if (status === 'conflict') {
      draft.announce(t('hub.decide.already'));
      conflictRef.current?.focus();
      detail.reload();
    }
    if (status === 'held' || status === 'done') setSheet(false);
  }, [status]);

  // The same words, said twice, must be heard twice: the live region is keyed by the announcement's number.
  const live = draft.announcement;

  const decide = (andNext: boolean): void => {
    if (!editable || readOnly || report === undefined) return;
    setAttempted(true);
    if (draft.problems.count > 0) {
      setFailedTries((n) => n + 1);
      return;
    }
    decisions.submit({ reportId: report.id, person: report.targetPerson, name: nameOfTarget, input: toInput(form), snapshot: form });
    if (andNext) {
      void actions.takeNext().then((result) => {
        // Nobody is waiting: leave the finished case for the team view, which says so.
        if (result === 'none') go({ name: 'overview' });
      });
    }
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const stateRef = useRef({ editable: editable && !readOnly, setVerdict: draft.setVerdict });
  stateRef.current = { editable: editable && !readOnly, setVerdict: draft.setVerdict };

  // 1, 2 and 3 choose the verdict; Ctrl or Cmd with Enter decides and takes the next case. Neither fires while typing (except
  // Ctrl+Enter, which is made for the reason box), under a window, or when the adopter turned shortcuts off.
  useEffect(() => {
    if (!shortcuts) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || !stateRef.current.editable) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      if (e.key === 'Enter' && (e.ctrlKey !== e.metaKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        decideRef.current(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const hit = VERDICTS.find((v) => v.key === e.key);
      if (hit !== undefined) {
        e.preventDefault();
        stateRef.current.setVerdict(hit.verdict);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
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
    if (p.rule !== undefined) items.push({ id: where('rule'), problem: p.rule });
    if (p.gapNote !== undefined) items.push({ id: where('gap'), problem: p.gapNote });
    if (p.lines !== undefined) items.push({ id: where('person'), problem: p.lines });
  });
  if (shown.list !== undefined) items.push({ id: addId, problem: shown.list });
  if (shown.reason !== undefined) items.push({ id: `${base}-reason`, problem: shown.reason });

  const atLimit = form.actions.length >= MAX_ACTIONS;
  // A problem on an action that is shown in short opens the editor, where the field is.
  const goTo = (id: string): void => {
    if (document.getElementById(id) === null) {
      setEditing(true);
      setFocusId(id);
    } else document.getElementById(id)?.focus();
  };
  const problemsOf = (uid: string): { rule?: Problem } | undefined => shown.actions[uid];

  let body: ReactNode;
  if (!open) {
    body = (
      <>
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
        {status === 'held' && (
          <div className="cw-queued" role="status" tabIndex={-1} ref={heldRef}>
            <p>
              <strong>{t('hub.decide.queued')}</strong> <span>{t('hub.decide.queued.note', { seconds: SECONDS })}</span>
            </p>
            <button type="button" className="cw-btn" onClick={() => decisions.undo(report.id)}>
              {t('hub.toast.undo')}
            </button>
          </div>
        )}
        {status === 'sending' && (
          <div className="cw-queued" role="status" aria-busy="true">
            <p>
              <strong>{t('hub.decide.submitting')}</strong>
            </p>
          </div>
        )}
        {status === 'done' && entry?.state.status === 'done' && (
          <div className="cw-result" tabIndex={-1} ref={resultRef}>
            <p>
              <strong>{t('hub.decide.result.done')}</strong>
            </p>
            {entry.state.replay && <p>{t('hub.decide.result.replay')}</p>}
            {entry.state.groups.length === 0 ? (
              <p className="cw-hint">{t('hub.decide.result.none')}</p>
            ) : (
              <ul aria-label={t('hub.decide.result.codes')}>
                {entry.state.groups.map((g) => (
                  <li key={g.refCode}>
                    <span className="cw-pid">{t('hub.decide.result.code', { code: g.refCode, kind: kindLabel(t, g.kind) })}</span>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="cw-btn cw-btn--primary" onClick={() => void actions.takeNext().then((r) => r === 'none' && go({ name: 'overview' }))}>
              {t('hub.queue.takeNext')}
            </button>
          </div>
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
              <strong>{t('hub.decide.readOnly', { name: actorName(holder.by) })}</strong> <span>{t('hub.decide.readOnly.note')}</span>
            </p>
            {can('claims.override') && (
              <button type="button" className="cw-btn" onClick={() => void actions.takeOver(report.targetPerson)}>
                {t('hub.claim.takeOver')}
              </button>
            )}
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
                hint={t('hub.decide.reason.hint')}
                counter={t('hub.decide.counter', { count: form.reason.trim().length, max: REASON_MAX })}
                problem={shown.reason}
              >
                {(a) => <textarea {...a} rows={2} value={form.reason} onChange={(e) => draft.setForm((f) => ({ ...f, reason: e.target.value }))} />}
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
                <button type="button" className="cw-btn cw-btn--primary" aria-disabled={readOnly} {...(shortcuts ? { 'aria-keyshortcuts': 'Control+Enter Meta+Enter' } : {})} onClick={() => decide(true)}>
                  <span>{t('hub.decide.submitNext')}</span>
                  {shortcuts && (
                    <span className="cw-submit-keys" aria-hidden="true">
                      <Kbd>{keyLabel(t, modKey())}</Kbd>
                      <Kbd>{t('hub.key.enter')}</Kbd>
                    </span>
                  )}
                </button>
                <button type="button" className="cw-btn" aria-disabled={readOnly} onClick={() => decide(false)}>
                  {t('hub.decide.submit')}
                </button>
                <p className="cw-hint">{t('hub.decide.undoHint', { seconds: SECONDS })}</p>
              </div>
            </fieldset>
          </form>
        )}
      </>
    );
  }

  return (
    <section className="cw-dock" aria-label={t('hub.decide.title')} data-open={sheet ? 'true' : 'false'} {...(readOnly ? { 'data-readonly': 'true' } : {})}>
      <div className="cw-dock-bar">
        <p className="cw-dock-title" aria-hidden="true">
          {t('hub.decide.title')}
        </p>
        <button type="button" className="cw-btn cw-btn--primary cw-dock-toggle" aria-expanded={sheet} aria-controls={bodyId} onClick={() => setSheet((s) => !s)}>
          {t(sheet ? 'hub.decide.sheet.close' : 'hub.decide.sheet.open')}
        </button>
      </div>
      <div className="cw-dock-body" id={bodyId}>
        <div className="cw-sr" role="status" aria-label={t('hub.decide.live')}>
          <span key={live.n}>{live.text}</span>
        </div>
        {body}
      </div>
    </section>
  );
}
