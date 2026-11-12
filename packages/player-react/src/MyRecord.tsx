import { useId, useState } from 'react';
import type { PlayerAppeal } from '@chatwarden/core';
import { AppealDialog } from './AppealDialog.js';
import { AppealSlot, useAppeals } from './appeals.js';
import type { PlayerClient } from './client.js';
import { usePlayerData } from './hooks.js';
import { WARNING_DAYS } from './constants.js';
import { AppealLink, Card, ErrorBlock, Facts, isSanction, kindKey, Lines, Root, useUi } from './ui.js';
import type { DialogHostProps, PlayerUiProps } from './ui.js';

export interface MyRecordProps extends PlayerUiProps, DialogHostProps {
  client: PlayerClient;
  /** Where "Think this is a mistake?" goes: an `http(s)` address or a path starting with `/`. Left out when absent or unsafe. */
  appealUrl?: string;
  /**
   * @experimental Let the player appeal a sanction from here (the kit's appeals, `profile.appeals`, must be on). Each sanction then has a
   * "Think this is a mistake?" button that opens `AppealDialog`, and `appealUrl` is not used; once an appeal is sent the same place reads
   * "Appeal sent <date>", and later the outcome in words. Default false: the `appealUrl` link, exactly as before, and no extra request.
   */
  appeals?: boolean;
  /** Change it to load the record again. */
  refreshKey?: number | string;
}

/** "My record": what is on the player's record now, newest first, from `GET /record`; or a calm line when it is clear. */
export function MyRecord(props: MyRecordProps) {
  const { client, appealUrl, appeals: appealsProp = false, refreshKey, theme, className, t: words, locale, now, timeZone, container, returnFocusTo } = props;
  const ui = useUi(props);
  const { t } = ui;
  const state = usePlayerData(() => client.record(), refreshKey);
  const titleId = useId();
  const linesId = useId();
  const appeals = useAppeals(client, appealsProp, refreshKey);
  // The notice whose appeal dialog is open, and the one whose appeal control takes focus (the button became "Appeal sent").
  const [appealFor, setAppealFor] = useState<string | null>(null);
  const [returned, setReturned] = useState<string | null>(null);
  const items = state.data === undefined ? [] : [...state.data].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <Root theme={theme} className={className}>
        <section className="cw-section" aria-labelledby={titleId}>
          <h2 id={titleId} className="cw-title">
            {t('player.record.title')}
          </h2>
          {state.error !== null && <ErrorBlock ui={ui} what={t('player.record.loadFailed')} error={state.error} onRetry={state.reload} />}
          {state.data === undefined && state.error === null && (
            <p className="cw-state" role="status">
              {t('player.record.loading')}
            </p>
          )}
          {state.data !== undefined && items.length === 0 && <p className="cw-state">{t('player.record.empty')}</p>}
          {items.length > 0 && (
            <>
              <p className="cw-body">{t('player.record.intro', { days: WARNING_DAYS })}</p>
              {!appealsProp && <AppealLink ui={ui} href={appealUrl} />}
              <ul className="cw-items" aria-labelledby={titleId}>
                {items.map((notice, i) => (
                  <li key={notice.id} className="cw-item">
                    <div className="cw-head">
                      <Card kind={notice.kind} />
                      <h3 className="cw-kind">{t(kindKey(notice.kind))}</h3>
                    </div>
                    <Facts ui={ui} notice={notice} record />
                    <Lines ui={ui} notice={notice} id={`${linesId}-${i}`} />
                    {appealsProp && isSanction(notice.kind) && (
                      <AppealSlot ui={ui} notice={notice} appeals={appeals} onOpen={() => setAppealFor(notice.id)} focus={returned === notice.id} onFocused={() => setReturned(null)} />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </Root>
      {appealFor !== null && (
        <AppealDialog
          client={client}
          {...(words === undefined ? {} : { t: words })}
          {...(locale === undefined ? {} : { locale })}
          {...(now === undefined ? {} : { now })}
          {...(timeZone === undefined ? {} : { timeZone })}
          {...(theme === undefined ? {} : { theme })}
          {...(className === undefined ? {} : { className })}
          {...(container === undefined ? {} : { container })}
          {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
          noticeId={appealFor}
          onClose={(sent?: PlayerAppeal) => {
            // The button the dialog was opened from is gone once an appeal was sent: its words take focus instead.
            if (sent !== undefined) {
              appeals.add(sent);
              setReturned(appealFor);
            }
            setAppealFor(null);
          }}
        />
      )}
    </>
  );
}
