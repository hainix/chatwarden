import { useEffect, useRef } from 'react';
import { Masked } from '../case/Transcript.js';
import { useHub } from '../context.js';

/** How many dry-run hits are listed before "and N more". */
export const HITS_SHOWN = 20;

/**
 * The in-page confirm after a dry run found lines a word would also block: how many, the lines (the first twenty, then a count),
 * and "Save anyway" or "Go back". The lines hold the word, so they stay behind a Show until the word is shown (`visible`).
 */
export function HitsConfirm({
  hits,
  visible,
  busy,
  onReveal,
  onSave,
  onBack,
}: {
  hits: readonly string[];
  visible: boolean;
  busy: boolean;
  onReveal: () => void;
  onSave: () => void;
  onBack: () => void;
}) {
  const { t } = useHub();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const listed = hits.slice(0, HITS_SHOWN);
  const more = hits.length - listed.length;
  return (
    <div className="cw-hits" role="group" aria-label={t('hub.terms.hits.list')} tabIndex={-1} ref={ref}>
      <p role="status">
        <strong>{t('hub.terms.hits.title', { count: hits.length })}</strong>
      </p>
      <p className="cw-hint">{t('hub.terms.hits.body')}</p>
      {visible ? (
        <>
          <ul className="cw-hits-list" aria-label={t('hub.terms.hits.list')}>
            {listed.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {more > 0 && <p className="cw-hint">{t('hub.terms.hits.more', { count: more })}</p>}
        </>
      ) : (
        <p className="cw-row-actions">
          <Masked />
          <button type="button" className="cw-linkbtn" onClick={onReveal}>
            {t('hub.terms.hits.show')}
          </button>
        </p>
      )}
      <div className="cw-action-foot">
        <button type="button" className="cw-btn cw-btn--primary" aria-disabled={busy} aria-busy={busy} onClick={onSave}>
          {t('hub.terms.hits.saveAnyway')}
        </button>
        <button type="button" className="cw-btn" onClick={onBack}>
          {t('hub.terms.hits.back')}
        </button>
      </div>
    </div>
  );
}
