import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAiT } from '../ai/i18n.js';
import type { AiT } from '../ai/i18n.js';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { onPage } from '../dom.js';
import { absoluteTime } from '../format.js';
import { errorText } from '../labels.js';
import type { AiReadView } from '../types.js';
import { Time } from '../ui.js';
import { useCase } from './CaseContext.js';

// The one door behind the strip (the ⋯ menu): when and by what model the read was made, how sure it was, the two plain notes (older
// rules, a line that tried to instruct the AI), Read again and Hide the AI on this case. Nothing else, and nothing of the evidence.
// A failed Read again is the hub's normal error block, in here only: the case itself never shows one.

/** Why Read again did not go through, as one sentence. The server's own words are never shown. */
export function aiErrorText(t: AiT, error: HubError): string {
  if (error.code === 'ai_final') return t('hub.ai.error.final');
  if (error.code === 'ai_budget') return t('hub.ai.error.budget');
  if (error.code === 'ai_unavailable') return t('hub.ai.error.unavailable');
  if (error.code === 'ai_off') return t('hub.ai.error.off');
  return errorText(t as never, error);
}

/** Only an error that may pass is worth another try. */
const retryable = (e: HubError): boolean => e.code === 'network' || e.code === 'ai_unavailable' || e.status >= 500;

export function AiDetails({ read, rereading, onAsked }: { read: AiReadView; rereading: boolean; onAsked: () => void }) {
  const t = useAiT();
  const { client, can, locale, t: hubT } = useHub();
  const c = useCase();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  // A press away from the menu closes it. It reads where the press began, so it holds inside a shadow root too.
  useEffect(() => {
    if (!open) return undefined;
    return onPage('pointerdown', (e) => {
      const origin = e.composedPath()[0];
      if (origin instanceof Node && box.current?.contains(origin) !== true) setOpen(false);
    });
  }, [open]);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !open) return;
    // This Escape is the menu's: the hub's own Escape (back to the queue) must not also run.
    e.stopPropagation();
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  };

  const ask = async (): Promise<void> => {
    if (busy || rereading) return;
    setBusy(true);
    setError(null);
    setReady(false);
    try {
      const res = await client.readAgain(c.reportId);
      if (res.status === 'pending') onAsked();
      else setReady(true);
      c.detail.reload();
    } catch (e) {
      setError(toHubError(e));
    } finally {
      setBusy(false);
    }
  };

  const waiting = busy || rereading;
  return (
    <div className="cw-ai-menu" ref={box} onKeyDown={onKeyDown}>
      <button ref={button} type="button" className="cw-btn cw-ai-more" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">⋯</span>
        <span className="cw-sr">{t('hub.ai.details')}</span>
      </button>
      {open && (
        <div className="cw-ai-panel" role="group" id={`${id}-panel`} aria-label={t('hub.ai.details')}>
          <dl className="cw-ai-facts">
            <div>
              <dt>{t('hub.ai.details.model')}</dt>
              <dd>{read.model ?? t('hub.ai.details.model.none')}</dd>
            </div>
            <div>
              <dt>{t('hub.ai.details.read')}</dt>
              <dd>
                <Time at={read.at} />
                <span className="cw-sr"> ({absoluteTime(read.at, locale)})</span>
              </dd>
            </div>
            <div>
              <dt>{t('hub.ai.details.confidence')}</dt>
              <dd>{t(`hub.ai.confidence.${read.confidence}`)}</dd>
            </div>
          </dl>
          {read.stale && <p className="cw-hint">{t('hub.ai.details.stale')}</p>}
          {read.injectionSuspected && <p className="cw-hint">{t('hub.ai.details.injection')}</p>}
          <p className="cw-hint">{hubT('hub.ai.note')}</p>
          {error !== null && (
            <div className="cw-error" role="alert">
              <p>
                <strong>{t('hub.ai.readAgain.failed')}</strong> {aiErrorText(t, error)}
              </p>
              {retryable(error) && (
                <button type="button" className="cw-btn" onClick={() => void ask()}>
                  {hubT('hub.state.retry')}
                </button>
              )}
            </div>
          )}
          {ready && error === null && (
            <p className="cw-hint" role="status">
              {t('hub.ai.readAgain.ready')}
            </p>
          )}
          <div className="cw-ai-actions">
            {can('reports.decide') && (
              <button type="button" className="cw-btn" aria-disabled={waiting} onClick={() => void ask()}>
                {t('hub.ai.readAgain')}
              </button>
            )}
            <button
              type="button"
              className="cw-btn"
              onClick={() => {
                setOpen(false);
                c.setAiHidden(true);
              }}
            >
              {t('hub.ai.hide')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
