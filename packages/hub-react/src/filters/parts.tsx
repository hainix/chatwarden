import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { FilterAction } from '@chatwarden/core';
import { useHub } from '../context.js';
import { filterActionLabel } from '../labels.js';
import { cardOfPath, fieldOfPath, isSharedHosting } from '../policy/filters.js';
import type { CardKey } from '../policy/filters.js';

// The small pieces the four cards of "Chat filters" share: the card with its switch, the four-way action, the Community Rule, a number, a list of domains as chips,
// and the line that says what is wrong in words. Every string goes through `t()`.

export interface Problem {
  path: string;
  message: string;
  /** From the server's refusal rather than the form's own check. */
  refused?: boolean;
}

/** What is wrong, in words: "Denied domains, entry 2: this is not valid." Never the kit's English. */
export function ProblemLine({ problem, card }: { problem: Problem | null; card: CardKey }) {
  const { t } = useHub();
  if (problem === null || cardOfPath(problem.path) !== card) return null;
  const f = fieldOfPath(problem.path);
  const field = t(`hub.settings.filters.field.${f.word}` as never, { n: f.n ?? '', rule: f.rule ?? '' });
  const reason = problem.refused === true ? t('hub.settings.filters.problem.refused') : isSharedHosting(problem.message) ? t('hub.settings.filters.problem.shared') : t('hub.settings.filters.problem.invalid');
  return (
    <p className="cw-field-error" role="alert">
      {t('hub.settings.filters.problem', { field, reason })}
    </p>
  );
}

/** One card: a fieldset named for the filter, with its switch; the details show only while it is on. */
export function Card({ title, hint, on, onToggle, children }: { title: string; hint: string; on: boolean; onToggle: (on: boolean) => void; children: ReactNode }) {
  const id = useId();
  return (
    <fieldset className="cw-fcard">
      <legend className="cw-sr">{title}</legend>
      <label className="cw-choice cw-flowopt">
        <input type="checkbox" checked={on} aria-labelledby={`${id}-t`} aria-describedby={`${id}-h`} onChange={(e) => onToggle(e.target.checked)} />
        <span>
          <strong id={`${id}-t`}>{title}</strong>
          <span id={`${id}-h`} className="cw-hint cw-flowopt-line">
            {hint}
          </span>
        </span>
      </label>
      {on && <div className="cw-fcard-body">{children}</div>}
    </fieldset>
  );
}

/** What to do: the four answers in words, and one sentence for what the chosen one means. `only` limits the choice (street addresses can only count or flag). */
export function ActionChoice({ value, onChange, about, only }: { value: FilterAction; onChange: (a: FilterAction) => void; about: (a: FilterAction) => string; only?: readonly FilterAction[] }) {
  const { t } = useHub();
  const name = useId();
  return (
    <fieldset className="cw-fchoice">
      <legend>{t('hub.settings.filters.action.legend')}</legend>
      <div className="cw-fchoice-row">
        {(['count', 'flag', 'mask', 'refuse'] as const)
          .filter((a) => only === undefined || only.includes(a))
          .map((a) => (
            <label key={a} className="cw-choice">
              <input type="radio" name={name} checked={value === a} onChange={() => onChange(a)} />
              <span>{filterActionLabel(t, a)}</span>
            </label>
          ))}
      </div>
      <p className="cw-hint">{about(value)}</p>
    </fieldset>
  );
}

/** A whole number, empty meaning "not set". A number that is not whole or in range is the kit's to refuse (the form shows what it says). */
export function NumField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
  disabled,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="cw-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        step="1"
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        value={value === null || value === undefined ? '' : String(value)}
        {...(disabled === true ? { disabled: true } : {})}
        {...(hint === undefined ? {} : { 'aria-describedby': `${id}-h` })}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
      {hint !== undefined && (
        <p id={`${id}-h`} className="cw-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** The Community Rule a filter cites. */
export function RuleField({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  const { t } = useHub();
  return <NumField label={t('hub.settings.filters.rule')} value={value} onChange={onChange} min={1} />;
}

/** A list of short entries (domains) as chips with a remove button each, and an input to add one. */
export function ChipList({
  entries,
  onChange,
  label,
  addLabel,
  addButton,
  hint,
}: {
  entries: readonly string[];
  onChange: (entries: string[]) => void;
  label: string;
  addLabel: string;
  addButton: string;
  hint?: string;
}) {
  const { t } = useHub();
  const id = useId();
  const [text, setText] = useState('');
  const add = (): void => {
    const v = text.trim();
    if (v === '') return;
    onChange([...entries, v]);
    setText('');
  };
  return (
    <div className="cw-field">
      <span id={`${id}-l`} className="cw-flabel">
        {label}
      </span>
      {entries.length > 0 && (
        <ul className="cw-chips" aria-labelledby={`${id}-l`}>
          {entries.map((e, i) => (
            <li key={`${e}-${i}`} className="cw-fchip">
              <span>{e}</span>
              <button type="button" className="cw-linkbtn" aria-label={t('hub.settings.filters.links.remove', { name: e })} onClick={() => onChange(entries.filter((_, j) => j !== i))}>
                {'\u00d7'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="cw-fadd">
        <input
          type="text"
          aria-label={addLabel}
          {...(hint === undefined ? {} : { 'aria-describedby': `${id}-h` })}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="cw-btn" aria-label={addButton} onClick={add}>
          {t('hub.settings.lengths.addButton')}
        </button>
      </div>
      {hint !== undefined && (
        <p id={`${id}-h`} className="cw-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A line with its matched ranges marked (`<mark>`), offsets in the line as typed. Overlapping and out-of-range ranges are tidied first. */
export function Marked({ text, spans }: { text: string; spans: ReadonlyArray<{ start: number; end: number }> }) {
  const sorted = [...spans].filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start && s.start >= 0 && s.start < text.length).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s.start <= last.end) last.end = Math.max(last.end, Math.min(s.end, text.length));
    else merged.push({ start: s.start, end: Math.min(s.end, text.length) });
  }
  const out: ReactNode[] = [];
  let at = 0;
  merged.forEach((m, i) => {
    if (m.start > at) out.push(text.slice(at, m.start));
    out.push(<mark key={i}>{text.slice(m.start, m.end)}</mark>);
    at = m.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
