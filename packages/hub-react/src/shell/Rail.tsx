import { useHub } from '../context.js';
import { Icon } from '../icons.js';
import { TABS } from '../nav.js';
import { tabOf } from '../router.js';
import type { Route } from '../router.js';
import { Link } from '../ui.js';

/** The section rail: where to go, receding until it is needed. Only the screens the role can open are listed. */
export function Rail({ route }: { route: Route }) {
  const { t, can } = useHub();
  const current = tabOf(route);
  return (
    <nav className="cw-rail" aria-label={t('hub.nav.label')}>
      <ul>
        {TABS.filter((tab) => tab.permission === null || can(tab.permission)).map((tab) => (
          <li key={tab.tab}>
            <Link to={tab.route} {...(current === tab.tab ? { 'aria-current': 'page' as const } : {})}>
              <Icon name={tab.tab} />
              <span className="cw-rail-label">{t(tab.label)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
