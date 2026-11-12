import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { NoticeKind, PlayerNotice } from '@chatwarden/core';
import { WARNING_DAYS } from './constants.js';
import type { PlayerError } from './client.js';
import { dayText, timeLeft, untilText } from './format.js';
import { createT, en } from './i18n.js';
import type { PlayerT, PlayerText } from './i18n.js';
import { safeHref } from './safeHref.js';

const DAY = 86_400_000;

/** What every component takes besides its own props. */
export interface PlayerUiProps {
  /** Words: `createT({ ...en, ...yourTranslation }, locale)`. Default: English. */
  t?: PlayerT;
  /** The locale for dates, times and plurals. Default: `en`. */
  locale?: string;
  /** The current time in epoch ms, for "how long is left". Default: `Date.now`. */
  now?: () => number;
  /** An IANA time zone for the times shown (`UTC`, `Europe/Berlin`). Default: the player's own. */
  timeZone?: string;
  /** Forces a theme; without it the player's `prefers-color-scheme` decides. */
  theme?: 'light' | 'dark';
  /** Added to the root element, so a game can theme it from its own stylesheet. */
  className?: string;
}

export interface Ui {
  t: PlayerT;
  locale: string;
  now: () => number;
  timeZone: string | undefined;
}

export function useUi({ t, locale = 'en', now, timeZone }: PlayerUiProps): Ui {
  const words = useMemo(() => t ?? createT(en, locale), [t, locale]);
  return { t: words, locale, now: now ?? Date.now, timeZone };
}

/** What the two components that open a dialog take besides the common props. */
export interface DialogHostProps {
  /**
   * Draw the dialog inside this element instead of where the component is. The dialog is `position: fixed`, so an ancestor of the
   * component with a `transform`, `filter`, `contain` or `will-change: transform` would make it relative to that ancestor and clip it;
   * pass `document.body` (or a layer of your own) to avoid that. The theme and `className` still apply.
   */
  container?: HTMLElement | null;
  /**
   * Where focus goes when the dialog closes and the element that had focus before it opened is gone. Without it focus is left to the
   * browser, which is the page body.
   */
  returnFocusTo?: () => HTMLElement | null;
}

/** Renders `children` where they are, or into `container` when one is given. */
export function Portal({ container, children }: { container: HTMLElement | null | undefined; children: ReactNode }) {
  return container === undefined || container === null ? <>{children}</> : createPortal(children, container);
}

/** The root every component renders: the one class all the stylesheet's rules are scoped under. */
export function Root({ theme, className, children }: { theme?: 'light' | 'dark'; className?: string; children: ReactNode }) {
  return (
    <div className={className === undefined ? 'cw-player' : `cw-player ${className}`} {...(theme === undefined ? {} : { 'data-cw-theme': theme })}>
      {children}
    </div>
  );
}

type CardKind = 'warning' | 'restriction' | 'ban' | 'note';
const CARD_OF: Readonly<Record<string, CardKind>> = { warning: 'warning', chat: 'restriction', area: 'restriction', ban: 'ban', note: 'note' };

/**
 * The referee card: a yellow card for a warning, half yellow and half red for a restriction, red for a ban, and a dashed outline
 * for a note. The same card as the moderator hub's, so a sanction looks the same to staff and player. Decoration: the kind is
 * always written beside it. A kind with no card (a thank-you for a report) draws nothing.
 */
export function Card({ kind }: { kind: string }) {
  const card = Object.hasOwn(CARD_OF, kind) ? CARD_OF[kind] : undefined;
  return card === undefined ? null : <span className={`cw-card cw-card--${card}`} aria-hidden="true" />;
}

/** The plain sentence for a failed call. The server's own message is never shown. */
export function errorText(t: PlayerT, e: PlayerError): string {
  if (e.status === 0) return e.code === 'network' ? t('player.error.network') : t('player.error.generic');
  if (e.status === 401) return t('player.error.unauthorized');
  if (e.status === 403) return t('player.error.forbidden');
  if (e.status === 404) return t('player.error.notFound');
  if (e.status === 429) return e.retryAfter === undefined ? t('player.error.rateLimited') : t('player.error.rateLimited.after', { count: e.retryAfter });
  if (e.status >= 500) return t('player.error.server');
  return t('player.error.generic');
}

/** A failed load: what could not be loaded, why, and a way to try again. */
export function ErrorBlock({ ui, what, error, onRetry }: { ui: Ui; what: string; error: PlayerError; onRetry: () => void }) {
  return (
    <div className="cw-error" role="alert">
      <p>
        <strong>{what}</strong> {errorText(ui.t, error)}
      </p>
      <button type="button" className="cw-btn" onClick={onRetry}>
        {ui.t('player.state.retry')}
      </button>
    </div>
  );
}

