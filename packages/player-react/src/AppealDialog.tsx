import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, MutableRefObject, RefObject } from 'react';
import type { AppealRefusal, PlayerAppeal } from '@chatwarden/core';
import { APPEAL_MAX } from './constants.js';
import { toPlayerError } from './client.js';
import type { PlayerClient, PlayerError } from './client.js';
import { Dialog } from './Dialog.js';
import type { PlayerText } from './i18n.js';
import { errorText, Portal, Root, useUi } from './ui.js';
import type { DialogHostProps, PlayerUiProps, Ui } from './ui.js';

export interface AppealDialogProps extends PlayerUiProps, DialogHostProps {
  /** A client over the player routes (`createPlayerClient`); the dialog calls its `fileAppeal`. */
  client: Pick<PlayerClient, 'fileAppeal'>;
  /** The notice the appeal is about: the id of a notice from `NoticeQueue` or `MyRecord`'s list (`PlayerNotice.id`). */
  noticeId: string;
  /**
   * Called on Escape, Cancel and Close, once. With the appeal when one was filed in this dialog (so the host can write "Appeal sent" in
   * its place), and with nothing when the player left without sending. Unmount the dialog in answer. It is not called while a send is on its way.
   */
  onClose: (sent?: PlayerAppeal) => void;
}

/** What the host of an appeal form needs to read from it (Escape lives in the host's dialog): a send in flight, and the appeal once filed. */
export interface AppealState {
  busy: boolean;
  sent: PlayerAppeal | null;
}

/** Leaves the form: with the appeal when one was filed, and never while a send is on its way. */
export function leaveAppeal(state: AppealState, onClose: (sent?: PlayerAppeal) => void): void {
  if (state.busy) return;
  if (state.sent === null) onClose();
  else onClose(state.sent);
}

// One plain message for each refusal the kit has; `off` and `not_appealable` read as `not_found`, as the route answers them (one answer).
const REFUSED_TEXT: Readonly<Record<AppealRefusal, PlayerText>> = {
  already_appealed: 'player.appeal.refused.already_appealed',
  rate: 'player.appeal.refused.rate',
  not_found: 'player.appeal.refused.not_found',
  off: 'player.appeal.refused.not_found',
  not_appealable: 'player.appeal.refused.not_found',
  statement_invalid: 'player.appeal.refused.invalid',
};

/**
 * The inside of the appeal dialog: the heading, the one field with its count, Send and Cancel, and the "sent" screen. `NoticeQueue` puts it
 * inside its own dialog (a second dialog on top would fight for focus); `AppealDialog` wraps it in a dialog of its own.
 */
