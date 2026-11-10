import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import type { HubText } from '../i18n.js';
import type { Route } from '../router.js';
import { Overview } from './Overview.js';
import { Report } from './Report.js';
import { Reports } from './Reports.js';

// The screen for each route. Later screens replace the `Soon` entries here and nothing else in the shell changes.

const SOON_NAME: Record<'person' | 'terms' | 'blocked' | 'gaps' | 'guide' | 'audit', HubText> = {
  person: 'hub.route.soon.name.person',
  terms: 'hub.nav.terms',
  blocked: 'hub.nav.blocked',
  gaps: 'hub.nav.gaps',
  guide: 'hub.nav.guide',
  audit: 'hub.nav.audit',
};

/** A screen that is not built yet: a title and one sentence, so a link to it is never a dead end. */
function Soon({ name }: { name: keyof typeof SOON_NAME }) {
  const { t } = useHub();
  return (
    <div className="cw-screen">
      <div className="cw-empty">
        <h2 className="cw-screen-title" tabIndex={-1}>{t('hub.route.soon.title', { name: t(SOON_NAME[name]) })}</h2>
        <p>{t('hub.route.soon.body')}</p>
      </div>
    </div>
  );
}

/** The screen for a route that the role may open. */
export function screenFor(route: Route): ReactNode {
  switch (route.name) {
    case 'overview':
      return <Overview />;
    case 'reports':
      return <Reports status={route.status} />;
    case 'report':
      return <Report id={route.id} />;
    case 'notFound':
      return null;
    default:
      return <Soon name={route.name} />;
  }
}
