import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import { Icon } from '../icons.js';
import { kindLabel, lengthPhrase } from '../labels.js';
import type { CommunityRule, ConductLevel, SanctionKind } from '../types.js';
import { Card, Panel, Scroll } from '../ui.js';
import { LENGTH_UNITS, addDuration, parseAmount, removeDuration } from './length.js';
import type { LengthUnit } from './length.js';
import { LengthField } from './LengthField.js';
import type { LengthMenu } from './LengthField.js';
import { COLUMNS, EDITED_LEVELS, timed } from './model.js';
import type { CellDraft, CellKind, Column, EditedLevel, OutcomeDraft, OutcomeKind, PolicyDraft } from './model.js';

// The panels of the Steps and ladder screen. Each edits one part of the local draft; none of them sends anything. A field carries
// `data-field`, the key the screen uses to put keyboard focus on it when the kit refuses it. Every word is from the catalog.

export type SetDraft = (update: (draft: PolicyDraft) => PolicyDraft) => void;
export type Problems = Readonly<Record<string, Problem>>;

interface PanelProps {
  draft: PolicyDraft;
  set: SetDraft;
  problems: Problems;
  /** The Reset button and its confirm, drawn by the screen. */
  reset: ReactNode;
}

const KIND_OF_CELL: readonly CellKind[] = ['warning', 'chat', 'area', 'ban'];
const KIND_OF_OUTCOME: readonly OutcomeKind[] = ['none', 'note', 'warning', 'chat', 'area', 'ban'];
const KIND_OF_REPEAT: readonly OutcomeKind[] = ['warning', 'chat', 'area', 'ban'];

function FieldError({ id, problem }: { id: string; problem: Problem | undefined }) {
  const { t } = useHub();
  return problem === undefined ? null : (
    <p id={id} className="cw-field-error">
      {t(problem.key, problem.params)}
    </p>
  );
}

/** The menu a ladder cell, a first offence or the repeat rule draws its lengths from: the draft's own list, permanent, and custom. */
const menuFor = (draft: PolicyDraft): LengthMenu => ({ durations: draft.durations, permanent: true, custom: true });

// ---- Lengths ---------------------------------------------------------------------------------------------------------------

