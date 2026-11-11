import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PlayerReporting, ReportDetailResult, ReportRefusal, ReportResult } from '@chatwarden/core';
import { NOTE_MAX } from './constants.js';
import { PlayerError } from './client.js';
import { Dialog } from './Dialog.js';
import type { PlayerText } from './i18n.js';
import { groupReasons, readReporting } from './reporting.js';
import { errorText, Portal, Root, useUi } from './ui.js';
import type { DialogHostProps, PlayerUiProps } from './ui.js';

/**
 * What the player filled in. Your server adds the room and the seats and calls `cw.reports.submit({ ...draft, roomId, reporterSeat,
 * targetSeat })`. The dialog sends `reason` (an id from the studio's `reporting` list, or nothing) and `note` in the one report. A
 * reason is only a hint: the moderators decide what a report really is.
 */
export interface ReportDraft {
  /** The reason the player chose: an id from `reporting.reasons`. Left out when none was chosen. */
  reason?: string;
  /** The note, trimmed; left out when blank. */
  note?: string;
}

/**
 * A reason and a note added to a report after it was filed (`cw.reports.addDetail`). The dialog no longer has a follow-up step (the
 * reason and the note go in the one report), so this is only the shape a follow-up of your own may take.
 */
export interface ReportFollowUp {
  reason?: string;
  note?: string;
}

export interface ReportDialogProps extends PlayerUiProps, DialogHostProps {
  /**
   * Sends the report: your server calls `cw.reports.submit({ ...draft, roomId, reporterSeat, targetSeat })` and returns its
   * `ReportResult`. A refusal is a result, not an error; reject only when no answer arrived.
   */
  onSubmit: (draft: ReportDraft) => Promise<ReportResult>;
  /**
   * @deprecated The dialog is one step now: the reason and the note go in the single `onSubmit`, so this is accepted but never
   * called. Remove it. (`cw.reports.addDetail` is still there for a follow-up of your own.)
   */
  onAddDetail?: (reportId: string, detail: ReportFollowUp) => Promise<ReportDetailResult>;
  /** Called on Escape, Cancel and Close. Unmount the dialog in answer. */
  onClose: () => void;
  /**
   * How reporting works here: `(await createPlayerClient.rules()).reporting`, the `reporting` part of `GET /rules`. It gives the
   * reasons (grouped, with hints), whether a reason is required, and the thank-you. Without it the dialog has no reasons to offer:
   * one press files the report, with the dialog's own words, the same as when `GET /rules` cannot be loaded.
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

/**
 * A dialog for reporting a message or a player, in one step: "Report this message?", the quoted line, an optional "Why?" (one
 * select, the reasons in groups) and a Report button. A note is behind "Add a note", or shown when the chosen reason asks for one.
 * Report sends the reason and the note together (`onSubmit`); the dialog then says "Report sent" and the thank-you. The studio's
 * `reporting` setting decides whether the reason is required (`reason_required`: the select is required, and Report without a
 * reason asks for one and sends nothing), what the reasons are, and the thank-you. The reason is only a hint for the moderators.
 * Every refusal the kit can give has its own plain message. Render it when the player chooses to report, and unmount it in `onClose`.
 */
export function ReportDialog(props: ReportDialogProps) {
  const { onSubmit, onClose, targetName, line, theme, className, container, returnFocusTo } = props;
  const ui = useUi(props);
  const { t } = ui;
  const heading = useRef<HTMLHeadingElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  // One report on its way at a time: a second click, or a second Enter, does nothing.
  const sending = useRef(false);
  const titleId = useId();
  const reasonId = useId();
  const noteId = useId();
  const noteHintId = useId();
  const reasonHintId = useId();
  const missingId = useId();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  // The note is shown once it was asked for (the "Add a note" button, or a reason that asks for one) and then stays.
  const [noteOpen, setNoteOpen] = useState(false);
  const [focusNote, setFocusNote] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlayerError | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);

  // No `reporting` (or something that is not the payload): no reasons to offer, as when `GET /rules` cannot be loaded.
  const read = readReporting(props.reporting) ?? { flow: 'one_tap' as const, reasons: [], thanks: '' };
  const thanks = read.thanks.trim();
  const hasReasons = read.reasons.length > 0;
  // A flow that asks for a reason has nothing to ask with when the list is empty.
  const required = hasReasons && read.flow === 'reason_required';
  const groups = groupReasons(read.reasons);
  const named = groups.filter((g) => g.name !== '');
  const bare = groups.filter((g) => g.name === '').flatMap((g) => g.items);
  const chosen = read.reasons.find((r) => r.id === reason);
  const hint = chosen !== undefined && chosen.hint !== '' ? chosen.hint : null;
  const noteShown = hasReasons && noteOpen;

