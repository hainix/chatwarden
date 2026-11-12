import { useId, useMemo, useRef, useState } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import type { HubText } from '../i18n.js';
import { namesDirty, namesDraftOf, namesFieldKey, namesLayer } from '../policy/names.js';
import type { NamesDraft } from '../policy/names.js';
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

// Settings > Advanced > "Names": four switches with one sentence each (check swearing in names; keep blocked names as evidence, with the retention in words; let
// moderators ask for a new name; hide flagged names until shown). A local draft saved through the same policy machinery as the other panels (a reason, a conflict
// offers a reload, a per-section reset); only the owner edits. A name the word list refuses is refused whatever these say.

const withoutNames = (layer: PolicyLayer): PolicyLayer => {
  const { names: _own, ...rest } = layer;
  void _own;
  return rest;
};

const SWITCHES: ReadonlyArray<{ key: keyof NamesDraft; label: HubText; hint: HubText }> = [
  { key: 'profanity', label: 'hub.settings.names.profanity', hint: 'hub.settings.names.profanity.hint' },
  { key: 'keep', label: 'hub.settings.names.keep', hint: 'hub.settings.names.keep.hint' },
  { key: 'renames', label: 'hub.settings.names.renames', hint: 'hub.settings.names.renames.hint' },
  { key: 'mask', label: 'hub.settings.names.mask', hint: 'hub.settings.names.mask.hint' },
];

/** The panel. `state` and `policy` come from the Advanced screen, which reads the policy once for all its panels. */
export function NameSettings({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const { t } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;
  const [draft, setDraftState] = useState<NamesDraft>(() => namesDraftOf(state.effective.names));
  const set = (patch: Partial<NamesDraft>): void => setDraftState((d) => ({ ...d, ...patch }));

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(namesDraftOf(next.effective.names)),
    sections: (sections, next) => {
      if (sections.includes('names')) setDraftState(namesDraftOf(next.effective.names));
    },
  });

  const layer = useMemo((): PolicyLayer => ({ ...withoutNames(state.layer), names: namesLayer(draft) }), [draft, state.layer]);
  const isDirty = useMemo(() => namesDirty(draft, state.effective.names), [draft, state.effective.names]);

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: namesFieldKey,
    onBlocked: () => undefined,
    onSaved: () => toasts.push({ text: t('hub.settings.names.saved') }),
    onRefused: () => undefined,
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && namesFieldKey(save.saveError.path ?? '') !== null;

  const discard = (): void => {
    setDraftState(namesDraftOf(state.effective.names));
    save.close();
  };
  const reload = (): void => {
    pending.current = 'all';
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
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS.names.done) }) });
      resetFocus();
    },
  });
  const guard = useUnsavedGuard(isDirty);

  return (
    <div ref={root} className="cw-settings cw-name-settings">
      <Panel title={t('hub.settings.names.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.settings.names.intro')}</p>
          {!state.canSave ? <Notice role="status">{t('hub.settings.names.unsupported')}</Notice> : !editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
          {editable && (
            <div className="cw-settings-all">
              <button type="button" id={`${base}-reset`} className="cw-btn" aria-disabled={!reset.canReset('names')} aria-expanded={reset.confirming === 'names'} onClick={() => reset.open('names')}>
                {t('hub.settings.reset.button', { what: t(RESETS.names.what) })}
              </button>
            </div>
          )}
          {reset.confirming === 'names' && <ResetConfirm what={t(RESETS.names.what)} busy={policy.busy} error={reset.error} onConfirm={(why) => void reset.run('names', why)} onCancel={() => reset.close('names')} />}
          <fieldset className="cw-settings-body" disabled={!editable}>
            <legend className="cw-sr">{t('hub.settings.names.title')}</legend>
            {SWITCHES.map((s) => (
              <div key={s.key} className="cw-pace-row">
                <label className="cw-choice cw-flowopt">
                  <input type="checkbox" checked={draft[s.key]} aria-labelledby={`${base}-${s.key}-t`} aria-describedby={`${base}-${s.key}-hint`} data-field={s.key} onChange={(e) => set({ [s.key]: e.target.checked })} />
                  <span>
                    <strong id={`${base}-${s.key}-t`}>{t(s.label)}</strong>
                    <span id={`${base}-${s.key}-hint`} className="cw-hint cw-flowopt-line">
                      {t(s.hint)}
                    </span>
                  </span>
                </label>
              </div>
            ))}
          </fieldset>
          {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={refusedField} idBase={base} label={t('hub.settings.names.save.form')} onDiscard={discard} onReload={reload} />}
        </div>
      </Panel>
      {guard}
    </div>
  );
}
