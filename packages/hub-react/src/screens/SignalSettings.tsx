import { BUILTIN_SIGNAL_KINDS } from '@chatwarden/core';
import { useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { byId, rootOf } from '../dom.js';
import { useHubData } from '../hooks.js';
import type { HubText } from '../i18n.js';
import { ResetConfirm } from '../policy/ResetConfirm.js';
import { SaveBar } from '../policy/SaveBar.js';
import { declaredKinds, nextRuleId, signalsDirty, signalsDraftOf, signalsFeeds, signalsFieldKey, signalsProblems, RULES_MAX } from '../policy/signals.js';
import type { Effect, QueueDraft, RuleDraft, SignalsDraft, WindowDraft } from '../policy/signals.js';
import { RESETS, useResetFlow } from '../policy/useResetFlow.js';
import { useDraftSync } from '../policy/useDraftSync.js';
import { useSaveFlow } from '../policy/useSaveFlow.js';
import { useUnsavedGuard } from '../policy/useUnsavedGuard.js';
import type { Problems } from '../policy/panels.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { AiStatusView, PolicyLayer, PolicyState } from '../types.js';
import { Notice, Panel } from '../ui.js';

// Settings > Advanced > "Signals": the kinds the game declared (read only) and four small forms, each off until switched on: show on a person's record, put
// these people sooner in the queue, add to the suggested step, give the AI read as background. The same save machinery as every settings screen. Polarity is
// in words ("counts against", "counts for"), never colour. A signal never acts on its own.

const focusField = (root: HTMLElement | null, key: string): void => root?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus();

/** The layer that was saved, without the signals section: what this panel sends is its own section plus whatever another screen saved. */
const withoutSignals = (layer: PolicyLayer): PolicyLayer => {
  const { signals: _own, ...rest } = layer;
  void _own;
  return rest;
};

type Kinds = Array<[string, { label: string; polarity: 'negative' | 'positive'; weight: number }]>;

function FieldError({ id, problems, field }: { id: string; problems: Problems; field: string }) {
  const { t } = useHub();
  const p = problems[field];
  return p === undefined ? null : (
    <p id={id} className="cw-field-error">
      {t(p.key, p.params)}
    </p>
  );
}

/** One kind's polarity as words. */
const polarityText = (polarity: 'negative' | 'positive'): HubText => (polarity === 'negative' ? 'hub.person.signals.negative' : 'hub.person.signals.positive');

function KindChoices({ field, kinds, chosen, negativeOnly, disabled, problems, onChange }: { field: string; kinds: Kinds; chosen: readonly string[]; negativeOnly: boolean; disabled: boolean; problems: Problems; onChange: (next: string[]) => void }) {
  const { t } = useHub();
  const id = useId();
  // A kind already chosen stays in the list even when it no longer fits, so the owner can untick it.
  const shown = kinds.filter(([k, v]) => !negativeOnly || v.polarity === 'negative' || chosen.includes(k));
  const problem = problems[field];
  return (
    <fieldset className="cw-flowopts cw-signal-kinds" data-field={field} tabIndex={-1} disabled={disabled} {...(problem === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${id}-err` })}>
      <legend>{t('hub.settings.signals.kinds')}</legend>
      {shown.map(([k, v]) => (
        <label key={k} className="cw-choice">
          <input type="checkbox" checked={chosen.includes(k)} onChange={(e) => onChange(e.target.checked ? [...chosen, k] : chosen.filter((x) => x !== k))} />
          <span>{v.label}</span>
        </label>
      ))}
      <FieldError id={`${id}-err`} problems={problems} field={field} />
    </fieldset>
  );
}

function NumberField({ field, label, value, disabled, problems, onChange }: { field: string; label: string; value: string; disabled: boolean; problems: Problems; onChange: (v: string) => void }) {
  const id = useId();
  const problem = problems[field];
  return (
    <div className="cw-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" inputMode="numeric" min="1" step="1" data-field={field} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...(problem === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${id}-err` })} />
      <FieldError id={`${id}-err`} problems={problems} field={field} />
    </div>
  );
}

