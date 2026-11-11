import { useEffect, useId, useRef, useState } from 'react';
import { Field } from '../case/ActionEditor.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { REASON_MAX } from '../decision.js';
import type { Problem } from '../decision.js';
import { errorText } from '../labels.js';

/**
 * The in-page confirm of a reset: what it does, why (the audit trail keeps the reason), and a way out. `loses` adds that the unsaved
 * changes of the whole screen go too (a reset of everything).
 */
export function ResetConfirm({
  what,
  busy,
  error,
  loses = false,
  onConfirm,
  onCancel,
}: {
  what: string;
  busy: boolean;
  error: HubError | null;
  loses?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
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
        {loses && ` ${t('hub.settings.reset.dirty')}`}
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
