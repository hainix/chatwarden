import { FILTER_SUGGESTIONS, resolveFilters } from '@chatwarden/core';
import type { FilterSettings as FilterSettingsInput } from '@chatwarden/core';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import { FilterChecker, FilterTester } from '../filters/FilterTester.js';
import { FilterHits } from '../filters/FilterHits.js';
import { LinkCard } from '../filters/LinkCard.js';
import { PersonalInfoCard } from '../filters/PersonalInfoCard.js';
import { PhraseCard } from '../filters/PhraseCard.js';
import { RatioCard } from '../filters/RatioCard.js';
import { NumField } from '../filters/parts.js';
import type { Problem } from '../filters/parts.js';
import { cardOfPath, filterDirty, filterDraftOf, filterLayer, filterProblem, filterRefusalPath, patternsOf } from '../policy/filters.js';
import type { FilterDraft } from '../policy/filters.js';
import { ResetConfirm } from '../policy/ResetConfirm.js';
import { SaveBar } from '../policy/SaveBar.js';
import { RESETS, useResetFlow } from '../policy/useResetFlow.js';
import { useDraftSync } from '../policy/useDraftSync.js';
import { useSaveFlow } from '../policy/useSaveFlow.js';
import { useUnsavedGuard } from '../policy/useUnsavedGuard.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { PolicyLayer, PolicyState } from '../types.js';
import { Notice, Panel } from '../ui.js';

// Settings > Advanced > "Chat filters": four cards (links, personal info, shouting and repeats, phrases), each a switch that is off, with a four-way action in words, a
// Community Rule and its own details; "Test a message", "Check my changes" and "Hits" under them. A local draft, saved through the same policy machinery as the other
// panels (a reason, a conflict offers a reload, a per-section reset); only the owner edits. Nothing is on by default, and a filter never saves anything about a line.

const withoutFilters = (layer: PolicyLayer): PolicyLayer => {
  const { filters: _own, ...rest } = layer;
  void _own;
  return rest;
};

/** The preset the profile in code started from, as the suggestions are keyed: its name in lower case, `standard` when it is a team's own. */
const presetOf = (name: unknown): 'relaxed' | 'standard' | 'strict' => {
  const key = typeof name === 'string' ? name.toLowerCase() : '';
  return key === 'relaxed' || key === 'strict' ? key : 'standard';
};

/** What is sent as the candidate and the layer: patterns with their blank lines taken out. */
const cleaned = (d: FilterDraft): FilterDraft => ({ ...d, phrases: d.phrases.map((p) => ({ ...p, phrases: patternsOf(p.phrases.join('\n')) })) });

