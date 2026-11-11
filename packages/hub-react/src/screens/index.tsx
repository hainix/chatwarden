import type { ReactNode } from 'react';
import { CaseCard } from '../case/CaseCard.js';
import type { Route } from '../router.js';
import { Actions } from './Actions.js';
import { Audit } from './Audit.js';
import { Blocked } from './Blocked.js';
import { Gaps } from './Gaps.js';
import { Guide } from './Guide.js';
import { Overview } from './Overview.js';
import { Person } from './Person.js';
import { Report } from './Report.js';
import { Reports } from './Reports.js';
import { Settings } from './Settings.js';
import { SimpleHome } from './SimpleHome.js';
import { Terms } from './Terms.js';

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
      return <Actions />;
    case 'terms':
      return <Terms />;
    case 'blocked':
      return <Blocked />;
    case 'gaps':
      return <Gaps />;
    case 'audit':
      return <Audit />;
    case 'guide':
      return <Guide />;
    case 'settings':
      return <Settings section={route.section} />;
    case 'notFound':
      return null;
  }
}
