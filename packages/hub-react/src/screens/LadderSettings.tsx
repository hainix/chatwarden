import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Field } from '../case/ActionEditor.js';
import { useHub } from '../context.js';
import type { HubText } from '../i18n.js';
import { Dialog } from '../Dialog.js';
import { REASON_MAX } from '../decision.js';
import type { Problem } from '../decision.js';
import { useLeaveGuard } from '../leaveGuard.js';
import { useHubData } from '../hooks.js';
import type { HubError } from '../client.js';
import { errorText } from '../labels.js';
import { FirstPanel, GuidelinesPanel, LadderPanel, LengthsPanel, RepeatPanel, RulesPanel } from '../policy/panels.js';
import type { Problems } from '../policy/panels.js';
import { Preview } from '../policy/Preview.js';
import type { PreviewState } from '../policy/Preview.js';
import { SECTION_ORDER, dirtySections, draftOf, fieldKeyOf, layerOf, otherSections, setSection } from '../policy/model.js';
import type { PolicyDraft } from '../policy/model.js';
import { usePolicy } from '../policyHooks.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { PolicySection, PolicyState } from '../types.js';
import { Fetched, Notice } from '../ui.js';

// The Steps and ladder settings: what the hub suggests, and the lengths moderators pick from. The owner edits a local draft, sees
// what it would suggest (a preview, 400 ms after the last edit), and saves it with a reason. The kit is the judge: a refusal points
// at its field. Nothing is read on a timer: the settings are read when the screen opens and again after a save or a reset (each read
// is one audit row).

/** How long after the last edit the preview is asked for. */
export const PREVIEW_DELAY_MS = 400;

type ResetKey = 'lengths' | 'ladder' | 'first' | 'repeat' | 'rules' | 'guidelines' | 'all';
const RESETS: Record<ResetKey, { sections: readonly PolicySection[]; what: HubText; done: HubText }> = {
  lengths: { sections: ['durations', 'customDuration'], what: 'hub.settings.lengths.what', done: 'hub.settings.lengths.done' },
  ladder: { sections: ['ladder'], what: 'hub.settings.ladder.what', done: 'hub.settings.ladder.done' },
  first: { sections: ['firstOffense'], what: 'hub.settings.first.what', done: 'hub.settings.first.done' },
  repeat: { sections: ['repeat'], what: 'hub.settings.repeat.what', done: 'hub.settings.repeat.done' },
  rules: { sections: ['areaRules', 'severeRules'], what: 'hub.settings.rules.what', done: 'hub.settings.rules.done' },
  guidelines: { sections: ['guidelines'], what: 'hub.settings.guidelines.what', done: 'hub.settings.guidelines.done' },
  all: { sections: SECTION_ORDER, what: 'hub.settings.reset.all', done: 'hub.settings.reset.all.done' },
};

const sameOrder = (a: Problems, b: Problems): Problems => ({ ...a, ...b });

/** Puts keyboard focus on the field with this key (a custom length's number box when it has one). Returns whether it found one. */
function focusField(root: HTMLElement | null, key: string): boolean {
  const el = root?.querySelector<HTMLElement>(`[data-field="${key}-number"]`) ?? root?.querySelector<HTMLElement>(`[data-field="${key}"]`) ?? null;
  el?.focus();
  return el !== null;
}

/** The first of these fields on the page, in reading order. */
function firstField(root: HTMLElement | null, keys: readonly string[]): string | null {
  const found = keys
    .map((k) => ({ k, el: root?.querySelector<HTMLElement>(`[data-field="${k}-number"]`) ?? root?.querySelector<HTMLElement>(`[data-field="${k}"]`) ?? null }))
    .filter((x): x is { k: string; el: HTMLElement } => x.el !== null);
  found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return found[0]?.k ?? null;
}