/** The panel. `state` and `policy` come from the Advanced screen, which reads the policy once for all its panels. */
export function FilterSettings({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const { t, can } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;
  const [draft, setDraftState] = useState<FilterDraft>(() => filterDraftOf(state.effective.filters));
  const [refused, setRefused] = useState<Problem | null>(null);
  const [waiting, setWaiting] = useState(false);
  const set = (patch: Partial<FilterDraft>): void => {
    setDraftState((d) => ({ ...d, ...patch }));
    setRefused(null);
  };

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(filterDraftOf(next.effective.filters)),
    sections: (sections, next) => {
      if (sections.includes('filters')) setDraftState(filterDraftOf(next.effective.filters));
    },
  });

  const clean = useMemo(() => cleaned(draft), [draft]);
  const own = useMemo((): Problem | null => filterProblem(clean), [clean]);
  const problem: Problem | null = own ?? refused;
  const layer = useMemo((): PolicyLayer | null => (own !== null || waiting ? null : { ...withoutFilters(state.layer), filters: filterLayer(clean) }), [clean, own, waiting, state.layer]);
  const isDirty = useMemo(() => filterDirty(clean, state.effective.filters), [clean, state.effective.filters]);

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: filterRefusalPath,
    onBlocked: () => root.current?.querySelector<HTMLElement>('.cw-field-error, .cw-notice--warn input')?.focus(),
    onSaved: () => {
      setRefused(null);
      toasts.push({ text: t('hub.settings.filters.saved') });
    },
    onRefused: (path) => setRefused({ path, message: '', refused: true }),
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && filterRefusalPath(save.saveError.path ?? '') !== null;

  const discard = (): void => {
    setDraftState(filterDraftOf(state.effective.filters));
    setRefused(null);
    save.close();
  };
  const reload = (): void => {
    pending.current = 'all';
    setRefused(null);
    save.close();
    policy.reload();
  };
  const resetFocus = (): void =>
    queueMicrotask(() => {
      if (root.current !== null) byId(rootOf(root.current), `${base}-reset`)?.focus();
    });
  const reset = useResetFlow({
    policy,
    state,
    editable,
    pending,
    onClosed: resetFocus,
    onDone: () => {
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS.filters.done) }) });
      resetFocus();
    },
  });
  const guard = useUnsavedGuard(isDirty);

  const suggest = (): void => {
    setDraftState(filterDraftOf(resolveFilters(FILTER_SUGGESTIONS[presetOf(state.effective.name)])));
    setRefused(null);
    // The form fills silently: say so, for a screen reader (the hint under the button is static).
    toasts.push({ text: t('hub.settings.filters.suggest.done') });
  };

  const labelOf = useCallback((key: string): string | undefined => draft.phrases.find((p) => `phrase.${p.id}` === key)?.label, [draft.phrases]);
  const candidate: FilterSettingsInput = useMemo(() => filterLayer(clean), [clean]);
  const tools = can('filters.read');
  const accountAge = state.limits?.filters?.accountAge === true;

  return (
    <div ref={root} className="cw-settings cw-filters">
      <Panel title={t('hub.settings.filters.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.settings.filters.intro')}</p>
          {!state.canSave ? <Notice role="status">{t('hub.settings.filters.unsupported')}</Notice> : !editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
          {editable && (
            <div className="cw-settings-all">
              <button type="button" className="cw-btn" onClick={suggest}>
                {t('hub.settings.filters.suggest')}
              </button>
              <button type="button" id={`${base}-reset`} className="cw-btn" aria-disabled={!reset.canReset('filters')} aria-expanded={reset.confirming === 'filters'} onClick={() => reset.open('filters')}>
                {t('hub.settings.reset.button', { what: t(RESETS.filters.what) })}
              </button>
            </div>
          )}
          {editable && <p className="cw-hint">{t('hub.settings.filters.suggest.hint')}</p>}
          {reset.confirming === 'filters' && <ResetConfirm what={t(RESETS.filters.what)} busy={policy.busy} error={reset.error} onConfirm={(why) => void reset.run('filters', why)} onCancel={() => reset.close('filters')} />}
          <fieldset className="cw-settings-body" disabled={!editable}>
            <legend className="cw-sr">{t('hub.settings.filters.title')}</legend>
            <LinkCard value={draft.links} onChange={(links) => set({ links })} problem={problem} flagCap={draft.flagCapPerDay} accountAge={accountAge} />
            <PersonalInfoCard value={draft.personalInfo} onChange={(personalInfo) => set({ personalInfo })} problem={problem} flagCap={draft.flagCapPerDay} />
            <RatioCard value={draft.ratio} onChange={(ratio) => set({ ratio })} problem={problem} flagCap={draft.flagCapPerDay} />
            <PhraseCard value={draft.phrases} onChange={(phrases) => set({ phrases })} problem={problem} flagCap={draft.flagCapPerDay} />
            <details className="cw-fmore">
              <summary>{t('hub.settings.filters.more')}</summary>
              <NumField label={t('hub.settings.filters.flagCap')} value={draft.flagCapPerDay} onChange={(n) => set({ flagCapPerDay: n ?? 0 })} min={1} max={500} />
              <div className="cw-field">
                <label htmlFor={`${base}-ignore`}>{t('hub.settings.filters.ignore')}</label>
                <p id={`${base}-ignore-h`} className="cw-hint">
                  {t('hub.settings.filters.ignore.hint')}
                </p>
                <textarea id={`${base}-ignore`} rows={2} aria-describedby={`${base}-ignore-h`} value={draft.ignore.join('\n')} onChange={(e) => set({ ignore: e.target.value.split('\n') })} />
              </div>
            </details>
            {problem !== null && cardOfPath(problem.path) === 'other' && <p className="cw-field-error">{t('hub.settings.filters.problem', { field: t('hub.settings.filters.field.general'), reason: t('hub.settings.filters.problem.invalid') })}</p>}
          </fieldset>
          {tools && <FilterTester candidate={candidate} problem={own} labelOf={labelOf} />}
          {tools && <FilterChecker candidate={candidate} problem={own} labelOf={labelOf} onGate={setWaiting} />}
          {tools && <FilterHits labelOf={labelOf} />}
          <p className="cw-hint">{t('hub.settings.filters.scope')}</p>
          {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={refusedField} idBase={base} label={t('hub.settings.filters.save.form')} onDiscard={discard} onReload={reload} />}
        </div>
      </Panel>
      {guard}
    </div>
  );
}