/** "Think this is a mistake?", when the adopter gave an address that is safe to link to. */
export function AppealLink({ ui, href }: { ui: Ui; href: string | undefined }) {
  const safe = safeHref(href);
  if (safe === null) return null;
  return (
    <p className="cw-appeal">
      <a className="cw-link" href={safe} target="_blank" rel="noopener noreferrer">
        {ui.t('player.notice.appeal')}
      </a>
    </p>
  );
}

const TITLE: Readonly<Record<string, PlayerText>> = {
  warning: 'player.notice.title.warning',
  chat: 'player.notice.title.chat',
  area: 'player.notice.title.area',
  ban: 'player.notice.title.ban',
  report_outcome: 'player.notice.title.report_outcome',
  rename_required: 'player.notice.title.rename_required',
  appeal_upheld: 'player.notice.title.appeal_upheld',
  appeal_reduced: 'player.notice.title.appeal_reduced',
  appeal_revoked: 'player.notice.title.appeal_revoked',
};
const BODY: Readonly<Record<string, PlayerText>> = {
  warning: 'player.notice.body.warning',
  chat: 'player.notice.body.chat',
  area: 'player.notice.body.area',
  ban: 'player.notice.body.ban',
  report_outcome: 'player.notice.body.report_outcome',
  rename_required: 'player.notice.body.rename_required',
  appeal_upheld: 'player.notice.body.appeal_upheld',
  appeal_reduced: 'player.notice.body.appeal_reduced',
  appeal_revoked: 'player.notice.body.appeal_revoked',
};
const KIND: Readonly<Record<string, PlayerText>> = {
  warning: 'player.record.kind.warning',
  chat: 'player.record.kind.chat',
  area: 'player.record.kind.area',
  ban: 'player.record.kind.ban',
};

export const titleKey = (kind: NoticeKind | string): PlayerText => (Object.hasOwn(TITLE, kind) ? (TITLE[kind] as PlayerText) : 'player.notice.title.fallback');
export const bodyKey = (kind: NoticeKind | string): PlayerText => (Object.hasOwn(BODY, kind) ? (BODY[kind] as PlayerText) : 'player.notice.body.fallback');
export const kindKey = (kind: NoticeKind | string): PlayerText => (Object.hasOwn(KIND, kind) ? (KIND[kind] as PlayerText) : 'player.record.kind.fallback');

/** A sanction a player can contest (a thank-you for a report, a required rename and the outcome of an appeal are not one). */
export const isSanction = (kind: string): boolean => kind === 'warning' || kind === 'chat' || kind === 'area' || kind === 'ban';

/** The facts of a notice, as a term list: the rule, when it was given (the record only), until when, and the reference code. */
export function Facts({ ui, notice, record = false }: { ui: Ui; notice: PlayerNotice; record?: boolean }) {
  const { t, locale, timeZone } = ui;
  const rows: Array<[string, ReactNode]> = [];
  if (notice.ruleLabel !== null) rows.push([t('player.notice.rule'), notice.ruleLabel]);
  if (record) rows.push([t('player.notice.given'), untilText(notice.createdAt, locale, timeZone)]);
  if (notice.kind === 'warning') {
    // A warning has no end of its own: it stays on the record for 90 days from when it was made.
    rows.push([t('player.notice.onRecordUntil'), untilText(notice.createdAt + WARNING_DAYS * DAY, locale, timeZone)]);
  } else if (isSanction(notice.kind) || notice.until !== null) {
    if (notice.until === null) rows.push([t('player.notice.until'), t('player.notice.noEnd')]);
    else {
      const when = untilText(notice.until, locale, timeZone);
      const left = timeLeft(notice.until, ui.now(), locale);
      rows.push(left === null ? [t('player.notice.ended'), when] : [t('player.notice.until'), t('player.notice.untilLeft', { when, left })]);
    }
  }
  if (notice.refCode !== null) rows.push([t('player.notice.ref'), notice.refCode]);
  if (rows.length === 0) return null;
  return (
    <dl className="cw-facts">
      {rows.map(([term, value]) => (
        <div key={term} className="cw-fact">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The player's own lines that led to a notice, as text with their day. Never HTML. */
export function Lines({ ui, notice, id }: { ui: Ui; notice: PlayerNotice; id: string }) {
  if (notice.excerpt.length === 0) return null;
  return (
    <>
      <p id={id} className="cw-lines-label">
        {ui.t('player.notice.lines')}
      </p>
      <ul className="cw-lines" aria-labelledby={id}>
        {notice.excerpt.map((line, i) => (
          <li key={i}>
            <span className="cw-line-day">{dayText(line.day, ui.locale)}</span>
            <span className="cw-line-text">{line.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
