import { APPEAL_STATEMENT_MAX } from '@chatwarden/core';
import { useId, useMemo, useRef, useState } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import { useHubData } from '../hooks.js';
import { ruleLabel } from '../labels.js';
import { appealsDirty, appealsDraftOf, appealsFieldKey, appealsLayer, appealsProblems, BAND_TEXT, bandOf } from '../policy/appeals.js';
import type { AppealsDraft } from '../policy/appeals.js';
import type { Problems } from '../policy/panels.js';
import { ResetConfirm } from '../policy/ResetConfirm.js';
import { SaveBar } from '../policy/SaveBar.js';
import { RESETS, useResetFlow } from '../policy/useResetFlow.js';
import { useDraftSync } from '../policy/useDraftSync.js';
import { useSaveFlow } from '../policy/useSaveFlow.js';
import { useUnsavedGuard } from '../policy/useUnsavedGuard.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { AppealStats, PolicyLayer, PolicyState } from '../types.js';
import { ErrorBlock, Loading, Notice, Panel, Scroll } from '../ui.js';

// Settings > Advanced > "Appeals": on or off, how many a player may file a week, whether the person who made a decision may decide its appeal, the statement
// limit (read only), and "Mistakes by rule" behind a disclosure. A local draft saved through the same policy machinery as the other panels (a reason, a conflict
// offers a reload, a per-section reset); only the owner edits. Appeals are off until the owner turns them on. The false-positive picture is here, behind the
// advanced door, and never on a queue or a card: a band is a few words, never a colour and never a number outside the table.

const focusField = (root: HTMLElement | null, key: string): void => root?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus();

const withoutAppeals = (layer: PolicyLayer): PolicyLayer => {
  const { appeals: _own, ...rest } = layer;
  void _own;
  return rest;
};

