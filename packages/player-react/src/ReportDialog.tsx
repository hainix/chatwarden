import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import type { PlayerReporting, ReportCategory, ReportDetailResult, ReportFlow, ReportRefusal, ReportResult } from '@chatwarden/core';
import { CATEGORIES, NOTE_MAX } from './categories.js';
import { PlayerError } from './client.js';
import { Dialog } from './Dialog.js';
import type { PlayerText } from './i18n.js';
import { groupReasons, readReporting } from './reporting.js';
import type { ReasonGroup, ReasonItem } from './reporting.js';
import { errorText, Portal, Root, useUi } from './ui.js';
import type { DialogHostProps, PlayerUiProps } from './ui.js';

/**
 * What the player filled in. Your server adds the room and the seats and calls `cw.reports.submit({ ...draft, roomId, reporterSeat,
 * targetSeat })`. A dialog given the studio's `reporting` settings sends `reason` (an id from the list, or nothing); the old dialog
 * (no `reporting`) sends `category`. Either way a reason is only a hint: the moderators decide what a report really is.
 */
export interface ReportDraft {
  /** The reason the player chose: an id from `reporting.reasons`. Left out when none was chosen. */
  reason?: string;
  /** Set instead of `reason` by the old dialog (no `reporting`). */
  category?: ReportCategory;
  /** The note, trimmed; left out when blank. */
  note?: string;
}

/** What the player adds after a one-tap report. Your server calls `cw.reports.addDetail(reportId, reporterSeat, detail)`. */
export interface ReportDetail {
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
   * The optional follow-up after a one-tap report: your server calls `cw.reports.addDetail(reportId, reporterSeat, detail)` (the seat
   * from its own session, never from the page) and returns its `ReportDetailResult`. Without it the "Add a reason" step is not shown.
   */
  onAddDetail?: (reportId: string, detail: ReportDetail) => Promise<ReportDetailResult>;
  /** Called on Escape, Cancel and Close. Unmount the dialog in answer. */
  onClose: () => void;
  /**
   * How reporting works here: `(await playerClient.rules()).reporting`, the `reporting` part of `GET /rules`. It sets the flow
   * (one tap, pick a reason first, reason required), the reasons (grouped, with hints) and the thank-you. Without it the dialog is
   * the old one: a required category, an optional note.
   */
  reporting?: PlayerReporting;
  /** Who is being reported, as the player knows them (a handle). Shown as text in the heading. */
  targetName?: string;
  /** The message being reported. Shown as quoted text (cut if very long) so the player sees what they are reporting. */
  line?: string;
  /** The old categories to offer, in order. Used only without `reporting`. Default (and when none of them is one the kit has): all the kit has. */
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
  reason_required: 'player.report.refused.reason_required',
  reason_unknown: 'player.report.refused.reason_unknown',
};

