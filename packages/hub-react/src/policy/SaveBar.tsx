import { Field } from '../case/ActionEditor.js';
import { useHub } from '../context.js';
import { REASON_MAX } from '../decision.js';
import { errorText } from '../labels.js';
import type { UsePolicy } from '../policyHooks.js';
import type { SaveFlow } from './useSaveFlow.js';

/**
 * The save bar of a settings screen: Save changes (which asks why), Discard, the count of unsaved sections, and what went wrong with the last
 * try (a conflict with Reload, a refusal, a failure with Retry). `refusedField` says the kit's refusal named a field the screen marked.
 */
export function SaveBar({
  policy,
  save,
  isDirty,
  dirtyCount,
  refusedField,
  idBase,
  onDiscard,
  onReload,
}: {
  policy: UsePolicy;
  save: SaveFlow;
  isDirty: boolean;
  dirtyCount: number;
  refusedField: boolean;
  idBase: string;
  onDiscard: () => void;
  onReload: () => void;
}) {
  const { t } = useHub();
  const err = save.saveError;
  return (
    <section className="cw-savebar" aria-label={t('hub.settings.save.form')}>
      {err !== null && err.code === 'conflict' && (
        <div className="cw-error" role="alert">
          <p>
            <strong>{t('hub.settings.error.conflict')}</strong> {t('hub.settings.error.conflict.body')}
          </p>
          <button type="button" className="cw-btn" onClick={onReload}>
            {t('hub.settings.error.reload')}
          </button>
        </div>
      )}
      {err !== null && err.code === 'invalid_profile' && (
        <div className="cw-error" role="alert">
          <p>
            <strong>{t(refusedField ? 'hub.settings.error.invalid' : 'hub.settings.error.invalid.general')}</strong>{' '}
            {t(refusedField ? 'hub.settings.error.invalid.body' : 'hub.settings.error.invalid.general.body')}
          </p>
        </div>
      )}
      {err !== null && err.code !== 'conflict' && err.code !== 'invalid_profile' && (
        <div className="cw-error" role="alert">
          <p>{err.code === 'not_supported' ? t('hub.settings.error.unsupported') : errorText(t, err)}</p>
          {(err.code === 'network' || err.status >= 500 || err.status === 429) && save.asking && (
            <button type="button" className="cw-btn" onClick={() => void save.submit()}>
              {t('hub.state.retry')}
            </button>
          )}
        </div>
      )}
      {save.asking ? (
        <form
          className="cw-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save.submit();
          }}
        >
          <Field id={`${idBase}-reason`} label={t('hub.settings.save.reason')} hint={t('hub.settings.save.reason.hint')} counter={t('hub.decide.counter', { count: save.trimmed.length, max: REASON_MAX })} problem={save.reasonProblem}>
            {(a) => <textarea {...a} ref={save.reasonBox} rows={2} value={save.reason} onChange={(e) => save.setReason(e.target.value)} />}
          </Field>
          <div className="cw-action-foot">
            <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={policy.busy} aria-busy={policy.busy}>
              {t('hub.settings.save')}
            </button>
            <button type="button" className="cw-btn" onClick={() => save.setAsking(false)}>
              {t('hub.settings.save.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="cw-action-foot">
          <button type="button" className="cw-btn cw-btn--primary" aria-disabled={!isDirty} onClick={save.start}>
            {t('hub.settings.save')}
          </button>
          <button type="button" className="cw-btn" aria-disabled={!isDirty} onClick={() => isDirty && onDiscard()}>
            {t('hub.settings.discard')}
          </button>
          <p className="cw-hint" role="status">
            {isDirty ? t('hub.settings.dirty', { count: dirtyCount }) : t('hub.settings.clean')}
          </p>
        </div>
      )}
    </section>
  );
}
