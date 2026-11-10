import { useId, useRef, useState } from 'react';
import { Field } from '../case/ActionEditor.js';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { errorText } from '../labels.js';
import type { TextVerdict } from '../types.js';
import { Panel } from '../ui.js';

/** What the live list says about one line: whether it would be blocked, and by which term (its word and language, as far as they may be shown). */
export interface Matched {
  /** The term's word, or null while words are hidden. */
  word: string | null;
  /** The term's language, as a label. */
  language: string;
}

/**
 * "Test a message": would the live list block this chat line? Nothing is sent to anyone and nothing is saved or audited. The line
 * you typed is never repeated in the answer, and the matching word is named only when words are shown.
 */
export function Tester({ matchOf }: { matchOf: (termId: string) => Matched | null }) {
  const { t, client } = useHub();
  const id = useId();
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<{ verdict: TextVerdict; termId: string | null } | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  const run = async (): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    if (text.trim() === '') return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      setResult(await client.testText(text));
    } catch (e) {
      setResult(null);
      setError(toHubError(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const matched = result?.termId == null ? null : matchOf(result.termId);
  const problem = attempted && text.trim() === '' ? { key: 'hub.terms.test.empty' as const } : undefined;

  return (
    <Panel title={t('hub.terms.test.title')}>
      <form
        className="cw-form cw-panel-pad cw-tester"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Field id={`${id}-text`} label={t('hub.terms.test.label')} hint={t('hub.terms.test.hint')} problem={problem}>
          {(a) => (
            <textarea
              {...a}
              rows={2}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setResult(null);
                setError(null);
              }}
            />
          )}
        </Field>
        <div className="cw-action-foot">
          <button type="submit" className="cw-btn" aria-disabled={busy} aria-busy={busy}>
            {t('hub.terms.test.run')}
          </button>
        </div>
        <div className="cw-tester-result" role="status">
          {result !== null && (
            <>
              <p>
                <strong>{t(result.verdict === 'blocked' ? 'hub.terms.test.blocked' : result.verdict === 'clean' ? 'hub.terms.test.clean' : 'hub.terms.test.tooLong')}</strong>
              </p>
              {result.verdict === 'blocked' && matched !== null && (
                <p className="cw-hint">
                  {matched.word === null
                    ? t('hub.terms.test.matched', { language: matched.language })
                    : t('hub.terms.test.matchedWord', { word: matched.word, language: matched.language })}
                </p>
              )}
            </>
          )}
        </div>
        {error !== null && (
          <div className="cw-error" role="alert">
            <p>{error.status === 404 ? t('hub.terms.test.unavailable') : errorText(t, error)}</p>
          </div>
        )}
      </form>
    </Panel>
  );
}