export function LengthsPanel({ draft, set, problems, reset }: PanelProps) {
  const { t, locale } = useHub();
  const base = useId();
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<LengthUnit>('hours');
  const [problem, setProblem] = useState<Problem | undefined>();
  const input = useRef<HTMLInputElement>(null);

  const add = (): void => {
    const parsed = parseAmount(amount, unit);
    if (!parsed.ok) return setProblem(parsed.problem);
    const next = addDuration(draft.durations, parsed.ms);
    if (!next.ok) return setProblem(next.problem);
    set((d) => ({ ...d, durations: next.list }));
    setAmount('');
    setProblem(undefined);
  };
  const shown = problem ?? problems.durations;
  const err = `${base}-err`;
  return (
    <Panel title={t('hub.settings.lengths.title')} action={reset}>
      <div className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.lengths.hint')}</p>
        {draft.durations.length === 0 ? (
          <p className="cw-hint">{t('hub.settings.lengths.none')}</p>
        ) : (
          <ul className="cw-lchips" role="list" aria-label={t('hub.settings.lengths.list')}>
            {draft.durations.map((ms) => (
              <li key={ms} className="cw-lchip">
                <span>{lengthPhrase(t, locale, ms)}</span>
                <button
                  type="button"
                  aria-label={t('hub.settings.lengths.remove', { length: lengthPhrase(t, locale, ms) })}
                  onClick={() => {
                    set((d) => ({ ...d, durations: removeDuration(d.durations, ms) }));
                    input.current?.focus();
                  }}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="cw-field">
          <label htmlFor={`${base}-add`}>{t('hub.settings.lengths.add')}</label>
          <div className="cw-length-add">
            <input
              ref={input}
              id={`${base}-add`}
              data-field="durations"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={amount}
              {...(shown === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': err })}
              onChange={(e) => {
                setAmount(e.target.value);
                setProblem(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <select aria-label={t('hub.length.unit')} value={unit} onChange={(e) => setUnit(e.target.value as LengthUnit)}>
              {LENGTH_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(u === 'hours' ? 'hub.length.unit.hours' : 'hub.length.unit.days')}
                </option>
              ))}
            </select>
            <button type="button" className="cw-btn" onClick={add}>
              {t('hub.settings.lengths.addButton')}
            </button>
          </div>
          <FieldError id={err} problem={shown} />
        </div>
        <label className="cw-tick">
          <input type="checkbox" data-field="custom" checked={draft.customDuration} aria-describedby={`${base}-custom`} onChange={(e) => set((d) => ({ ...d, customDuration: e.target.checked }))} />
          <span>{t('hub.settings.lengths.custom')}</span>
        </label>
        <p id={`${base}-custom`} className="cw-hint">
          {t('hub.settings.lengths.custom.hint')}
        </p>
      </div>
    </Panel>
  );
}

// ---- Kind and length (a ladder cell, a first offence, the repeat rule) -----------------------------------------------------

function KindAndLength({
  field,
  kinds,
  value,
  onChange,
  draft,
  problems,
  names,
  hideLength = false,
}: {
  field: string;
  kinds: readonly OutcomeKind[];
  value: OutcomeDraft | CellDraft;
  onChange: (next: OutcomeDraft | CellDraft) => void;
  draft: PolicyDraft;
  problems: Problems;
  names: { kind: string; length: string; number: string; unit: string };
  hideLength?: boolean;
}) {
  const { t } = useHub();
  const base = useId();
  const refused = problems[`${field}-kind`];
  return (
    <span className="cw-kl">
      <span className="cw-kl-kind">
        {value.kind !== 'none' && <Card kind={value.kind as SanctionKind} />}
        <select
          id={`${base}-kind`}
          aria-label={names.kind}
          data-field={`${field}-kind`}
          value={value.kind}
          {...(refused === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${base}-kind-err` })}
          onChange={(e) => onChange({ ...value, kind: e.target.value } as OutcomeDraft | CellDraft)}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k === 'none' ? t('hub.settings.outcome.none') : kindLabel(t, k)}
            </option>
          ))}
        </select>
      </span>
      {timed(value.kind) && !hideLength && (
        <LengthField
          id={`${base}-length`}
          field={`${field}-length`}
          label={names.length}
          numberLabel={names.number}
          unitLabel={names.unit}
          menu={menuFor(draft)}
          value={value.length}
          onChange={(length) => onChange({ ...value, length } as OutcomeDraft | CellDraft)}
          problem={problems[`${field}-length`]}
        />
      )}
      <FieldError id={`${base}-kind-err`} problem={refused} />
    </span>
  );
}

// ---- The ladder ------------------------------------------------------------------------------------------------------------

export function LadderPanel({ draft, set, problems, reset }: PanelProps) {
  const { t } = useHub();
  const set1 = (i: number, col: Column, next: CellDraft): void => set((d) => ({ ...d, ladder: d.ladder.map((r, j) => (j === i ? { ...r, [col]: next } : r)) }));
  return (
    <Panel title={t('hub.settings.ladder.panel')} action={reset}>
      <p className="cw-hint cw-panel-pad">{t('hub.settings.ladder.hint')}</p>
      <Scroll label={t('hub.settings.ladder.grid')}>
        <table className="cw-table cw-grid">
          <thead>
            <tr>
              <th scope="col">{t('hub.settings.ladder.col.step')}</th>
              <th scope="col">{t('hub.settings.ladder.col.lighter')}</th>
              <th scope="col">{t('hub.settings.ladder.col.harsher')}</th>
            </tr>
          </thead>
          <tbody>
            {draft.ladder.map((row, i) => (
              <tr key={i}>
                <th scope="row">{t('hub.guide.ladder.stepN', { n: i })}</th>
                {COLUMNS.map((col) => {
                  const column = t(col === 'lowMedium' ? 'hub.settings.ladder.column.lighter' : 'hub.settings.ladder.column.harsher');
                  const names = {
                    kind: t('hub.settings.ladder.cell.kind', { n: i, column }),
                    length: t('hub.settings.ladder.cell.length', { n: i, column }),
                    number: t('hub.settings.ladder.cell.number', { n: i, column }),
                    unit: t('hub.settings.ladder.cell.unit', { n: i, column }),
                  };
                  return (
                    <td key={col}>
                      <KindAndLength
                        field={`ladder-${i}-${col}`}
                        kinds={KIND_OF_CELL}
                        value={row[col]}
                        onChange={(next) => set1(i, col, next as CellDraft)}
                        draft={draft}
                        problems={problems}
                        names={names}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroll>
    </Panel>
  );
}

// ---- First offence ---------------------------------------------------------------------------------------------------------

const levelLabel = (t: ReturnType<typeof useHub>['t'], level: ConductLevel): string => t(`hub.decide.suggest.level.${level}` as 'hub.decide.suggest.level.rude');

export function FirstPanel({ draft, set, problems, reset }: PanelProps) {
  const { t } = useHub();
  return (
    <Panel title={t('hub.settings.first.title')} action={reset}>
      <div className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.first.hint')}</p>
        <p>{t('hub.settings.first.banter')}</p>
        {EDITED_LEVELS.map((level: EditedLevel) => {
          const name = levelLabel(t, level);
          return (
            <div key={level} className="cw-row-field">
              <span className="cw-row-name">{name}</span>
              <KindAndLength
                field={`first-${level}`}
                kinds={KIND_OF_OUTCOME}
                value={draft.firstOffense[level]}
                onChange={(next) => set((d) => ({ ...d, firstOffense: { ...d.firstOffense, [level]: next } }))}
                draft={draft}
                problems={problems}
                names={{
                  kind: t('hub.settings.first.kind', { level: name }),
                  length: t('hub.settings.first.length', { level: name }),
                  number: t('hub.settings.first.number', { level: name }),
                  unit: t('hub.settings.first.unit', { level: name }),
                }}
              />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ---- Repeated --------------------------------------------------------------------------------------------------------------

export function RepeatPanel({ draft, set, problems, reset }: PanelProps) {
  const { t } = useHub();
  const base = useId();
  const num = (key: 'notes' | 'windowDays', label: string, hint?: string) => {
    const field = key === 'notes' ? 'repeat-notes' : 'repeat-windowDays';
    const problem = problems[field];
    return (
      <div className="cw-field">
        <label htmlFor={`${base}-${key}`}>{label}</label>
        <input
          id={`${base}-${key}`}
          data-field={field}
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          value={draft.repeat[key]}
          {...(problem === undefined ? (hint === undefined ? {} : { 'aria-describedby': `${base}-${key}-hint` }) : { 'aria-invalid': true as const, 'aria-describedby': `${base}-${key}-err` })}
          onChange={(e) => set((d) => ({ ...d, repeat: { ...d.repeat, [key]: e.target.value } }))}
        />
        {hint !== undefined && (
          <p id={`${base}-${key}-hint`} className="cw-hint">
            {hint}
          </p>
        )}
        <FieldError id={`${base}-${key}-err`} problem={problem} />
      </div>
    );
  };
  return (
    <Panel title={t('hub.settings.repeat.title')} action={reset}>
      <div className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.repeat.hint')}</p>
        <div className="cw-pair">
          {num('notes', t('hub.settings.repeat.notes'))}
          {num('windowDays', t('hub.settings.repeat.days'), t('hub.settings.repeat.days.hint'))}
        </div>
        <label className="cw-tick">
          <input
            type="checkbox"
            data-field="repeat-distinct"
            checked={draft.repeat.distinctGames}
            onChange={(e) => set((d) => ({ ...d, repeat: { ...d.repeat, distinctGames: e.target.checked } }))}
          />
          <span>{t('hub.settings.repeat.distinct')}</span>
        </label>
        <KindAndLength
          field="repeat"
          kinds={KIND_OF_REPEAT}
          value={draft.repeat.outcome}
          onChange={(next) => set((d) => ({ ...d, repeat: { ...d.repeat, outcome: next as OutcomeDraft } }))}
          draft={draft}
          problems={problems}
          names={{ kind: t('hub.settings.repeat.kind'), length: t('hub.settings.repeat.length'), number: t('hub.settings.repeat.number'), unit: t('hub.settings.repeat.unit') }}
        />
      </div>
    </Panel>
  );
}

// ---- Rules -----------------------------------------------------------------------------------------------------------------

function RulePicker({ field, legend, picked, rules, onChange, problem }: { field: string; legend: string; picked: readonly number[]; rules: readonly CommunityRule[]; onChange: (next: number[]) => void; problem: Problem | undefined }) {
  const { t } = useHub();
  const named = (n: number): string => {
    const r = rules.find((x) => x.number === n);
    return r === undefined ? t('hub.guide.rule.number', { number: n }) : t('hub.guide.rule.named', { number: n, title: r.title });
  };
  // The rules in force, and any picked number the list does not have (a rule retired since), so it can still be unticked.
  const numbers = [...new Set([...rules.filter((r) => r.retired !== true).map((r) => r.number), ...picked])].sort((a, b) => a - b);
  const toggle = (n: number, on: boolean): void => onChange(on ? [...picked, n].sort((a, b) => a - b) : picked.filter((x) => x !== n));
  return (
    <fieldset className="cw-picks" data-field={field} tabIndex={-1} {...(problem === undefined ? {} : { 'aria-invalid': true as const })}>
      <legend>{legend}</legend>
      {numbers.length === 0 ? (
        <p className="cw-hint">{t('hub.settings.rules.none')}</p>
      ) : (
        <ul className="cw-picklist">
          {numbers.map((n) => (
            <li key={n}>
              <label className="cw-tick">
                <input type="checkbox" checked={picked.includes(n)} onChange={(e) => toggle(n, e.target.checked)} />
                <span>{named(n)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {problem !== undefined && <p className="cw-field-error">{t(problem.key, problem.params)}</p>}
    </fieldset>
  );
}

export function RulesPanel({ draft, set, problems, reset, rules }: PanelProps & { rules: readonly CommunityRule[] }) {
  const { t } = useHub();
  return (
    <Panel title={t('hub.settings.rules.title')} action={reset}>
      <div className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.rules.hint')}</p>
        <RulePicker field="area" legend={t('hub.settings.rules.area')} picked={draft.areaRules} rules={rules} onChange={(areaRules) => set((d) => ({ ...d, areaRules }))} problem={problems.area} />
        <RulePicker field="severe" legend={t('hub.settings.rules.severe')} picked={draft.severeRules} rules={rules} onChange={(severeRules) => set((d) => ({ ...d, severeRules }))} problem={problems.severe} />
      </div>
    </Panel>
  );
}

// ---- Written guidelines ----------------------------------------------------------------------------------------------------

export function GuidelinesPanel({ draft, set, problems, reset, titles }: PanelProps & { titles: readonly string[] }) {
  const { t } = useHub();
  const base = useId();
  return (
    <Panel title={t('hub.settings.guidelines.title')} action={reset}>
      <div className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.guidelines.hint')}</p>
        {draft.guidelines.map((text, i) => {
          const problem = problems[`guide-${i}`];
          return (
            <div key={i} className="cw-field">
              <label htmlFor={`${base}-${i}`}>{t('hub.settings.guideline.label', { title: titles[i] ?? '' })}</label>
              <textarea
                id={`${base}-${i}`}
                data-field={`guide-${i}`}
                rows={2}
                value={text}
                {...(problem === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${base}-${i}-err` })}
                onChange={(e) => set((d) => ({ ...d, guidelines: d.guidelines.map((g, j) => (j === i ? e.target.value : g)) }))}
              />
              <FieldError id={`${base}-${i}-err`} problem={problem} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
