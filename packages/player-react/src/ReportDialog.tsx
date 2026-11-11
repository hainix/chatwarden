import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PlayerReporting, ReportDetailResult, ReportFlow, ReportRefusal, ReportResult } from '@chatwarden/core';
import { NOTE_MAX } from './constants.js';
import { PlayerError } from './client.js';
import { Dialog } from './Dialog.js';
import { DETAIL_REFUSED_TEXT, FollowUp } from './FollowUp.js';
import type { FollowUpOutcome, ReportFollowUp } from './FollowUp.js';
import { Picker } from './Picker.js';
import type { PlayerText } from './i18n.js';
import { groupReasons, readReporting } from './reporting.js';
import type { ReasonItem } from './reporting.js';
import { errorText, Portal, Root, useUi } from './ui.js';
import type { DialogHostProps, PlayerUiProps } from './ui.js';

/**
 * What the player filled in. Your server adds the room and the seats and calls `cw.reports.submit({ ...draft, roomId, reporterSeat,
 * targetSeat })`. The dialog sends `reason` (an id from the studio's `reporting` list, or nothing, as in one tap). A reason is only a
 * hint: the moderators decide what a report really is.
 */
export interface ReportDraft {
  /** The reason the player chose: an id from `reporting.reasons`. Left out when none was chosen. */
  reason?: string;
  /** The note, trimmed; left out when blank. */
  note?: string;
}

export type { ReportFollowUp } from './FollowUp.js';

export interface ReportDialogProps extends PlayerUiProps, DialogHostProps {
  /**
   * Sends the report: your server calls `cw.reports.submit({ ...draft, roomId, reporterSeat, targetSeat })` and returns its
   * `ReportResult`. A refusal is a result, not an error; reject only when no answer arrived.
   */
  onSubmit: (draft: ReportDraft) => Promise<ReportResult>;
  /**
   * The optional follow-up after a one-tap report: your server calls `cw.reports.addDetail(reportId, reporterSeat, detail)` (the seat
   * from its own session, never from the page) and returns its `ReportDetailResult`. Without it the "Add a reason" step is not shown.
   */
  onAddDetail?: (reportId: string, detail: ReportFollowUp) => Promise<ReportDetailResult>;
  /** Called on Escape, Cancel and Close. Unmount the dialog in answer. */
  onClose: () => void;
  /**
   * How reporting works here: `(await createPlayerClient.rules()).reporting`, the `reporting` part of `GET /rules`. It sets the flow
   * (one tap, pick a reason first, reason required), the reasons (grouped, with hints) and the thank-you. Without it the dialog is
   * one tap with the dialog's own words, the same as when `GET /rules` cannot be loaded.
   */
  reporting?: PlayerReporting;
  /** Who is being reported, as the player knows them (a handle). Shown as text in the heading. */
  targetName?: string;
  /** The message being reported. Shown as quoted text (cut if very long) so the player sees what they are reporting. */
  line?: string;
}

// One plain message for each refusal the kit has. Anything else (a refusal a newer kit adds) gets the last one.
const REFUSED_TEXT: Readonly<Record<ReportRefusal, PlayerText>> = {
  duplicate: 'player.report.refused.duplicate',
  rate: 'player.report.refused.rate',
  self: 'player.report.refused.self',
  not_player: 'player.report.refused.not_player',
  off: 'player.report.refused.off',
  suspended: 'player.report.refused.suspended',
  reason_required: 'player.report.refused.reason_required',
  reason_unknown: 'player.report.refused.reason_unknown',
};

/** How much of the reported message is quoted on the screen. */
const LINE_MAX = 280;

/** A failure to send as an error the components can word: anything that is not already a PlayerError is a dropped connection. */
const failureOf = (e: unknown): PlayerError =>
  e instanceof PlayerError ? e : new PlayerError({ status: 0, code: 'network', message: 'Could not reach the server.' });

/** Anything that is not a result object (undefined, null, a string) is not a success and not a crash: it reads as an unknown refusal. */
const resultOf = <T,>(answer: unknown, unknown: T): T => (typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? (answer as T) : unknown);

const quoted = (line: string | undefined): string => {
  const plain = (line ?? '').replace(/\s+/g, ' ').trim();
  return plain.length > LINE_MAX ? `${plain.slice(0, LINE_MAX).trimEnd()}…` : plain;
};

/** The screen to draw: the flow, the reasons as the dialog will list them, and the thank-you. */
interface Screen {
  flow: ReportFlow;
  reasons: ReasonItem[];
  thanks: string;
}

