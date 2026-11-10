import { useId } from 'react';
import type { PlayerClient } from './client.js';
import { usePlayerData } from './hooks.js';
import { ErrorBlock, Root, useUi } from './ui.js';
import type { PlayerUiProps } from './ui.js';

export interface RulesPageProps extends PlayerUiProps {
  client: PlayerClient;
  /** Change it to load the rules again. */
  refreshKey?: number | string;
}

/** The community rules: the profile's summary and the numbered rules from `GET /rules`. Text only, never HTML. */
export function RulesPage(props: RulesPageProps) {
  const { client, refreshKey, theme, className } = props;
  const ui = useUi(props);
  const { t } = ui;
  const state = usePlayerData(() => client.rules(), refreshKey);
  const titleId = useId();
  const data = state.data;

  return (
    <Root theme={theme} className={className}>
      <section className="cw-section" aria-labelledby={titleId}>
        <h2 id={titleId} className="cw-title">
          {t('player.rules.title')}
        </h2>
        {state.error !== null && <ErrorBlock ui={ui} what={t('player.rules.loadFailed')} error={state.error} onRetry={state.reload} />}
        {data === undefined && state.error === null && (
          <p className="cw-state" role="status">
            {t('player.rules.loading')}
          </p>
        )}
        {data !== undefined && data.summary !== '' && <p className="cw-summary">{data.summary}</p>}
        {data !== undefined && data.rules.length === 0 && <p className="cw-state">{t('player.rules.empty')}</p>}
        {data !== undefined && data.rules.length > 0 && (
          // The kit's own numbers, so a retired rule leaves a gap instead of renumbering the ones after it.
          <ol className="cw-rules" aria-labelledby={titleId}>
            {data.rules.map((rule) => (
              <li key={rule.number} value={rule.number}>
                <strong className="cw-rule-title">{rule.title}</strong> <span className="cw-rule-text">{rule.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Root>
  );
}
