import { APPEAL_STATEMENT_MAX } from '@chatwarden/core';
import { useId, useMemo, useRef, useState } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import { useHubData } from '../hooks.js';
import { lengthPhrase, ruleLabel } from '../labels.js';
import { appealsDirty, appealsDraftOf, appealsFieldKey, appealsLayer, appealsProblems, BAND_TEXT, bandOf, LINK_DAYS } from '../policy/appeals.js';
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

// Settings > Advanced > "Appeals": on or off, how many a player may file a week, whether the person who made a decision may decide its appeal, how long an appeal
// link works, the support contact and whether the person is emailed the outcome (the landing address, its origins and the game's own words are set in code, so
// there is no control for them), the statement limit (read only), and "Mistakes by rule" behind a disclosure. A local draft saved through the same policy machinery as the other panels (a reason, a conflict
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
  const { t, can, locale } = useHub();
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
  const layer = useMemo((): PolicyLayer | null => (Object.keys(local).length > 0 ? null : { ...withoutAppeals(state.layer), appeals: appealsLayer(draft, state.effective.appeals, state.layer.appeals) }), [draft, local, state.layer, state.effective.appeals]);
  const isDirty = useMemo(() => appealsDirty(draft, state.effective.appeals), [draft, state.effective.appeals]);

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: appealsFieldKey,
    onBlocked: () => focusField(root.current, Object.hasOwn(local, 'perWeek') ? 'perWeek' : (Object.keys(local)[0] ?? 'perWeek')),
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
  // The server refuses the switch for a store that cannot keep appeals: the same words as any refused field.
  const onRefused = problems['enabled'];
  const linkProblem = problems['link'];
  const contactProblem = problems['contact'];
  const emailsProblem = problems['emails'];
  // The days the select offers, in order, plus the stored length when it is not one of them (a profile may hold any length the kit accepts): it stays selectable as it is.
  const offered = LINK_DAYS.map((d) => ({ ms: d * 86_400_000, label: t('hub.settings.appeals.link.days', { count: d }) }));
  const storedMs = Number(draft.linkMs);
  const linkOptions = offered.some((o) => o.ms === storedMs) || !Number.isFinite(storedMs) ? offered : [...offered, { ms: storedMs, label: t('hub.settings.appeals.link.custom', { length: lengthPhrase(t, locale, storedMs) }) }].sort((a, b) => a.ms - b.ms);

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
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  aria-labelledby={`${base}-on-t`}
                  aria-describedby={onRefused === undefined ? `${base}-on-hint` : `${base}-on-hint ${base}-on-err`}
                  data-field="enabled"
                  onChange={(e) => set({ enabled: e.target.checked })}
                  {...(onRefused === undefined ? {} : { 'aria-invalid': true as const })}
                />
                <span>
                  <strong id={`${base}-on-t`}>{t('hub.settings.appeals.on')}</strong>
                  <span id={`${base}-on-hint`} className="cw-hint cw-flowopt-line">
                    {t('hub.settings.appeals.on.hint')}
                  </span>
                  {onRefused !== undefined && (
                    <span id={`${base}-on-err`} className="cw-field-error cw-flowopt-line">
                      {t(onRefused.key, onRefused.params)}
                    </span>
                  )}
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
            <div className="cw-pace-row">
              <div className="cw-field">
                <label htmlFor={`${base}-link`}>{t('hub.settings.appeals.link.label')}</label>
                <p id={`${base}-link-hint`} className="cw-hint">
                  {t('hub.settings.appeals.link.hint')}
                </p>
                <select
                  id={`${base}-link`}
                  data-field="link"
                  value={draft.linkMs}
                  onChange={(e) => set({ linkMs: e.target.value })}
                  aria-describedby={linkProblem === undefined ? `${base}-link-hint` : `${base}-link-hint ${base}-link-err`}
                  {...(linkProblem === undefined ? {} : { 'aria-invalid': true as const })}
                >
                  {linkOptions.map((o) => (
                    <option key={o.ms} value={String(o.ms)}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {linkProblem !== undefined && (
                  <p id={`${base}-link-err`} className="cw-field-error">
                    {t(linkProblem.key, linkProblem.params)}
                  </p>
                )}
              </div>
              <div className="cw-field">
                <label htmlFor={`${base}-contact`}>{t('hub.settings.appeals.contact.label')}</label>
                <p id={`${base}-contact-hint`} className="cw-hint">
                  {t('hub.settings.appeals.contact.hint')}
                </p>
                <input
                  id={`${base}-contact`}
                  type="text"
                  autoComplete="off"
                  data-field="contact"
                  value={draft.contact}
                  onChange={(e) => set({ contact: e.target.value })}
                  aria-describedby={contactProblem === undefined ? `${base}-contact-hint` : `${base}-contact-hint ${base}-contact-err`}
                  {...(contactProblem === undefined ? {} : { 'aria-invalid': true as const })}
                />
                {contactProblem !== undefined && (
                  <p id={`${base}-contact-err`} className="cw-field-error">
                    {t(contactProblem.key, contactProblem.params)}
                  </p>
                )}
              </div>
            </div>
            <div className="cw-pace-row">
              <label className="cw-choice cw-flowopt">
                <input
                  type="checkbox"
                  checked={draft.emails}
                  aria-labelledby={`${base}-emails-t`}
                  aria-describedby={emailsProblem === undefined ? `${base}-emails-hint` : `${base}-emails-hint ${base}-emails-err`}
                  data-field="emails"
                  onChange={(e) => set({ emails: e.target.checked })}
                  {...(emailsProblem === undefined ? {} : { 'aria-invalid': true as const })}
                />
                <span>
                  <strong id={`${base}-emails-t`}>{t('hub.settings.appeals.emails.label')}</strong>
                  <span id={`${base}-emails-hint`} className="cw-hint cw-flowopt-line">
                    {t('hub.settings.appeals.emails.hint')}
                  </span>
                  {emailsProblem !== undefined && (
                    <span id={`${base}-emails-err`} className="cw-field-error cw-flowopt-line">
                      {t(emailsProblem.key, emailsProblem.params)}
                    </span>
                  )}
                </span>
              </label>
            </div>
          </fieldset>
          <p className="cw-hint">{t('hub.settings.appeals.where')}</p>
          <p className="cw-hint">{t('hub.settings.appeals.statement', { max: APPEAL_STATEMENT_MAX })}</p>
          {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={refusedField} idBase={base} label={t('hub.settings.appeals.save.form')} onDiscard={discard} onReload={reload} />}
          {can('appeals.read') && <Mistakes on={state.effective.appeals?.enabled === true} />}
        </div>
      </Panel>
      {guard}
    </div>
  );
}

/** "Mistakes by rule": collapsed until asked for, and nothing is read from the server before that. Drawn only for a role that may read appeals (the panel decides). */
function Mistakes({ on }: { on: boolean }) {
  const { t, client } = useHub();
  const id = useId();
  const [open, setOpen] = useState(false);
  const wants = open && on;
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