/**
 * A dialog for reporting a message or a player. How it works is the studio's setting (`reporting`, from `GET /rules`):
 * - `one_tap` (the default): one step, "Report this message?" and a Report button. The report is filed at once and the thank-you
 *   shown; an optional "Add a reason" step then attaches a reason and a note to the same report (`onAddDetail`).
 * - `reason_first`: the reasons in groups, then an optional note; a reason can be skipped.
 * - `reason_required`: the same without the skip.
 * The reason is only a hint for the moderators. Every refusal the kit can give has its own plain message. Render it when the player
 * chooses to report, and unmount it in `onClose`.
 */
export function ReportDialog(props: ReportDialogProps) {
  const { onSubmit, onAddDetail, onClose, targetName, line, theme, className, container, returnFocusTo } = props;
  const ui = useUi(props);
  const { t } = ui;
  const heading = useRef<HTMLHeadingElement>(null);
  const picker = useRef<HTMLFieldSetElement>(null);
  // One thing on its way at a time, report or follow-up: a second click, or a second Enter, does nothing.
  const sending = useRef(false);
  const titleId = useId();
  const groupName = useId();
  const noteId = useId();
  const hintId = useId();
  const missingId = useId();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlayerError | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  // How the follow-up after a one-tap report ended, and whether its time is up (the kit takes one until `detailUntil`).
  const [dDone, setDDone] = useState<FollowUpOutcome | null>(null);
  const [expired, setExpired] = useState(false);

  const screen: Screen = (() => {
    // No `reporting` (or something that is not the payload): one tap with the dialog's own words, as when `GET /rules` cannot be loaded.
    const read = readReporting(props.reporting) ?? { flow: 'one_tap' as const, reasons: [], thanks: '' };
    // A flow that asks for a reason has nothing to ask with when the list is empty: it is one tap.
    return { flow: read.reasons.length === 0 ? 'one_tap' : read.flow, reasons: read.reasons, thanks: read.thanks.trim() };
  })();
  const { flow } = screen;
  const groups = groupReasons(screen.reasons);
  const chosen = screen.reasons.find((r) => r.id === reason);
  // The note: when the chosen reason asks for it.
  const showNote = chosen?.asksNote === true;

  // The form is gone once there is an answer: focus goes back to the heading, so the answer is read and focus is not lost.
  useEffect(() => {
    if (result !== null) heading.current?.focus();
  }, [result]);
  useEffect(() => {
    if (dDone !== null) heading.current?.focus();
  }, [dDone]);
  // The follow-up stops being offered when the kit would no longer take it.
  const until = result?.ok === true && typeof result.detailUntil === 'number' && Number.isFinite(result.detailUntil) ? result.detailUntil : null;
  useEffect(() => {
    if (until === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Looks at the clock again when the time comes, so a clock that has not moved does not end the offer early.
    const check = (): void => {
      const left = until - ui.now();
      if (left < 0) setExpired(true);
      else timer = setTimeout(check, Math.min(Math.max(left + 1, 50), 2_000_000_000));
    };
    check();
    return () => clearTimeout(timer);
  }, [until]);

  const send = async (draft: ReportDraft): Promise<void> => {
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      setResult(resultOf<ReportResult>(await onSubmit(draft), { ok: false, refused: 'unknown' } as unknown as ReportResult));
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const trimmed = note.trim();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (sending.current) return;
    if (flow !== 'one_tap' && reason === null) {
      setMissing(true);
      picker.current?.querySelector<HTMLElement>('input')?.focus();
      return;
    }
    const draft: ReportDraft = flow === 'one_tap' ? {} : { reason: reason as string };
    if (showNote && trimmed !== '') draft.note = trimmed;
    void send(draft);
  };
  const skip = (): void => {
    if (sending.current) return;
    void send(showNote && trimmed !== '' ? { note: trimmed } : {});
  };

  const reportId = result?.ok === true && typeof result.reportId === 'string' && result.reportId !== '' ? result.reportId : null;
  const quote = quoted(line);
  const oneTapTitle = quote !== '' ? t('player.report.titleOneTap') : targetName === undefined ? t('player.report.titleOneTapPlayer') : t('player.report.titleOneTapNamed', { name: targetName });
  const title = flow === 'one_tap' ? oneTapTitle : targetName === undefined ? t('player.report.title') : t('player.report.titleNamed', { name: targetName });
  const taken = result?.ok === true;
  const refusal = result !== null && !taken ? result : null;
  // After an answer the heading says what happened (a question would be stale), and focus is on it.
  const shownTitle = result === null ? title : taken ? t('player.report.titleSent') : t('player.report.titleRefused');
  const remaining = taken && typeof result.remaining === 'number' && Number.isFinite(result.remaining) && result.remaining >= 0 ? result.remaining : null;
  const refusedKey = (r: unknown): PlayerText => {
    const refused = (r as { refused?: unknown }).refused;
    return typeof refused === 'string' && Object.hasOwn(REFUSED_TEXT, refused) ? REFUSED_TEXT[refused as ReportRefusal] : 'player.report.refused.unknown';
  };
  const detailRefusedKey = (refused: string): PlayerText => (Object.hasOwn(DETAIL_REFUSED_TEXT, refused) ? (DETAIL_REFUSED_TEXT[refused] as PlayerText) : 'player.report.detail.failed');
  const detailUntil = taken && typeof result.detailUntil === 'number' && Number.isFinite(result.detailUntil) ? result.detailUntil : null;
  const timeUp = expired || (detailUntil !== null && ui.now() > detailUntil);
  const canFollow = taken && flow === 'one_tap' && reportId !== null && onAddDetail !== undefined && screen.reasons.length > 0 && !timeUp;
  const needText: PlayerText = flow === 'reason_first' ? 'player.report.needReasonOrSkip' : 'player.report.needReason';

  return (
    <Portal container={container}>
    <Root theme={theme} className={className}>
      <Dialog labelledBy={titleId} initialFocus={heading} onEscape={() => !sending.current && onClose()} {...(returnFocusTo === undefined ? {} : { returnFocusTo })}>
        <h2 id={titleId} ref={heading} className="cw-title" tabIndex={-1}>
          {shownTitle}
        </h2>
        {/* Always there, so what is written into it is announced: the thank-you, and "Added. Thanks.". */}
        <div role="status" className="cw-live">
          {taken && (
            <p className="cw-result">
              {screen.thanks === '' ? t('player.report.thanks') : screen.thanks}
              {remaining !== null && ` ${t('player.report.remaining', { count: remaining })}`}
            </p>
          )}
          {dDone?.ok === true && <p className="cw-result">{t('player.report.detail.added')}</p>}
        </div>
        {result === null ? (
          <form onSubmit={submit} noValidate>
            <p className="cw-body">{flow === 'one_tap' ? t('player.report.oneTap.intro') : t('player.report.intro')}</p>
            {quote !== '' && <blockquote className="cw-quote">{t('player.report.quote', { line: quote })}</blockquote>}
            {flow !== 'one_tap' && (
              <Picker
                groups={groups}
                name={groupName}
                value={reason}
                legend={t('player.report.legend')}
                invalid={missing}
                describedBy={missingId}
                fieldset={picker}
                onChange={(id) => {
                  setReason(id);
                  setMissing(false);
                }}
              />
            )}
            {missing && (
              <p id={missingId} className="cw-field-error" role="alert">
                {t(needText)}
              </p>
            )}
            {showNote && (
              <>
                <label className="cw-label" htmlFor={noteId}>
                  {t('player.report.note')}
                </label>
                <textarea id={noteId} className="cw-textarea" rows={4} maxLength={NOTE_MAX} value={note} aria-describedby={hintId} onChange={(e) => setNote(e.target.value)} />
                <p id={hintId} className="cw-hint">
                  {t('player.report.noteHint', { max: NOTE_MAX })}
                </p>
              </>
            )}
            {failure !== null && (
              <p className="cw-error" role="alert">
                {t('player.report.failed')} {errorText(t, failure)}
              </p>
            )}
            <div className="cw-actions">
              <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={busy || undefined} aria-busy={busy || undefined}>
                {flow === 'one_tap' ? t('player.report.oneTap.send') : t('player.report.send')}
              </button>
              {flow === 'reason_first' && (
                <button type="button" className="cw-btn" aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={skip}>
                  {t('player.report.skip')}
                </button>
              )}
              {/* Closing while a report is on its way would lose the answer: busy, like Escape. */}
              <button type="button" className="cw-btn" aria-disabled={busy || undefined} onClick={() => !sending.current && onClose()}>
                {t('player.report.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <>
            {!taken && (
              <p className="cw-error" role="alert">
                {t(refusedKey(refusal))}
              </p>
            )}
            {canFollow && dDone === null && (
              <FollowUp t={t} groups={groups} reportId={reportId} onAddDetail={onAddDetail} sending={sending} busy={busy} onBusy={setBusy} onDone={setDDone} />
            )}
            {dDone !== null && !dDone.ok && (
              <p className="cw-error" role="alert">
                {t(detailRefusedKey(dDone.refused))}
              </p>
            )}
            <div className="cw-actions">
              <button type="button" className="cw-btn cw-btn--primary" aria-disabled={busy || undefined} onClick={() => !sending.current && onClose()}>
                {t('player.report.close')}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </Root>
    </Portal>
  );
}
