import type { ReactNode } from 'react';
import { CaseCard } from '../case/CaseCard.js';
import type { Route } from '../router.js';
import { Overview } from './Overview.js';
import { Person } from './Person.js';
import { Report } from './Report.js';
import { Reports } from './Reports.js';
import { Settings } from './Settings.js';
import { SimpleHome } from './SimpleHome.js';
import { LazyActions, LazyAudit, LazyBlocked, LazyGaps, LazyGuide, LazyTerms } from './lazy.js';

/**
 * The screen for a route that the role may open. In Simple mode the landing is the calm Cases screen and a case is the one card;
 * every other screen is the same in both modes.
 */
export function screenFor(route: Route, simple = false): ReactNode {
  switch (route.name) {
    case 'overview':
      return simple ? <SimpleHome /> : <Overview />;
    case 'reports':
      return <Reports status={route.status} />;
    case 'report':
      return simple ? <CaseCard /> : <Report />;
    case 'person':
      return <Person person={route.ref} />;
    case 'actions':
      return <LazyActions />;
    case 'terms':
      return <LazyTerms />;
    case 'blocked':
      return <LazyBlocked />;
    case 'gaps':
      return <LazyGaps />;
    case 'audit':
      return <LazyAudit />;
    case 'guide':
      return <LazyGuide />;
    case 'settings':
      return <Settings section={route.section} />;
    case 'notFound':
      return null;
  }
}