export function AppealBody({
  ui,
  client,
  noticeId,
  titleId,
  heading,
  state,
  onClose,
}: {
  ui: Ui;
  client: Pick<PlayerClient, 'fileAppeal'>;
  noticeId: string;
  titleId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  state: MutableRefObject<AppealState>;
  onClose: (sent?: PlayerAppeal) => void;
}) {
  const { t } = ui;
  const fieldId = useId();
  const hintId = useId();
  const countId = useId();
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<AppealRefusal | null>(null);
  const [failure, setFailure] = useState<PlayerError | null>(null);
  const [sent, setSent] = useState<PlayerAppeal | null>(null);

  // The heading is what a screen reader reads first, when the form opens and again when the answer replaces it.
  useEffect(() => heading.current?.focus(), [sent, heading]);

  // The statement is counted as the server counts it: trimmed, in characters (code points), not UTF-16 units. It is sent as typed.
  const count = [...statement.trim()].length;
  const empty = count === 0;
  const over = count > APPEAL_MAX;

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (state.current.busy || empty || over) return;
    state.current.busy = true;
    setBusy(true);
    setRefused(null);
    setFailure(null);
    try {
      const result = await client.fileAppeal(noticeId, statement);
      if (result.ok) {
        state.current.sent = result.appeal;
        setSent(result.appeal);
      } else setRefused(result.refused);
    } catch (error) {
      setFailure(toPlayerError(error));
    } finally {
      state.current.busy = false;
      setBusy(false);
    }
  };

  const refusal = refused === null ? null : Object.hasOwn(REFUSED_TEXT, refused) ? REFUSED_TEXT[refused] : 'player.appeal.failed';
  const problem = over ? t('player.appeal.refused.invalid', { max: APPEAL_MAX }) : refusal !== null ? t(refusal, { max: APPEAL_MAX }) : null;

  return (
    <>
      <h2 id={titleId} ref={heading} className="cw-title" tabIndex={-1}>
        {t('player.appeal.title')}
      </h2>
      {/* Always there, so what is written into it is announced. */}
      <div role="status" className="cw-live">
        {sent !== null && <p className="cw-result">{t('player.appeal.sent')}</p>}
      </div>
      {sent === null ? (
        <form onSubmit={(e) => void submit(e)} noValidate>
          <p className="cw-body">{t('player.appeal.intro')}</p>
          <div className="cw-field">
            <label className="cw-label" htmlFor={fieldId}>
              {t('player.appeal.label')}
            </label>
            {/* No maxlength: a long paste is counted and refused, never cut. */}
            <textarea
              id={fieldId}
              className="cw-textarea"
              rows={5}
              value={statement}
              aria-invalid={over || undefined}
              aria-describedby={`${hintId} ${countId}`}
              onChange={(e) => {
                setStatement(e.target.value);
                setRefused(null);
                setFailure(null);
              }}
            />
            <p id={hintId} className="cw-hint">
              {t('player.appeal.hint', { max: APPEAL_MAX })}
            </p>
            <p id={countId} className="cw-hint">
              {t('player.appeal.count', { n: count, max: APPEAL_MAX })}
            </p>
            {problem !== null && (
              <p className="cw-field-error" role="alert">
                {problem}
              </p>
            )}
          </div>
          {failure !== null && (
            <p className="cw-error" role="alert">
              {t('player.appeal.failed')} {errorText(t, failure)}
            </p>
          )}
          <div className="cw-actions">
            <button
              type="submit"
              className="cw-btn cw-btn--primary"
              disabled={(empty || over) && !busy}
              aria-disabled={busy || undefined}
              aria-busy={busy || undefined}
            >
              {t('player.appeal.send')}
            </button>
            {/* Closing while an appeal is on its way would lose the answer: busy, like Escape. */}
            <button type="button" className="cw-btn" aria-disabled={busy || undefined} onClick={() => leaveAppeal(state.current, onClose)}>
              {t('player.appeal.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="cw-actions">
          <button type="button" className="cw-btn cw-btn--primary" onClick={() => leaveAppeal(state.current, onClose)}>
            {t('player.appeal.close')}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * A dialog for appealing a sanction: the player says in their own words what they think was wrong (a textarea with a live count against
 * 1000 characters), presses Send, and is told the appeal was sent; each refusal the kit can give has its own plain message, shown in the form.
 * `NoticeQueue` and `MyRecord` open it for you when you pass them `appeals`; render it yourself when you build your own screen: it
 * sends through `client.fileAppeal(noticeId, statement)`, and unmounts in your `onClose`. Focus goes back to the button that opened it.
 * @experimental
 */
export function AppealDialog(props: AppealDialogProps) {
  const { client, noticeId, onClose, theme, className, container, returnFocusTo } = props;
  const ui = useUi(props);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const state = useRef<AppealState>({ busy: false, sent: null });
  return (
    <Portal container={container}>
      <Root theme={theme} className={className}>
        <Dialog labelledBy={titleId} initialFocus={heading} onEscape={() => leaveAppeal(state.current, onClose)} {...(returnFocusTo === undefined ? {} : { returnFocusTo })}>
          <AppealBody ui={ui} client={client} noticeId={noticeId} titleId={titleId} heading={heading} state={state} onClose={onClose} />
        </Dialog>
      </Root>
    </Portal>
  );
}
