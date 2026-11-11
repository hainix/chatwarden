import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { FlowPanel, PlayersSee, ReasonsPanel, ThanksPanel } from '../policy/ReportingPanels.js';
import { ResetConfirm } from '../policy/ResetConfirm.js';
import { SaveBar } from '../policy/SaveBar.js';
import { reportingDirty, reportingDraftOf, reportingFieldKey, reportingLayer, reportingProblems } from '../policy/reporting.js';
import type { ReportingDraft } from '../policy/reporting.js';
import { RESETS, useResetFlow } from '../policy/useResetFlow.js';
import { useDraftSync } from '../policy/useDraftSync.js';
import { useSaveFlow } from '../policy/useSaveFlow.js';
import { useUnsavedGuard } from '../policy/useUnsavedGuard.js';
import { usePolicy } from '../policyHooks.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { PolicyLayer, PolicyState } from '../types.js';
import { Fetched, Notice } from '../ui.js';
import type { Problems } from '../policy/panels.js';

// The Reporting settings: how players report (one tap, a reason first, or a reason required), the reasons they can give, and the thank-you.
// Like the steps and ladder screen it edits a local draft and saves it with a reason; the server is the judge and a refusal points at its
// field. The "What players see" picture is drawn from the draft, so it needs no round trip. The flows (save, reset, leaving) are the same
// hooks the ladder screen uses.

/** Puts keyboard focus on the field with this key. */
function focusField(root: HTMLElement | null, key: string): void {
  root?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus();
}

/** The first field of these on the page, in reading order. */
function firstField(root: HTMLElement | null, keys: readonly string[]): string | null {
  const found = keys
    .map((k) => ({ k, el: root?.querySelector<HTMLElement>(`[data-field="${k}"]`) ?? null }))
    .filter((x): x is { k: string; el: HTMLElement } => x.el !== null);
  found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return found[0]?.k ?? null;
}

/** The layer that was saved, without the reporting section: what this screen sends is its own section plus whatever another screen saved. */
const withoutReporting = (layer: PolicyLayer): PolicyLayer => {
  const { reporting: _own, ...rest } = layer;
  void _own;
  return rest;
};

function Editor({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const { t, session } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;

  const [draft, setDraftState] = useState<ReportingDraft>(() => reportingDraftOf(state.effective.reporting));
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const setDraft = (update: (d: ReportingDraft) => ReportingDraft): void => {
    setDraftState(update);
    // An edit answers a refusal: the mark comes off.
    setServerProblems({});
  };

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(reportingDraftOf(next.effective.reporting)),
    sections: (sections, next) => {
      if (sections.includes('reporting')) setDraftState(reportingDraftOf(next.effective.reporting));
    },
  });

  // The Community Rules, for the rule pickers: read once through the hub's session (it is audited as one `policy.view`).
  const rulesRead = useHubData('settings:rules', () => session.policy());
  const rules = rulesRead.data?.rules ?? [];

  const local = useMemo(() => reportingProblems(draft), [draft]);
  const built = useMemo((): { ok: true; layer: PolicyLayer } | { ok: false } => {
    if (Object.keys(local).length > 0) return { ok: false };
    const section = reportingLayer(draft, state.base.reporting);
    return { ok: true, layer: { ...withoutReporting(state.layer), ...(section === null ? {} : { reporting: section }) } };
  }, [draft, local, state]);
  const isDirty = useMemo(() => reportingDirty(draft, state.effective.reporting), [draft, state]);
  const problems: Problems = { ...local, ...serverProblems };

  const save = useSaveFlow({
    policy,
    layer: built.ok ? built.layer : null,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: (path) => reportingFieldKey(path, draft),
    onBlocked: () => {
      const key = firstField(root.current, Object.keys(local));
      if (key !== null) focusField(root.current, key);
    },
    onSaved: () => {
      setServerProblems({});
      toasts.push({ text: t('hub.reporting.saved') });
    },
    onRefused: (key) => {
      setServerProblems({ [key]: { key: 'hub.settings.field.refused' } });
      queueMicrotask(() => focusField(root.current, key));
    },
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && reportingFieldKey(save.saveError.path ?? '', draft) !== null;

  const discard = (): void => {
    setDraftState(reportingDraftOf(state.effective.reporting));
    setServerProblems({});
    save.close();
  };
  const reload = (): void => {
    pending.current = 'all';
    setServerProblems({});
    save.close();
    policy.reload();
  };

  const resetFocus = (): void => queueMicrotask(() => document.getElementById(`${base}-reset`)?.focus());
  const reset = useResetFlow({
    policy,
    state,
    editable,
    pending,
    onClosed: resetFocus,
    onDone: () => {
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS.reporting.done) }) });
      resetFocus();
    },
  });
  const guard = useUnsavedGuard(isDirty);

  const resetButton: ReactNode = editable ? (
    <button type="button" id={`${base}-reset`} className="cw-btn" aria-disabled={!reset.canReset('reporting')} aria-expanded={reset.confirming === 'reporting'} onClick={() => reset.open('reporting')}>
      {t('hub.settings.reset.button', { what: t(RESETS.reporting.what) })}
    </button>
  ) : null;

  return (
    <div ref={root} className="cw-settings">
      {state.layerError !== undefined && <Notice tone="warn">{t('hub.settings.layerError')}</Notice>}
      {!state.canSave ? <Notice role="status">{t('hub.reporting.unsupported')}</Notice> : !editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
      {editable && <div className="cw-settings-all">{resetButton}</div>}
      {reset.confirming === 'reporting' && (
        <ResetConfirm what={t(RESETS.reporting.what)} busy={policy.busy} error={reset.error} onConfirm={(why) => void reset.run('reporting', why)} onCancel={() => reset.close('reporting')} />
      )}
      <fieldset className="cw-settings-body" disabled={!editable}>
        <legend className="cw-sr">{t('hub.reporting.body')}</legend>
        <FlowPanel draft={draft} set={setDraft} problems={problems} />
        <ReasonsPanel draft={draft} set={setDraft} problems={problems} rules={rules} />
        <ThanksPanel draft={draft} set={setDraft} problems={problems} />
      </fieldset>
      <PlayersSee draft={draft} />
      {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={refusedField} idBase={base} onDiscard={discard} onReload={reload} />}
      {guard}
    </div>
  );
}

/** The Reporting screen: how players report, the reasons they can give and the thank-you, edited in the page. */
export function ReportingSettingsScreen() {
  const { t } = useHub();
  const policy = usePolicy();
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.reporting.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.reporting.intro')}</p>
      <Fetched state={{ data: policy.data, error: policy.error, loading: policy.loading, reload: policy.reload }} what={t('hub.state.what.settings')}>
        {(state) => <Editor state={state} policy={policy} />}
      </Fetched>
    </div>
  );
}
