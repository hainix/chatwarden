import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import { useHubData } from '../hooks.js';
import { FirstPanel, GuidelinesPanel, LadderPanel, LengthsPanel, RepeatPanel, RulesPanel } from '../policy/panels.js';
import type { Problems } from '../policy/panels.js';
import { Preview } from '../policy/Preview.js';
import { ResetConfirm } from '../policy/ResetConfirm.js';
import { dirtySections, draftOf, fieldKeyOf, layerOf, otherSections, setSection } from '../policy/model.js';
import type { PolicyDraft } from '../policy/model.js';
import { SaveBar } from '../policy/SaveBar.js';
import { RESETS, useResetFlow } from '../policy/useResetFlow.js';
import type { ResetKey } from '../policy/useResetFlow.js';
import { usePreview } from '../policy/usePreview.js';
import { useDraftSync } from '../policy/useDraftSync.js';
import { useSaveFlow } from '../policy/useSaveFlow.js';
import { useUnsavedGuard } from '../policy/useUnsavedGuard.js';
import { usePolicy } from '../policyHooks.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { PolicyState } from '../types.js';
import { Fetched, Notice } from '../ui.js';

// The Steps and ladder settings: what the hub suggests, and the lengths moderators pick from. The owner edits a local draft, sees
// what it would suggest (a preview, 400 ms after the last edit), and saves it with a reason. The server is the judge: a refusal points
// at its field. Nothing is read on a timer: the settings are read when the screen opens and again after a save or a reset (each read
// is one audit row). The flows (preview, save, reset) are hooks in `../policy/`; this file puts them together.

export { PREVIEW_DELAY_MS } from '../policy/usePreview.js';

/** Puts keyboard focus on the field with this key (a custom length's number box when it has one). */
function focusField(root: HTMLElement | null, key: string): void {
  (root?.querySelector<HTMLElement>(`[data-field="${key}-number"]`) ?? root?.querySelector<HTMLElement>(`[data-field="${key}"]`))?.focus();
}

/** The first of these fields on the page, in reading order. */
function firstField(root: HTMLElement | null, keys: readonly string[]): string | null {
  const found = keys
    .map((k) => ({ k, el: root?.querySelector<HTMLElement>(`[data-field="${k}-number"]`) ?? root?.querySelector<HTMLElement>(`[data-field="${k}"]`) ?? null }))
    .filter((x): x is { k: string; el: HTMLElement } => x.el !== null);
  found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return found[0]?.k ?? null;
}

