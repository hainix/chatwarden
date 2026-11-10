import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerNotice } from '@chatwarden/core';
import { toPlayerError } from './client.js';
import type { PlayerClient, PlayerError } from './client.js';
import { Dialog } from './Dialog.js';
import { usePlayerData } from './hooks.js';
import { AppealLink, bodyKey, Card, errorText, Facts, isSanction, Lines, Root, titleKey, useUi } from './ui.js';
import type { PlayerUiProps, Ui } from './ui.js';

export interface NoticeQueueProps extends PlayerUiProps {
  client: PlayerClient;
  /**
   * Whether a notice may appear now. Pass `false` during a match: notices are held (kept, not dropped, not acknowledged) and
   * appear, oldest first, when it turns `true` again. Default: `true`.
   */
  canShow?: boolean;
  /** Where "Think this is a mistake?" goes: an `http(s)` address or a path starting with `/`. Left out when absent or unsafe. */
  appealUrl?: string;
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
  const { client, canShow = true, appealUrl, refreshKey, onAcknowledged, onPendingChange, theme, className } = props;
  const ui = useUi(props);
  const state = usePlayerData(() => client.notices(), refreshKey);
  // The ids acknowledged since this list arrived. A newer list replaces both, so the server stays the truth.
  const [done, setDone] = useState<{ list: PlayerNotice[] | undefined; ids: readonly string[] }>({ list: undefined, ids: [] });
  const gone = done.list === state.data ? done.ids : [];
  const queue = (state.data ?? []).filter((n) => !gone.includes(n.id)).sort((a, b) => a.createdAt - b.createdAt);
  const count = queue.length;
  const loaded = state.data !== undefined;
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

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
  if (current === undefined) return null;

  const acknowledged = (notice: PlayerNotice): void => {
    setDone({ list: state.data, ids: [...gone, notice.id] });
    onAcknowledged?.(notice);
  };

  return (
    <Root theme={theme} className={className}>
      {/* One dialog for the whole queue: it opens once and closes once, so focus comes back to where it was after the last notice. */}
      <Dialog labelledBy={titleId} initialFocus={heading}>
        <NoticeCard key={current.id} ui={ui} client={client} notice={current} total={count} appealUrl={appealUrl} titleId={titleId} heading={heading} onDone={acknowledged} />
      </Dialog>
    </Root>
  );
}

function NoticeCard({
  ui,
  client,
  notice,
  total,
  appealUrl,
  titleId,
  heading,
  onDone,
}: {
  ui: Ui;
  client: PlayerClient;
  notice: PlayerNotice;
  /** How many notices are waiting, this one included. It is always the first. */
  total: number;
  appealUrl: string | undefined;
  titleId: string;
  heading: RefObject<HTMLHeadingElement | null>;
  onDone: (notice: PlayerNotice) => void;
}) {
  const { t } = ui;
  const linesId = useId();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PlayerError | null>(null);

  // Each notice, not only the first, takes focus at its heading: it is what a screen reader should read next.
  useEffect(() => heading.current?.focus(), []);

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
      {total > 1 && <p className="cw-position">{t('player.notice.position', { n: 1, total })}</p>}
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
      {isSanction(notice.kind) && <AppealLink ui={ui} href={appealUrl} />}
      {mustAck && <p className="cw-hint">{t('player.notice.todo.warning')}</p>}
      {failure !== null && (
        <div className="cw-error" role="alert">
          <p>
            {t('player.notice.ackFailed')} {errorText(t, failure)}
          </p>
          <button type="button" className="cw-btn" onClick={() => void acknowledge()}>
            {t('player.state.retry')}
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
