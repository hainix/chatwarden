import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { Fetched, Panel } from '../ui.js';

// Settings > Advanced > "Room contexts": the contexts the profile declares, read only. A context gives one kind of room its own chat rules; it is declared in code (never in the stored settings), so there is
// nothing to edit here: the list says which contexts exist, the label each shows on a case and which sections it overrides. Names only, never a value. Its own lazy chunk.

export function RoomContexts() {
  const { t, client } = useHub();
  const state = useHubData('contexts:list', () => client.contexts());
  return (
    <div className="cw-settings cw-contexts">
      <Panel title={t('hub.settings.contexts.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.settings.contexts.intro')}</p>
          <Fetched state={state} what={t('hub.state.what.contexts')}>
            {(data) =>
              data.contexts.length === 0 ? (
                <>
                  <p className="cw-hint">{t('hub.settings.contexts.empty')}</p>
                  <p className="cw-hint">{t('hub.settings.contexts.where')}</p>
                </>
              ) : (
                <ul className="cw-contexts-list" aria-label={t('hub.settings.contexts.list')}>
                  {data.contexts.map((c) => (
                    <li key={c.name}>
                      <strong>{c.label}</strong> <code>{c.name}</code>
                      <br />
                      <span className="cw-hint">{c.overrides.length === 0 ? t('hub.settings.contexts.none') : t('hub.settings.contexts.sets', { sections: c.overrides.join(', ') })}</span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Fetched>
        </div>
      </Panel>
    </div>
  );
}
