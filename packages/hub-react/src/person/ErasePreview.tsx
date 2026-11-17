import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { Dialog } from '../Dialog.js';
import { errorText } from '../labels.js';
import { downloadJson } from '../privacy/download.js';
import { usePrivacyT } from '../privacy/i18n.js';
import type { PrivacyText } from '../privacy/i18n.js';
import type { ErasePreviewView, ErasureReceiptView } from '../types.js';
import { Notice, Time } from '../ui.js';

// "Erase data..." (privacy requests, design 5.3): the owner's one dialog. It opens by counting, in words, what would be removed and what stays (a dry run: nothing is written),
// then asks for the word ERASE. The server checks the owner, the word it is given (the person's ref) and the choice again, so a forced click gets the same answer. After the
// erase it shows the receipt (counts and words only) with a download. It says plainly that this is not legal advice and that the kit does not tell the player.

/** The exact word. Case, spaces and anything around it count. */
const WORD = 'ERASE';

type Keep = 'safety' | 'none';

/** The categories of a count, in the order the kit lists them. An unknown category from a newer kit is shown under its own name. */
const ORDER = ['subjects', 'identifiers', 'sanctions', 'notices', 'reports_filed', 'reports_about', 'report_lines', 'strikes', 'mutes', 'blocked_names', 'appeals', 'signals', 'ai', 'workflow', 'audit', 'holds'] as const;

type Counts = Partial<Record<string, number>>;

