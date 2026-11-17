import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { toHubError } from '../client.js';
import { useHub } from '../context.js';
import { Dialog } from '../Dialog.js';
import { Notice } from '../ui.js';
import { actingErrorText } from './acting.js';
import { useAiT } from './i18n.js';

// "Switch on acting" (AI levels 3 and 4, release 2, design 9.2): the owner's one dialog. Plain words, in order, then the word ACT and a reason. The button stays
// off until both are right; the server checks the word and the role again, so a forced click gets the same refusal. In this release the first step is shadow: the AI
// records what it would have done and nothing is sent to a player.

/** The exact word. Case, spaces and anything around it count. */
const WORD = 'ACT';
const PARTS = ['do', 'not', 'told', 'team', 'shadow'] as const;

export function ActDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useAiT();
  const { client } = useHub();
  const id = useId();
  const word = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = typed === WORD && reason.trim() !== '' && !busy;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    client.aiActingStep('shadow', { confirm: WORD, reason: reason.trim() }).then(
      () => {
        onDone();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(actingErrorText(t, 'shadow', toHubError(cause)));
      },
    );
  };

  return (
    <Dialog label={t('hub.settings.ai.act.dialog.title')} onClose={onClose} initialFocus={word}>
      <form className="cw-form cw-act-dialog" onSubmit={submit}>
        <h3>{t('hub.settings.ai.act.dialog.title')}</h3>
        <ol className="cw-act-parts">
          {PARTS.map((part) => (
            <li key={part}>
              <strong>{t(`hub.settings.ai.act.dialog.${part}`)}</strong> {t(`hub.settings.ai.act.dialog.${part}.text`)}
            </li>
          ))}
        </ol>
        <label htmlFor={`${id}-word`}>{t('hub.settings.ai.act.dialog.word')}</label>
        <input ref={word} id={`${id}-word`} type="text" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        <label htmlFor={`${id}-reason`}>{t('hub.settings.ai.act.dialog.reason')}</label>
        <textarea id={`${id}-reason`} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
        {error !== null && (
          <Notice tone="warn" role="alert">
            {error}
          </Notice>
        )}
        <div className="cw-actions">
          <button type="button" className="cw-btn" onClick={onClose}>
            {t('hub.settings.ai.act.dialog.cancel')}
          </button>
          <button type="submit" className="cw-btn cw-btn--primary" disabled={!ready}>
            {t('hub.settings.ai.act.dialog.start')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
