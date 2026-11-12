import { useEffect, useRef, useState } from 'react';
import { useAiT } from '../ai/i18n.js';
import { useHub } from '../context.js';
import { ruleLabel } from '../labels.js';
import type { AiReadView } from '../types.js';
import { Skeleton } from '../ui.js';
import { AiDetails } from './AiDetails.js';
import { useCase } from './CaseContext.js';

// The AI's read on the case: a neutral strip with a dashed outline ("machine-written"), the conduct level in words, the rule and the
// summary as plain text, and one menu behind it for everything else. It is advice, never a decision, and it never shows an error: a read
// that does not come looks like the AI being off. While one is expected it holds a skeleton for up to 20 seconds and reads the case again
// a few times (not in a loop) until the read is there.

/** How long a read is waited for before the skeleton goes. */
export const AI_WAIT_MS = 20_000;
/** When the case is read again while waiting (milliseconds after the strip appeared). */
const POLLS_MS = [3_000, 6_000, 10_000, 15_000] as const;

export function AiStrip({ read }: { read: AiReadView | null }) {
  const t = useAiT();
  const { t: hubT } = useHub();
  const c = useCase();
  // The id of the read that "Read again" was asked for: waiting until a read with another id comes.
  const [again, setAgain] = useState<string | null>(null);
  // The read (or none) the 20 seconds ran out on.
  const [spent, setSpent] = useState<string | null>(null);
  const key = read?.id ?? '';
  const rereading = again !== null && again === key;
  const waiting = spent !== key && (read === null || rereading || read.stale);

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

  if (c.aiHidden && read !== null) {
    return (
      <p className="cw-ai-hidden cw-hint">
        <span>{t('hub.ai.hidden')}</span>{' '}
        <button type="button" className="cw-linkbtn" onClick={() => c.setAiHidden(false)}>
          {t('hub.ai.show')}
        </button>
      </p>
    );
  }

  if (read === null) {
    if (spent === key) return null;
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
        <AiDetails read={read} rereading={rereading} onAsked={() => setAgain(key)} />
      </div>
      <p className="cw-ai-summary">{read.summary}</p>
    </section>
  );
}
