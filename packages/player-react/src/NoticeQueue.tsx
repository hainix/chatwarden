import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerAppeal, PlayerNotice } from '@chatwarden/core';
import { AppealBody, leaveAppeal } from './AppealDialog.js';
import type { AppealState } from './AppealDialog.js';
import { AppealSlot, useAppeals } from './appeals.js';
import type { AppealsView } from './appeals.js';
import { toPlayerError } from './client.js';
import type { PlayerClient, PlayerError } from './client.js';
import { Dialog } from './Dialog.js';
import { usePlayerData } from './hooks.js';
import { AppealLink, bodyKey, Card, errorText, Facts, isSanction, Lines, Portal, Root, titleKey, useUi } from './ui.js';
import type { DialogHostProps, PlayerUiProps, Ui } from './ui.js';

export interface NoticeQueueProps extends PlayerUiProps, DialogHostProps {
  client: PlayerClient;
  /**
   * Whether a notice may appear now. Pass `false` during a match: notices are held (kept, not dropped, not acknowledged) and
   * appear, oldest first, when it turns `true` again; the list is asked for once more at that moment, so a notice that arrived during
   * the match is not missed. Default: `true`.
   */
  canShow?: boolean;
  /** Where "Think this is a mistake?" goes: an `https` address or a relative one (`/appeal`). Left out when absent or unsafe. Not used with `appeals`. */
  appealUrl?: string;
  /**
   * @experimental Let the player appeal a sanction from here (the kit's appeals, `profile.appeals`, must be on). "Think this is a mistake?" is then
   * a button that opens the appeal form in place of the notice, and `appealUrl` is not used; once an appeal is sent the same place reads
   * "Appeal sent <date>", and later the outcome in words. Default false: the `appealUrl` link, exactly as before, and no extra request.
   */
  appeals?: boolean;
  /** Change it to ask the server again (for example when your own push channel says a notice is pending). */
  refreshKey?: number | string;
  /** Called once for each notice the player acknowledged. */
  onAcknowledged?: (notice: PlayerNotice) => void;
  /** Called with how many notices are waiting (shown or held) each time that number changes, after the first load. */
  onPendingChange?: (count: number) => void;
}

/**
 * Shows the player's pending notices, oldest first, one at a time in a modal dialog. Every notice is acknowledged (a warning with
 * "Acknowledge", the others with "Got it"); the dialog closes after the last one and focus returns to where it was.
 */
