import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { HubContext, useHub } from '../context.js';
import { KeyScope } from '../keyScope.js';
import { PieceNavContext } from '../pieceRuntime.js';
import type { PieceNav } from '../pieceRuntime.js';
import type { Route } from '../router.js';
import type { PermissionKey } from '../types.js';

// What every piece is: a box in somebody else's page, told where things go by callback props, never by an address. It checks the
// permission before it reads anything, listens for keys on itself only, and says in one plain line when the role cannot use it.

/**
 * Where a piece sends the moderator. Each is optional: a piece that is not told where a thing opens shows it as plain text, and never moves the page.
 * @experimental
 */
export interface PieceLinks {
  /** A case was chosen: the reported person's ref, and the id of their newest open report. */
  onOpenCase?: (person: string, reportId: string) => void;
  /** A person was chosen: their staff ref (show it as a short tag; never print it whole). */
  onOpenPerson?: (person: string) => void;
  /** One report was chosen. */
  onOpenReport?: (reportId: string) => void;
}

/**
 * What a piece takes besides the callbacks.
 * @experimental
 */
export interface PieceProps {
  /** Extra class names for the piece's root element. */
  className?: string;
}

const cx = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(' ');

export function Piece({
  name,
  need,
  className,
  links = {},
  onEnter,
  children,
}: {
  name: string;
  need: PermissionKey;
  className?: string | undefined;
  links?: PieceNav;
  /** Keyboard focus moved into the piece. */
  onEnter?: () => void;
  children: ReactNode;
}) {
  const hub = useHub();
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef<PieceNav>(links);
  latest.current = links;

  const allowed = hub.can(need);
  const value = useMemo(() => {
    const here = (): PieceNav => latest.current;
    const canGo = (route: Route): boolean => {
      const to = here();
      switch (route.name) {
        case 'report':
          return to.onOpenReport !== undefined;
        case 'person':
          return to.onOpenPerson !== undefined;
        case 'terms':
          return to.onOpenTerms !== undefined;
        default:
          return false;
      }
    };
    const go = (route: Route): void => {
      const to = here();
      if (route.name === 'report') to.onOpenReport?.(route.id);
      else if (route.name === 'person') to.onOpenPerson?.(route.ref);
      else if (route.name === 'terms') to.onOpenTerms?.();
    };
    return { ...hub, canGo, go, href: () => '' };
  }, [hub]);

  if (!allowed) {
    return (
      <div className={cx('cw-piece', 'cw-piece--denied', className)} data-cw-piece={name}>
        <p className="cw-hint" data-cw-need={need}>
          {hub.t('hub.piece.noAccess')}
        </p>
      </div>
    );
  }
  return (
    <div ref={root} className={cx('cw-piece', className)} data-cw-piece={name} {...(onEnter === undefined ? {} : { onFocus: onEnter })}>
      <KeyScope.Provider value={root}>
        <HubContext.Provider value={value}>
          <PieceNavContext.Provider value={latest}>{children}</PieceNavContext.Provider>
        </HubContext.Provider>
      </KeyScope.Provider>
    </div>
  );
}
