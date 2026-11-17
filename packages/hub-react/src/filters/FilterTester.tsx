import { useEffect, useId, useRef, useState } from 'react';
import type { FilterSettings } from '@chatwarden/core';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { errorText, filterActionLabel, filterKeyLabel } from '../labels.js';
import type { FilterCheckView, FilterTestView } from '../types.js';
import { Marked } from './parts.js';
import type { Problem } from './parts.js';

// "Test a message" and "Check my changes": two tries of the form AS IT IS NOW (saved or not), against one line and against recent lines. Neither saves, counts or
// audits anything. A form the kit would refuse is not sent: the problem above is shown instead.

/** More than this share of the recent lines refused or changed asks for a confirm before the form can be saved. */
export const CHECK_CONFIRM_OVER = 0.05;
/** Samples shown under each rule (the server sends up to 20). */
const SAMPLES_SHOWN = 3;

export interface FilterToolsProps {
  /** The form as the kit would read it: what is sent as the candidate. */
  candidate: FilterSettings;
  /** The first thing the kit would refuse in it, if anything. */
  problem: Problem | null;
  /** A phrase rule's name for a counter key, when the form has one. */
  labelOf: (key: string) => string | undefined;
  /** True while a check says the form touches more than 5 percent of recent lines and the owner has not said they still want it. */
  onGate: (waiting: boolean) => void;
}

export function FilterTester({ candidate, problem, labelOf }: Omit<FilterToolsProps, 'onGate'>) {
  const { t, client } = useHub();
  const id = useId();
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);
  // The answer is about the form as it was when it was run (the text and the candidate): change either and it is no longer shown.
  const [done, setDone] = useState<{ for: string; text: string; view: FilterTestView } | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const current = JSON.stringify(candidate);
  const result = done !== null && done.for === current ? done : null;

  const run = async (): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    if (text.trim() === '' || problem !== null) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      setDone({ for: current, text, view: await client.filterTest({ text, candidate }) });
    } catch (e) {
      setDone(null);
      setError(toHubError(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="cw-ftool" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('hub.settings.filters.test.title')}</h3>
      <form
        className="cw-form cw-tester"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="cw-field">
          <label htmlFor={`${id}-text`}>{t('hub.settings.filters.test.label')}</label>
          <p id={`${id}-hint`} className="cw-hint">
            {t('hub.settings.filters.test.hint')}
          </p>
          <textarea
            id={`${id}-text`}
            rows={2}
            maxLength={2000}
            aria-describedby={`${id}-hint`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDone(null);
              setError(null);
            }}
          />
          {attempted && text.trim() === '' && <p className="cw-field-error">{t('hub.settings.filters.test.empty')}</p>}
          {attempted && text.trim() !== '' && problem !== null && <p className="cw-field-error">{t('hub.settings.filters.test.blocked')}</p>}
        </div>
        <div className="cw-action-foot">
          <button type="submit" className="cw-btn" aria-disabled={busy} aria-busy={busy}>
            {t('hub.settings.filters.test.run')}
          </button>
        </div>
        <div className="cw-tester-result" role="status" aria-label={t('hub.settings.filters.test.result')}>
          {result !== null && (
            <>
              <p>
                <Marked text={result.text} spans={result.view.verdict.hits.flatMap((h) => h.spans)} />
              </p>
              {result.view.verdict.hits.length === 0 ? (
                <p>
                  <strong>{t('hub.settings.filters.test.clean')}</strong>
                </p>
              ) : (
                <ul>
                  {result.view.verdict.hits.map((h, i) => (
                    <li key={`${h.key}-${i}`}>
                      {t('hub.settings.filters.test.hit', { what: filterKeyLabel(t, h.key, labelOf(h.key)), action: filterActionLabel(t, h.action), rule: h.rule })}
                    </li>
                  ))}
                </ul>
              )}
              {result.view.delivered === null && result.view.verdict.hits.length > 0 && (
                <p>
                  <strong>{t('hub.settings.filters.test.refused')}</strong>
                </p>
              )}
              {result.view.delivered !== null && result.view.delivered !== result.text && <p>{t('hub.settings.filters.test.sent', { text: result.view.delivered })}</p>}
            </>
          )}
        </div>
        {error !== null && (
          <div className="cw-error" role="alert">
            <p>{error.status === 404 ? t('hub.settings.filters.test.unavailable') : errorText(t, error)}</p>
          </div>
        )}
      </form>
    </section>
  );
}