/** The in-page confirm of a reset: what it does, why (the audit trail keeps it), and a way out. */
function ResetConfirm({ what, busy, error, onConfirm, onCancel }: { what: string; busy: boolean; error: HubError | null; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const { t } = useHub();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => box.current?.focus(), []);
  const trimmed = reason.trim();
  const problem: Problem | undefined = trimmed === '' ? { key: 'hub.settings.reset.reason.required' } : trimmed.length > REASON_MAX ? { key: 'hub.decide.error.reasonLong', params: { max: REASON_MAX } } : undefined;
  return (
    <div className="cw-confirm cw-panel-pad" role="group" aria-label={t('hub.settings.reset.title', { what })}>
      <p>
        <strong>{t('hub.settings.reset.title', { what })}</strong> {t('hub.settings.reset.body')}
      </p>
      <Field id={`${id}-reason`} label={t('hub.settings.reset.reason')} counter={t('hub.decide.counter', { count: trimmed.length, max: REASON_MAX })} problem={attempted ? problem : undefined}>
        {(a) => <textarea {...a} ref={box} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      {error !== null && (
        <p className="cw-field-error" role="alert">
          {errorText(t, error)}
        </p>
      )}
      <div className="cw-action-foot">
        <button
          type="button"
          className="cw-btn cw-btn--danger"
          aria-disabled={busy}
          aria-busy={busy}
          onClick={() => {
            setAttempted(true);
            if (problem !== undefined) box.current?.focus();
            else onConfirm(trimmed);
          }}
        >
          {t('hub.settings.reset.confirm')}
        </button>
        <button type="button" className="cw-btn" onClick={onCancel}>
          {t('hub.settings.reset.keep')}
        </button>
      </div>
    </div>
  );
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
  const pending = useRef<'all' | readonly PolicySection[] | null>(null);
  const seen = useRef(state);
  useEffect(() => {
    if (seen.current === state) return;
    seen.current = state;
    const p = pending.current;
    pending.current = null;
    if (p === 'all') setDraftState(draftOf(state.effective));
    else if (p !== null) setDraftState((d) => p.reduce((acc, s) => setSection(acc, s, state.effective), d));
  }, [state]);

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
  const problems: Problems = sameOrder(built.ok ? {} : built.problems, serverProblems);

  // ---- The preview ----
  const [rule, setRule] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ samples: null, note: null });
  const previewRef = useRef(policy.preview);
  previewRef.current = policy.preview;
  const layerKey = built.ok ? JSON.stringify(built.layer) : null;
  const first = useRef(true);
  useEffect(() => {
    if (!built.ok) {
      setPreview((p) => ({ ...p, note: 'blocked' }));
      return undefined;
    }
    let live = true;
    const run = (): void => {
      void previewRef.current(built.layer, rule ?? undefined).then((res) => {
        if (!live) return;
        setPreview(res.ok ? { samples: res.value, note: null } : (p) => ({ ...p, note: 'failed' }));
      });
    };
    // The first preview is asked for at once; after an edit, 400 ms after the last one.
    if (first.current) {
      first.current = false;
      run();
      return () => {
        live = false;
      };
    }
    const timer = setTimeout(run, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The draft's layer and the rule are what the preview is of.
  }, [layerKey, rule]);

  // ---- Saving ----
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonShown, setReasonShown] = useState(false);
  const [saveError, setSaveError] = useState<HubError | null>(null);
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const reasonId = `${base}-reason`;
  const trimmed = reason.trim();
  const reasonProblem: Problem | undefined = trimmed === '' ? { key: 'hub.settings.save.reason.required' } : trimmed.length > REASON_MAX ? { key: 'hub.decide.error.reasonLong', params: { max: REASON_MAX } } : undefined;

  const startSave = (): void => {
    if (!isDirty) return;
    if (!built.ok) {
      const key = firstField(root.current, Object.keys(built.problems));
      if (key !== null) focusField(root.current, key);
      return;
    }
    setSaveError(null);
    setAsking(true);
    queueMicrotask(() => reasonBox.current?.focus());
  };
  const submitSave = async (): Promise<void> => {
    if (!built.ok || policy.busy) return;
    setReasonShown(true);
    if (reasonProblem !== undefined) {
      reasonBox.current?.focus();
      return;
    }
    pending.current = 'all';
    const res = await policy.save(built.layer, trimmed);
    if (res.ok) {
      setAsking(false);
      setReason('');
      setReasonShown(false);
      setSaveError(null);
      setServerProblems({});
      toasts.push({ text: t('hub.settings.saved') });
      return;
    }
    pending.current = null;
    setSaveError(res.error);
    if (res.error.code === 'invalid_profile') {
      // The kit refused a setting: the form closes (the reason is kept) and keyboard focus goes to the field it named.
      const key = fieldKeyOf(res.error.path ?? '');
      setAsking(false);
      if (key !== null) {
        setServerProblems({ [key]: { key: 'hub.settings.field.refused' } });
        queueMicrotask(() => focusField(root.current, key));
      }
    } else if (res.error.code === 'conflict') setAsking(false);
  };
  const discard = (): void => {
    setDraftState(draftOf(state.effective));
    setServerProblems({});
    setAsking(false);
    setSaveError(null);
  };
  const reload = (): void => {
    pending.current = 'all';
    setAsking(false);
    setSaveError(null);
    setServerProblems({});
    policy.reload();
  };

  // ---- Resetting ----
  const [confirming, setConfirming] = useState<ResetKey | null>(null);
  const [resetError, setResetError] = useState<HubError | null>(null);
  const savedSections = Object.keys(state.layer) as PolicySection[];
  const sectionsOf = (key: ResetKey): PolicySection[] => RESETS[key].sections.filter((s) => savedSections.includes(s));
  const canReset = (key: ResetKey): boolean => sectionsOf(key).length > 0 || (key === 'all' && state.layerError !== undefined);
  const resetButton = (key: ResetKey): ReactNode =>
    editable ? (
      <button
        type="button"
        id={`${base}-reset-${key}`}
        className="cw-btn"
        aria-disabled={!canReset(key)}
        aria-expanded={confirming === key}
        onClick={() => {
          if (!canReset(key)) return;
          setResetError(null);
          setConfirming(key);
        }}
      >
        {t('hub.settings.reset.button', { what: t(RESETS[key].what) })}
      </button>
    ) : null;
  const closeConfirm = (key: ResetKey): void => {
    setConfirming(null);
    setResetError(null);
    queueMicrotask(() => document.getElementById(`${base}-reset-${key}`)?.focus());
  };
  const doReset = async (key: ResetKey, why: string): Promise<void> => {
    const sections = key === 'all' ? undefined : sectionsOf(key);
    pending.current = sections ?? 'all';
    const res = await policy.reset(sections, why);
    if (!res.ok) {
      pending.current = null;
      setResetError(res.error);
      return;
    }
    setConfirming(null);
    setResetError(null);
    toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS[key].done) }) });
    queueMicrotask(() => document.getElementById(`${base}-reset-${key}`)?.focus());
  };
  const resetSlot = resetButton;
  const confirmFor = (key: ResetKey): ReactNode =>
    confirming === key ? (
      <ResetConfirm what={t(RESETS[key].what)} busy={policy.busy} error={resetError} onConfirm={(why) => void doReset(key, why)} onCancel={() => closeConfirm(key)} />
    ) : null;

  // ---- Leaving with unsaved edits ----
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const dirtyNow = useRef(isDirty);
  dirtyNow.current = isDirty;
  useLeaveGuard((proceed) => {
    if (!dirtyNow.current) return false;
    setLeaving(() => proceed);
    return true;
  });
  useEffect(() => {
    if (!isDirty) return undefined;
    // Closing the tab: the browser asks, in its own words.
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const body = (key: ResetKey, panel: ReactNode): ReactNode => (
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
      {!state.canSave ? (
        <Notice role="status">{t('hub.settings.unsupported')}</Notice>
      ) : (
        !editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>
      )}
      {editable && (
        <div className="cw-settings-all">
          {resetButton('all')}
        </div>
      )}
      {confirmFor('all')}
      <fieldset className="cw-settings-body" disabled={!editable}>
        <legend className="cw-sr">{t('hub.settings.body')}</legend>
        {body('lengths', <LengthsPanel {...common} reset={resetSlot('lengths')} />)}
        {body('ladder', <LadderPanel {...common} reset={resetSlot('ladder')} />)}
        {body('first', <FirstPanel {...common} reset={resetSlot('first')} />)}
        {body('repeat', <RepeatPanel {...common} reset={resetSlot('repeat')} />)}
        {body('rules', <RulesPanel {...common} rules={rules} reset={resetSlot('rules')} />)}
        {body('guidelines', <GuidelinesPanel {...common} titles={titles} reset={resetSlot('guidelines')} />)}
      </fieldset>
      <Preview state={preview} rules={rules} rule={rule} onRule={setRule} />

      {editable && (
        <section className="cw-savebar" aria-label={t('hub.settings.save.form')}>
          {saveError !== null && saveError.code === 'conflict' && (
            <div className="cw-error" role="alert">
              <p>
                <strong>{t('hub.settings.error.conflict')}</strong> {t('hub.settings.error.conflict.body')}
              </p>
              <button type="button" className="cw-btn" onClick={reload}>
                {t('hub.settings.error.reload')}
              </button>
            </div>
          )}
          {saveError !== null && saveError.code === 'invalid_profile' && (
            <div className="cw-error" role="alert">
              <p>
                <strong>{t('hub.settings.error.invalid')}</strong> {t('hub.settings.error.invalid.body')}
              </p>
            </div>
          )}
          {saveError !== null && saveError.code !== 'conflict' && saveError.code !== 'invalid_profile' && (
            <div className="cw-error" role="alert">
              <p>{saveError.code === 'not_supported' ? t('hub.settings.error.unsupported') : errorText(t, saveError)}</p>
              {(saveError.code === 'network' || saveError.status >= 500 || saveError.status === 429) && asking && (
                <button type="button" className="cw-btn" onClick={() => void submitSave()}>
                  {t('hub.state.retry')}
                </button>
              )}
            </div>
          )}
          {asking ? (
            <form
              className="cw-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void submitSave();
              }}
            >
              <Field id={reasonId} label={t('hub.settings.save.reason')} hint={t('hub.settings.save.reason.hint')} counter={t('hub.decide.counter', { count: trimmed.length, max: REASON_MAX })} problem={reasonShown ? reasonProblem : undefined}>
                {(a) => <textarea {...a} ref={reasonBox} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
              <div className="cw-action-foot">
                <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={policy.busy} aria-busy={policy.busy}>
                  {t('hub.settings.save')}
                </button>
                <button type="button" className="cw-btn" onClick={() => setAsking(false)}>
                  {t('hub.settings.save.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <div className="cw-action-foot">
              <button type="button" className="cw-btn cw-btn--primary" aria-disabled={!isDirty} onClick={startSave}>
                {t('hub.settings.save')}
              </button>
              <button type="button" className="cw-btn" aria-disabled={!isDirty} onClick={() => isDirty && discard()}>
                {t('hub.settings.discard')}
              </button>
              <p className="cw-hint" role="status">
                {isDirty ? t('hub.settings.dirty', { count: dirty.length }) : t('hub.settings.clean')}
              </p>
            </div>
          )}
        </section>
      )}

      {leaving !== null && (
        <Dialog label={t('hub.settings.leave.title')} onClose={() => setLeaving(null)}>
          <h2>{t('hub.settings.leave.title')}</h2>
          <p>{t('hub.settings.leave.body')}</p>
          <div className="cw-action-foot">
            <button type="button" className="cw-btn cw-btn--primary" onClick={() => setLeaving(null)}>
              {t('hub.settings.leave.stay')}
            </button>
            <button
              type="button"
              className="cw-btn"
              onClick={() => {
                const go = leaving;
                setLeaving(null);
                go();
              }}
            >
              {t('hub.settings.leave.go')}
            </button>
          </div>
        </Dialog>
      )}
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
