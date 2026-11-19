import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MAX_GUIDELINE_OUTCOME, MAX_TIER_DESCRIPTION, MAX_TIER_EXAMPLES, MAX_TIER_TITLE } from '@chatwarden/core';
import type { GuidelineCover } from '@chatwarden/core';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import type { PromptExcluded } from '../types.js';
import { Panel } from '../ui.js';
import type { PanelProps } from './panels.js';
import { ALL_COVERS, addTier, flaggedField, moveCover, removeTier, tiersOf } from './principles.js';
import type { TierDraft, TierEdit } from './principles.js';
import { charsOf } from './reporting.js';

// The Moderation principles panel (Steps and ladder): each principle's name, what it covers, examples and outcome are always on the screen, each with its counter. The structure (which
// levels each principle covers, removing a principle, adding one) sits behind ONE disclosure, closed by default: most teams never open it. A warning about what the AI will not see sits next
// to the field it flags. Nothing here sends anything; the screen saves the draft.

type Refusal = Extract<TierEdit, { ok: false }>['reason'];
const REFUSED = {
  none_chosen: 'hub.settings.principle.refused.none',
  unknown_cover: 'hub.settings.principle.refused.unknown',
  empty_source: 'hub.settings.principle.refused.empty',
  last_tier: 'hub.settings.principle.refused.last',
  no_such_tier: 'hub.settings.principle.refused.unknown',
} as const satisfies Record<Refusal, string>;

function FieldError({ id, problem }: { id: string; problem: Problem | undefined }) {
  const { t } = useHub();
  return problem === undefined ? null : (
    <p id={id} className="cw-field-error">
      {t(problem.key, problem.params)}
    </p>
  );
}

const ids = (...parts: Array<string | false>): string | undefined => {
  const out = parts.filter((p): p is string => p !== false);
  return out.length === 0 ? undefined : out.join(' ');
};

