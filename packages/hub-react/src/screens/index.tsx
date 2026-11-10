import type { ReactNode } from 'react';
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
import { Terms } from './Terms.js';

/** The screen for a route that the role may open. */
export function screenFor(route: Route): ReactNode {
  switch (route.name) {
    case 'overview':
      return <Overview />;
    case 'reports':
      return <Reports status={route.status} />;
    case 'report':
      return <Report />;
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
    case 'notFound':
      return null;
  }
}
