import { useId } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import type { HubError } from './client.js';
import type { HubData } from './hooks.js';
import { useHub } from './context.js';
import { actorInitial } from './claims.js';
import { absoluteTime, personTag, relativeTime } from './format.js';
import { errorText } from './labels.js';
import type { Route } from './router.js';
import type { SanctionKind } from './types.js';

// The small parts every screen is built from. They carry the hub's class names (`cw-*`) and nothing else: no inline style,
// every word from the catalog through `useHub().t`.

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'accent';

const cx = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(' ');

/** A link to a hub route: a real address (it opens in a new tab), and a plain click moves without reloading. */
export function Link({
  to,
  className,
  children,
  ...aria
}: {
  to: Route;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  'aria-current'?: 'page' | 'true';
}) {
  const { href, go } = useHub();
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to);
  };
  return (
    <a href={href(to)} className={className} onClick={onClick} {...aria}>
      {children}
    </a>
  );
}

/** A short coloured label. The words carry the meaning; the colour only helps. */
export function Tag({ tone = 'idle', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('cw-tag', `cw-tag--${tone}`)}>{children}</span>;
}

/** Text for screen readers only. */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="cw-sr">{children}</span>;
}

/** A reported or sanctioned person: the first 8 characters of their ref, never the ref. */
export function PersonChip({ person }: { person: string }) {
  const { t } = useHub();
  return (
    <span className="cw-pid">
      <SrOnly>{t('hub.person.prefix')} </SrOnly>
      {personTag(person)}
    </span>
  );
}

/** A time as "5 minutes ago", with the exact time on hover. */
export function Time({ at }: { at: number }) {
  const { now, locale } = useHub();
  if (!Number.isFinite(at)) return null;
  return (
    <time dateTime={new Date(at).toISOString()} title={absoluteTime(at, locale)}>
      {relativeTime(at, now(), locale)}
    </time>
  );
}

/** A titled block of the page: a labelled region with a heading, and an optional action beside the heading. */
export function Panel({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={cx('cw-panel', className)} aria-labelledby={id}>
      <div className="cw-panel-head">
        <h2 id={id}>{title}</h2>
        {action}
      </div>
      <div className="cw-panel-body">{children}</div>
    </section>
  );
}

/** A row of buttons of which one is on: a filter. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
}) {
  return (
    <div className="cw-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A message in a box. `alert` for something that went wrong, `status` for news; both are announced. */
export function Notice({ tone = 'idle', role, children }: { tone?: Tone; role?: 'alert' | 'status'; children: ReactNode }) {
  return (
    <div className={cx('cw-notice', `cw-notice--${tone}`)} role={role}>
      {children}
    </div>
  );
}

/** "Loading": announced politely to a screen reader, with placeholder bars where the content will be (not spinners). */
export function Loading({ label }: { label?: string }) {
  const { t } = useHub();
  return (
    <div className="cw-loading">
      <p role="status">{label ?? t('hub.state.loading')}</p>
      <Skeleton lines={3} />
    </div>
  );
}

/** Grey bars the size of the text that is coming. Decoration only: the words that say "loading" live beside it. */
export function Skeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="cw-skel" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="cw-skel-bar" />
      ))}
    </div>
  );
}

/**
 * A person's initial in a circle. Neutral for everyone; the accent marks you. The name is never only in the circle: a
 * person is always named beside it or in `title`.
 */
export function Avatar({ actor, you = false, size = 'm' }: { actor: string; you?: boolean; size?: 's' | 'm' }) {
  return (
    <span className={cx('cw-avatar', you && 'cw-avatar--you', size === 's' && 'cw-avatar--s')} aria-hidden="true">
      {actorInitial(actor)}
    </span>
  );
}

const CARD_OF: Record<SanctionKind, 'warning' | 'restriction' | 'ban' | 'note'> = {
  warning: 'warning',
  chat: 'restriction',
  area: 'restriction',
  ban: 'ban',
  note: 'note',
};

/**
 * The referee card: a yellow card for a warning, half yellow and half red for a restriction, red for a ban, and a dashed
 * outline for a note (no card). Used wherever a sanction is shown. Decoration: the kind is always written beside it.
 */
export function Card({ kind }: { kind: SanctionKind }) {
  return <span className={cx('cw-card', `cw-card--${CARD_OF[kind]}`)} aria-hidden="true" />;
}

/** A key cap, for a shortcut. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cw-kbd">{children}</kbd>;
}

/** A failed load: what could not be loaded, why, and a way to try again. */
export function ErrorBlock({ error, what, onRetry }: { error: HubError; what: string; onRetry: () => void }) {
  const { t } = useHub();
  return (
    <div className="cw-error" role="alert">
      <p>
        <strong>{t('hub.state.loadFailed', { what })}</strong> {errorText(t, error)}
      </p>
      <button type="button" className="cw-btn" onClick={onRetry}>
        {t('hub.state.retry')}
      </button>
    </div>
  );
}

/**
 * Shows loaded data, or the loading line, or the error with a retry. A failed reload keeps the data on screen with the error
 * above it.
 */
export function Fetched<T>({ state, what, children }: { state: HubData<T>; what: string; children: (data: T) => ReactNode }) {
  if (state.data === undefined) {
    return state.error === null ? <Loading /> : <ErrorBlock error={state.error} what={what} onRetry={state.reload} />;
  }
  return (
    <>
      {state.error !== null && <ErrorBlock error={state.error} what={what} onRetry={state.reload} />}
      {children(state.data)}
    </>
  );
}

/** A wide table or code block that scrolls inside its own box instead of widening the page. Keyboard-reachable. */
export function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cw-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** The empty state of a list: a title, optionally, and what to do or what it means. */
export function Empty({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="cw-empty">
      {title !== undefined && <strong>{title}</strong>}
      <p>{children}</p>
    </div>
  );
}
