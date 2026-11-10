import { useId } from 'react';
import type { PlayerClient } from './client.js';
import { usePlayerData } from './hooks.js';
import { WARNING_DAYS } from './categories.js';
import { AppealLink, Card, ErrorBlock, Facts, kindKey, Lines, Root, useUi } from './ui.js';
import type { PlayerUiProps } from './ui.js';

export interface MyRecordProps extends PlayerUiProps {
  client: PlayerClient;
  /** Where "Think this is a mistake?" goes: an `http(s)` address or a path starting with `/`. Left out when absent or unsafe. */
  appealUrl?: string;
  /** Change it to load the record again. */
  refreshKey?: number | string;
}

/** "My record": what is on the player's record now, newest first, from `GET /record`; or a calm line when it is clear. */
export function MyRecord(props: MyRecordProps) {
  const { client, appealUrl, refreshKey, theme, className } = props;
  const ui = useUi(props);
  const { t } = ui;
  const state = usePlayerData(() => client.record(), refreshKey);
  const titleId = useId();
  const linesId = useId();
  const items = state.data === undefined ? [] : [...state.data].sort((a, b) => b.createdAt - a.createdAt);

  return (
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
            <AppealLink ui={ui} href={appealUrl} />
            <ul className="cw-items" aria-labelledby={titleId}>
              {items.map((notice, i) => (
                <li key={notice.id} className="cw-item">
                  <div className="cw-head">
                    <Card kind={notice.kind} />
                    <h3 className="cw-kind">{t(kindKey(notice.kind))}</h3>
                  </div>
                  <Facts ui={ui} notice={notice} record />
                  <Lines ui={ui} notice={notice} id={`${linesId}-${i}`} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </Root>
  );
}
