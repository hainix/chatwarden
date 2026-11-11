import { useId, useState } from 'react';
import type { FormEvent, MutableRefObject } from 'react';
import type { ReportDetailResult } from '@chatwarden/core';
import { NOTE_MAX } from './categories.js';
import { PlayerError } from './client.js';
import type { PlayerText } from './i18n.js';
import { Picker } from './Picker.js';
import type { ReasonGroup } from './reporting.js';
import { errorText } from './ui.js';
import type { PlayerT } from './i18n.js';

/** What the player adds after a one-tap report. Your server calls `cw.reports.addDetail(reportId, reporterSeat, detail)`. */
export interface ReportDetail {
  reason?: string;
  note?: string;
}

/** How the follow-up ended, for the dialog to say: added, or the refusal word (an unknown one reads as a failure). */
export type FollowUpOutcome = { ok: true } | { ok: false; refused: string };

/** A failure to send as an error the components can word: anything that is not already a PlayerError is a dropped connection. */
const failureOf = (e: unknown): PlayerError =>
  e instanceof PlayerError ? e : new PlayerError({ status: 0, code: 'network', message: 'Could not reach the server.' });

/**
 * The optional step after a one-tap report: an "Add a reason" button that opens the reasons (in groups) and a note, and sends them to
 * `onAddDetail` for the report just filed. Nothing is sent when nothing is chosen. One thing on its way at a time, shared with the
 * dialog through `sending` (so Escape and Close wait for it); `onBusy` tells the dialog to dim its Close button.
 */
export function FollowUp(props: {
  t: PlayerT;
  groups: readonly ReasonGroup[];
  reportId: string;
  onAddDetail: (reportId: string, detail: ReportDetail) => Promise<ReportDetailResult>;
  sending: MutableRefObject<boolean>;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: (outcome: FollowUpOutcome) => void;
}) {
  const { t, groups, reportId, onAddDetail, sending, busy, onBusy, onDone } = props;
  const name = useId();
  const noteId = useId();
  const missingId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<PlayerError | null>(null);

  const trimmed = note.trim();
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (sending.current) return;
    if (reason === null && trimmed === '') {
      setMissing(true);
      return;
    }
    sending.current = true;
    onBusy(true);
    setFailure(null);
    try {
      const detail: ReportDetail = { ...(reason === null ? {} : { reason }), ...(trimmed === '' ? {} : { note: trimmed }) };
      const raw: unknown = await onAddDetail(reportId, detail);
      // Anything that is not a result object (undefined, null, a string) is not a success and not a crash: it reads as an unknown refusal.
      const answer = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as ReportDetailResult) : ({ ok: false, refused: 'unknown' } as unknown as ReportDetailResult);
      onDone(answer.ok === true ? { ok: true } : { ok: false, refused: String((answer as { refused?: unknown }).refused) });
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      sending.current = false;
      onBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <button type="button" className="cw-btn cw-disclosure" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
        {t('player.report.addReason')}
      </button>
      {open && (
        <div id={panelId} className="cw-panel">
          <p className="cw-hint">{t('player.report.addReasonHint')}</p>
          <Picker
            groups={groups}
            name={name}
            value={reason}
            legend={t('player.report.detail.legend')}
            invalid={missing}
            describedBy={missingId}
            onChange={(id) => {
              setReason(id);
              setMissing(false);
            }}
          />
          {missing && (
            <p id={missingId} className="cw-field-error" role="alert">
              {t('player.report.detail.need')}
            </p>
          )}
          <label className="cw-label" htmlFor={noteId}>
            {t('player.report.note')}
          </label>
          <textarea
            id={noteId}
            className="cw-textarea"
            rows={3}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setMissing(false);
            }}
          />
          {failure !== null && (
            <p className="cw-error" role="alert">
              {t('player.report.detail.failed')} {errorText(t, failure)}
            </p>
          )}
          <div className="cw-actions">
            <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={busy || undefined} aria-busy={busy || undefined}>
              {t('player.report.detail.send')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

/** The plain message for a follow-up refusal; one a newer kit adds gets the general one. */
export const DETAIL_REFUSED_TEXT: Readonly<Record<string, PlayerText>> = {
  off: 'player.report.detail.refused.off',
  not_found: 'player.report.detail.refused.not_found',
  not_reporter: 'player.report.detail.refused.not_reporter',
  too_late: 'player.report.detail.refused.too_late',
  already_added: 'player.report.detail.refused.already_added',
  reason_unknown: 'player.report.detail.refused.reason_unknown',
};
