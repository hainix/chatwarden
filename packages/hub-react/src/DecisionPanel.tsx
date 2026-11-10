import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { toHubError } from './client.js';
import type { HubError } from './client.js';
import { useHub } from './context.js';
import {
  CUSTOM_KINDS,
  DURATIONS,
  LINES_MAX,
  MAX_ACTIONS,
  addAction,
  choiceKey,
  dropTargetActions,
  emptyForm,
  GAP_NOTE_MAX,
  hasLength,
  outcomeChoice,
  presets,
  REASON_MAX,
  EVIDENCE_MAX,
  resolveDraft,
  toInput,
  validate,
  withSuggestion,
} from './decision.js';
import type { DecisionForm, Draft, Problem, Problems, UiVerdict, ValidationContext } from './decision.js';
import { excerptLines } from './excerpt.js';
import type { ReportPerson } from './excerpt.js';
import { personName } from './excerpt.js';
import { absoluteTime, personTag, relativeTime, timeOfDay } from './format.js';
import { useHubAction, useHubData } from './hooks.js';
import { choiceLabel, decideErrorText, errorText, kindLabel, lengthPhrase, outcomeLabel } from './labels.js';
import type { ConductLevel, DecideResult, ReportDetail, Suggestion } from './types.js';
import { Fetched, Notice, Panel, Segmented, Tag } from './ui.js';

// The decision panel: the ladder's suggestion, the verdict, the actions on each person, the reason, and one call to
// `POST /reports/:id/decide`. The form refuses what the server would refuse before it sends (`decision.ts`); the server stays
// the judge, and anything it still refuses is shown without losing what was typed.
//
// There is no idempotency key to send: the server recognises a repeated decision by its content (report, verdict and actions)
// and answers `replay: true`, so the same body is always safe to send again.

const VERDICTS: readonly UiVerdict[] = ['fair', 'not_a_problem', 'bad_faith'];
const LEVELS: readonly ConductLevel[] = ['banter', 'rude', 'hostile', 'severe'];
const NO_PROBLEMS: Problems = { actions: {}, count: 0 };

type Outcome = { kind: 'done'; replay: boolean; groups: DecideResult['groups'] } | { kind: 'conflict' };

/** A labelled field: its label, an optional hint and counter, and its message, all tied to the control by id. */
function Field({
  id,
  label,
  hint,
  counter,
  problem,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  counter?: string;
  problem?: Problem | undefined;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode;
}) {
  const { t } = useHub();
  const described = [hint !== undefined && `${id}-hint`, counter !== undefined && `${id}-counter`, problem !== undefined && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className="cw-field">
      <label htmlFor={id}>{label}</label>
      {hint !== undefined && (
        <p id={`${id}-hint`} className="cw-hint">
          {hint}
        </p>
      )}
      {children({ id, ...(described === '' ? {} : { 'aria-describedby': described }), ...(problem === undefined ? {} : { 'aria-invalid': true as const }) })}
      {counter !== undefined && (
        <p id={`${id}-counter`} className="cw-counter">
          {counter}
        </p>
      )}
      {problem !== undefined && (
        <p id={`${id}-error`} className="cw-field-error">
          {t(problem.key, problem.params)}
        </p>
      )}
    </div>
  );
}

