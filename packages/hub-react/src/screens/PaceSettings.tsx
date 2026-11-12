import { PACE_SUGGESTIONS } from '@chatwarden/core';
import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import { burstLooserThanBuiltin, paceDirty, paceDraftOf, paceFieldKey, paceLayer, paceProblems, suggestedDraft } from '../policy/pace.js';
import type { PaceDraft } from '../policy/pace.js';
import { ResetConfirm } from '../policy/ResetConfirm.js';
import { SaveBar } from '../policy/SaveBar.js';
import { RESETS, useResetFlow } from '../policy/useResetFlow.js';
import { useDraftSync } from '../policy/useDraftSync.js';
import { useSaveFlow } from '../policy/useSaveFlow.js';
import { useUnsavedGuard } from '../policy/useUnsavedGuard.js';
import type { Problems } from '../policy/panels.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { PolicyLayer, PolicyState } from '../types.js';
import { Notice, Panel } from '../ui.js';

// Settings > Advanced > "Slow mode and flooding": the pacer's three limits, in seconds, each off until switched on. A local draft, saved through the same policy
// machinery as the other settings (a reason, a conflict offers a reload, a per-section reset); only the owner edits. "Use suggested values" fills the draft
// and never saves, and nothing is ever on by default.

const focusField = (root: HTMLElement | null, key: string): void => root?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus();

const withoutPace = (layer: PolicyLayer): PolicyLayer => {
  const { pace: _own, ...rest } = layer;
  void _own;
  return rest;
};

/** The preset the profile in code started from, as the suggestions are keyed: its name in lower case, `standard` when it is a team's own. */
const presetOf = (name: unknown): 'relaxed' | 'standard' | 'strict' => {
  const key = typeof name === 'string' ? name.toLowerCase() : '';
  return key === 'relaxed' || key === 'strict' ? key : 'standard';
};

function Row({
  id,
  label,
  hint,
  on,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="cw-pace-row">
      <label className="cw-choice cw-flowopt">
        <input type="checkbox" checked={on} aria-labelledby={`${id}-t`} aria-describedby={`${id}-hint`} onChange={(e) => onToggle(e.target.checked)} />
        <span>
          <strong id={`${id}-t`}>{label}</strong>
          <span id={`${id}-hint`} className="cw-hint cw-flowopt-line">
            {hint}
          </span>
        </span>
      </label>
      <div className="cw-pace-fields">{children}</div>
    </div>
  );
}

