import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { useHub } from '../context.js';
import type { HubText } from '../i18n.js';
import type { Route } from '../router.js';
import type { PermissionKey } from '../types.js';
import { Link } from '../ui.js';

// The menu in Simple mode: Cases, Words and Blocked, and More for the rest. Every route still works (the command bar reaches them
// all); this is only what the top bar offers a one or two person team. Each entry shows only when the role holds its permission.

interface Entry {
  id: 'cases' | 'terms' | 'blocked';
  route: Route;
  label: HubText;
  permission: PermissionKey | null;
}

const MAIN: readonly Entry[] = [
  { id: 'cases', route: { name: 'overview' }, label: 'hub.simple.nav.cases', permission: null },
  { id: 'terms', route: { name: 'terms' }, label: 'hub.simple.nav.words', permission: 'terms.read' },
  { id: 'blocked', route: { name: 'blocked' }, label: 'hub.nav.blocked', permission: 'blocked.read' },
];

const MORE: ReadonlyArray<Omit<Entry, 'id'>> = [
  { route: { name: 'actions' }, label: 'hub.overview.recent.title', permission: 'history.read' },
  { route: { name: 'audit' }, label: 'hub.nav.audit', permission: 'audit.read' },
  { route: { name: 'gaps' }, label: 'hub.nav.gaps', permission: 'gaps.read' },
  { route: { name: 'guide' }, label: 'hub.nav.guide', permission: 'policy.read' },
  { route: { name: 'settings', section: 'ladder' }, label: 'hub.settings.ladder.nav', permission: 'policy.read' },
  { route: { name: 'settings', section: 'reporting' }, label: 'hub.settings.reporting.nav', permission: 'policy.read' },
];

/** The entry a route belongs to: Cases holds the overview, the queue, an open case and a person. */
function currentOf(route: Route): 'cases' | 'terms' | 'blocked' | 'more' | null {
  switch (route.name) {
    case 'overview':
    case 'reports':
    case 'report':
    case 'person':
      return 'cases';
    case 'terms':
    case 'blocked':
      return route.name;
    case 'actions':
    case 'audit':
    case 'gaps':
    case 'guide':
    case 'settings':
      return 'more';
    case 'notFound':
      return null;
  }
}

export function SimpleNav({ route }: { route: Route }) {
  const { t, can } = useHub();
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const here = currentOf(route);
  const allowed = (e: Omit<Entry, 'id'>): boolean => e.permission === null || can(e.permission);
  const more = MORE.filter(allowed);

  // Moving anywhere closes the menu; so does a click or a key press away from it.
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event): void => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>): void => {
    if (e.key !== 'Escape' || !open) return;
    // Handled here, so the page-wide Escape (back to the queue) does not also run.
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  };

  // Tabbing out of the menu closes it. (A pointer press that moves focus nowhere leaves it open: the press handler above decides.)
  const onBlur = (e: FocusEvent<HTMLLIElement>): void => {
    if (open && e.relatedTarget instanceof Node && !wrap.current?.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <nav className="cw-snav" aria-label={t('hub.nav.label')}>
      <ul>
        {MAIN.filter(allowed).map((e) => (
          <li key={e.label}>
            <Link to={e.route} {...(here === e.id ? { 'aria-current': 'page' as const } : {})}>
              {t(e.label)}
            </Link>
          </li>
        ))}
        {more.length > 0 && (
          <li ref={wrap} className="cw-snav-more" onKeyDown={onKeyDown} onBlur={onBlur}>
            <button
              ref={button}
              type="button"
              aria-expanded={open}
              {...(open ? { 'aria-controls': `${id}-more` } : {})}
              {...(here === 'more' ? { 'data-current': 'true' } : {})}
              onClick={() => setOpen((v) => !v)}
            >
              {t('hub.simple.nav.more')}
            </button>
            {open && (
              <ul id={`${id}-more`} className="cw-snav-menu">
                {more.map((e) => (
                  <li key={e.label}>
                    <Link to={e.route} {...(route.name === e.route.name ? { 'aria-current': 'page' as const } : {})}>
                      {t(e.label)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )}
      </ul>
    </nav>
  );
}
