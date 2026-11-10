import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ReportCategory, ReportRefusal, ReportResult } from '@chatwarden/core';
import { CATEGORIES, NOTE_MAX } from './categories.js';
import { PlayerError } from './client.js';
import { Dialog } from './Dialog.js';
import type { PlayerText } from './i18n.js';
import { errorText, Portal, Root, useUi } from './ui.js';
import type { DialogHostProps, PlayerUiProps } from './ui.js';

/** What the player filled in. Your server adds the room and the seats and calls `cw.reports.submit`. */
export interface ReportDraft {
  category: ReportCategory;
  /** The note, trimmed; left out when blank. */
  note?: string;
}

export interface ReportDialogProps extends PlayerUiProps, DialogHostProps {
  /**
   * Sends the report: your server calls `cw.reports.submit({ ...draft, roomId, reporterSeat, targetSeat })` and returns its
   * `ReportResult`. A refusal is a result, not an error; reject only when no answer arrived.
   */
  onSubmit: (draft: ReportDraft) => Promise<ReportResult>;
  /** Called on Escape, Cancel and Close. Unmount the dialog in answer. */
  onClose: () => void;
  /** Who is being reported, as the player knows them (a handle). Shown as text in the heading. */
  targetName?: string;
  /** The categories to offer, in order. Default (and when none of them is one the kit has): all the kit has. */
  categories?: readonly ReportCategory[];
}

const CATEGORY_TEXT: Readonly<Record<ReportCategory, PlayerText>> = {
  harassment: 'player.report.category.harassment',
  hate: 'player.report.category.hate',
  cheating: 'player.report.category.cheating',
  spam: 'player.report.category.spam',
  disruption: 'player.report.category.disruption',
  other: 'player.report.category.somethingElse',
};

// One plain message for each refusal the kit has. Anything else (a refusal a newer kit adds) gets the last one.
const REFUSED_TEXT: Readonly<Record<ReportRefusal, PlayerText>> = {
  duplicate: 'player.report.refused.duplicate',
  rate: 'player.report.refused.rate',
  self: 'player.report.refused.self',
  not_player: 'player.report.refused.not_player',
  off: 'player.report.refused.off',
  suspended: 'player.report.refused.suspended',
};

/** A failure to send as an error the components can word: anything that is not already a PlayerError is a dropped connection. */
const failureOf = (e: unknown): PlayerError =>
  e instanceof PlayerError ? e : new PlayerError({ status: 0, code: 'network', message: 'Could not reach the server.' });

/**
 * A dialog for reporting a player: a category, an optional note, and a plain answer. It maps every refusal the kit can give to
 * its own message and shows how many reports are left today after a good one. Render it when the player chooses to report, and
 * unmount it in `onClose`.
 */
export function ReportDialog(props: ReportDialogProps) {
  const { onSubmit, onClose, targetName, categories = CATEGORIES, theme, className, container, returnFocusTo } = props;
  const ui = useUi(props);
  const { t } = ui;
  const heading = useRef<HTMLHeadingElement>(null);
  const picker = useRef<HTMLFieldSetElement>(null);
  const sending = useRef(false);
  const titleId = useId();
  const groupName = useId();
  const noteId = useId();
  const hintId = useId();
  const missingId = useId();
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlayerError | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  // A list that filters to nothing would make a form that can never be sent: fall back to every category.
  const kept = CATEGORIES.filter((c) => categories.includes(c));
  const offered = kept.length > 0 ? kept : CATEGORIES;

  // The form is gone once there is an answer: focus goes back to the heading, so the answer is read and focus is not lost.
  useEffect(() => {
    if (result !== null) heading.current?.focus();
  }, [result]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    // One report at a time: a second click, or a second Enter, while one is on its way does nothing.
    if (sending.current) return;
    if (category === null) {
      setMissing(true);
      picker.current?.querySelector<HTMLElement>('input')?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const trimmed = note.trim();
      const answer: unknown = await onSubmit({ category, ...(trimmed === '' ? {} : { note: trimmed }) });
      // Anything that is not a result object (undefined, null, a string) is not a success and not a crash: it reads as an unknown refusal.
      setResult(typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? (answer as ReportResult) : ({ ok: false, refused: 'unknown' } as unknown as ReportResult));
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const title = targetName === undefined ? t('player.report.title') : t('player.report.titleNamed', { name: targetName });
  const taken = result?.ok === true;
  const refusal = result !== null && !taken ? result : null;
  const remaining = taken && typeof result.remaining === 'number' && Number.isFinite(result.remaining) && result.remaining >= 0 ? result.remaining : null;
  const refusedKey = (r: unknown): PlayerText => {
    const refused = (r as { refused?: unknown }).refused;
    return typeof refused === 'string' && Object.hasOwn(REFUSED_TEXT, refused) ? REFUSED_TEXT[refused as ReportRefusal] : 'player.report.refused.unknown';
  };

  return (
    <Portal container={container}>
    <Root theme={theme} className={className}>
      <Dialog labelledBy={titleId} initialFocus={heading} onEscape={() => !sending.current && onClose()} {...(returnFocusTo === undefined ? {} : { returnFocusTo })}>
        <h2 id={titleId} ref={heading} className="cw-title" tabIndex={-1}>
          {title}
        </h2>
        {result === null ? (
          <form onSubmit={(e) => void submit(e)} noValidate>
            <p className="cw-body">{t('player.report.intro')}</p>
            <fieldset ref={picker} className="cw-fieldset" role="radiogroup" aria-invalid={missing || undefined} aria-describedby={missing ? missingId : undefined}>
              <legend className="cw-legend">{t('player.report.legend')}</legend>
              {offered.map((c) => (
                <label key={c} className="cw-choice">
                  <input
                    type="radio"
                    name={groupName}
                    value={c}
                    checked={category === c}
                    onChange={() => {
                      setCategory(c);
                      setMissing(false);
                    }}
                  />
                  <span>{t(CATEGORY_TEXT[c])}</span>
                </label>
              ))}
            </fieldset>
            {missing && (
              <p id={missingId} className="cw-field-error" role="alert">
                {t('player.report.needCategory')}
              </p>
            )}
            <label className="cw-label" htmlFor={noteId}>
              {t('player.report.note')}
            </label>
            <textarea id={noteId} className="cw-textarea" rows={4} maxLength={NOTE_MAX} value={note} aria-describedby={hintId} onChange={(e) => setNote(e.target.value)} />
            <p id={hintId} className="cw-hint">
              {t('player.report.noteHint', { max: NOTE_MAX })}
            </p>
            {failure !== null && (
              <p className="cw-error" role="alert">
                {t('player.report.failed')} {errorText(t, failure)}
              </p>
            )}
            <div className="cw-actions">
              <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={busy || undefined} aria-busy={busy || undefined}>
                {t('player.report.send')}
              </button>
              {/* Closing while a report is on its way would lose the answer: busy, like Escape. */}
              <button type="button" className="cw-btn" aria-disabled={busy || undefined} onClick={() => !sending.current && onClose()}>
                {t('player.report.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <>
            {taken ? (
              <p className="cw-result" role="status">
                {t('player.report.thanks')}
                {remaining !== null && ` ${t('player.report.remaining', { count: remaining })}`}
              </p>
            ) : (
              <p className="cw-error" role="alert">
                {t(refusedKey(refusal))}
              </p>
            )}
            <div className="cw-actions">
              <button type="button" className="cw-btn cw-btn--primary" onClick={onClose}>
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