  // The form is gone once there is an answer: focus goes back to the heading, so the answer is read and focus is not lost.
  useEffect(() => {
    if (result !== null) heading.current?.focus();
  }, [result]);
  // "Add a note" is replaced by the field: focus follows it.
  useEffect(() => {
    if (focusNote) {
      noteField.current?.focus();
      setFocusNote(false);
    }
  }, [focusNote]);

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
    if (required && reason === '') {
      setMissing(true);
      select.current?.focus();
      return;
    }
    const draft: ReportDraft = {};
    if (reason !== '') draft.reason = reason;
    if (noteShown && trimmed !== '') draft.note = trimmed;
    void send(draft);
  };

  const quote = quoted(line);
  const title = quote !== '' ? t('player.report.titleOneTap') : targetName === undefined ? t('player.report.titleOneTapPlayer') : t('player.report.titleOneTapNamed', { name: targetName });
  const taken = result?.ok === true;
  const refusal = result !== null && !taken ? result : null;
  // After an answer the heading says what happened (a question would be stale), and focus is on it.
  const shownTitle = result === null ? title : taken ? t('player.report.titleSent') : t('player.report.titleRefused');
  const remaining = taken && typeof result.remaining === 'number' && Number.isFinite(result.remaining) && result.remaining >= 0 ? result.remaining : null;
  const refusedKey = (r: unknown): PlayerText => {
    const refused = (r as { refused?: unknown }).refused;
    return typeof refused === 'string' && Object.hasOwn(REFUSED_TEXT, refused) ? REFUSED_TEXT[refused as ReportRefusal] : 'player.report.refused.unknown';
  };
  const option = (r: { id: string; label: string }) => (
    <option key={r.id} value={r.id}>
      {r.label}
    </option>
  );
  const describedBy = [hint === null ? '' : reasonHintId, missing ? missingId : ''].filter((id) => id !== '').join(' ');

  return (
    <Portal container={container}>
    <Root theme={theme} className={className}>
      <Dialog labelledBy={titleId} initialFocus={heading} onEscape={() => !sending.current && onClose()} {...(returnFocusTo === undefined ? {} : { returnFocusTo })}>
        <h2 id={titleId} ref={heading} className="cw-title" tabIndex={-1}>
          {shownTitle}
        </h2>
        {/* Always there, so what is written into it is announced: the thank-you. */}
        <div role="status" className="cw-live">
          {taken && (
            <p className="cw-result">
              {thanks === '' ? t('player.report.thanks') : thanks}
              {remaining !== null && ` ${t('player.report.remaining', { count: remaining })}`}
            </p>
          )}
        </div>
        {result === null ? (
          <form onSubmit={submit} noValidate>
            <p className="cw-body">{required ? t('player.report.intro') : t('player.report.oneTap.intro')}</p>
            {quote !== '' && <blockquote className="cw-quote">{t('player.report.quote', { line: quote })}</blockquote>}
            {hasReasons && (
              <div className="cw-field">
                <label className="cw-label" htmlFor={reasonId}>
                  {required ? t('player.report.whyRequired') : t('player.report.why')}
                </label>
                <select
                  id={reasonId}
                  ref={select}
                  className="cw-select"
                  value={reason}
                  required={required}
                  aria-invalid={missing || undefined}
                  aria-describedby={describedBy === '' ? undefined : describedBy}
                  onChange={(e) => {
                    const id = e.target.value;
                    setReason(id);
                    setMissing(false);
                    if (read.reasons.find((r) => r.id === id)?.asksNote === true) setNoteOpen(true);
                  }}
                >
                  <option value="">{required ? t('player.report.chooseRequired') : t('player.report.choose')}</option>
                  {named.map((g) => (
                    <optgroup key={g.name} label={g.name}>
                      {g.items.map(option)}
                    </optgroup>
                  ))}
                  {bare.map(option)}
                </select>
                {hint !== null && (
                  <p id={reasonHintId} className="cw-hint">
                    {hint}
                  </p>
                )}
                {missing && (
                  <p id={missingId} className="cw-field-error" role="alert">
                    {t('player.report.needReason')}
                  </p>
                )}
              </div>
            )}
            {noteShown && (
              <div className="cw-field">
                <label className="cw-label" htmlFor={noteId}>
                  {t('player.report.note')}
                </label>
                <textarea id={noteId} ref={noteField} className="cw-textarea" rows={3} maxLength={NOTE_MAX} value={note} aria-describedby={noteHintId} onChange={(e) => setNote(e.target.value)} />
                <p id={noteHintId} className="cw-hint">
                  {t('player.report.noteHint', { max: NOTE_MAX })}
                </p>
              </div>
            )}
            {hasReasons && !noteShown && (
              <button
                type="button"
                className="cw-linkbtn"
                onClick={() => {
                  setNoteOpen(true);
                  setFocusNote(true);
                }}
              >
                {t('player.report.addNote')}
              </button>
            )}
            {failure !== null && (
              <p className="cw-error" role="alert">
                {t('player.report.failed')} {errorText(t, failure)}
              </p>
            )}
            <div className="cw-actions">
              <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={busy || undefined} aria-busy={busy || undefined}>
                {t('player.report.oneTap.send')}
              </button>
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