/** What the ladder suggests for the reported person, with the conduct level to ask again, and a way to take it as an action. */
function LadderSuggestion({
  suggestion,
  level,
  error,
  canAdd,
  canPermanent,
  onLevel,
  onUse,
}: {
  suggestion: Suggestion;
  level: ConductLevel | null;
  error: HubError | null;
  canAdd: boolean;
  canPermanent: boolean;
  onLevel: (level: ConductLevel) => void;
  onUse: () => void;
}) {
  const { t, locale } = useHub();
  const id = useId();
  const choice = outcomeChoice(suggestion.outcome);
  const permanent = choice !== null && hasLength(choice.kind) && choice.durationMs === null;
  const blocked = permanent && !canPermanent;
  return (
    <div className="cw-suggest" role="group" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('hub.decide.suggest.title')}</h3>
      <p className="cw-suggest-label">{outcomeLabel(t, locale, suggestion.outcome)}</p>
      <p className="cw-hint">{suggestion.why}</p>
      <Segmented
        label={t('hub.decide.suggest.level')}
        value={level ?? ''}
        options={LEVELS.map((l) => ({ value: l as string, label: t(`hub.decide.suggest.level.${l}`) }))}
        onChange={(v) => onLevel(v as ConductLevel)}
      />
      {error !== null && (
        <Notice tone="bad" role="alert">
          {t('hub.decide.suggest.failed')} {errorText(t, error)}
        </Notice>
      )}
      {choice !== null && canAdd && !blocked && (
        <button type="button" className="cw-btn" onClick={onUse}>
          {t('hub.decide.suggest.use')}
        </button>
      )}
      {choice !== null && canAdd && blocked && <p className="cw-hint">{t('hub.decide.suggest.needsSenior')}</p>}
    </div>
  );
}

interface CardProps {
  n: number;
  base: string;
  draft: Draft;
  people: readonly ReportPerson[];
  target: string;
  dismissal: boolean;
  rules: ReadonlyArray<{ number: number; title: string }>;
  canPermanent: boolean;
  lines: ReadonlyArray<{ id: string; ts: number; raw: string; blocked: boolean }>;
  problems: Problems['actions'][string] | undefined;
  onChange: (patch: Partial<Draft>) => void;
  onToggleLine: (id: string) => void;
  onRemove: () => void;
}

