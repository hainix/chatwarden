import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Field, RuleOptions } from '../case/ActionEditor.js';
import { actorName } from '../claims.js';
import { useHub } from '../context.js';
import { GAP_NOTE_MAX, REASON_MAX, hasLength } from '../decision.js';
import { useHubAction, useHubData } from '../hooks.js';
import { choiceLabel, errorText, kindLabel } from '../labels.js';
import { LengthField } from '../policy/LengthField.js';
import { lengthsOf, menuOf, snapLength } from '../policy/lengths.js';
import { useToasts } from '../toasts.js';
import type { PolicyDocs, SanctionKind } from '../types.js';
import { ErrorBlock, Panel } from '../ui.js';
import { emptySanction, sanctionProblems, toSanctionInput } from './sanctionDraft.js';
import type { SanctionDraft, SanctionMode, SanctionProblems } from './sanctionDraft.js';

const NO_PROBLEMS: SanctionProblems = { count: 0 };

/** What a moderator can pick directly. A note has its own form. */
const KINDS: readonly SanctionKind[] = ['warning', 'chat', 'area', 'ban'];

/**
 * A sanction or a note on one person, from their page. The fields are the decision form's (what, how long, which rule, why), with
 * "include their IP for 24 hours" for the timed kinds. Nothing is sent until the form passes the same checks a decision does; a
 * refusal from the server is shown with everything typed kept. A senior can take over another moderator's claim from here.
 */