function NumberField({
  id,
  field,
  label,
  value,
  disabled,
  problems,
  onChange,
  step,
}: {
  id: string;
  field: string;
  label: string;
  value: string;
  disabled: boolean;
  problems: Problems;
  onChange: (value: string) => void;
  step?: string;
}) {
  const { t } = useHub();
  const problem = problems[field];
  return (
    <div className="cw-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step={step ?? 'any'}
        data-field={field}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        {...(problem === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${id}-err` })}
      />
      {problem !== undefined && (
        <p id={`${id}-err`} className="cw-field-error">
          {t(problem.key, problem.params)}
        </p>
      )}
    </div>
  );
}

/** The panel. `state` and `policy` come from the Advanced screen, which reads the policy once for all its panels. */
export function PaceSettings({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const { t } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;
  const [draft, setDraftState] = useState<PaceDraft>(() => paceDraftOf(state.effective.pace));
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const set = (patch: Partial<PaceDraft>): void => {
    setDraftState((d) => ({ ...d, ...patch }));
    setServerProblems({});
  };

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(paceDraftOf(next.effective.pace)),
    sections: (sections, next) => {
      if (sections.includes('pace')) setDraftState(paceDraftOf(next.effective.pace));
    },
  });

  const local = useMemo(() => paceProblems(draft), [draft]);
  const problems: Problems = { ...local, ...serverProblems };
  const layer = useMemo((): PolicyLayer | null => (Object.keys(local).length > 0 ? null : { ...withoutPace(state.layer), pace: paceLayer(draft) }), [draft, local, state.layer]);
  const isDirty = useMemo(() => paceDirty(draft, state.effective.pace), [draft, state.effective.pace]);

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: paceFieldKey,
    onBlocked: () => {
      const first = (['slowSec', 'burstLines', 'burstSec', 'dupSec'] as const).find((k) => local[k] !== undefined);
      if (first !== undefined) focusField(root.current, first);
    },
    onSaved: () => {
      setServerProblems({});
      toasts.push({ text: t('hub.settings.pace.saved') });
    },
    onRefused: (key) => {
      setServerProblems({ [key]: { key: 'hub.settings.field.refused' } });
      queueMicrotask(() => focusField(root.current, key));
    },
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && paceFieldKey(save.saveError.path ?? '') !== null;

  const discard = (): void => {
    setDraftState(paceDraftOf(state.effective.pace));
    setServerProblems({});
    save.close();
  };
  const reload = (): void => {
    pending.current = 'all';
    setServerProblems({});
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
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS.pace.done) }) });
      resetFocus();
    },
  });
  const guard = useUnsavedGuard(isDirty);

  const suggest = (): void => {
    setDraftState(suggestedDraft(PACE_SUGGESTIONS[presetOf(state.effective.name)]));
    setServerProblems({});
  };

  return (
    <div ref={root} className="cw-settings cw-pace">
      <Panel title={t('hub.settings.pace.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.settings.pace.intro')}</p>
          {!state.canSave ? <Notice role="status">{t('hub.settings.pace.unsupported')}</Notice> : !editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
          {editable && (
            <div className="cw-settings-all">
              <button type="button" className="cw-btn" onClick={suggest}>
                {t('hub.settings.pace.suggest')}
              </button>
              <button type="button" id={`${base}-reset`} className="cw-btn" aria-disabled={!reset.canReset('pace')} aria-expanded={reset.confirming === 'pace'} onClick={() => reset.open('pace')}>
                {t('hub.settings.reset.button', { what: t(RESETS.pace.what) })}
              </button>
            </div>
          )}
          {editable && <p className="cw-hint">{t('hub.settings.pace.suggest.hint')}</p>}
          {reset.confirming === 'pace' && <ResetConfirm what={t(RESETS.pace.what)} busy={policy.busy} error={reset.error} onConfirm={(why) => void reset.run('pace', why)} onCancel={() => reset.close('pace')} />}
          <fieldset className="cw-settings-body" disabled={!editable}>
            <legend className="cw-sr">{t('hub.settings.pace.title')}</legend>
            <Row id={`${base}-slow`} label={t('hub.settings.pace.slow')} hint={t('hub.settings.pace.slow.hint')} on={draft.slow} onToggle={(slow) => set({ slow })}>
              <NumberField id={`${base}-slow-s`} field="slowSec" label={t('hub.settings.pace.slow.seconds')} value={draft.slowSec} disabled={!draft.slow || !editable} problems={problems} onChange={(slowSec) => set({ slowSec })} />
            </Row>
            <Row id={`${base}-burst`} label={t('hub.settings.pace.burst')} hint={t('hub.settings.pace.burst.hint')} on={draft.burst} onToggle={(burst) => set({ burst })}>
              <NumberField id={`${base}-burst-n`} field="burstLines" label={t('hub.settings.pace.burst.lines')} value={draft.burstLines} disabled={!draft.burst || !editable} problems={problems} step="1" onChange={(burstLines) => set({ burstLines })} />
              <NumberField id={`${base}-burst-s`} field="burstSec" label={t('hub.settings.pace.burst.seconds')} value={draft.burstSec} disabled={!draft.burst || !editable} problems={problems} onChange={(burstSec) => set({ burstSec })} />
              {burstLooserThanBuiltin(draft) && <p className="cw-hint">{t('hub.settings.pace.builtin')}</p>}
            </Row>
            <Row id={`${base}-dup`} label={t('hub.settings.pace.repeat')} hint={t('hub.settings.pace.repeat.hint')} on={draft.dup} onToggle={(dup) => set({ dup })}>
              <NumberField id={`${base}-dup-s`} field="dupSec" label={t('hub.settings.pace.repeat.seconds')} value={draft.dupSec} disabled={!draft.dup || !editable} problems={problems} onChange={(dupSec) => set({ dupSec })} />
            </Row>
          </fieldset>
          <p className="cw-hint">{t('hub.settings.pace.scope')}</p>
        </div>
      </Panel>
      {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={refusedField} idBase={base} onDiscard={discard} onReload={reload} />}
      {guard}
    </div>
  );
}
