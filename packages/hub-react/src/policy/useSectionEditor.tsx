import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import type { HubText } from '../i18n.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { PolicyLayer, PolicySection, PolicyState } from '../types.js';
import { Notice, Panel } from '../ui.js';
import type { Problems } from './panels.js';
import { ResetConfirm } from './ResetConfirm.js';
import { SaveBar } from './SaveBar.js';
import { RESETS, useResetFlow } from './useResetFlow.js';
import type { ResetFlow, ResetKey } from './useResetFlow.js';
import { useDraftSync } from './useDraftSync.js';
import { useSaveFlow } from './useSaveFlow.js';
import type { SaveFlow } from './useSaveFlow.js';
import { useUnsavedGuard } from './useUnsavedGuard.js';

// What one Advanced panel that edits one section of the profile does, so the panels do not each carry the same two hundred lines: a local draft, the checks made before anything is
// sent, the layer a save carries (the whole saved layer with this section replaced, so another screen's sections are kept), the reason and conflict flows, a per-section reset, and
// the guard against leaving with unsaved changes. The Pace panel is the pattern; these panels (Safety, Desk) are its short form. A panel brings what is its own: the draft, its
// checks, the fields.

export interface SectionEditorConfig<D> {
  state: PolicyState;
  policy: UsePolicy;
  section: PolicySection;
  reset: ResetKey;
  /** The draft the settings in force make. */
  draftOf: (state: PolicyState) => D;
  /** What the kit would refuse in the draft, by field key. */
  problemsOf: (draft: D) => Problems;
  /** The section a save carries, or null for "none" (the section then goes back to the profile in code). */
  sectionOf: (draft: D, state: PolicyState) => unknown;
  dirtyOf: (draft: D, state: PolicyState) => boolean;
  /** The field a refusal's layer path names, or null. */
  fieldOf: (path: string, draft: D) => string | null;
  /** The first field with a problem, for the focus after a blocked save. */
  firstOf: (draft: D, problems: Problems) => string | null;
  saved: HubText;
}

export interface SectionEditor<D> {
  root: RefObject<HTMLDivElement | null>;
  base: string;
  draft: D;
  set: (update: (draft: D) => D) => void;
  problems: Problems;
  editable: boolean;
  isDirty: boolean;
  save: SaveFlow;
  refusedField: boolean;
  discard: () => void;
  reload: () => void;
  reset: ResetFlow;
  resetKey: ResetKey;
  guard: ReactNode;
  policy: UsePolicy;
  state: PolicyState;
}

const focusField = (root: HTMLElement | null, key: string): void => root?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus();

function withoutSection(layer: PolicyLayer, section: PolicySection): PolicyLayer {
  const copy: Record<string, unknown> = { ...layer };
  delete copy[section];
  return copy as PolicyLayer;
}

export function useSectionEditor<D>(cfg: SectionEditorConfig<D>): SectionEditor<D> {
  const { state, policy, section } = cfg;
  const { t } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;
  const [draft, setDraft] = useState<D>(() => cfg.draftOf(state));
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const set = (update: (d: D) => D): void => {
    setDraft(update);
    setServerProblems({});
  };

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraft(cfg.draftOf(next)),
    sections: (sections, next) => {
      if (sections.includes(section)) setDraft(cfg.draftOf(next));
    },
  });

  const local = useMemo(() => cfg.problemsOf(draft), [draft]);
  const problems: Problems = { ...local, ...serverProblems };
  const layer = useMemo((): PolicyLayer | null => {
    if (Object.keys(local).length > 0) return null;
    const value = cfg.sectionOf(draft, state);
    return { ...withoutSection(state.layer, section), ...(value === null ? {} : { [section]: value }) } as PolicyLayer;
  }, [draft, local, state]);
  const isDirty = useMemo(() => cfg.dirtyOf(draft, state), [draft, state]);

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: (path) => cfg.fieldOf(path, draft),
    onBlocked: () => {
      const key = cfg.firstOf(draft, local);
      if (key !== null) focusField(root.current, key);
    },
    onSaved: () => {
      setServerProblems({});
      toasts.push({ text: t(cfg.saved) });
    },
    onRefused: (key) => {
      setServerProblems({ [key]: { key: 'hub.settings.field.refused' } });
      queueMicrotask(() => focusField(root.current, key));
    },
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && cfg.fieldOf(save.saveError.path ?? '', draft) !== null;

  const discard = (): void => {
    setDraft(cfg.draftOf(state));
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
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS[cfg.reset].done) }) });
      resetFocus();
    },
  });
  const guard = useUnsavedGuard(isDirty);

  return { root, base, draft, set, problems, editable, isDirty, save, refusedField, discard, reload, reset, resetKey: cfg.reset, guard, policy, state };
}

/**
 * The frame every such panel shares: the titled panel, the intro, what the viewer may do (a read-only notice, or Reset), the fields (disabled for a reader) and the save bar.
 * With `disclosure` the body is behind one button, closed by default (a panel that most owners only need once).
 */
export function SectionShell<D>({
  editor,
  title,
  intro,
  saveLabel,
  disclosure,
  children,
}: {
  editor: SectionEditor<D>;
  title: string;
  intro: string;
  saveLabel: string;
  disclosure?: string;
  children: ReactNode;
}) {
  const { t } = useHub();
  const { policy, state, reset, resetKey } = editor;
  const [open, setOpen] = useState(disclosure === undefined);
  const bodyId = useId();
  const what = t(RESETS[resetKey].what);
  return (
    <div ref={editor.root} className="cw-settings">
      <Panel title={title}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{intro}</p>
          {disclosure !== undefined && (
            <button type="button" className="cw-btn cw-section-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
              {disclosure}
            </button>
          )}
          {open && (
            <div id={bodyId} className="cw-section-body">
              {!state.canSave ? <Notice role="status">{t('hub.settings.pace.unsupported')}</Notice> : !editor.editable && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
              {editor.editable && (
                <div className="cw-settings-all">
                  <button type="button" id={`${editor.base}-reset`} className="cw-btn" aria-disabled={!reset.canReset(resetKey)} aria-expanded={reset.confirming === resetKey} onClick={() => reset.open(resetKey)}>
                    {t('hub.settings.reset.button', { what })}
                  </button>
                </div>
              )}
              {reset.confirming === resetKey && <ResetConfirm what={what} busy={policy.busy} error={reset.error} onConfirm={(why) => void reset.run(resetKey, why)} onCancel={() => reset.close(resetKey)} />}
              <fieldset className="cw-settings-body" disabled={!editor.editable}>
                <legend className="cw-sr">{title}</legend>
                {children}
              </fieldset>
              {editor.editable && (
                <SaveBar policy={policy} save={editor.save} isDirty={editor.isDirty} dirtyCount={1} refusedField={editor.refusedField} idBase={editor.base} label={saveLabel} onDiscard={editor.discard} onReload={editor.reload} />
              )}
            </div>
          )}
        </div>
      </Panel>
      {editor.guard}
    </div>
  );
}
