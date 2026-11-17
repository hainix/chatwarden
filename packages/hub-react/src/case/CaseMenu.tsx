import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { onPage } from '../dom.js';
import { errorText } from '../labels.js';
import { useCase } from './CaseContext.js';
import { useUrgentActions } from './useUrgent.js';

// The case's one `...` door (design 20.23). A disclosure button whose panel lists what this caller may do about this case, and which renders NOTHING when there is no such thing: no
// button, no wrapper. This is the only place the case grows power: later items (a second look, an escalation, a room lock) are more entries in `useCaseMenuItems`, never new
// always-visible controls. It follows the other `...` menus: aria-expanded and aria-controls, Escape closes it and gives the focus back (and is the menu's own, so the hub's Escape,
// back to the queue, does not also run), and a press away from it closes it.

/** One thing the menu offers. `run` does it (a failure is told inside the menu, which then stays open); `panel` instead opens a small form in the menu's place. */
export interface CaseMenuItem {
  id: string;
  label: string;
  run?: () => Promise<HubError | null>;
  /** The item's own form, drawn in the menu while it is chosen; `done` closes the menu. */
  panel?: (done: () => void) => ReactNode;
}

/** What this caller may do about the open case, in order. */
export function useCaseMenuItems(): CaseMenuItem[] {
  const { t, can } = useHub();
  const { detail } = useCase();
  const { setUrgent } = useUrgentActions();
  const report = detail.data?.report;
  const items: CaseMenuItem[] = [];
  if (report === undefined || report.status !== 'open') return items;
  if (can('reports.urgent')) {
    const on = report.urgent === true;
    items.push({
      id: on ? 'not-urgent' : 'urgent',
      label: t(on ? 'hub.case.menu.notUrgent' : 'hub.case.menu.urgent'),
      run: async () => {
        const res = await setUrgent.run(!on);
        return res.ok ? null : res.error;
      },
    });
  }
  return items;
}

export function CaseMenu() {
  const items = useCaseMenuItems();
  return items.length === 0 ? null : <Menu items={items} />;
}

function Menu({ items }: { items: CaseMenuItem[] }) {
  const { t } = useHub();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  // A press away from the menu closes it. It reads where the press began, so it holds inside a shadow root too.
  useEffect(() => {
    if (!open) return undefined;
    return onPage('pointerdown', (e) => {
      const origin = e.composedPath()[0];
      if (origin instanceof Node && box.current?.contains(origin) !== true) setOpen(false);
    });
  }, [open]);

  const close = (): void => {
    setOpen(false);
    setChosen(null);
    setError(null);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !open) return;
    // This Escape is the menu's: the hub's own Escape (back to the queue) must not also run.
    e.stopPropagation();
    e.preventDefault();
    close();
    button.current?.focus();
  };
  const choose = async (item: CaseMenuItem): Promise<void> => {
    setError(null);
    if (item.panel !== undefined) {
      setChosen(item.id);
      return;
    }
    const failed = (await item.run?.()) ?? null;
    if (failed === null) {
      close();
      button.current?.focus();
    } else setError(failed);
  };

  const panelOf = items.find((i) => i.id === chosen)?.panel;
  return (
    <div className="cw-case-menu" ref={box} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="cw-btn cw-case-menu-button"
        aria-expanded={open}
        {...(open ? { 'aria-controls': `${id}-menu` } : {})}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span aria-hidden="true">{'\u22EF'}</span>
        <span className="cw-sr">{t('hub.case.menu')}</span>
      </button>
      {open && (
        <div className="cw-case-menu-panel" role="group" id={`${id}-menu`} aria-label={t('hub.case.menu')}>
          {panelOf === undefined ? (
            items.map((item) => (
              <button key={item.id} type="button" className="cw-btn" onClick={() => void choose(item)}>
                {item.label}
              </button>
            ))
          ) : (
            panelOf(() => {
              close();
              button.current?.focus();
            })
          )}
          {error !== null && (
            <p className="cw-error" role="alert">
              {errorText(t, error)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
