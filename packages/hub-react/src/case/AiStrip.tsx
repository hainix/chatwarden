import { useEffect, useRef, useState } from 'react';
import { useAiT } from '../ai/i18n.js';
import { useAiHidden } from '../ai/hide.js';
import { useHub } from '../context.js';
import { ruleLabel } from '../labels.js';
import type { AiReadView } from '../types.js';
import { Skeleton } from '../ui.js';
import { AiDetails } from './AiDetails.js';
import { useCase } from './CaseContext.js';

// The AI's read on the case: a neutral strip with a dashed outline ("machine-written"), the conduct level in words, the rule and the
// summary as plain text, and one menu behind it for everything else. It is advice, never a decision, and it never shows an error: a read
// that does not come looks like the AI being off. While one is expected it holds a skeleton for up to 20 seconds and reads the case again
// twice (about 5 and 15 seconds: each is an audited read of the case, so three per open at most), then leaves one quiet "Check again".


/** How long a read is waited for before the skeleton goes. */
export const AI_WAIT_MS = 20_000;
/** When the case is read again while waiting (milliseconds after the strip appeared). */
const POLLS_MS = [5_000, 15_000] as const;

export function AiStrip({ read, expected }: { read: AiReadView | null; expected: boolean }) {
  const t = useAiT();
  const { t: hubT } = useHub();
  const c = useCase();
  const [hidden, setHidden] = useAiHidden(c.reportId);
  // The id of the read that "Read again" was asked for: waiting until a read with another id comes.
  const [again, setAgain] = useState<string | null>(null);
  // The read (or none) the 20 seconds ran out on.
  const [spent, setSpent] = useState<string | null>(null);
  // Hiding took the menu away with the focus on it: it goes to Show (not when the case opens already hidden).
  const show = useRef<HTMLButtonElement>(null);
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (hidden && !wasHidden.current) show.current?.focus();
    wasHidden.current = hidden;
  }, [hidden]);
  c.aiBus.hidden.current = hidden;
  const key = read?.id ?? '';
  // A Read again that has not landed when the wait runs out is no longer waited for: it can be asked again.
  const rereading = again !== null && again === key && spent !== key;
  // A read is waited for only while the server says one is on its way (a stale read in a degraded mode is shown, not waited for).
  const waiting = spent !== key && (rereading || ((read === null || read.stale) && expected));

  const reload = useRef(c.detail.reload);
  reload.current = c.detail.reload;
  useEffect(() => {
    if (!waiting) return undefined;
    const polls = POLLS_MS.map((ms) => setTimeout(() => reload.current(), ms));
    const stop = setTimeout(() => setSpent(key), AI_WAIT_MS);
    return () => {
      for (const id of polls) clearTimeout(id);
      clearTimeout(stop);
    };
  }, [waiting, key]);

  if (hidden && read !== null) {
    return (
      <p className="cw-ai-hidden cw-hint">
        <span>{t('hub.ai.hidden')}</span>{' '}
        <button ref={show} type="button" className="cw-linkbtn" onClick={() => setHidden(false)}>
          {t('hub.ai.show')}
        </button>
      </p>
    );
  }

  if (read === null) {
    if (spent === key) {
      return (
        <section className="cw-ai" aria-label={hubT('hub.ai.label')}>
          <p className="cw-hint">
            <span>{t('hub.ai.waiting')}</span>{' '}
            <button type="button" className="cw-linkbtn" onClick={() => c.detail.reload()}>
              {t('hub.ai.checkAgain')}
            </button>
          </p>
        </section>
      );
    }
    return (
      <section className="cw-ai" aria-label={hubT('hub.ai.label')} aria-busy="true">
        <p className="cw-sr" role="status">
          {t('hub.ai.pending')}
        </p>
        <Skeleton lines={1} />
      </section>
    );
  }

  const cited = read.evidenceLineIds.length;
  return (
    <section className="cw-ai" aria-label={hubT('hub.ai.label')}>
      <h3 className="cw-sr">{hubT('hub.ai.title', { level: read.recommendation === null ? 1 : 2 })}</h3>
      <div className="cw-ai-head">
        <span className="cw-aitag">{t('hub.ai.tag')}</span>
        <strong className="cw-ai-level">{hubT(`hub.decide.suggest.level.${read.severity}`)}</strong>
        {read.rule !== null && <span className="cw-ai-rule">{ruleLabel(hubT, read.rule)}</span>}
        {cited > 0 && <span className="cw-ai-count">{t('hub.ai.cites', { count: cited })}</span>}
        {rereading && spent !== key && (
          <span className="cw-hint" role="status">
            {t('hub.ai.rereading')}
          </span>
        )}
        {read.stale && spent === key && (
          <button type="button" className="cw-linkbtn" onClick={() => c.detail.reload()}>
            {t('hub.ai.checkAgain')}
          </button>
        )}
        <AiDetails read={read} rereading={rereading} onAsked={() => {
            setAgain(key);
            setSpent(null);
          }} />
      </div>
      <p className="cw-ai-summary">{read.summary}</p>
    </section>
  );
}
