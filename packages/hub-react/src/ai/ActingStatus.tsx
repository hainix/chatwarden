import { useState } from 'react';
import { toHubError } from '../client.js';
import { useHub } from '../context.js';
import type { AiActingState, AiActingStep } from '../types.js';
import { Notice } from '../ui.js';
import { actingErrorText } from './acting.js';
import { useAiT } from './i18n.js';

// The status line of acting (AI levels 3 and 4, release 2) with the one-click steps beside it: Pause (a senior's, no typed word: pausing is the safe direction), Resume and
// "Switch acting off" (the owner's). Each sends one request with a fixed reason; the server decides and the line is read again. Shown only when acting is not off.

// The reasons are one fixed English form, never a translated word: they are stored in the audit trail, and a trail read by an admin in another language must not mix them.
const REASON = {
  pause: 'Paused in Settings',
  resume: 'Resumed in Settings',
  off: 'Switched off in Settings',
} as const;

export function ActingStatus({ state, onChanged }: { state: AiActingState; onChanged: () => void }) {
  const t = useAiT();
  const { me, can, locale, client } = useHub();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = me.role === 'owner';

  const run = (step: Exclude<AiActingStep, 'shadow' | 'start'>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    client.aiActingStep(step, { reason: REASON[step] }).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(actingErrorText(t, step, toHubError(cause)));
      },
    );
  };

  if (state.mode === 'off') return null;
  const since = state.modeSince === null ? '' : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(state.modeSince);
  let line: string;
  if (state.paused) line = t('hub.settings.ai.act.status.paused');
  else if (state.mode === 'on') line = t('hub.settings.ai.act.status.on');
  else line = t('hub.settings.ai.act.status.shadow', { since, count: state.shadowWouldHaveActed });

  return (
    <div className="cw-ai-status cw-act-status">
      <span className="cw-hint">{t('hub.settings.ai.act.status.label')}</span>
      <strong role="status">{line}</strong>
      <span className="cw-act-steps">
        {!state.paused && can('ai.pause') && (
          <button type="button" className="cw-btn" disabled={busy} onClick={() => run('pause')}>
            {t('hub.settings.ai.act.pause')}
          </button>
        )}
        {state.paused && owner && (
          <button type="button" className="cw-btn" disabled={busy} onClick={() => run('resume')}>
            {t('hub.settings.ai.act.resume')}
          </button>
        )}
        {owner && (
          <button type="button" className="cw-btn" disabled={busy} onClick={() => run('off')}>
            {t('hub.settings.ai.act.off')}
          </button>
        )}
      </span>
      {error !== null && (
        <Notice tone="warn" role="alert">
          {error}
        </Notice>
      )}
    </div>
  );
}