export function PrinciplesPanel({ draft, set, problems, reset, editable, excluded }: PanelProps & { editable: boolean; excluded: PromptExcluded | undefined }) {
  const { t } = useHub();
  const base = useId();
  const root = useRef<HTMLDivElement>(null);
  const tiers = draft.guidelines;
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<GuidelineCover[]>([]);
  // What the last structure change said: a refusal (shown) or a confirmation (read out only).
  const [said, setSaid] = useState<{ text: string; refused: boolean } | null>(null);
  // The field to put the focus on once the list has been redrawn (after an add or a remove).
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (focus === null) return;
    root.current?.querySelector<HTMLElement>(`[data-field="${focus}"]`)?.focus();
    setFocus(null);
  }, [focus]);

  const unnamed = (i: number): string => t('hub.settings.principle.unnamed', { n: i + 1 });
  const nameOf = (i: number): string => (tiers[i]?.title.trim() === '' ? unnamed(i) : (tiers[i]?.title.trim() ?? ''));
  const change = (i: number, patch: Partial<TierDraft>): void => set((d) => ({ ...d, guidelines: d.guidelines.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  /** Apply a structure change; say why when it is refused. Returns whether it went through. */
  const apply = (edit: TierEdit, announce: string): boolean => {
    if (!edit.ok) {
      setSaid({ text: t(REFUSED[edit.reason]), refused: true });
      return false;
    }
    set((d) => ({ ...d, guidelines: edit.tiers }));
    setSaid({ text: announce, refused: false });
    return true;
  };

  const toggleCover = (i: number, cover: GuidelineCover, on: boolean): void => {
    // Ticking a level moves it here; unticking moves it to the principle above (the next one for the first).
    const to = on ? i : i === 0 ? 1 : i - 1;
    apply(moveCover(tiers, cover, to), t('hub.settings.principle.moved', { cover: t(`hub.settings.cover.${cover}`), n: to + 1 }));
  };
  const remove = (i: number): void => {
    if (apply(removeTier(tiers, i), t('hub.settings.principle.removed', { count: tiers.length - 1 }))) setFocus(`guide-${i === 0 ? 0 : i - 1}-title`);
  };
  const create = (): void => {
    const edit = addTier(tiers, picked);
    if (!apply(edit, t('hub.settings.principle.added', { count: tiers.length + 1 }))) return;
    if (edit.ok) setFocus(`guide-${edit.tiers.findIndex((x) => x.covers.includes(picked[0]!))}-title`);
    setAdding(false);
    setPicked([]);
  };
  const closeDoor = (): void => {
    setOpen(!open);
    setAdding(false);
    setPicked([]);
    setSaid(null);
  };
  // The levels that can be split off: those whose principle holds two or more, and those no principle holds (a profile in code from 0.2.1 may leave some out).
  const owner = (c: GuidelineCover): TierDraft | undefined => tiers.find((x) => x.covers.includes(c));
  const splittable = ALL_COVERS.filter((c) => owner(c) === undefined || (owner(c)?.covers.length ?? 0) > 1);
  // What the door opens: the structure of each principle and the add form.
  const controls = [...tiers.map((_, i) => `${base}-${i}-structure`), `${base}-add`].join(' ');

  const counter = (id: string, count: number, max: number, key: 'hub.settings.principle.count' | 'hub.settings.principle.examples.count' = 'hub.settings.principle.count'): ReactNode => (
    <p id={id} className="cw-hint cw-counter">
      {t(key, { count, max })}
    </p>
  );

  return (
    <Panel title={t('hub.settings.guidelines.title')} action={reset}>
      <div ref={root} className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.guidelines.hint')}</p>
        {editable && (
          <>
            <button type="button" className="cw-btn cw-section-toggle" data-field="guide-covers" aria-expanded={open} aria-controls={controls} onClick={closeDoor}>
              {t('hub.settings.principle.door')}
            </button>
            <FieldError id={`${base}-covers-err`} problem={problems['guide-covers']} />
          </>
        )}
        {tiers.map((tier, i) => {
          const f = (field: string): string => `${base}-${i}-${field}`;
          const problem = (field: string): Problem | undefined => problems[`guide-${i}-${field}`];
          const mark = (field: string, ...also: Array<string | false>): Record<string, unknown> => ({
            'aria-describedby': ids(f(`${field}-count`), problem(field) !== undefined && f(`${field}-err`), ...also),
            ...(problem(field) === undefined ? {} : { 'aria-invalid': true }),
          });
          // The kit names the principle; the field is found in the same text, so the warning sits under it (the description when the kit and the screen disagree).
          const flaggedAt = excluded?.tiers.includes(i) === true ? (flaggedField(tier) ?? 'description') : null;
          const lines = tiersOf([tier])[0]!.examples.length;
          return (
            <fieldset key={i} className="cw-principle">
              <legend>{t('hub.settings.principle.legend', { n: i + 1 })}</legend>
              <div className="cw-field">
                <label htmlFor={f('title')}>{t('hub.settings.principle.name', { n: i + 1 })}</label>
                <input id={f('title')} type="text" data-field={`guide-${i}-title`} value={tier.title} {...mark('title', flaggedAt === 'title' && f('ai'))} onChange={(e) => change(i, { title: e.target.value })} />
                {counter(f('title-count'), charsOf(tier.title.trim()), MAX_TIER_TITLE)}
                <FieldError id={f('title-err')} problem={problem('title')} />
                {flaggedAt === 'title' && (
                  <p id={f('ai')} className="cw-field-warn">
                    {t('hub.settings.principle.excluded.name')}
                  </p>
                )}
              </div>
              <div className="cw-field">
                <label htmlFor={f('description')}>{t('hub.settings.principle.about', { n: i + 1 })}</label>
                <textarea id={f('description')} data-field={`guide-${i}-description`} rows={3} value={tier.description} {...mark('description', flaggedAt === 'description' && f('ai'))} onChange={(e) => change(i, { description: e.target.value })} />
                {counter(f('description-count'), charsOf(tier.description.trim()), MAX_TIER_DESCRIPTION)}
                <FieldError id={f('description-err')} problem={problem('description')} />
                {flaggedAt === 'description' && (
                  <p id={f('ai')} className="cw-field-warn">
                    {t('hub.settings.principle.excluded')}
                  </p>
                )}
              </div>
              <div className="cw-field">
                <label htmlFor={f('examples')}>{t('hub.settings.principle.examples', { n: i + 1 })}</label>
                <textarea id={f('examples')} data-field={`guide-${i}-examples`} rows={3} value={tier.examples} {...mark('examples', flaggedAt === 'examples' && f('ai'))} onChange={(e) => change(i, { examples: e.target.value })} />
                {counter(f('examples-count'), lines, MAX_TIER_EXAMPLES, 'hub.settings.principle.examples.count')}
                <FieldError id={f('examples-err')} problem={problem('examples')} />
                {flaggedAt === 'examples' && (
                  <p id={f('ai')} className="cw-field-warn">
                    {t('hub.settings.principle.excluded')}
                  </p>
                )}
              </div>
              <div className="cw-field">
                <label htmlFor={f('outcome')}>{t('hub.settings.guideline.label', { title: nameOf(i) })}</label>
                <textarea id={f('outcome')} data-field={`guide-${i}-outcome`} rows={2} value={tier.outcome} {...mark('outcome')} onChange={(e) => change(i, { outcome: e.target.value })} />
                {counter(f('outcome-count'), charsOf(tier.outcome.trim()), MAX_GUIDELINE_OUTCOME)}
                <FieldError id={f('outcome-err')} problem={problem('outcome')} />
              </div>
              {editable && open && (
                <div id={`${base}-${i}-structure`} className="cw-principle-structure">
                  <fieldset className="cw-picks">
                    <legend>{t('hub.settings.principle.levels', { n: i + 1 })}</legend>
                    <ul className="cw-picklist">
                      {ALL_COVERS.map((c) => {
                        const on = tier.covers.includes(c);
                        const only = on && tier.covers.length < 2;
                        return (
                          <li key={c}>
                            <label className="cw-tick">
                              <input type="checkbox" checked={on} disabled={only} aria-describedby={only ? f('last') : undefined} onChange={(e) => toggleCover(i, c, e.target.checked)} />
                              <span>{t(`hub.settings.cover.${c}`)}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {tier.covers.length < 2 && (
                      <p id={f('last')} className="cw-hint">
                        {t('hub.settings.principle.last')}
                      </p>
                    )}
                  </fieldset>
                  <button type="button" className="cw-btn" aria-disabled={tiers.length < 2} aria-label={t('hub.settings.principle.remove.for', { name: nameOf(i) })} onClick={() => remove(i)}>
                    {t('hub.settings.principle.remove')}
                  </button>
                </div>
              )}
            </fieldset>
          );
        })}
        {editable && open && (
          <div id={`${base}-add`} className="cw-principle-add">
            <button type="button" className="cw-btn" aria-expanded={adding} onClick={() => (setAdding(!adding), setPicked([]), setSaid(null))}>
              {t('hub.settings.principle.add')}
            </button>
            {adding && (
              <fieldset className="cw-picks">
                <legend>{t('hub.settings.principle.pick')}</legend>
                {splittable.length === 0 ? (
                  <p className="cw-hint">{t('hub.settings.principle.pick.none')}</p>
                ) : (
                  <ul className="cw-picklist">
                    {splittable.map((c) => (
                      <li key={c}>
                        <label className="cw-tick">
                          <input type="checkbox" checked={picked.includes(c)} onChange={(e) => setPicked(e.target.checked ? [...picked, c] : picked.filter((x) => x !== c))} />
                          <span>
                            {owner(c) === undefined
                              ? t('hub.settings.principle.pick.uncovered', { cover: t(`hub.settings.cover.${c}`) })
                              : t('hub.settings.principle.pick.item', { cover: t(`hub.settings.cover.${c}`), name: nameOf(tiers.findIndex((x) => x.covers.includes(c))) })}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="cw-action-foot">
                  {splittable.length > 0 && (
                    <button type="button" className="cw-btn cw-btn--primary" onClick={create}>
                      {t('hub.settings.principle.create')}
                    </button>
                  )}
                  <button type="button" className="cw-btn" onClick={() => (setAdding(false), setPicked([]), setSaid(null))}>
                    {t('hub.settings.principle.cancel')}
                  </button>
                </div>
              </fieldset>
            )}
          </div>
        )}
        {editable && open && (
          <p role="status" className={said?.refused === true ? 'cw-field-error' : 'cw-sr'}>
            {said?.text ?? ''}
          </p>
        )}
      </div>
    </Panel>
  );
}
