import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import type { HubText } from '../i18n.js';
import type { Route, SettingsSection } from '../router.js';
import type { PermissionKey } from '../types.js';
import { Link } from '../ui.js';
import { LazyAdvancedSettings, LazyAiSettings, LazyLadderSettings, LazyReportingSettings } from './lazy.js';

// The settings screen is a list of sections, each its own address (`#/settings/ladder`) and its own component. A new section
// is one more entry here and one more value of `SettingsSection` in the router: nothing else is restructured. The section list shows
// only when there is more than one to choose from.

interface Section {
  id: SettingsSection;
  label: HubText;
  need: PermissionKey;
  render: () => ReactNode;
}

const SECTIONS: readonly Section[] = [
  { id: 'ladder', label: 'hub.settings.ladder.nav', need: 'policy.read', render: () => <LazyLadderSettings /> },
  { id: 'reporting', label: 'hub.settings.reporting.nav', need: 'policy.read', render: () => <LazyReportingSettings /> },
  { id: 'ai', label: 'hub.settings.ai.nav', need: 'policy.read', render: () => <LazyAiSettings /> },
  { id: 'advanced', label: 'hub.settings.advanced.nav', need: 'policy.read', render: () => <LazyAdvancedSettings /> },
];

export function Settings({ section }: { section: SettingsSection }) {
  const { t, can } = useHub();
  const visible = SECTIONS.filter((s) => can(s.need));
  const shown = visible.find((s) => s.id === section) ?? visible[0];
  return (
    <>
      {visible.length > 1 && (
        <nav className="cw-settings-nav" aria-label={t('hub.settings.sections')}>
          <ul>
            {visible.map((s) => {
              const to: Route = { name: 'settings', section: s.id };
              return (
                <li key={s.id}>
                  <Link to={to} {...(s.id === shown?.id ? { 'aria-current': 'page' as const } : {})}>
                    {t(s.label)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {shown?.render() ?? null}
    </>
  );
}