/** One action: who, what, under which rule, and which of their lines the player sees. */
function ActionCard(props: CardProps) {
  const { n, base, draft, people, target, dismissal, rules, canPermanent, lines, problems, onChange, onToggleLine, onRemove } = props;
  const { t, locale } = useHub();
  const idOf = (field: string): string => `${base}-${draft.uid}-${field}`;
  const choice = resolveDraft(draft);
  const choices = presets().filter((c) => canPermanent || c.durationMs !== null || !hasLength(c.kind));
  const options = people.filter((p) => !(dismissal && p.ref === target));
  const person = people.find((p) => p.ref === draft.person);
  const showLines = choice !== null && choice.kind !== 'note';
  const full = draft.lineIds.length >= LINES_MAX;
  const role = (p: ReportPerson): string => t(p.role === 'target' ? 'hub.decide.action.role.target' : p.role === 'reporter' ? 'hub.decide.action.role.reporter' : 'hub.decide.action.role.bystander');

  return (
    <fieldset className="cw-action">
      <legend>{t('hub.decide.action.title', { n })}</legend>
      <div className="cw-action-grid">
        <Field id={idOf('person')} label={t('hub.decide.action.person')} problem={problems?.person}>
          {(a) => (
            <select {...a} value={draft.person} onChange={(e) => onChange({ person: e.target.value, lineIds: [] })}>
              {options.map((p) => (
                <option key={p.ref} value={p.ref}>
                  {t('hub.decide.action.person.option', { name: personName(p, people, t('hub.person.prefix')), role: role(p), tag: personTag(p.ref) })}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={idOf('what')} label={t('hub.decide.action.what')} problem={problems?.what}>
          {(a) => (
            <select {...a} value={draft.what} onChange={(e) => onChange({ what: e.target.value })}>
              <option value="">{t('hub.decide.action.what.choose')}</option>
              {choices.map((c) => (
                <option key={choiceKey(c)} value={choiceKey(c)}>
                  {choiceLabel(t, locale, c)}
                </option>
              ))}
              <option value="other">{t('hub.decide.action.what.custom')}</option>
            </select>
          )}
        </Field>
        {draft.what === 'other' && (
          <>
            <Field id={idOf('kind')} label={t('hub.decide.action.kind')}>
              {(a) => (
                <select {...a} value={draft.customKind} onChange={(e) => onChange({ customKind: e.target.value as Draft['customKind'] })}>
                  {CUSTOM_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {kindLabel(t, k)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {hasLength(draft.customKind) && (
              <Field id={idOf('length')} label={t('hub.decide.action.length')}>
                {(a) => (
                  <select {...a} value={draft.customDuration} onChange={(e) => onChange({ customDuration: e.target.value as Draft['customDuration'] })}>
                    {DURATIONS.filter((d) => canPermanent || d.ms !== null).map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.ms === null ? t('hub.decide.length.permanent') : lengthPhrase(t, locale, d.ms)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
          </>
        )}
        <Field id={idOf('rule')} label={t('hub.decide.action.rule')} problem={problems?.rule}>
          {(a) => (
            <select {...a} value={draft.rule} onChange={(e) => onChange({ rule: e.target.value })}>
              <option value="">{t('hub.decide.action.rule.choose')}</option>
              {rules.map((r) => (
                <option key={r.number} value={String(r.number)}>
                  {t('hub.decide.action.rule.option', { number: r.number, title: r.title })}
                </option>
              ))}
              <option value="uncovered">{t('hub.decide.action.rule.uncovered')}</option>
            </select>
          )}
        </Field>
      </div>
      {draft.rule === 'uncovered' && (
        <Field
          id={idOf('gap')}
          label={t('hub.decide.action.gap')}
          hint={t('hub.decide.action.gap.hint')}
          counter={t('hub.decide.counter', { count: draft.gapNote.trim().length, max: GAP_NOTE_MAX })}
          problem={problems?.gapNote}
        >
          {(a) => <textarea {...a} rows={3} value={draft.gapNote} onChange={(e) => onChange({ gapNote: e.target.value })} />}
        </Field>
      )}
      {showLines && (
        <fieldset className="cw-picks" {...(lines.length === 0 ? {} : { 'aria-describedby': `${idOf('lines')}-hint` })}>
          <legend>{t('hub.decide.action.lines')}</legend>
          {lines.length === 0 ? (
            <p className="cw-hint">{t('hub.decide.action.lines.none', { name: person === undefined ? '' : personName(person, people, t('hub.person.prefix')) })}</p>
          ) : (
            <>
              <p id={`${idOf('lines')}-hint`} className="cw-hint">
                {t('hub.decide.action.lines.hint', { max: LINES_MAX })}
              </p>
              <ul>
                {lines.map((l) => {
                  const on = draft.lineIds.includes(l.id);
                  return (
                    <li key={l.id}>
                      <label className="cw-check">
                        <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onToggleLine(l.id)} />
                        <span className="cw-check-time">{timeOfDay(l.ts, locale)}</span>
                        <span className="cw-check-text">{l.raw}</span>
                        {l.blocked && <Tag>{t('hub.report.line.blocked')}</Tag>}
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="cw-counter">{t('hub.decide.action.lines.chosen', { chosen: draft.lineIds.length, max: LINES_MAX })}</p>
              {problems?.lines !== undefined && (
                <p id={idOf('lines-error')} className="cw-field-error">
                  {t(problems.lines.key, problems.lines.params)}
                </p>
              )}
            </>
          )}
        </fieldset>
      )}
      <div className="cw-action-foot">
        <button type="button" className="cw-btn" aria-label={t('hub.decide.action.removeLabel', { n })} onClick={onRemove}>
          {t('hub.decide.action.remove')}
        </button>
      </div>
    </fieldset>
  );
}

/** The form itself, once the rules are known. */
function FormBody({
  detail,
  people,
  rules,
  announce,
  onDone,
  onConflict,
}: {
  detail: ReportDetail;
  people: ReportPerson[];
  rules: ReadonlyArray<{ number: number; title: string }>;
  announce: (text: string) => void;
  onDone: (result: DecideResult) => void;
  onConflict: () => void;
}) {
  const { client, t, locale, can } = useHub();
  const base = useId();
  const { report } = detail;
  const canApply = can('sanctions.apply');
  const canPermanent = can('sanctions.apply.ban_permanent');

  const [form, setForm] = useState<DecisionForm>(emptyForm);
  const [attempted, setAttempted] = useState(false);
  const [failedTries, setFailedTries] = useState(0);
  const [suggestion, setSuggestion] = useState<Suggestion>(detail.suggest);
  const [level, setLevel] = useState<ConductLevel | null>(null);
  const [levelError, setLevelError] = useState<HubError | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const uids = useRef(0);
  const levelSeq = useRef(0);
  const sending = useRef(false);
  const summary = useRef<HTMLDivElement>(null);

  const ctx: ValidationContext = useMemo(
    () => ({
      target: report.targetPerson,
      people: people.map((p) => p.ref),
      rules: rules.map((r) => r.number),
      canApply,
      canPermanent,
      ownLineIds: report.ownLineIds,
    }),
    [report.targetPerson, report.ownLineIds, people, rules, canApply, canPermanent],
  );
  const problems = validate(form, ctx);
  const shown = attempted ? problems : NO_PROBLEMS;
  const dismissal = form.verdict === 'not_a_problem' || form.verdict === 'bad_faith';
  const lineList = useMemo(() => excerptLines(report), [report]);
  const send = useHubAction((input: ReturnType<typeof toInput>) => client.decide(report.id, input));

  useEffect(() => {
    if (focusId === null) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);
  useEffect(() => {
    if (failedTries > 0) summary.current?.focus();
  }, [failedTries]);

  const addId = `${base}-add`;
  const nextUid = (): string => `a${(uids.current += 1)}`;

  const setVerdict = (verdict: UiVerdict): void => {
    const next: DecisionForm = { ...form, verdict };
    const result = verdict === 'fair' ? { form: next, dropped: 0 } : dropTargetActions(next, ctx.target);
    setForm(result.form);
    if (result.dropped > 0) announce(t('hub.decide.announce.dropped', { count: result.dropped }));
  };
  const patchAction = (uid: string, patch: Partial<Draft>): void => setForm((f) => ({ ...f, actions: f.actions.map((a) => (a.uid === uid ? { ...a, ...patch } : a)) }));
  const toggleLine = (uid: string, id: string): void =>
    setForm((f) => ({
      ...f,
      actions: f.actions.map((a) => {
        if (a.uid !== uid) return a;
        if (a.lineIds.includes(id)) return { ...a, lineIds: a.lineIds.filter((x) => x !== id) };
        return a.lineIds.length >= LINES_MAX ? a : { ...a, lineIds: [...a.lineIds, id] };
      }),
    }));

  const add = (): void => {
    if (!canApply || form.actions.length >= MAX_ACTIONS) return;
    const uid = nextUid();
    setForm(addAction(form, ctx, detail.rule, uid));
    announce(t('hub.decide.announce.added', { n: form.actions.length + 1 }));
    setFocusId(`${base}-${uid}-person`);
  };
  const remove = (uid: string, n: number): void => {
    setForm((f) => ({ ...f, actions: f.actions.filter((a) => a.uid !== uid) }));
    announce(t('hub.decide.announce.removed', { n }));
    setFocusId(addId);
  };
  const useSuggestion = (): void => {
    const next = withSuggestion(form, ctx, suggestion.outcome, detail.rule, nextUid());
    if (next === null) return;
    setForm(next);
    announce(t('hub.decide.announce.added', { n: next.actions.length }));
  };

  const pickLevel = async (picked: ConductLevel): Promise<void> => {
    const mine = (levelSeq.current += 1);
    setLevelError(null);
    try {
      const answer = await client.suggest(report.id, { level: picked });
      if (mine !== levelSeq.current) return;
      setSuggestion(answer);
      setLevel(picked);
      announce(t('hub.decide.suggest.updated', { label: outcomeLabel(t, locale, answer.outcome) }));
    } catch (e) {
      if (mine === levelSeq.current) setLevelError(toHubError(e));
    }
  };

  const submit = async (): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    if (problems.count > 0) {
      setFailedTries((n) => n + 1);
      return;
    }
    sending.current = true;
    try {
      const result = await send.run(toInput(form));
      if (result.ok) onDone(result.value);
      else if (result.error.code === 'already_decided') onConflict();
    } finally {
      sending.current = false;
    }
  };

  // The list of problems, each a button that takes the person to the field.
  const items: Array<{ id: string; problem: Problem }> = [];
  if (shown.verdict !== undefined) items.push({ id: `${base}-verdict-fair`, problem: shown.verdict });
  if (shown.evidence !== undefined) items.push({ id: `${base}-evidence`, problem: shown.evidence });
  form.actions.forEach((a) => {
    const p = shown.actions[a.uid];
    if (p === undefined) return;
    if (p.person !== undefined) items.push({ id: `${base}-${a.uid}-person`, problem: p.person });
    if (p.what !== undefined) items.push({ id: `${base}-${a.uid}-what`, problem: p.what });
    if (p.rule !== undefined) items.push({ id: `${base}-${a.uid}-rule`, problem: p.rule });
    if (p.gapNote !== undefined) items.push({ id: `${base}-${a.uid}-gap`, problem: p.gapNote });
    if (p.lines !== undefined) items.push({ id: `${base}-${a.uid}-person`, problem: p.lines });
  });
  if (shown.list !== undefined) items.push({ id: addId, problem: shown.list });
  if (shown.reason !== undefined) items.push({ id: `${base}-reason`, problem: shown.reason });

  const sendError = send.error !== null && send.error.code !== 'already_decided' ? send.error : null;
  const atLimit = form.actions.length >= MAX_ACTIONS;

  return (
    <form className="cw-form" noValidate onSubmit={(e) => e.preventDefault()}>
      <LadderSuggestion
        suggestion={suggestion}
        level={level}
        error={levelError}
        canAdd={canApply}
        canPermanent={canPermanent}
        onLevel={(l) => void pickLevel(l)}
        onUse={useSuggestion}
      />

      <fieldset className="cw-verdicts">
        <legend>{t('hub.decide.verdict.legend')}</legend>
        <div className="cw-verdict-grid">
          {VERDICTS.map((v) => (
            <div key={v} className="cw-radio">
              <input
                type="radio"
                id={`${base}-verdict-${v}`}
                name={`${base}-verdict`}
                value={v}
                checked={form.verdict === v}
                aria-describedby={`${base}-verdict-${v}-hint`}
                onChange={() => setVerdict(v)}
              />
              <label htmlFor={`${base}-verdict-${v}`}>{t(`hub.decide.verdict.${v}`)}</label>
              <p id={`${base}-verdict-${v}-hint`} className="cw-hint">
                {t(`hub.decide.verdict.${v}.hint`)}
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
          {(a) => <textarea {...a} rows={3} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} />}
        </Field>
      )}

      <fieldset className="cw-actions">
        <legend>{t('hub.decide.actions.legend')}</legend>
        {form.actions.length === 0 && <p className="cw-hint">{t('hub.decide.actions.hint')}</p>}
        {dismissal && <p className="cw-hint">{t('hub.decide.actions.dismissalHint')}</p>}
        {!canApply && <p className="cw-hint">{t('hub.decide.noApply')}</p>}
        {form.actions.map((a, i) => (
          <ActionCard
            key={a.uid}
            n={i + 1}
            base={base}
            draft={a}
            people={people}
            target={ctx.target}
            dismissal={dismissal}
            rules={rules}
            canPermanent={canPermanent}
            lines={lineList.filter((l) => l.person === a.person).map((l) => ({ id: l.id, ts: l.ts, raw: l.raw, blocked: l.blocked }))}
            problems={shown.actions[a.uid]}
            onChange={(patch) => patchAction(a.uid, patch)}
            onToggleLine={(id) => toggleLine(a.uid, id)}
            onRemove={() => remove(a.uid, i + 1)}
          />
        ))}
        {canApply && (
          <div className="cw-add">
            <button id={addId} type="button" className="cw-btn" aria-disabled={atLimit} onClick={add}>
              {t('hub.decide.add')}
            </button>
            {atLimit && <p className="cw-hint">{t('hub.decide.add.limit', { max: MAX_ACTIONS })}</p>}
          </div>
        )}
      </fieldset>

      <Field
        id={`${base}-reason`}
        label={t('hub.decide.reason.label')}
        hint={t('hub.decide.reason.hint')}
        counter={t('hub.decide.counter', { count: form.reason.trim().length, max: REASON_MAX })}
        problem={shown.reason}
      >
        {(a) => <textarea {...a} rows={4} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}
      </Field>

      {attempted && items.length > 0 && (
        <div className="cw-problems" role="alert" tabIndex={-1} ref={summary}>
          <p>
            <strong>{t('hub.decide.problems', { count: problems.count })}</strong>
          </p>
          <ul>
            {items.map((item, i) => (
              <li key={`${item.id}-${i}`}>
                <button type="button" className="cw-linkbtn" onClick={() => document.getElementById(item.id)?.focus()}>
                  {t(item.problem.key, item.problem.params)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sendError !== null && (
        <div className="cw-error" role="alert">
          <p>{decideErrorText(t, sendError)}</p>
          <button type="button" className="cw-btn" onClick={() => void submit()}>
            {t('hub.state.retry')}
          </button>
        </div>
      )}

      <div className="cw-submit">
        <button type="button" className="cw-btn cw-btn--primary" aria-disabled={send.busy} aria-busy={send.busy} onClick={() => void submit()}>
          {send.busy ? t('hub.decide.submitting') : t('hub.decide.submit')}
        </button>
      </div>
    </form>
  );
}

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

/** The report's decision panel. Keeps the result and any conflict on screen after the report reloads as closed. */
export function DecisionPanel({
  detail,
  people,
  onDecided,
  onConflict,
}: {
  detail: ReportDetail;
  people: ReportPerson[];
  onDecided: () => void;
  onConflict: () => void;
}) {
  const { client, t, can } = useHub();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const resultRef = useRef<HTMLDivElement>(null);
  const open = detail.report.status === 'open';
  const announce = useCallback((text: string) => setAnnouncement(text), []);
  const wantsForm = open && can('reports.decide') && outcome === null;
  // The rules are only needed when there is a form to fill.
  const policy = useHubData(wantsForm ? 'policy' : 'policy:idle', () => (wantsForm ? client.policy() : Promise.resolve(null)));

  useEffect(() => {
    if (outcome?.kind === 'done') resultRef.current?.focus();
  }, [outcome]);

  let body: ReactNode;
  if (!open) body = <Decided detail={detail} />;
  else if (outcome !== null) body = null;
  else if (!can('reports.decide')) body = <p className="cw-hint">{t('hub.decide.denied')}</p>;
  else {
    body = (
      <Fetched state={policy} what={t('hub.state.what.rules')}>
        {(doc) =>
          doc === null ? null : (
            <FormBody
              detail={detail}
              people={people}
              rules={doc.rules.filter((r) => r.retired !== true).sort((a, b) => a.number - b.number)}
              announce={announce}
              onDone={(result) => {
                setOutcome({ kind: 'done', replay: result.replay, groups: result.groups });
                announce(result.replay ? t('hub.decide.result.replay') : t('hub.decide.result.done'));
                onDecided();
              }}
              onConflict={() => {
                setOutcome({ kind: 'conflict' });
                announce(t('hub.decide.already'));
                onConflict();
              }}
            />
          )
        }
      </Fetched>
    );
  }

  return (
    <Panel title={t('hub.decide.title')} className="cw-decision">
      <div className="cw-sr" role="status" aria-label={t('hub.decide.live')}>
        {announcement}
      </div>
      {outcome?.kind === 'done' && (
        <div className="cw-result" tabIndex={-1} ref={resultRef}>
          <p>
            <strong>{t('hub.decide.result.done')}</strong>
          </p>
          {outcome.replay && <p>{t('hub.decide.result.replay')}</p>}
          {outcome.groups.length === 0 ? (
            <p className="cw-hint">{t('hub.decide.result.none')}</p>
          ) : (
            <ul aria-label={t('hub.decide.result.codes')}>
              {outcome.groups.map((g) => (
                <li key={g.refCode}>
                  <span className="cw-pid">{t('hub.decide.result.code', { code: g.refCode, kind: kindLabel(t, g.kind) })}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {outcome?.kind === 'conflict' && (
        <Notice tone="warn" role="alert">
          {t('hub.decide.already')}
        </Notice>
      )}
      {body}
    </Panel>
  );
}
