import { useEffect, useId, useRef, useState } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { useFeatures } from '../features.js';
import type { HubT, HubText } from '../i18n.js';
import { errorText } from '../labels.js';
import type { ReportKind } from '../types.js';
import { communityStatus } from './communityStatus.js';

// "Report a problem with this community term" (design 10.6, 14): the same disclosure place as Share, for a row the shared list added.
// Closed by default; shown only when the server reports it can send a report. Opened, it says exactly what is sent (the term's number on
// the list and the problem, never the word), a closed choice of problem and one Send. Closing it throws the choice away. There is no free
// text, so nothing here can carry a name or a chat line. The browser never talks to the community service: its own server does.

export interface ReportTermProps {
  /** The row being edited: a term the shared list added. Its id is the term's number on the list. */
  termId: string;
}

const KINDS: readonly ReportKind[] = ['innocent_sense', 'wrong_category', 'removal'];
const KIND_WORD: Record<ReportKind, HubText> = {
  innocent_sense: 'hub.community.report.kind.innocent_sense',
  wrong_category: 'hub.community.report.kind.wrong_category',
  removal: 'hub.community.report.kind.removal',
};

/** What the person is told when a send fails: never the service's text, only these. */
function sendFailure(t: HubT, error: HubError): string {
  if (error.code === 'network' || error.code === 'share_unavailable' || error.status >= 500) return t('hub.community.share.error.offline');
  if (error.status === 429) return t('hub.community.report.error.rateLimited');
  if (error.code === 'share_refused' || error.status === 400 || error.status === 409) return t('hub.community.report.error.refused');
  return errorText(t, error);
}

/** The disclosure. Draws nothing until the server has said it can send a report. */
export function ReportTerm({ termId }: ReportTermProps) {
  const { t, client } = useHub();
  const { community: wired } = useFeatures();
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [reporting, setReporting] = useState(false);
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!wired) return;
    let live = true;
    void communityStatus(client).then((status) => {
      if (live && status !== null && status.reporting === true) setReporting(true);
    });
    return () => {
      live = false;
    };
  }, [client, wired]);

  if (!reporting) return null;

  const close = (): void => {
    setOpen(false);
    toggle.current?.focus();
  };

  return (
    <div
      className="cw-share"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <button ref={toggle} type="button" className="cw-linkbtn cw-share-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        {t('hub.community.report.toggle')}
      </button>
      {sent && (
        <p className="cw-hint cw-share-status" role="status">
          {t('hub.community.report.sent')}
        </p>
      )}
      {open && (
        <ReportPanel
          id={panelId}
          termId={termId}
          onSent={() => {
            setSent(true);
            close();
          }}
        />
      )}
    </div>
  );
}

function ReportPanel({ id, termId, onSent }: { id: string; termId: string; onSent: () => void }) {
  const { t, client } = useHub();
  const base = useId();
  const [kind, setKind] = useState<ReportKind>('innocent_sense');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  const send = async (): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.reportTerm(termId, { kind });
      onSent();
    } catch (e) {
      setError(sendFailure(t, toHubError(e)));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <div id={id} className="cw-share-panel">
      <p className="cw-share-consent">{t('hub.community.report.note')}</p>
      <div role="group" aria-label={t('hub.community.share.payload')} className="cw-share-payload">
        <dl>
          <div>
            <dt>{t('hub.community.report.field.number')}</dt>
            <dd>{termId}</dd>
          </div>
          <div>
            <dt>{t('hub.community.report.field.kind')}</dt>
            <dd>{t(KIND_WORD[kind])}</dd>
          </div>
          <div>
            <dt>{t('hub.community.share.field.day')}</dt>
            <dd>{t('hub.community.share.day')}</dd>
          </div>
          <div>
            <dt>{t('hub.community.share.field.kit')}</dt>
            <dd>{t('hub.community.share.kit')}</dd>
          </div>
          <div>
            <dt>{t('hub.community.share.field.key')}</dt>
            <dd>{t('hub.community.share.key')}</dd>
          </div>
        </dl>
      </div>
      <div className="cw-share-fields">
        <div className="cw-field">
          <label htmlFor={`${base}-kind`}>{t('hub.community.report.kind')}</label>
          <select id={`${base}-kind`} value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_WORD[k])}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error !== null && (
        <div className="cw-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      <div className="cw-action-foot">
        <button type="button" className="cw-btn cw-btn--primary" aria-disabled={busy} aria-busy={busy} onClick={() => void send()}>
          {busy ? t('hub.community.report.sending') : t('hub.community.report.send')}
        </button>
      </div>
    </div>
  );
}