/** A form: a switch with the form's own words, and what it takes when it is on. */
function FormBox({ title, hint, on, disabled, onToggle, children }: { title: string; hint: string; on: boolean; disabled: boolean; onToggle: (on: boolean) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="cw-signal-form" role="group" aria-label={title}>
      <label className="cw-choice cw-flowopt">
        <input type="checkbox" checked={on} disabled={disabled} aria-labelledby={`${id}-t`} aria-describedby={`${id}-h`} onChange={(e) => onToggle(e.target.checked)} />
        <span>
          <strong id={`${id}-t`}>{title}</strong>
          <span id={`${id}-h`} className="cw-hint cw-flowopt-line">
            {hint}
          </span>
        </span>
      </label>
      <div className="cw-signal-fields">{children}</div>
    </div>
  );
}

/** The record and AI forms: which kinds (all, or some) and how many days. */
function WindowForm({ name, draft, set, kinds, disabled, problems, title, hint }: { name: 'record' | 'ai'; draft: WindowDraft; set: (patch: Partial<WindowDraft>) => void; kinds: Kinds; disabled: boolean; problems: Problems; title: string; hint: string }) {
  const { t } = useHub();
  return (
    <FormBox title={title} hint={hint} on={draft.on} disabled={disabled} onToggle={(on) => set({ on })}>
      <label className="cw-choice">
        <input type="checkbox" checked={draft.all} disabled={disabled || !draft.on} onChange={(e) => set({ all: e.target.checked })} />
        <span>{t('hub.settings.signals.allKinds')}</span>
      </label>
      {!draft.all && <KindChoices field={`${name}.kinds`} kinds={kinds} chosen={draft.kinds} negativeOnly={false} disabled={disabled || !draft.on} problems={problems} onChange={(k) => set({ kinds: k })} />}
      <NumberField field={`${name}.days`} label={t('hub.settings.signals.days')} value={draft.days} disabled={disabled || !draft.on} problems={problems} onChange={(days) => set({ days })} />
    </FormBox>
  );
}

function QueueForm({ draft, set, kinds, disabled, problems }: { draft: QueueDraft; set: (patch: Partial<QueueDraft>) => void; kinds: Kinds; disabled: boolean; problems: Problems }) {
  const { t } = useHub();
  return (
    <FormBox title={t('hub.settings.signals.queue')} hint={t('hub.settings.signals.queue.hint')} on={draft.on} disabled={disabled} onToggle={(on) => set({ on })}>
      <KindChoices field="queue.kinds" kinds={kinds} chosen={draft.kinds} negativeOnly disabled={disabled || !draft.on} problems={problems} onChange={(k) => set({ kinds: k })} />
      <NumberField field="queue.players" label={t('hub.settings.signals.players')} value={draft.players} disabled={disabled || !draft.on} problems={problems} onChange={(players) => set({ players })} />
      <NumberField field="queue.days" label={t('hub.settings.signals.days')} value={draft.days} disabled={disabled || !draft.on} problems={problems} onChange={(days) => set({ days })} />
    </FormBox>
  );
}

function LadderForm({ draft, setAll, kinds, disabled, problems }: { draft: SignalsDraft; setAll: (update: (d: SignalsDraft) => SignalsDraft) => void; kinds: Kinds; disabled: boolean; problems: Problems }) {
  const { t } = useHub();
  const off = disabled || !draft.ladderOn;
  const patch = (i: number, p: Partial<RuleDraft>): void => setAll((d) => ({ ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...p } : r)) }));
  const addRule = (d: SignalsDraft): SignalsDraft => ({ ...d, rules: [...d.rules, { id: nextRuleId(d.rules), effect: 'note', kinds: [], players: '', days: '' }] });
  return (
    <FormBox
      title={t('hub.settings.signals.ladder')}
      hint={t('hub.settings.signals.ladder.hint')}
      on={draft.ladderOn}
      disabled={disabled}
      onToggle={(on) => setAll((d) => (on && d.rules.length === 0 ? { ...addRule(d), ladderOn: true } : { ...d, ladderOn: on }))}
    >
      {draft.rules.map((r, i) => (
        <div key={r.id} className="cw-signal-rule" role="group" aria-label={t('hub.settings.signals.rule', { n: i + 1 })}>
          <KindChoices field={`ladder.${i}.kinds`} kinds={kinds} chosen={r.kinds} negativeOnly={r.effect === 'raise'} disabled={off} problems={problems} onChange={(k) => patch(i, { kinds: k })} />
          <NumberField field={`ladder.${i}.players`} label={t('hub.settings.signals.players')} value={r.players} disabled={off} problems={problems} onChange={(players) => patch(i, { players })} />
          <NumberField field={`ladder.${i}.days`} label={t('hub.settings.signals.days')} value={r.days} disabled={off} problems={problems} onChange={(days) => patch(i, { days })} />
          <RuleEffect index={i} value={r.effect} disabled={off} onChange={(effect) => patch(i, { effect })} />
          <button type="button" className="cw-btn" disabled={off} onClick={() => setAll((d) => ({ ...d, rules: d.rules.filter((_, j) => j !== i) }))}>
            {t('hub.settings.signals.rule.remove')}
          </button>
        </div>
      ))}
      <button type="button" className="cw-btn" disabled={off || draft.rules.length >= RULES_MAX} onClick={() => setAll(addRule)}>
        {t('hub.settings.signals.rule.add')}
      </button>
    </FormBox>
  );
}

