import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerAppeal, PlayerNotice } from '@chatwarden/core';
import type { PlayerClient } from './client.js';
import { dateText } from './format.js';
import { usePlayerData } from './hooks.js';
import type { PlayerText } from './i18n.js';
import type { Ui } from './ui.js';

// The part of `NoticeQueue` and `MyRecord` that knows about appeals: which of the player's sanctions already have one, and the button or
// the words that stand in the place of the old "Think this is a mistake?" link.

/** The player's appeals as a component sees them. */
export interface AppealsView {
  /** Whether the list has been asked for and answered (or failed): until then nothing is drawn, so a sent appeal never shows a button first. */
  ready: boolean;
  /** The appeal filed from this notice, if any. */
  of: (noticeId: string) => PlayerAppeal | undefined;
  /** Remember an appeal filed in this page now, until the list is asked for again. */
  add: (appeal: PlayerAppeal) => void;
}

/**
 * Loads `client.appeals()` when `enabled` (and not otherwise: with appeals off no request is made). A failure, including the 404 of a server
 * that has them off, leaves the list empty: the button stays, and a filing says in words what is wrong.
 */
export function useAppeals(client: PlayerClient, enabled: boolean, refreshKey: number | string | undefined): AppealsView {
  const state = usePlayerData(() => (enabled ? client.appeals() : Promise.resolve([])), `${enabled}:${refreshKey}`);
  const [filed, setFiled] = useState<PlayerAppeal[]>([]);
  const add = useCallback((appeal: PlayerAppeal) => setFiled((list) => [appeal, ...list]), []);
  const loaded = state.data;
  const of = (noticeId: string): PlayerAppeal | undefined => loaded?.find((a) => a.noticeId === noticeId) ?? filed.find((a) => a.noticeId === noticeId);
  return { ready: loaded !== undefined || state.error !== null, of, add };
}

const STATUS_TEXT: Readonly<Record<Exclude<PlayerAppeal['status'], 'open'>, PlayerText>> = {
  upheld: 'player.appeal.status.upheld',
  reduced: 'player.appeal.status.reduced',
  revoked: 'player.appeal.status.revoked',
};

/**
 * In the place of the appeal link on a sanction: a button that opens the appeal form, or, once one was sent, "Appeal sent <date>" and then the
 * outcome in words. `focus` hands focus to it when it appears (after the form closes), and `onFocused` says it was done.
 */
export function AppealSlot({
  ui,
  notice,
  appeals,
  onOpen,
  focus,
  onFocused,
  inert = false,
}: {
  ui: Ui;
  notice: PlayerNotice;
  appeals: AppealsView;
  onOpen: () => void;
  focus: boolean;
  onFocused: () => void;
  /** The button does nothing (and says so with `aria-disabled`): the host has something in flight that opening the form would lose. */
  inert?: boolean;
}) {
  const { t } = ui;
  const target = useRef<HTMLElement | null>(null);
  const told = useRef(onFocused);
  told.current = onFocused;
  useEffect(() => {
    if (!focus) return;
    target.current?.focus();
    told.current();
  }, [focus]);

  if (!appeals.ready) return null;
  const appeal = appeals.of(notice.id);
  if (appeal === undefined) {
    return (
      <p className="cw-appeal">
        <button
          type="button"
          className="cw-linkbtn"
          ref={(el) => void (target.current = el)}
          aria-disabled={inert || undefined}
          onClick={() => {
            if (!inert) onOpen();
          }}
        >
          {t('player.notice.appeal')}
        </button>
      </p>
    );
  }
  const words = appeal.status === 'open' ? t('player.appeal.status.open', { when: dateText(appeal.createdAt, ui.locale, ui.timeZone) }) : t(STATUS_TEXT[appeal.status]);
  return (
    <p className="cw-appeal" tabIndex={-1} ref={(el) => void (target.current = el)}>
      {words}
    </p>
  );
}
