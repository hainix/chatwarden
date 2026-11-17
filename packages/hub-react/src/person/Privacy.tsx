import { useId, useRef, useState } from 'react';
import { useHub } from '../context.js';
import { useHubAction } from '../hooks.js';
import { errorText } from '../labels.js';
import { downloadJson } from '../privacy/download.js';
import { usePrivacyT } from '../privacy/i18n.js';
import { useToasts } from '../toasts.js';
import { ErasePreview } from './ErasePreview.js';

// "Export data..." and "Erase data..." on the Person page (privacy requests, design 5.2): two items behind one quiet `...` button, for the owner only (the server compares the
// role in code too). Export downloads at once: the server audits it first, so a failed audit shows an error and downloads nothing. Erase opens the dialog that counts first.
// It is its own chunk: fetched when the owner opens a person.

/** What the part is given. @experimental */
export interface PersonPrivacyProps {
  /** The staff ref of the person whose page this is. */
  person: string;
}

export function PersonPrivacy({ person }: PersonPrivacyProps) {
  const t = usePrivacyT();
  const { client, t: hubT, go } = useHub();
  const toasts = useToasts();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [erasing, setErasing] = useState(false);
  // A double click sends once: the second call gets the first call's answer.
  const exporting = useHubAction(() => client.privacyExport(person));
  // An export is audited and saved once per click: a second click inside the moment after the first is the same click.
  const lock = useRef(false);

  const run = async (): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    try {
      const result = await exporting.run();
      if (!result.ok) return;
      downloadJson('chatwarden-privacy-export.json', result.value);
      toasts.push({ text: t('hub.privacy.export.done') });
    } finally {
      setTimeout(() => {
        lock.current = false;
      }, 500);
    }
  };

  return (
    <div className="cw-person-automation cw-person-privacy">
      <button type="button" className="cw-btn cw-person-more" aria-label={t('hub.privacy.menu')} aria-expanded={open} aria-controls={`${id}-group`} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{'\u2026'}</span>
      </button>
      {open && (
        <fieldset className="cw-form cw-person-automation-group" id={`${id}-group`}>
          <legend>{t('hub.privacy.menu')}</legend>
          <p className="cw-hint">{t('hub.privacy.menu.hint')}</p>
          <button type="button" className="cw-btn" aria-disabled={exporting.busy} onClick={() => void run()}>
            {t('hub.privacy.export.item')}
          </button>
          <button type="button" className="cw-btn" onClick={() => setErasing(true)}>
            {t('hub.privacy.erase.item')}
          </button>
          {exporting.error !== null && (
            <div className="cw-error" role="alert">
              <strong>{t('hub.privacy.export.failed')}</strong> {errorText(hubT, exporting.error)}
            </div>
          )}
        </fieldset>
      )}
      {erasing && (
        <ErasePreview
          person={person}
          onClose={() => setErasing(false)}
          onErased={() => {
            setErasing(false);
            // The person is gone: their page would only say so.
            go({ name: 'overview' });
          }}
        />
      )}
    </div>
  );
}
