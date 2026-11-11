import { useId, useRef, useState } from 'react';
import { Field } from '../case/ActionEditor.js';
import { useHub } from '../context.js';
import { REASON_MAX } from '../decision.js';
import type { Problem } from '../decision.js';
import { useHubAction } from '../hooks.js';
import { choiceLabel, errorText } from '../labels.js';
import { useToasts } from '../toasts.js';
import type { SanctionGroupView } from '../types.js';

/** How a revoke ended: done, or it was already revoked (a 404: someone else got there first, so the goal is met). */
export type RevokeResult = 'done' | 'already';

/**
 * Revoke one sanction in force: a button, and under it a form that asks for the reason. A revoke is a deliberate act, so there is
 * no undo window: the form is the confirmation. Nothing is sent until the reason is written; a failure keeps the form and the
 * reason; a double click sends once.
 */
export function Revoke({ s, open, onOpen, onClose, onRevoked }: { s: SanctionGroupView; open: boolean; onOpen: () => void; onClose: () => void; onRevoked: (result: RevokeResult) => void }) {
  const { t, locale, client } = useHub();
  const toasts = useToasts();
  const base = useId();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  // A second click while the first is on its way does nothing: only the first call carries on to the toast and the reload.
  const sending = useRef(false);
  const action = useHubAction((text: string) => client.revokeSanction(s.groupId, text));

  const what = choiceLabel(t, locale, { kind: s.kind, durationMs: s.endsAt === null ? null : s.endsAt - s.startsAt });
  const trimmed = reason.trim();
  const problem: Problem | undefined =
    trimmed === '' ? { key: 'hub.decide.error.reasonRequired' } : trimmed.length > REASON_MAX ? { key: 'hub.decide.error.reasonLong', params: { max: REASON_MAX } } : undefined;

  const close = (): void => {
    setReason('');
    setAttempted(false);
    action.clearError();
    onClose();
    // The form is going: keyboard focus goes back to the button that opened it.
    queueMicrotask(() => triggerRef.current?.focus());
  };

  const submit = async (): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    if (problem !== undefined) {
      textRef.current?.focus();
      return;
    }
    sending.current = true;
    const result = await action.run(trimmed).finally(() => {
      sending.current = false;
    });
    if (result.ok) {
      toasts.push({ text: t('hub.person.revoke.done', { what }) });
      onRevoked('done');
    } else if (result.error.status === 404) {
      // No such sanction in force any more: someone revoked it first. The page reloads and shows it so.
      toasts.push({ text: t('hub.person.revoke.already') });
      onRevoked('already');
    }
  };

  const failed = action.error !== null && action.error.status !== 404 ? action.error : null;
  const retryable = failed !== null && (failed.code === 'network' || failed.status >= 500 || failed.status === 429);

  return (
    <div className="cw-revoke">
      <button
        ref={triggerRef}
        type="button"
        className="cw-btn"
        aria-expanded={open}
        aria-controls={`${base}-form`}
        aria-label={t('hub.person.revoke.label', { what, code: s.refCode })}
        onClick={() => {
          if (open) return;
          onOpen();
          queueMicrotask(() => textRef.current?.focus());
        }}
      >
        {t('hub.person.revoke')}
      </button>
      {open && (
        <form
          id={`${base}-form`}
          className="cw-form cw-revoke-form"
          aria-label={t('hub.person.revoke.form', { what })}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field
            id={`${base}-reason`}
            label={t('hub.person.revoke.reason')}
            hint={t('hub.decide.reason.hint')}
            counter={t('hub.decide.counter', { count: trimmed.length, max: REASON_MAX })}
            problem={attempted ? problem : undefined}
          >
            {(a) => <textarea {...a} ref={textRef} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          {failed !== null && (
            <div className="cw-error" role="alert">
              <p>{errorText(t, failed)}</p>
              {retryable && (
                <button type="button" className="cw-btn" onClick={() => void submit()}>
                  {t('hub.state.retry')}
                </button>
              )}
            </div>
          )}
          <div className="cw-action-foot">
            <button type="submit" className="cw-btn cw-btn--danger" aria-disabled={action.busy} aria-busy={action.busy}>
              {t('hub.person.revoke.confirm')}
            </button>
            <button type="button" className="cw-btn" onClick={close}>
              {t('hub.person.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
