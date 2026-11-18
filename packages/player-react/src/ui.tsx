import type { ReactNode } from 'react';
import type { NoticeKind, PlayerNotice } from '@chatwarden/core';
import { bodyKey, isSanction, NOTICE_WORDS, noticeView, titleKey } from '@chatwarden/core/notice-copy';
import type { NoticeView, NoticeWords, NoticeWordKey } from '@chatwarden/core/notice-copy';
import type { PlayerError } from './client.js';
import type { PlayerT, PlayerText } from './i18n.js';
import { safeHref } from './safeHref.js';

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

// `useUi` is in its own file (it carries the English catalog as its default words), so an entry that draws only pieces of this file (the appeal page) does not bundle the catalog.
export { useUi } from './useUi.js';

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

// `Portal` is in its own file so an entry that draws no dialog (the appeal page) does not import React DOM.
export { Portal } from './Portal.js';

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

const KIND: Readonly<Record<string, PlayerText>> = {
  warning: 'player.record.kind.warning',
  chat: 'player.record.kind.chat',
  area: 'player.record.kind.area',
  ban: 'player.record.kind.ban',
};

export { bodyKey, isSanction, titleKey };
export const kindKey = (kind: NoticeKind | string): PlayerText => (Object.hasOwn(KIND, kind) ? (KIND[kind] as PlayerText) : 'player.record.kind.fallback');

const WORD_KEYS = Object.keys(NOTICE_WORDS) as NoticeWordKey[];
const wordsOfT = new WeakMap<PlayerT, NoticeWords>();

/** The shared notice words as this `t` words them (a catalog that lacks one reads the key, as it always did). Cached for each `t`. */
function wordsOf(t: PlayerT): NoticeWords {
  let words = wordsOfT.get(t);
  if (words === undefined) {
    words = Object.fromEntries(WORD_KEYS.map((key) => [key, t(key)])) as NoticeWords;
    wordsOfT.set(t, words);
  }
  return words;
}

/** What a notice says: the one `noticeView` of core, with this `ui`'s words, locale, time zone and clock. `record` adds the day it was given. */
export function viewOf(ui: Ui, notice: PlayerNotice, record = false): NoticeView {
  return noticeView(notice, { words: wordsOf(ui.t), locale: ui.locale, ...(ui.timeZone === undefined ? {} : { timeZone: ui.timeZone }), now: ui.now, record });
}

/** The facts of a notice, as a term list: the rule, when it was given (the record only), until when, and the reference code. */
export function Facts({ ui, notice, record = false }: { ui: Ui; notice: PlayerNotice; record?: boolean }) {
  const { facts } = viewOf(ui, notice, record);
  if (facts.length === 0) return null;
  return (
    <dl className="cw-facts">
      {facts.map((fact) => (
        <div key={fact.term} className="cw-fact">
          <dt>{fact.term}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The player's own lines that led to a notice, as text with their day. Never HTML. */
export function Lines({ ui, notice, id }: { ui: Ui; notice: PlayerNotice; id: string }) {
  const { linesLabel, lines } = viewOf(ui, notice);
  if (linesLabel === null) return null;
  return (
    <>
      <p id={id} className="cw-lines-label">
        {linesLabel}
      </p>
      <ul className="cw-lines" aria-labelledby={id}>
        {lines.map((line, i) => (
          <li key={i}>
            <span className="cw-line-day">{line.day}</span>
            <span className="cw-line-text">{line.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
