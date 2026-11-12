import { useState } from 'react';
import { toHubError } from '../client.js';
import { useHub } from '../context.js';
import { LazyAppealSettings, LazyNameSettings, LazyPaceSettings, LazySignalSettings, resetLazyParts } from '../lazyParts.js';
import { usePolicy } from '../policyHooks.js';
import { ErrorBlock, Fetched } from '../ui.js';

// Settings > Advanced: the one door for power settings. A panel is off until the owner turns it on, and nothing here is on a screen a moderator uses every
// day. The policy is read once for all the panels (so they share one version, and a save in one is seen by the others); each panel is its own lazy chunk.

/** The Advanced screen: its panels, one after the other. */
export function AdvancedSettingsScreen() {
  const { t } = useHub();
  const policy = usePolicy();
  // A panel's own code could not be fetched (offline, a deploy replaced the file): the panels are the whole page, so say so, with Try again.
  const [failed, setFailed] = useState(false);
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.settings.advanced.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.settings.advanced.intro')}</p>
      <Fetched state={{ data: policy.data, error: policy.error, loading: policy.loading, reload: policy.reload }} what={t('hub.state.what.settings')}>
        {(state) => (
          failed ? (
            <ErrorBlock
              error={toHubError(new Error('The page did not load.'))}
              what={t('hub.state.what.advanced')}
              onRetry={() => {
                resetLazyParts();
                setFailed(false);
              }}
            />
          ) : (
            <>
              <LazyPaceSettings state={state} policy={policy} onFailed={() => setFailed(true)} />
              <LazySignalSettings state={state} policy={policy} onFailed={() => setFailed(true)} />
              <LazyAppealSettings state={state} policy={policy} onFailed={() => setFailed(true)} />
              <LazyNameSettings state={state} policy={policy} onFailed={() => setFailed(true)} />
            </>
          )
        )}
      </Fetched>
    </div>
  );
}
