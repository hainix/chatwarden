import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { CUSTOM_KINDS, GAP_NOTE_MAX, LINES_MAX, choiceKey, hasLength, needsBanPermission, resolveDraft } from '../decision.js';
import type { ActionProblems, Choice, Draft } from '../decision.js';
import type { ExcerptLine, ReportPerson } from '../excerpt.js';
import { personName } from '../excerpt.js';
import { personTag, timeOfDay } from '../format.js';
import { choiceLabel, kindLabel } from '../labels.js';
import { LengthField } from '../policy/LengthField.js';
import { menuOf, snapLength } from '../policy/lengths.js';
import type { LengthPolicy } from '../policy/lengths.js';
import { Card, Tag } from '../ui.js';
import { useCase } from './CaseContext.js';
import { Masked } from './Transcript.js';
import type { Problem } from '../decision.js';

// One action of the decision, as the full editor: who, what, under which rule, and which of their lines the player sees. This is
// what "Change" opens; the compact summary of an action lives in the decision bar.

/** A labelled field: its label, an optional hint and counter, and its message, all tied to the control by id. */
export function Field({
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

export interface ActionProps {
  n: number;
  base: string;
  draft: Draft;
  people: readonly ReportPerson[];
  target: string;
  dismissal: boolean;
  rules: ReadonlyArray<{ number: number; title: string }>;
  choices: readonly Choice[];
  /** The lengths the profile offers; undefined until it is read (then the four the form always had). */
  lengths?: LengthPolicy | undefined;
  canPermanent: boolean;
  lines: readonly ExcerptLine[];
  problems: ActionProblems | undefined;
  onChange: (patch: Partial<Draft>) => void;
  onToggleLine: (id: string) => void;
  onRemove: () => void;
}

/** The rule menu of an action: the active rules, and "No rule covers this". */
export function RuleOptions({ rules }: { rules: ReadonlyArray<{ number: number; title: string }> }) {
  const { t } = useHub();
  return (
    <>
      <option value="">{t('hub.decide.action.rule.choose')}</option>
      {rules.map((r) => (
        <option key={r.number} value={String(r.number)}>
          {t('hub.decide.action.rule.option', { number: r.number, title: r.title })}
        </option>
      ))}
      <option value="uncovered">{t('hub.decide.action.rule.uncovered')}</option>
    </>
  );
}

/** What an action does, in words, with its referee card. "Choose what happens" while nothing is chosen. */
export function ActionTitle({ draft }: { draft: Draft }) {
  const { t, locale } = useHub();
  const choice = resolveDraft(draft);
  return (
    <span className="cw-act-title">
      {choice !== null && <Card kind={choice.kind} />}
      <strong>{choice === null ? t('hub.decide.action.what.choose') : choiceLabel(t, locale, choice)}</strong>
    </span>
  );
}

/** One action: who, what, under which rule, and which of their lines the player sees. */
export function ActionCard(props: ActionProps) {
  const { n, base, draft, people, target, dismissal, rules, choices, lengths, canPermanent, lines, problems, onChange, onToggleLine, onRemove } = props;
  const { t, locale } = useHub();
  const { reveal } = useCase();
  const idOf = (field: string): string => `${base}-${draft.uid}-${field}`;
  const choice = resolveDraft(draft);
  // The length menu is the profile's. A draft starts on 24 hours, which the profile may not list: it moves to a length that is.
  const menu = menuOf(lengths, draft.customKind, canPermanent);
  const editsLength = draft.what === 'other' && hasLength(draft.customKind);
  const snapped = snapLength(draft.customDuration, menu);
  useEffect(() => {
    if (editsLength && snapped !== draft.customDuration) onChange({ customDuration: snapped });
  }, [editsLength, snapped, draft.customDuration]);
  const offered = choices.filter((c) => canPermanent || !needsBanPermission(c));
  // A one-off choice written in the draft (from a profile ladder) that the menu does not list is still shown, so it can be seen.
  const listed = choice !== null && draft.what !== 'other' && !offered.some((c) => choiceKey(c) === draft.what) ? [choice] : [];
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
                  {t('hub.decide.action.person.option', { name: personName(p, people, t), role: role(p), tag: personTag(p.ref) })}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={idOf('what')} label={t('hub.decide.action.what')} problem={problems?.what}>
          {(a) => (
            <select {...a} value={draft.what} onChange={(e) => onChange({ what: e.target.value })}>
              <option value="">{t('hub.decide.action.what.choose')}</option>
              {[...listed, ...offered].map((c) => (
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
              <div className="cw-field">
                <LengthField
                  id={idOf('length')}
                  visible
                  label={t('hub.decide.action.length')}
                  numberLabel={t('hub.length.number')}
                  unitLabel={t('hub.length.unit')}
                  menu={menu}
                  value={{ value: snapped, amount: draft.customAmount ?? '', unit: draft.customUnit ?? 'hours' }}
                  onChange={(l) => onChange({ customDuration: l.value, customAmount: l.amount, customUnit: l.unit })}
                  problem={problems?.length}
                />
              </div>
            )}
          </>
        )}
        <Field id={idOf('rule')} label={t('hub.decide.action.rule')} problem={problems?.rule}>
          {(a) => (
            <select {...a} value={draft.rule} onChange={(e) => onChange({ rule: e.target.value })}>
              <RuleOptions rules={rules} />
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
            <p className="cw-hint">{t('hub.decide.action.lines.none', { name: person === undefined ? '' : personName(person, people, t) })}</p>
          ) : (
            <>
              <p id={`${idOf('lines')}-hint`} className="cw-hint">
                {t('hub.decide.action.lines.hint', { max: LINES_MAX })}
              </p>
              <ul>
                {lines.map((l) => {
                  const on = draft.lineIds.includes(l.id);
                  const hidden = l.blocked && !reveal.shows(l.id);
                  return (
                    <li key={l.id}>
                      <label className="cw-check">
                        <input type="checkbox" checked={on} disabled={!on && full} onChange={() => onToggleLine(l.id)} />
                        <span className="cw-check-time">{timeOfDay(l.ts, locale)}</span>
                        <span className="cw-check-text">{hidden ? <Masked /> : l.raw}</span>
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
