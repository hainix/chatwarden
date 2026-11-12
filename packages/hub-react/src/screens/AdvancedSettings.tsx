import { useHub } from '../context.js';
import { LazyPaceSettings } from '../lazyParts.js';
import { usePolicy } from '../policyHooks.js';
import { Fetched } from '../ui.js';

// Settings > Advanced: the one door for power settings. A panel is off until the owner turns it on, and nothing here is on a screen a moderator uses every
// day. The policy is read once for all the panels (so they share one version, and a save in one is seen by the others); each panel is its own lazy chunk.

/** The Advanced screen: its panels, one after the other. */
export function AdvancedSettingsScreen() {
  const { t } = useHub();
  const policy = usePolicy();
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.settings.advanced.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.settings.advanced.intro')}</p>
      <Fetched state={{ data: policy.data, error: policy.error, loading: policy.loading, reload: policy.reload }} what={t('hub.state.what.settings')}>
        {(state) => <LazyPaceSettings state={state} policy={policy} />}
      </Fetched>
    </div>
  );
}