// The same for the follow-up's refusals.
const DETAIL_REFUSED_TEXT: Readonly<Record<string, PlayerText>> = {
  off: 'player.report.detail.refused.off',
  not_found: 'player.report.detail.refused.not_found',
  not_reporter: 'player.report.detail.refused.not_reporter',
  too_late: 'player.report.detail.refused.too_late',
  already_added: 'player.report.detail.refused.already_added',
  reason_unknown: 'player.report.detail.refused.reason_unknown',
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

/** The screen to draw: the flow, the reasons as the dialog will list them, and the thank-you. `legacy` is the old category dialog. */
interface Screen {
  flow: ReportFlow;
  reasons: ReasonItem[];
  thanks: string;
  legacy: boolean;
}

/** The radios, by group. One radio group (one name) across the groups, so the arrow keys walk all of them and Tab stops once. */
function Picker(props: {
  groups: readonly ReasonGroup[];
  name: string;
  value: string | null;
  onChange: (id: string) => void;
  legend: string;
  invalid?: boolean;
  describedBy?: string | undefined;
  fieldset?: RefObject<HTMLFieldSetElement | null>;
}) {
  const { groups, name, value, onChange, legend, invalid, describedBy, fieldset } = props;
  const base = useId();
  const choice = (r: ReasonItem) => {
    const label = `${base}-${r.id}-l`;
    const hint = `${base}-${r.id}-h`;
    return (
      <label key={r.id} className="cw-choice">
        <input
          type="radio"
          name={name}
          value={r.id}
          checked={value === r.id}
          aria-labelledby={label}
          aria-describedby={r.hint === '' ? undefined : hint}
          onChange={() => onChange(r.id)}
        />
        <span className="cw-choice-text">
          <span id={label}>{r.label}</span>
          {r.hint !== '' && (
            <span id={hint} className="cw-choice-hint">
              {r.hint}
            </span>
          )}
        </span>
      </label>
    );
  };
  return (
    <fieldset ref={fieldset} className="cw-fieldset" role="radiogroup" aria-invalid={invalid || undefined} aria-describedby={invalid ? describedBy : undefined}>
      <legend className="cw-legend">{legend}</legend>
      {groups.map((g, i) =>
        g.name === '' ? (
          <div key={`g${i}`} className="cw-group">
            {g.items.map(choice)}
          </div>
        ) : (
          <fieldset key={`g${i}`} className="cw-fieldset cw-group">
            <legend className="cw-group-legend">{g.name}</legend>
            {g.items.map(choice)}
          </fieldset>
        ),
      )}
    </fieldset>
  );
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
  const { onSubmit, onAddDetail, onClose, targetName, line, categories = CATEGORIES, theme, className, container, returnFocusTo } = props;
  const ui = useUi(props);
  const { t } = ui;
  const heading = useRef<HTMLHeadingElement>(null);
  const picker = useRef<HTMLFieldSetElement>(null);
  // One thing on its way at a time, report or follow-up: a second click, or a second Enter, does nothing.
  const sending = useRef(false);
  const titleId = useId();
  const groupName = useId();
  const detailName = useId();
  const noteId = useId();
  const hintId = useId();
  const missingId = useId();
  const detailNoteId = useId();
  const detailMissingId = useId();
  const panelId = useId();
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlayerError | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  // The follow-up after a one-tap report.
  const [open, setOpen] = useState(false);
  const [dReason, setDReason] = useState<string | null>(null);
  const [dNote, setDNote] = useState('');
  const [dMissing, setDMissing] = useState(false);
  const [dFailure, setDFailure] = useState<PlayerError | null>(null);
  const [dDone, setDDone] = useState<{ ok: true } | { ok: false; refused: string } | null>(null);

  const screen: Screen = (() => {
    const read = readReporting(props.reporting);
    if (read === undefined) {
      // The old dialog. A list that filters to nothing would make a form that can never be sent: fall back to every category.
      const kept = CATEGORIES.filter((c) => categories.includes(c));
      const reasons = (kept.length > 0 ? kept : CATEGORIES).map((c) => ({ id: c, label: t(CATEGORY_TEXT[c]), hint: '', group: '', asksNote: false }));
      return { flow: 'reason_required', reasons, thanks: '', legacy: true };
    }
    // A flow that asks for a reason has nothing to ask with when the list is empty: it is one tap.
    return { flow: read.reasons.length === 0 ? 'one_tap' : read.flow, reasons: read.reasons, thanks: read.thanks.trim(), legacy: false };
  })();
  const { flow, legacy } = screen;
  const groups = groupReasons(screen.reasons);
  const chosen = screen.reasons.find((r) => r.id === reason);
  // The note: always in the old dialog; in the new ones when the chosen reason asks for it.
  const showNote = legacy || chosen?.asksNote === true;

  // The form is gone once there is an answer: focus goes back to the heading, so the answer is read and focus is not lost.
  useEffect(() => {
    if (result !== null) heading.current?.focus();
  }, [result]);
  useEffect(() => {
    if (dDone !== null) heading.current?.focus();
  }, [dDone]);

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
    const draft: ReportDraft = flow === 'one_tap' ? {} : legacy ? { category: reason as ReportCategory } : { reason: reason as string };
    if (showNote && trimmed !== '') draft.note = trimmed;
    void send(draft);
  };
  const skip = (): void => {
    if (sending.current) return;
    void send(showNote && trimmed !== '' ? { note: trimmed } : {});
  };

  const reportId = result?.ok === true && typeof result.reportId === 'string' && result.reportId !== '' ? result.reportId : null;
  const dTrimmed = dNote.trim();
  const addDetail = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (sending.current || reportId === null || onAddDetail === undefined) return;
    if (dReason === null && dTrimmed === '') {
      setDMissing(true);
      return;
    }
    sending.current = true;
    setBusy(true);
    setDFailure(null);
    try {
      const detail: ReportDetail = { ...(dReason === null ? {} : { reason: dReason }), ...(dTrimmed === '' ? {} : { note: dTrimmed }) };
      const answer = resultOf<ReportDetailResult>(await onAddDetail(reportId, detail), { ok: false, refused: 'unknown' } as unknown as ReportDetailResult);
      setDDone(answer.ok === true ? { ok: true } : { ok: false, refused: String((answer as { refused?: unknown }).refused) });
    } catch (error) {
      setDFailure(failureOf(error));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const quote = quoted(line);
  const oneTapTitle = quote !== '' ? t('player.report.titleOneTap') : targetName === undefined ? t('player.report.titleOneTapPlayer') : t('player.report.titleOneTapNamed', { name: targetName });
  const title = flow === 'one_tap' ? oneTapTitle : targetName === undefined ? t('player.report.title') : t('player.report.titleNamed', { name: targetName });
  const taken = result?.ok === true;
  const refusal = result !== null && !taken ? result : null;
  const remaining = taken && typeof result.remaining === 'number' && Number.isFinite(result.remaining) && result.remaining >= 0 ? result.remaining : null;
  const refusedKey = (r: unknown): PlayerText => {
    const refused = (r as { refused?: unknown }).refused;
    return typeof refused === 'string' && Object.hasOwn(REFUSED_TEXT, refused) ? REFUSED_TEXT[refused as ReportRefusal] : 'player.report.refused.unknown';
  };
  const detailRefusedKey = (refused: string): PlayerText => (Object.hasOwn(DETAIL_REFUSED_TEXT, refused) ? (DETAIL_REFUSED_TEXT[refused] as PlayerText) : 'player.report.detail.failed');
  const canFollow = taken && flow === 'one_tap' && !legacy && reportId !== null && onAddDetail !== undefined && screen.reasons.length > 0;
  const needText: PlayerText = legacy ? 'player.report.needCategory' : flow === 'reason_first' ? 'player.report.needReasonOrSkip' : 'player.report.needReason';

  return (
    <Portal container={container}>
    <Root theme={theme} className={className}>
      <Dialog labelledBy={titleId} initialFocus={heading} onEscape={() => !sending.current && onClose()} {...(returnFocusTo === undefined ? {} : { returnFocusTo })}>
        <h2 id={titleId} ref={heading} className="cw-title" tabIndex={-1}>
          {title}
        </h2>
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
            {taken ? (
              <p className="cw-result" role="status">
                {screen.thanks === '' ? t('player.report.thanks') : screen.thanks}
                {remaining !== null && ` ${t('player.report.remaining', { count: remaining })}`}
              </p>
            ) : (
              <p className="cw-error" role="alert">
                {t(refusedKey(refusal))}
              </p>
            )}
            {canFollow && dDone === null && (
              <form onSubmit={(e) => void addDetail(e)} noValidate>
                <button type="button" className="cw-btn cw-disclosure" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
                  {t('player.report.addReason')}
                </button>
                {open && (
                  <div id={panelId} className="cw-panel">
                    <p className="cw-hint">{t('player.report.addReasonHint')}</p>
                    <Picker
                      groups={groups}
                      name={detailName}
                      value={dReason}
                      legend={t('player.report.detail.legend')}
                      invalid={dMissing}
                      describedBy={detailMissingId}
                      onChange={(id) => {
                        setDReason(id);
                        setDMissing(false);
                      }}
                    />
                    {dMissing && (
                      <p id={detailMissingId} className="cw-field-error" role="alert">
                        {t('player.report.detail.need')}
                      </p>
                    )}
                    <label className="cw-label" htmlFor={detailNoteId}>
                      {t('player.report.note')}
                    </label>
                    <textarea
                      id={detailNoteId}
                      className="cw-textarea"
                      rows={3}
                      maxLength={NOTE_MAX}
                      value={dNote}
                      onChange={(e) => {
                        setDNote(e.target.value);
                        setDMissing(false);
                      }}
                    />
                    {dFailure !== null && (
                      <p className="cw-error" role="alert">
                        {t('player.report.detail.failed')} {errorText(t, dFailure)}
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
            )}
            {dDone?.ok === true && (
              <p className="cw-result" role="status">
                {t('player.report.detail.added')}
              </p>
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
