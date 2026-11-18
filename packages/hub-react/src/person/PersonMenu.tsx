import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useHub } from '../context.js';
import { onPage } from '../dom.js';
import { listOf } from '../format.js';
import { useHubAction } from '../hooks.js';
import type { HubT } from '../i18n.js';
import { errorText } from '../labels.js';
import type { PersonLinksView } from '../types.js';

// The Person page's `...` menu (design 10): "Linked accounts" loads the counts when it is chosen and shows one line, with the hint that a shared device can link two different people. Counts
// only: the answer holds no id, key or address, and none is drawn. Nothing about it is on the page, or asked of the server, until the menu item is used. Escape closes the menu (and is the
// menu's own: the hub's Escape does not also run).

/** One sentence about how many accounts and devices are linked, and how many sanctions in force were placed on a linked account (or none linked). */
export function linksText(t: HubT, locale: string, links: PersonLinksView): { line: string; hint: boolean } {
  const parts: string[] = [];
  if (links.accounts > 0) parts.push(t('hub.person.links.accounts', { count: links.accounts }));
  if (links.devices > 0) parts.push(t('hub.person.links.devices', { count: links.devices }));
  if (parts.length === 0) return { line: t('hub.person.links.none'), hint: false };
  const single = parts.length === 1 ? (links.accounts > 0 ? links.accounts : links.devices) : 2;
  const first = t(single === 1 ? 'hub.person.links.isLinked' : 'hub.person.links.areLinked', { what: listOf(parts, locale) });
  const kinds: string[] = [];
  if (links.inForceOnLinked.ban > 0) kinds.push(t('hub.person.links.ban', { count: links.inForceOnLinked.ban }));
  if (links.inForceOnLinked.area > 0) kinds.push(t('hub.person.links.area', { count: links.inForceOnLinked.area }));
  if (links.inForceOnLinked.chat > 0) kinds.push(t('hub.person.links.chat', { count: links.inForceOnLinked.chat }));
  const total = links.inForceOnLinked.ban + links.inForceOnLinked.area + links.inForceOnLinked.chat;
  const second = kinds.length === 0 ? '' : ` ${t(total === 1 ? 'hub.person.links.wasPlaced' : 'hub.person.links.werePlaced', { what: listOf(kinds, locale) })}`;
  return { line: `${first}${second}`, hint: true };
}

export function PersonMenu({ person }: { person: string }) {
  const { t, locale, client } = useHub();
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<PersonLinksView | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const load = useHubAction(async (): Promise<void> => {
    setLinks(await client.personLinks(person));
  });
  useEffect(() => {
    if (!open) return undefined;
    return onPage('pointerdown', (e) => {
      const origin = e.composedPath()[0];
      if (origin instanceof Node && box.current?.contains(origin) !== true) setOpen(false);
    });
  }, [open]);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  };
  const shown = links === null ? null : linksText(t, locale, links);
  return (
    <div className="cw-person-menu" ref={box} onKeyDown={onKeyDown}>
      <button ref={button} type="button" className="cw-btn cw-person-more" aria-expanded={open} {...(open ? { 'aria-controls': `${id}-menu` } : {})} aria-label={t('hub.person.menu')} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{'\u22EF'}</span>
      </button>
      {open && (
        <div className="cw-person-menu-panel" role="group" id={`${id}-menu`} aria-label={t('hub.person.menu')}>
          <button type="button" className="cw-btn" aria-disabled={load.busy} onClick={() => void load.run()}>
            {t('hub.person.links.item')}
          </button>
          {shown !== null && (
            <div className="cw-person-links">
              <p>{shown.line}</p>
              {shown.hint && <p className="cw-hint">{t('hub.person.links.hint')}</p>}
            </div>
          )}
          {load.error !== null && (
            <p className="cw-error" role="alert">
              {errorText(t, load.error)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
