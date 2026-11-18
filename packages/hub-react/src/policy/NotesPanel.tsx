import { useEffect, useId, useRef, useState } from 'react';
import { TEAM_NOTE_MAX, TEAM_NOTES_MAX } from '@chatwarden/core';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import type { CommunityRule, PromptExcluded } from '../types.js';
import { Panel } from '../ui.js';
import type { PanelProps } from './panels.js';
import { charsOf } from './reporting.js';

// The Team notes panel (Steps and ladder): short staff-only notes, each optionally tied to a Community Rule. Players never see them; the AI read and the guide do. Nothing here sends
// anything; the screen saves the draft.

function FieldError({ id, problem }: { id: string; problem: Problem | undefined }) {
  const { t } = useHub();
  return problem === undefined ? null : (
    <p id={id} className="cw-field-error">
      {t(problem.key, problem.params)}
    </p>
  );
}

export function NotesPanel({ draft, set, problems, reset, rules, editable, excluded }: PanelProps & { rules: readonly CommunityRule[]; editable: boolean; excluded: PromptExcluded | undefined }) {
  const { t } = useHub();
  const base = useId();
  const root = useRef<HTMLDivElement>(null);
  const notes = draft.teamNotes;
  const full = notes.length >= TEAM_NOTES_MAX;
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (focus === null) return;
    root.current?.querySelector<HTMLElement>(`[data-field="${focus}"]`)?.focus();
    setFocus(null);
  }, [focus]);

  const named = (n: number): string => {
    const r = rules.find((x) => x.number === n);
    return r === undefined ? t('hub.guide.rule.number', { number: n }) : t('hub.guide.rule.named', { number: n, title: r.title });
  };
  const change = (i: number, patch: Partial<{ text: string; rule: string }>): void => set((d) => ({ ...d, teamNotes: d.teamNotes.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const add = (): void => {
    if (full) return;
    set((d) => ({ ...d, teamNotes: [...d.teamNotes, { text: '', rule: '' }] }));
    setFocus(`note-${notes.length}-text`);
  };
  const remove = (i: number): void => {
    set((d) => ({ ...d, teamNotes: d.teamNotes.filter((_, j) => j !== i) }));
    setFocus(notes.length < 2 ? 'notes-count' : `note-${Math.min(i, notes.length - 2)}-text`);
  };

  return (
    <Panel title={t('hub.settings.notes.title')} action={reset}>
      <div ref={root} className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.notes.hint')}</p>
        {excluded !== undefined && excluded.capped.length > 0 && <p className="cw-field-warn">{t('hub.settings.notes.capped', { count: excluded.capped.length })}</p>}
        {notes.length === 0 ? (
          <p className="cw-hint">{t('hub.settings.notes.none')}</p>
        ) : (
          <ul className="cw-notes-list" role="list">
            {notes.map((note, i) => {
              const f = (part: string): string => `${base}-${i}-${part}`;
              const text = problems[`note-${i}-text`];
              const rule = problems[`note-${i}-rule`];
              const flagged = excluded?.notes.includes(i) === true;
              // The rules in force, and the rule this note names when the list does not have it (a rule retired since), so it can still be seen and changed.
              const picked = note.rule.trim();
              const numbers = [...new Set([...rules.filter((r) => r.retired !== true).map((r) => r.number), ...(/^\d+$/.test(picked) ? [Number(picked)] : [])])].sort((a, b) => a - b);
              return (
                <li key={i} className="cw-note">
                  <div className="cw-field">
                    <label htmlFor={f('text')}>{t('hub.settings.notes.label', { n: i + 1 })}</label>
                    <textarea
                      id={f('text')}
                      data-field={`note-${i}-text`}
                      rows={2}
                      value={note.text}
                      aria-describedby={[f('count'), text !== undefined && f('text-err'), flagged && f('ai')].filter(Boolean).join(' ')}
                      {...(text === undefined ? {} : { 'aria-invalid': true as const })}
                      onChange={(e) => change(i, { text: e.target.value })}
                    />
                    <p id={f('count')} className="cw-hint cw-counter">
                      {t('hub.settings.principle.count', { count: charsOf(note.text.trim()), max: TEAM_NOTE_MAX })}
                    </p>
                    <FieldError id={f('text-err')} problem={text} />
                    {flagged && (
                      <p id={f('ai')} className="cw-field-warn">
                        {t('hub.settings.notes.excluded')}
                      </p>
                    )}
                  </div>
                  <div className="cw-field">
                    <label htmlFor={f('rule')}>{t('hub.settings.notes.rule', { n: i + 1 })}</label>
                    <select
                      id={f('rule')}
                      data-field={`note-${i}-rule`}
                      value={picked}
                      {...(rule === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': f('rule-err') })}
                      onChange={(e) => change(i, { rule: e.target.value })}
                    >
                      <option value="">{t('hub.settings.notes.anyRule')}</option>
                      {numbers.map((n) => (
                        <option key={n} value={String(n)}>
                          {named(n)}
                        </option>
                      ))}
                      {picked !== '' && !/^\d+$/.test(picked) && <option value={picked}>{picked}</option>}
                    </select>
                    <FieldError id={f('rule-err')} problem={rule} />
                  </div>
                  {editable && (
                    <button type="button" className="cw-btn" aria-label={t('hub.settings.notes.remove.for', { n: i + 1 })} onClick={() => remove(i)}>
                      {t('hub.settings.notes.remove')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {editable && (
          <button type="button" className="cw-btn" data-field="notes-count" aria-disabled={full} onClick={add}>
            {t('hub.settings.notes.add')}
          </button>
        )}
        {full && <p className="cw-hint">{t('hub.settings.notes.full', { max: TEAM_NOTES_MAX })}</p>}
        <FieldError id={`${base}-count-err`} problem={problems['notes-count']} />
      </div>
    </Panel>
  );
}