export function FilterChecker({ candidate, problem, labelOf, onGate }: FilterToolsProps) {
  const { t, client } = useHub();
  const id = useId();
  const [done, setDone] = useState<{ for: string; view: FilterCheckView } | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const current = JSON.stringify(candidate);
  // A result is about the form as it was when it was run: change the form and it is gone.
  const view = done !== null && done.for === current ? done.view : null;
  const touched = view === null ? 0 : view.refused + view.masked;
  const over = view !== null && view.lines > 0 && touched / view.lines > CHECK_CONFIRM_OVER;
  const waiting = over && !ack;
  useEffect(() => {
    onGate(waiting);
    return () => onGate(false);
  }, [waiting, onGate]);

  const run = async (): Promise<void> => {
    if (sending.current || problem !== null) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    setAck(false);
    try {
      setDone({ for: current, view: await client.filterCheck({ candidate }) });
    } catch (e) {
      setDone(null);
      setError(toHubError(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="cw-ftool" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('hub.settings.filters.check.title')}</h3>
      <div className="cw-form">
        <p className="cw-hint">{t('hub.settings.filters.check.hint')}</p>
        <div className="cw-action-foot">
          <button type="button" className="cw-btn" aria-disabled={busy || problem !== null} aria-busy={busy} onClick={() => void run()}>
            {t('hub.settings.filters.check.run')}
          </button>
        </div>
        {problem !== null && <p className="cw-field-error">{t('hub.settings.filters.test.blocked')}</p>}
        <div role="status" aria-label={t('hub.settings.filters.check.result')} id={`${id}-r`}>
          {view !== null && view.lines === 0 && <p>{t('hub.settings.filters.check.none')}</p>}
          {view !== null && view.lines > 0 && (
            <>
              <p>
                {[
                  t('hub.settings.filters.check.read', { count: view.lines }),
                  view.refused > 0 ? t('hub.settings.filters.check.refused', { count: view.refused }) : '',
                  view.masked > 0 ? t('hub.settings.filters.check.masked', { count: view.masked }) : '',
                  touched === 0 ? t('hub.settings.filters.check.nothing') : '',
                ]
                  .filter((s) => s !== '')
                  .join(' ')}
              </p>
              {view.rules.length > 0 && (
                <ul>
                  {view.rules.map((r) => (
                    <li key={r.key}>
                      {t('hub.settings.filters.check.rule', { what: filterKeyLabel(t, r.key, labelOf(r.key)), count: r.hits })}
                      <ul aria-label={t('hub.settings.filters.check.samples')}>
                        {r.samples.slice(0, SAMPLES_SHOWN).map((s, i) => (
                          <li key={i}>
                            <Marked text={s.text} spans={s.spans} />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {over && view !== null && (
            <div className="cw-notice cw-notice--warn">
              <p>{t('hub.settings.filters.check.over', { count: touched, total: view.lines })}</p>
              <label className="cw-choice">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>{t('hub.settings.filters.check.confirm')}</span>
              </label>
              {waiting && <p className="cw-hint">{t('hub.settings.filters.check.waiting')}</p>}
            </div>
          )}
        </div>
        {error !== null && (
          <div className="cw-error" role="alert">
            <p>{error.status === 404 ? t('hub.settings.filters.check.unavailable') : errorText(t, error)}</p>
          </div>
        )}
      </div>
    </section>
  );
}