/** The removed counts as lines: a word for the category and the number, nothing else. */
export function CountList({ removed }: { removed: Counts }) {
  const t = usePrivacyT();
  const known = ORDER.filter((c) => (removed[c] ?? 0) > 0);
  const other = Object.keys(removed).filter((c) => !(ORDER as readonly string[]).includes(c) && (removed[c] ?? 0) > 0);
  if (known.length === 0 && other.length === 0) return <p>{t('hub.privacy.erase.preview.none')}</p>;
  return (
    <dl className="cw-privacy-counts">
      {known.map((c) => (
        <div key={c}>
          <dt>{t(`hub.privacy.erase.cat.${c}` as PrivacyText)}</dt>
          <dd>{removed[c]}</dd>
        </div>
      ))}
      {other.map((c) => (
        <div key={c}>
          <dt>{c}</dt>
          <dd>{removed[c]}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What stays: the safety remainder and any held reports. */
function KeptList({ kept }: { kept: ErasePreviewView['kept'] }) {
  const t = usePrivacyT();
  const any = kept.identifiers || kept.sanctions > 0 || kept.heldReports > 0;
  if (!any) return <p>{t('hub.privacy.erase.kept.nothing')}</p>;
  return (
    <ul className="cw-privacy-kept">
      {kept.identifiers && <li>{t('hub.privacy.erase.kept.identifiers')}</li>}
      {kept.sanctions > 0 && <li>{t('hub.privacy.erase.kept.sanctions', { count: kept.sanctions })}</li>}
      {kept.heldReports > 0 && <li>{t('hub.privacy.erase.kept.held', { count: kept.heldReports })}</li>}
    </ul>
  );
}

/** The receipt shown at the end, with its download. */
function Receipt({ receipt, onDone }: { receipt: ErasureReceiptView; onDone: () => void }) {
  const t = usePrivacyT();
  const done = useRef<HTMLButtonElement>(null);
  return (
    <Dialog label={t('hub.privacy.receipt.title')} onClose={onDone} initialFocus={done}>
      <div className="cw-form cw-act-dialog">
        <h3>{t('hub.privacy.receipt.title')}</h3>
        <p>{t('hub.privacy.receipt.lead')}</p>
        <p>
          <strong>{t('hub.privacy.receipt.id')}</strong> <code>{receipt.id}</code> <Time at={receipt.at} />
        </p>
        {receipt.auditFailed === true && (
          <Notice tone="warn" role="alert">
            {t('hub.privacy.receipt.auditFailed')}
          </Notice>
        )}
        <h4>{t('hub.privacy.erase.removed')}</h4>
        <CountList removed={receipt.removed} />
        <h4>{t('hub.privacy.erase.kept')}</h4>
        <KeptList kept={receipt.kept} />
        <div className="cw-actions">
          <button type="button" className="cw-btn" onClick={() => downloadJson(`chatwarden-erasure-receipt-${receipt.id}.json`, receipt)}>
            {t('hub.privacy.receipt.download')}
          </button>
          <button ref={done} type="button" className="cw-btn cw-btn--primary" onClick={onDone}>
            {t('hub.privacy.receipt.done')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The dialog. `person` is the staff ref: the server wants it back as the confirmation. */
export function ErasePreview({ person, onClose, onErased }: { person: string; onClose: () => void; onErased: () => void }) {
  const t = usePrivacyT();
  const { client, t: hubT } = useHub();
  const id = useId();
  const word = useRef<HTMLInputElement>(null);
  const [keep, setKeep] = useState<Keep>('safety');
  const [preview, setPreview] = useState<{ keep: Keep; counts: ErasePreviewView } | 'loading' | HubError>('loading');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [receipt, setReceipt] = useState<ErasureReceiptView | null>(null);

  // The dry run: on open, and again whenever the choice changes. An answer for an older choice is dropped.
  useEffect(() => {
    let live = true;
    setPreview('loading');
    client.privacyErase(person, { keep, confirm: person, dryRun: true }).then(
      (answer) => {
        if (live) setPreview({ keep, counts: answer as ErasePreviewView });
      },
      (cause: unknown) => {
        if (live) setPreview(toHubError(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [client, person, keep]);

  const counted = typeof preview === 'object' && 'counts' in preview ? preview : null;
  const ready = typed === WORD && !busy && counted !== null && counted.keep === keep;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    client.privacyErase(person, { keep, confirm: person }).then(
      (answer) => {
        setBusy(false);
        setReceipt(answer as ErasureReceiptView);
      },
      (cause: unknown) => {
        // The dialog stays open with the choice and the typed word, so the owner can try again.
        setBusy(false);
        setError(toHubError(cause));
      },
    );
  };

  if (receipt !== null) return <Receipt receipt={receipt} onDone={onErased} />;

  return (
    <Dialog label={t('hub.privacy.erase.title')} onClose={onClose} initialFocus={word}>
      <form className="cw-form cw-act-dialog" onSubmit={submit}>
        <h3>{t('hub.privacy.erase.title')}</h3>
        <p>{t('hub.privacy.erase.lead')}</p>
        <fieldset className="cw-privacy-keep">
          <legend>{t('hub.privacy.erase.keep')}</legend>
          <label>
            <input type="radio" name={`${id}-keep`} checked={keep === 'safety'} onChange={() => setKeep('safety')} /> {t('hub.privacy.erase.keep.safety')}
          </label>
          <p className="cw-hint">{t('hub.privacy.erase.keep.safety.hint')}</p>
          <label>
            <input type="radio" name={`${id}-keep`} checked={keep === 'none'} onChange={() => setKeep('none')} /> {t('hub.privacy.erase.keep.none')}
          </label>
          {keep === 'none' && (
            <Notice tone="warn" role="alert">
              {t('hub.privacy.erase.keep.none.warn')}
            </Notice>
          )}
        </fieldset>
        <section aria-label={t('hub.privacy.erase.preview')} aria-live="polite">
          <h4>{t('hub.privacy.erase.preview')}</h4>
          {preview === 'loading' && <p role="status">{t('hub.privacy.erase.preview.loading')}</p>}
          {typeof preview === 'object' && 'message' in preview && (
            <Notice tone="warn" role="alert">
              {t('hub.privacy.erase.preview.failed')} {errorText(hubT, preview)}
            </Notice>
          )}
          {counted !== null && (
            <>
              <p>
                <strong>{t('hub.privacy.erase.removed')}</strong>
              </p>
              <CountList removed={counted.counts.removed} />
              <p>
                <strong>{t('hub.privacy.erase.kept')}</strong>
              </p>
              <KeptList kept={counted.counts.kept} />
            </>
          )}
        </section>
        <label htmlFor={`${id}-word`}>{t('hub.privacy.erase.word')}</label>
        <input ref={word} id={`${id}-word`} type="text" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        {error !== null && (
          <Notice tone="warn" role="alert">
            {t('hub.privacy.erase.failed')} {errorText(hubT, error)}
          </Notice>
        )}
        <div className="cw-actions">
          <button type="button" className="cw-btn" onClick={onClose}>
            {t('hub.privacy.erase.cancel')}
          </button>
          <button type="submit" className="cw-btn cw-btn--primary" disabled={!ready}>
            {t('hub.privacy.erase.go')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