export function SanctionForm({ person, name, mode, onDone, onCancel }: { person: string; name: string; mode: SanctionMode; onDone: () => void; onCancel: () => void }) {
  const { t, locale, can, client, session } = useHub();
  const toasts = useToasts();
  const base = useId();
  const id = (field: string): string => `${base}-${field}`;
  const [draft, setDraft] = useState<SanctionDraft>(() => emptySanction(mode));
  const [attempted, setAttempted] = useState(false);

  // The rules are read when the form opens (once per session: `session.policy()` remembers them), never when the page opens.
  const wantsRules = can('policy.read');
  const policy = useHubData<PolicyDocs | null>(wantsRules ? 'policy' : 'policy:idle', () => (wantsRules ? session.policy() : Promise.resolve(null)));
  const rules = useMemo(
    () => (policy.data?.rules ?? []).filter((r) => r.retired !== true).sort((a, b) => a.number - b.number).map((r) => ({ number: r.number, title: r.title })),
    [policy.data],
  );
  const canPermanent = can('sanctions.apply.ban_permanent');
  // The lengths are the profile's. A form starts on 24 hours, which the profile may not list: it moves to a length that is.
  const lengths = useMemo(() => lengthsOf(policy.data?.profile), [policy.data]);
  const timedKind = draft.kind !== '' && hasLength(draft.kind);
  const menu = menuOf(lengths, draft.kind, canPermanent);
  const snapped = snapLength(draft.duration, menu);
  useEffect(() => {
    if (timedKind && snapped !== draft.duration) setDraft((d) => ({ ...d, duration: snapped }));
  }, [timedKind, snapped, draft.duration]);
  const problems = sanctionProblems(draft, mode, { rules: rules.map((r) => r.number), canApply: can('sanctions.apply'), canPermanent });
  const shown = attempted ? problems : NO_PROBLEMS;

  // The first field takes focus when the form opens: the kind of a sanction, the note itself for a note.
  const whatRef = useRef<HTMLSelectElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    (mode === 'note' ? noteRef : whatRef).current?.focus();
  }, [mode]);

  // A second click while the first is on its way does nothing: only the first call carries on to the toast and the reload.
  const sending = useRef(false);
  const apply = useHubAction(async (takeOver: boolean) => {
    const input = toSanctionInput(person, draft, mode, takeOver ? { takeOver: true } : {});
    const done = await client.applySanction(input);
    return { ...done, input };
  });

  const submit = async (takeOver: boolean): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    if (problems.count > 0) {
      // Focus the first field with a problem, in the order they are on the page.
      const order = [problems.kind && 'what', problems.length && 'length-number', problems.rule && 'rule', problems.gapNote && 'gap', problems.reason && 'reason'].filter(Boolean) as string[];
      document.getElementById(id(order[0] ?? 'what'))?.focus();
      return;
    }
    sending.current = true;
    const result = await apply.run(takeOver).finally(() => {
      sending.current = false;
    });
    if (!result.ok) return;
    const { input, refCode } = { input: result.value.input, refCode: result.value.refCode };
    toasts.push({
      text: input.kind === 'note' ? t('hub.person.noteAdded') : t('hub.person.applied', { what: choiceLabel(t, locale, { kind: input.kind, durationMs: input.durationMs }), code: refCode }),
    });
    onDone();
  };

  // The IP only goes with a timed kind; a length the new kind may not have is moved by the menu check above.
  const setKind = (kind: SanctionKind | ''): void => setDraft((d) => ({ ...d, kind, includeIp: kind !== '' && hasLength(kind) ? d.includeIp : false }));
  const set = (patch: Partial<SanctionDraft>): void => setDraft((d) => ({ ...d, ...patch }));

  const failed = apply.error;
  const claimed = failed !== null && failed.code === 'claimed';
  const retryable = failed !== null && (failed.code === 'network' || failed.status >= 500 || failed.status === 429);
  const failure = (): string => {
    if (failed === null) return '';
    if (failed.code === 'claimed') return failed.heldBy === undefined ? t('hub.person.fail.claimedUnknown') : t('hub.person.fail.claimed', { name: actorName(failed.heldBy) });
    if (failed.code === 'duration_not_offered') return t('hub.error.durationNotOffered');
    if (failed.status === 400) return t('hub.person.fail.invalid');
    return errorText(t, failed);
  };
  const reasonLabel = mode === 'note' ? t('hub.person.note.label') : t('hub.decide.reason.label');

  return (
    <Panel title={t(mode === 'note' ? 'hub.person.form.noteTitle' : 'hub.person.form.sanctionTitle', { name })}>
      <form
        className="cw-form cw-panel-pad"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <div className="cw-form-body">
          {policy.error !== null && <ErrorBlock error={policy.error} what={t('hub.state.what.rules')} onRetry={policy.reload} />}
          <div className="cw-action-grid">
            {mode === 'sanction' && (
              <Field id={id('what')} label={t('hub.decide.action.what')} problem={shown.kind}>
                {(a) => (
                  <select {...a} ref={whatRef} value={draft.kind} onChange={(e) => setKind(e.target.value as SanctionKind | '')}>
                    <option value="">{t('hub.decide.action.what.choose')}</option>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {kindLabel(t, k)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            {timedKind && (
              <div className="cw-field">
                <LengthField
                  id={id('length')}
                  visible
                  label={t('hub.person.form.length')}
                  numberLabel={t('hub.length.number')}
                  unitLabel={t('hub.length.unit')}
                  menu={menu}
                  value={{ value: snapped, amount: draft.customAmount ?? '', unit: draft.customUnit ?? 'hours' }}
                  onChange={(l) => set({ duration: l.value, customAmount: l.amount, customUnit: l.unit })}
                  problem={shown.length}
                />
              </div>
            )}
            <Field id={id('rule')} label={t('hub.decide.action.rule')} problem={shown.rule}>
              {(a) => (
                <select {...a} value={draft.rule} onChange={(e) => set({ rule: e.target.value })}>
                  <RuleOptions rules={rules} />
                </select>
              )}
            </Field>
          </div>
          {draft.rule === 'uncovered' && (
            <Field
              id={id('gap')}
              label={t('hub.decide.action.gap')}
              hint={t('hub.decide.action.gap.hint')}
              counter={t('hub.decide.counter', { count: draft.gapNote.trim().length, max: GAP_NOTE_MAX })}
              problem={shown.gapNote}
            >
              {(a) => <textarea {...a} rows={2} value={draft.gapNote} onChange={(e) => set({ gapNote: e.target.value })} />}
            </Field>
          )}
          <Field
            id={id('reason')}
            label={reasonLabel}
            hint={mode === 'note' ? t('hub.person.note.hint') : t('hub.decide.reason.hint')}
            counter={t('hub.decide.counter', { count: draft.reason.trim().length, max: REASON_MAX })}
            problem={shown.reason}
          >
            {(a) => (
              <textarea
                {...a}
                ref={mode === 'note' ? noteRef : undefined}
                rows={3}
                value={draft.reason}
                onChange={(e) => set({ reason: e.target.value })}
              />
            )}
          </Field>
          {timedKind && (
            <div className="cw-field">
              <label className="cw-tick">
                <input type="checkbox" checked={draft.includeIp} aria-describedby={id('ip-hint')} onChange={(e) => set({ includeIp: e.target.checked })} />
                <span>{t('hub.person.form.ip')}</span>
              </label>
              <p id={id('ip-hint')} className="cw-hint">
                {t('hub.person.form.ip.hint')}
              </p>
            </div>
          )}
          {mode === 'sanction' && <p className="cw-hint">{t('hub.person.form.noNotice')}</p>}
          {failed !== null && (
            <div className="cw-error" role="alert">
              <p>{failure()}</p>
              {claimed && can('claims.override') && (
                <button type="button" className="cw-btn" onClick={() => void submit(true)}>
                  {t('hub.person.form.takeOver')}
                </button>
              )}
              {retryable && (
                <button type="button" className="cw-btn" onClick={() => void submit(false)}>
                  {t('hub.state.retry')}
                </button>
              )}
            </div>
          )}
          <div className="cw-action-foot">
            <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={apply.busy} aria-busy={apply.busy}>
              {t(mode === 'note' ? 'hub.person.form.saveNote' : 'hub.person.form.apply')}
            </button>
            <button type="button" className="cw-btn" onClick={onCancel}>
              {t('hub.person.cancel')}
            </button>
          </div>
        </div>
      </form>
    </Panel>
  );
}