/** The panel. `state` and `policy` come from the Advanced screen, which reads the policy once for all its panels. */
export function AppealSettings({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const { t } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;
  const [draft, setDraftState] = useState<AppealsDraft>(() => appealsDraftOf(state.effective.appeals));
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const set = (patch: Partial<AppealsDraft>): void => {
    setDraftState((d) => ({ ...d, ...patch }));
    setServerProblems({});
  };

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(appealsDraftOf(next.effective.appeals)),
    sections: (sections, next) => {
      if (sections.includes('appeals')) setDraftState(appealsDraftOf(next.effective.appeals));
    },
  });

  const local = useMemo(() => appealsProblems(draft), [draft]);
  const problems: Problems = { ...local, ...serverProblems };
  const layer = useMemo((): PolicyLayer | null => (Object.keys(local).length > 0 ? null : { ...withoutAppeals(state.layer), appeals: appealsLayer(draft) }), [draft, local, state.layer]);
  const isDirty = useMemo(() => appealsDirty(draft, state.effective.appeals), [draft, state.effective.appeals]);

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: appealsFieldKey,
    onBlocked: () => focusField(root.current, 'perWeek'),
    onSaved: () => {
      setServerProblems({});
      toasts.push({ text: t('hub.settings.appeals.saved') });
    },
    onRefused: (key) => {
      setServerProblems({ [key]: { key: 'hub.settings.field.refused' } });
      queueMicrotask(() => focusField(root.current, key));
    },
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && appealsFieldKey(save.saveError.path ?? '') !== null;

  const discard = (): void => {
    setDraftState(appealsDraftOf(state.effective.appeals));
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
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS.appeals.done) }) });
      resetFocus();
    },
  });
  const guard = useUnsavedGuard(isDirty);
  const limit = problems['perWeek'];

  return (
    <div ref={root} className="cw-settings cw-appeal-settings">
      <Panel title={t('hub.settings.appeals.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.settings.appeals.intro')}</p>
          {!state.canSave ? <Notice role="status">{t('hub.settings.appeals.unsupported')}</Notice> : !editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
          {editable && (
            <div className="cw-settings-all">
              <button type="button" id={`${base}-reset`} className="cw-btn" aria-disabled={!reset.canReset('appeals')} aria-expanded={reset.confirming === 'appeals'} onClick={() => reset.open('appeals')}>
                {t('hub.settings.reset.button', { what: t(RESETS.appeals.what) })}
              </button>
            </div>
          )}
          {reset.confirming === 'appeals' && (
            <ResetConfirm what={t(RESETS.appeals.what)} busy={policy.busy} error={reset.error} onConfirm={(why) => void reset.run('appeals', why)} onCancel={() => reset.close('appeals')} />
          )}
          <fieldset className="cw-settings-body" disabled={!editable}>
            <legend className="cw-sr">{t('hub.settings.appeals.title')}</legend>
            <div className="cw-pace-row">
              <label className="cw-choice cw-flowopt">
                <input type="checkbox" checked={draft.enabled} aria-labelledby={`${base}-on-t`} aria-describedby={`${base}-on-hint`} data-field="enabled" onChange={(e) => set({ enabled: e.target.checked })} />
                <span>
                  <strong id={`${base}-on-t`}>{t('hub.settings.appeals.on')}</strong>
                  <span id={`${base}-on-hint`} className="cw-hint cw-flowopt-line">
                    {t('hub.settings.appeals.on.hint')}
                  </span>
                </span>
              </label>
              <div className="cw-pace-fields">
                <div className="cw-field">
                  <label htmlFor={`${base}-limit`}>{t('hub.settings.appeals.limit')}</label>
                  <p id={`${base}-limit-hint`} className="cw-hint">
                    {t('hub.settings.appeals.limit.hint')}
                  </p>
                  <input
                    id={`${base}-limit`}
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="20"
                    step="1"
                    data-field="perWeek"
                    value={draft.perWeek}
                    disabled={!draft.enabled || !editable}
                    onChange={(e) => set({ perWeek: e.target.value })}
                    aria-describedby={limit === undefined ? `${base}-limit-hint` : `${base}-limit-hint ${base}-limit-err`}
                    {...(limit === undefined ? {} : { 'aria-invalid': true as const })}
                  />
                  {limit !== undefined && (
                    <p id={`${base}-limit-err`} className="cw-field-error">
                      {t(limit.key, limit.params)}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="cw-pace-row">
              <label className="cw-choice cw-flowopt">
                <input type="checkbox" checked={draft.self} aria-labelledby={`${base}-self-t`} aria-describedby={`${base}-self-hint`} data-field="self" onChange={(e) => set({ self: e.target.checked })} />
                <span>
                  <strong id={`${base}-self-t`}>{t('hub.settings.appeals.self')}</strong>
                  <span id={`${base}-self-hint`} className="cw-hint cw-flowopt-line">
                    {t('hub.settings.appeals.self.hint')}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
          <p className="cw-hint">{t('hub.settings.appeals.statement', { max: APPEAL_STATEMENT_MAX })}</p>
          {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={refusedField} idBase={base} label={t('hub.settings.appeals.save.form')} onDiscard={discard} onReload={reload} />}
          <Mistakes on={state.effective.appeals?.enabled === true} />
        </div>
      </Panel>
      {guard}
    </div>
  );
}

/** "Mistakes by rule": collapsed until asked for, and nothing is read from the server before that. */
function Mistakes({ on }: { on: boolean }) {
  const { t, client, can } = useHub();
  const id = useId();
  const [open, setOpen] = useState(false);
  const wants = open && on && can('appeals.read');
  const stats = useHubData<AppealStats | null>(wants ? 'appeal-stats' : 'appeal-stats:idle', () => (wants ? client.appealStats() : Promise.resolve(null)));
  return (
    <div className="cw-appeal-mistakes">
      <button type="button" className="cw-linkbtn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        {t('hub.settings.appeals.mistakes')}
      </button>
      {open && (
        <div id={id} className="cw-appeal-mistakes-body">
          <p className="cw-hint">{t('hub.settings.appeals.mistakes.intro')}</p>
          {!on ? (
            <p className="cw-hint">{t('hub.settings.appeals.mistakes.off')}</p>
          ) : stats.error !== null && stats.data == null ? (
            <ErrorBlock error={stats.error} what={t('hub.settings.appeals.mistakes')} onRetry={stats.reload} />
          ) : stats.data == null ? (
            <Loading label={t('hub.settings.appeals.mistakes.loading')} />
          ) : stats.data.perRule.length === 0 ? (
            <p className="cw-hint">{t('hub.settings.appeals.mistakes.none')}</p>
          ) : (
            <Scroll label={t('hub.settings.appeals.mistakes')}>
              <table className="cw-table" aria-label={t('hub.settings.appeals.mistakes')}>
                <thead>
                  <tr>
                    <th scope="col">{t('hub.settings.appeals.col.rule')}</th>
                    <th scope="col">{t('hub.settings.appeals.col.sanctions')}</th>
                    <th scope="col">{t('hub.settings.appeals.col.appealed')}</th>
                    <th scope="col">{t('hub.settings.appeals.col.revoked')}</th>
                    <th scope="col">{t('hub.settings.appeals.col.lightened')}</th>
                    <th scope="col">{t('hub.settings.appeals.col.band')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.perRule.map((r) => (
                    <tr key={String(r.rule)}>
                      <td>{ruleLabel(t, r.rule)}</td>
                      <td>{r.sanctions}</td>
                      <td>{r.appealed}</td>
                      <td>{r.granted}</td>
                      <td>{r.lightened}</td>
                      <td>{t(BAND_TEXT[bandOf(r.band)])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          )}
        </div>
      )}
    </div>
  );
}