function RuleEffect({ index, value, disabled, onChange }: { index: number; value: Effect; disabled: boolean; onChange: (e: Effect) => void }) {
  const { t } = useHub();
  const id = useId();
  return (
    <div className="cw-field">
      <label htmlFor={`${id}-${index}`}>{t('hub.settings.signals.effect')}</label>
      <select id={`${id}-${index}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value === 'raise' ? 'raise' : 'note')}>
        <option value="note">{t('hub.settings.signals.effect.note')}</option>
        <option value="raise">{t('hub.settings.signals.effect.raise')}</option>
      </select>
    </div>
  );
}

const FEED_WORDS: Record<string, HubText> = {
  record: 'hub.settings.signals.record',
  queue: 'hub.settings.signals.queue',
  ladder: 'hub.settings.signals.ladder',
  ai: 'hub.settings.signals.ai',
};
const REASON_WORDS: Record<string, HubText> = {
  unknown_kind: 'hub.settings.signals.dropped.unknown_kind',
  positive_kind: 'hub.settings.signals.dropped.positive_kind',
  window: 'hub.settings.signals.dropped.window',
  invalid: 'hub.settings.signals.dropped.invalid',
  unknown_feed: 'hub.settings.signals.dropped.unknown_feed',
};

/** What the kit left out of the saved settings, and why, in words. Feed names and reason codes only; never a kind or a rule. */
function Dropped({ dropped }: { dropped: NonNullable<PolicyState['dropped']> }) {
  const { t } = useHub();
  return (
    <div className="cw-notice cw-signal-dropped" role="status" aria-label={t('hub.settings.signals.dropped.label')}>
      <p>{t('hub.settings.signals.dropped')}</p>
      <ul>
        {dropped.map((d, i) => (
          <li key={`${d.feed}-${i}`}>
            {t('hub.settings.signals.dropped.item', { feed: t(FEED_WORDS[d.feed] ?? 'hub.settings.signals.dropped.feed'), why: t(REASON_WORDS[d.reason] ?? 'hub.settings.signals.dropped.invalid') })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The panel. `state` and `policy` come from the Advanced screen, which reads the policy once for all its panels. */
export function SignalSettings({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const { t, client } = useHub();
  const toasts = useToasts();
  const root = useRef<HTMLDivElement>(null);
  const base = useId();
  const editable = policy.canEdit;
  // The AI form is offered only when the AI is available on this server (the status says so; an older server has no such route).
  const aiStatus = useHubData<AiStatusView | null>('ai:status', () => client.aiStatus());
  const aiAvailable = aiStatus.data?.available === true;
  const kindList = useMemo((): Kinds => declaredKinds(state.effective.signals?.kinds, BUILTIN_SIGNAL_KINDS) as Kinds, [state.effective]);
  const allKinds = kindList;
  const kindMap = useMemo(() => Object.fromEntries(kindList), [kindList]);
  const [draft, setDraftState] = useState<SignalsDraft>(() => signalsDraftOf(state.effective.signals?.feeds));
  const [serverProblems, setServerProblems] = useState<Problems>({});
  const setAll = (update: (d: SignalsDraft) => SignalsDraft): void => {
    setDraftState(update);
    setServerProblems({});
  };

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(signalsDraftOf(next.effective.signals?.feeds)),
    sections: (sections, next) => {
      if (sections.includes('signals')) setDraftState(signalsDraftOf(next.effective.signals?.feeds));
    },
  });

  const local = useMemo(() => signalsProblems(draft, kindMap), [draft, kindMap]);
  const problems: Problems = { ...local, ...serverProblems };
  const layer = useMemo((): PolicyLayer | null => (Object.keys(local).length > 0 ? null : { ...withoutSignals(state.layer), signals: { feeds: signalsFeeds(draft) } }), [draft, local, state.layer]);
  const isDirty = useMemo(() => signalsDirty(draft, state.effective.signals?.feeds), [draft, state.effective]);

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: signalsFieldKey,
    onBlocked: () => {
      const first = [...(root.current?.querySelectorAll<HTMLElement>('[data-field]') ?? [])].find((el) => local[el.dataset['field'] ?? ''] !== undefined);
      first?.focus();
    },
    onSaved: () => {
      setServerProblems({});
      toasts.push({ text: t('hub.settings.signals.saved') });
    },
    onRefused: (key) => {
      setServerProblems({ [key]: { key: 'hub.settings.field.refused' } });
      queueMicrotask(() => focusField(root.current, key));
    },
  });
  const refusedField = save.saveError?.code === 'invalid_profile' && signalsFieldKey(save.saveError.path ?? '') !== null;

  const discard = (): void => {
    setDraftState(signalsDraftOf(state.effective.signals?.feeds));
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
      toasts.push({ text: t('hub.settings.reset.done', { done: t(RESETS.signals.done) }) });
      resetFocus();
    },
  });
  const guard = useUnsavedGuard(isDirty);
  const off = !editable;

  return (
    <div ref={root} className="cw-settings cw-signals-panel">
      <Panel title={t('hub.settings.signals.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.settings.signals.intro')}</p>
          {state.dropped !== undefined && state.dropped.length > 0 && <Dropped dropped={state.dropped} />}
          {!state.canSave ? <Notice role="status">{t('hub.settings.signals.unsupported')}</Notice> : !editable && allKinds.length > 0 && <Notice role="status">{t('hub.settings.readOnly')}</Notice>}
          {allKinds.length === 0 ? (
            <p className="cw-hint">{t('hub.settings.signals.none')}</p>
          ) : (
            <>
              <h3>{t('hub.settings.signals.kinds.title')}</h3>
              <p className="cw-hint">{t('hub.settings.signals.kinds.hint')}</p>
              <ul className="cw-recs" aria-label={t('hub.settings.signals.kinds.list')}>
                {allKinds.map(([id, k]) => (
                  <li key={id} className="cw-rec cw-signal-kind">
                    <p>
                      <strong>{k.label}</strong> <span className="cw-hint">{t(polarityText(k.polarity))}, {t('hub.settings.signals.weight', { weight: k.weight })}</span>
                    </p>
                  </li>
                ))}
              </ul>
              {editable && (
                <div className="cw-settings-all">
                  <button type="button" id={`${base}-reset`} className="cw-btn" aria-disabled={!reset.canReset('signals')} aria-expanded={reset.confirming === 'signals'} onClick={() => reset.open('signals')}>
                    {t('hub.settings.reset.button', { what: t(RESETS.signals.what) })}
                  </button>
                </div>
              )}
              {reset.confirming === 'signals' && <ResetConfirm what={t(RESETS.signals.what)} busy={policy.busy} error={reset.error} onConfirm={(why) => void reset.run('signals', why)} onCancel={() => reset.close('signals')} />}
              <h3>{t('hub.settings.signals.where')}</h3>
              <fieldset className="cw-settings-body" disabled={off}>
                <legend className="cw-sr">{t('hub.settings.signals.where')}</legend>
                <WindowForm name="record" draft={draft.record} set={(p) => setAll((d) => ({ ...d, record: { ...d.record, ...p } }))} kinds={kindList} disabled={off} problems={problems} title={t('hub.settings.signals.record')} hint={t('hub.settings.signals.record.hint')} />
                <QueueForm draft={draft.queue} set={(p) => setAll((d) => ({ ...d, queue: { ...d.queue, ...p } }))} kinds={kindList} disabled={off} problems={problems} />
                <LadderForm draft={draft} setAll={setAll} kinds={kindList} disabled={off} problems={problems} />
                {(aiAvailable || draft.ai.on) && (
                  <WindowForm name="ai" draft={draft.ai} set={(p) => setAll((d) => ({ ...d, ai: { ...d.ai, ...p } }))} kinds={kindList} disabled={off || !aiAvailable} problems={problems} title={t('hub.settings.signals.ai')} hint={t('hub.settings.signals.ai.hint')} />
                )}
              </fieldset>
              <p className="cw-hint">{t('hub.settings.signals.never')}</p>
            </>
          )}
          {editable && allKinds.length > 0 && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={refusedField} idBase={base} label={t('hub.settings.signals.save.form')} onDiscard={discard} onReload={reload} />}
        </div>
      </Panel>
      {guard}
    </div>
  );
}