export function NoticeQueue(props: NoticeQueueProps) {
  const { client, canShow = true, appealUrl, appeals: appealsProp = false, refreshKey, onAcknowledged, onPendingChange, theme, className, container, returnFocusTo } = props;
  const ui = useUi(props);
  const state = usePlayerData(() => client.notices(), refreshKey);
  // The ids acknowledged since this list arrived. A newer list replaces both, so the server stays the truth.
  const [done, setDone] = useState<{ list: PlayerNotice[] | undefined; ids: readonly string[] }>({ list: undefined, ids: [] });
  const gone = done.list === state.data ? done.ids : [];
  const queue = (state.data ?? []).filter((n) => !gone.includes(n.id)).sort((a, b) => a.createdAt - b.createdAt);
  const count = queue.length;
  const loaded = state.data !== undefined;
  // "Close for now" after a failed acknowledge hides the queue until a newer list arrives (a refresh, or the next release of a hold).
  const [later, setLater] = useState<PlayerNotice[] | undefined>(undefined);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const reload = state.reload;
  const appeals = useAppeals(client, appealsProp, refreshKey);
  // The notice whose appeal form is open (in place of the notice, inside the same dialog), and the notice whose appeal control takes focus
  // when the notice comes back.
  const [appealFor, setAppealFor] = useState<string | null>(null);
  const [returned, setReturned] = useState<string | null>(null);
  const appealState = useRef<AppealState>({ busy: false, sent: null, draft: '' });
  // A send is recorded the moment it is filed, even while the hold has the dialog away: the card says "Appeal sent" when it comes back.
  appealState.current.onSent = appeals.add;
  const closeAppeal = useCallback(
    (sent?: PlayerAppeal) => {
      if (sent !== undefined) appeals.add(sent);
      setReturned(appealFor);
      setAppealFor(null);
    },
    [appeals.add, appealFor],
  );

  // Releasing a hold asks the server once more: a warning that landed during the match must be seen before the next one.
  const wasShown = useRef(canShow);
  useEffect(() => {
    if (canShow && !wasShown.current) reload();
    wasShown.current = canShow;
  }, [canShow, reload]);

  const told = useRef(onPendingChange);
  told.current = onPendingChange;
  useEffect(() => {
    if (loaded) told.current?.(count);
  }, [loaded, count]);

  if (!canShow) return null;
  if (state.data === undefined) {
    if (state.error === null) return null;
    return (
      <Root theme={theme} className={className}>
        <div className="cw-error" role="alert">
          <p>
            <strong>{ui.t('player.notices.loadFailed')}</strong> {errorText(ui.t, state.error)}
          </p>
          <button type="button" className="cw-btn" onClick={state.reload}>
            {ui.t('player.state.retry')}
          </button>
        </div>
      </Root>
    );
  }
  const current = queue[0];
  if (current === undefined || later === state.data) return null;

  const acknowledged = (notice: PlayerNotice): void => {
    setDone({ list: state.data, ids: [...gone, notice.id] });
    onAcknowledged?.(notice);
  };

  return (
    <Portal container={container}>
    <Root theme={theme} className={className}>
      {/* One dialog for the whole queue: it opens once and closes once, so focus comes back to where it was after the last notice. */}
      <Dialog
        labelledBy={titleId}
        initialFocus={heading}
        {...(appealFor === null ? {} : { onEscape: () => leaveAppeal(appealState.current, closeAppeal) })}
        {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
      >
        {appealFor === current.id ? (
          <AppealBody ui={ui} client={client} noticeId={current.id} titleId={titleId} heading={heading} state={appealState} onClose={closeAppeal} />
        ) : (
          <NoticeCard
            key={current.id}
            ui={ui}
            client={client}
            notice={current}
            total={count}
            appealUrl={appealUrl}
            appeals={appealsProp ? appeals : null}
            returned={returned === current.id}
            onReturned={() => setReturned(null)}
            onAppeal={() => {
              appealState.current = { busy: false, sent: null, draft: '', onSent: appeals.add };
              setAppealFor(current.id);
            }}
            titleId={titleId}
            heading={heading}
            onDone={acknowledged}
            onLater={() => setLater(state.data)}
          />
        )}
      </Dialog>
    </Root>
    </Portal>
  );
}

function NoticeCard({
  ui,
  client,
  notice,
  total,
  appealUrl,
  appeals,
  returned,
  onReturned,
  onAppeal,
  titleId,
  heading,
  onDone,
  onLater,
}: {
  ui: Ui;
  client: PlayerClient;
  notice: PlayerNotice;
  /** How many notices are waiting, this one included. It is always the first. */
  total: number;
  appealUrl: string | undefined;
  /** The player's appeals when `appeals` is on; null when it is off (then the old link, if any). */
  appeals: AppealsView | null;
  /** The appeal form has just closed: focus goes to the appeal control, not the heading. */
  returned: boolean;
  onReturned: () => void;
  onAppeal: () => void;
  titleId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  onDone: (notice: PlayerNotice) => void;
  onLater: () => void;
}) {
  const { t } = ui;
  const linesId = useId();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlayerError | null>(null);

  // Each notice, not only the first, takes focus at its heading: it is what a screen reader should read next.
  useEffect(() => (returned ? undefined : heading.current?.focus()), []);

  const acknowledge = async (): Promise<void> => {
    // One request at a time: a second click, or a second Enter, while one is on its way does nothing.
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await client.ack(notice.id);
      // `false` (a 200 that is not ours) and a 404 both mean the notice is no longer pending: it is done.
      onDone(notice);
    } catch (e) {
      const error = toPlayerError(e);
      if (error.status === 404) onDone(notice);
      else setFailure(error);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const mustAck = notice.kind === 'warning' || notice.mustAcknowledge;
  return (
    <>
      {/* Always drawn, so a screen reader that has seen it empty hears it when a second notice arrives. */}
      <p className="cw-position" aria-live="polite">
        {total > 1 ? t('player.notice.position', { n: 1, total }) : null}
      </p>
      <div className="cw-head">
        <Card kind={notice.kind} />
        <h2 id={titleId} ref={heading} className="cw-title" tabIndex={-1}>
          {t(titleKey(notice.kind))}
        </h2>
      </div>
      <p className="cw-body">{t(bodyKey(notice.kind))}</p>
      <Facts ui={ui} notice={notice} />
      {notice.refCode !== null && <p className="cw-hint">{t('player.notice.refHint')}</p>}
      <Lines ui={ui} notice={notice} id={linesId} />
      {isSanction(notice.kind) &&
        (appeals === null ? (
        <AppealLink ui={ui} href={appealUrl} />
      ) : (
        <AppealSlot ui={ui} notice={notice} appeals={appeals} onOpen={onAppeal} focus={returned} onFocused={onReturned} inert={busy} />
      ))}
      {mustAck && <p className="cw-hint">{t('player.notice.todo.warning')}</p>}
      {failure !== null && (
        <div className="cw-error" role="alert">
          <p>
            {t('player.notice.ackFailed')} {errorText(t, failure)}
          </p>
          {/* The main button below tries again; this is the way out when it keeps failing. The notice stays pending. */}
          <button type="button" className="cw-btn" onClick={onLater}>
            {t('player.notice.closeForNow')}
          </button>
        </div>
      )}
      <div className="cw-actions">
        <button
          type="button"
          className="cw-btn cw-btn--primary"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => void acknowledge()}
        >
          {t(mustAck ? 'player.notice.acknowledge' : 'player.notice.gotIt')}
        </button>
      </div>
    </>
  );
}