function Editor({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const { t, session } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;

  const [draft, setDraftState] = useState<PolicyDraft>(() => draftOf(state.effective));
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const setDraft = (update: (d: PolicyDraft) => PolicyDraft): void => {
    setDraftState(update);
    // An edit answers a refusal: the mark comes off.
    setServerProblems({});
  };

  // After a save or a reset the screen is given the new state: the draft is made from it (all of it after a save; only the sections
  // that were reset after a reset, so edits elsewhere are kept). A state that arrives for another reason leaves the draft alone.
  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(draftOf(next.effective)),
    sections: (sections, next) => setDraftState((d) => sections.reduce((acc, sec) => setSection(acc, sec, next.effective), d)),
  });

  // The Community Rules, for the rule pickers: read once through the hub's session (it is audited as one `policy.view`).
  const rulesRead = useHubData('settings:rules', () => session.policy());
  const rules = rulesRead.data?.rules ?? [];

  // What this screen sends is its own sections plus whatever another screen saved (a save replaces the whole layer).
  const built = useMemo(() => {
    const r = layerOf(draft, state.base, state.effective);
    return r.ok ? { ...r, layer: { ...otherSections(state.layer), ...r.layer } } : r;
  }, [draft, state]);
  const dirty = useMemo(() => dirtySections(draft, state.effective), [draft, state]);
  const isDirty = dirty.length > 0;
  const problems: Problems = { ...(built.ok ? {} : built.problems), ...serverProblems };

  const [rule, setRule] = useState<number | null>(null);
  const preview = usePreview(built.ok ? built.layer : null, rule, policy.preview);

  const save = useSaveFlow({
    policy,
    layer: built.ok ? built.layer : null,
    dirty: isDirty,
    editable,
    pending,
    onBlocked: () => {
      const key = firstField(root.current, Object.keys(built.ok ? {} : built.problems));
      if (key !== null) focusField(root.current, key);
    },
    onSaved: () => {
      setServerProblems({});
      toasts.push({ text: t('hub.settings.saved') });
    },
    onRefused: (key) => {
      setServerProblems({ [key]: { key: 'hub.settings.field.refused' } });
      queueMicrotask(() => focusField(root.current, key));
    },
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && fieldKeyOf(save.saveError.path ?? '') !== null;

  const discard = (): void => {
    setDraftState(draftOf(state.effective));
    setServerProblems({});
    save.close();
  };
  const reload = (): void => {
    pending.current = 'all';
    setServerProblems({});
    save.close();
    policy.reload();
  };

  const resetFocus = (key: ResetKey): void =>
    queueMicrotask(() => {
      if (root.current !== null) byId(rootOf(root.current), `${base}-reset-${key}`)?.focus();
    });
  const reset = useResetFlow({
    policy,
    state,
    editable,
    pending,
    onClosed: resetFocus,
    onDone: (key) => {
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS[key].done) }) });
      resetFocus(key);
    },
  });
  const resetButton = (key: ResetKey): ReactNode =>
    editable ? (
      <button type="button" id={`${base}-reset-${key}`} className="cw-btn" aria-disabled={!reset.canReset(key)} aria-expanded={reset.confirming === key} onClick={() => reset.open(key)}>
        {t('hub.settings.reset.button', { what: t(RESETS[key].what) })}
      </button>
    ) : null;
  const confirmFor = (key: ResetKey): ReactNode =>
    reset.confirming === key ? (
      <ResetConfirm what={t(RESETS[key].what)} busy={policy.busy} error={reset.error} loses={key === 'all' && isDirty} onConfirm={(why) => void reset.run(key, why)} onCancel={() => reset.close(key)} />
    ) : null;

  const leaveDialog = useUnsavedGuard(isDirty);

  const part = (key: ResetKey, panel: ReactNode): ReactNode => (
    <div className="cw-settings-part">
      {panel}
      {confirmFor(key)}
    </div>
  );
  const common = { draft, set: setDraft, problems };
  const titles = state.effective.guidelines.map((g) => g.title);

  return (
    <div ref={root} className="cw-settings">
      {state.layerError !== undefined && <Notice tone="warn">{t('hub.settings.layerError')}</Notice>}
      {!state.canSave ? <Notice role="status">{t('hub.settings.unsupported')}</Notice> : !editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
      {editable && <div className="cw-settings-all">{resetButton('all')}</div>}
      {confirmFor('all')}
      <fieldset className="cw-settings-body" disabled={!editable}>
        <legend className="cw-sr">{t('hub.settings.body')}</legend>
        {part('lengths', <LengthsPanel {...common} reset={resetButton('lengths')} />)}
        {part('ladder', <LadderPanel {...common} reset={resetButton('ladder')} />)}
        {part('first', <FirstPanel {...common} reset={resetButton('first')} />)}
        {part('repeat', <RepeatPanel {...common} reset={resetButton('repeat')} />)}
        {part('rules', <RulesPanel {...common} rules={rules} reset={resetButton('rules')} />)}
        {part('guidelines', <GuidelinesPanel {...common} titles={titles} reset={resetButton('guidelines')} />)}
      </fieldset>
      <Preview state={preview} rules={rules} rule={rule} onRule={setRule} />

      {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={dirty.length} refusedField={refusedField} idBase={base} onDiscard={discard} onReload={reload} />}

      {leaveDialog}
    </div>
  );
}

/** The Steps and ladder screen: the settings of the profile, edited in the page. */
export function LadderSettingsScreen() {
  const { t } = useHub();
  const policy = usePolicy();
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.settings.ladder.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.settings.ladder.intro')}</p>
      <Fetched state={{ data: policy.data, error: policy.error, loading: policy.loading, reload: policy.reload }} what={t('hub.state.what.settings')}>
        {(state) => <Editor state={state} policy={policy} />}
      </Fetched>
    </div>
  );
}
