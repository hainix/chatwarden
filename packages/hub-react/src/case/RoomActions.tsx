import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { onPage } from '../dom.js';
import { useHubAction } from '../hooks.js';
import type { HubT } from '../i18n.js';
import { errorText } from '../labels.js';
import { useCase } from './CaseContext.js';

// What a moderator does about a room from a case (design 9): lock it or start emergency mode from the case's menu (with a duration, named in the question), and take one line back for
// everyone from the line's own menu. Neither is a sanction: no notice, no strike, nothing said to the author. Every mode ends by itself. Eager and small: the panel that lists every room
// is the lazy part.

/** The lengths a mode may be given: the panel and the menu offer the same four; 30 minutes is the default. */
export const ROOM_DURATIONS = [
  { ms: 15 * 60_000, key: 'hub.rooms.duration.m15' },
  { ms: 30 * 60_000, key: 'hub.rooms.duration.m30' },
  { ms: 60 * 60_000, key: 'hub.rooms.duration.h1' },
  { ms: 4 * 60 * 60_000, key: 'hub.rooms.duration.h4' },
] as const;
export const DEFAULT_ROOM_MS = 30 * 60_000;

/** Why a room change did not go through, in words: the kit's own sentences are never shown. */
export function roomErrorText(t: HubT, error: HubError): string {
  if (error.code === 'invalid_value') return t('hub.rooms.error.length');
  if (error.code === 'invalid_mode') return t('hub.rooms.error.mode');
  if (error.status === 404) return t('hub.rooms.error.gone');
  return errorText(t, error);
}

/** The duration select: a labelled select of the four lengths. */
export function DurationSelect({ id, value, onChange }: { id: string; value: number; onChange: (ms: number) => void }) {
  const { t } = useHub();
  return (
    <div className="cw-field">
      <label htmlFor={id}>{t('hub.rooms.duration')}</label>
      <select id={id} value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
        {ROOM_DURATIONS.map((d) => (
          <option key={d.ms} value={String(d.ms)}>
            {t(d.key)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The question the case menu asks before it locks a room or starts emergency mode: names the room and the length, and says what it does. `done` closes the menu. */
export function RoomModeForm({ room, mode, done }: { room: string; mode: 'locked' | 'emergency'; done: () => void }) {
  const { t, client } = useHub();
  const [ms, setMs] = useState(DEFAULT_ROOM_MS);
  const id = useId();
  const set = useHubAction(async (): Promise<void> => {
    await client.setRoomMode(room, mode, ms);
  });
  const length = t((ROOM_DURATIONS.find((d) => d.ms === ms) ?? ROOM_DURATIONS[1]).key);
  const label = t(mode === 'locked' ? 'hub.rooms.menu.lock' : 'hub.rooms.menu.emergency');
  return (
    <div className="cw-case-menu-form" role="group" aria-label={label}>
      <DurationSelect id={`${id}-for`} value={ms} onChange={setMs} />
      <p>{t(mode === 'locked' ? 'hub.rooms.confirm.lock' : 'hub.rooms.confirm.emergency', { room, duration: length })}</p>
      <div className="cw-whattodo-actions">
        <button
          type="button"
          className="cw-btn cw-btn--primary"
          aria-disabled={set.busy}
          onClick={async () => {
            const res = await set.run();
            if (res.ok) done();
          }}
        >
          {t('hub.rooms.confirm')}
        </button>
        <button type="button" className="cw-btn" onClick={done}>
          {t('hub.rooms.cancel')}
        </button>
      </div>
      {set.error !== null && (
        <p className="cw-error" role="alert">
          {roomErrorText(t, set.error)}
        </p>
      )}
    </div>
  );
}

/**
 * A line's own `...` menu, only for a line the server says can still be taken back (`removable`: delivered, in the room's evidence buffer, not yet taken back): "Remove from the room" and
 * "Remove all recent lines from this player". The text stays in the case as evidence; the line then reads "Removed from the room". A 404 means the line is too old or gone, and says so.
 */
export function LineMenu({ room, lineId, time }: { room: string; lineId: string; time: string }) {
  const { t, client } = useHub();
  const { detail } = useCase();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const retract = useHubAction(async (allFromAuthor: boolean): Promise<void> => {
    await client.retractLine(room, lineId, allFromAuthor ? { allFromAuthor: true } : {});
    detail.reload();
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
    // This Escape is the menu's: the hub's own (back to the queue) must not also run.
    e.stopPropagation();
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  };
  const run = async (all: boolean): Promise<void> => {
    const res = await retract.run(all);
    if (res.ok) setOpen(false);
  };
  return (
    <span className="cw-line-menu" ref={box} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="cw-linkbtn"
        aria-expanded={open}
        {...(open ? { 'aria-controls': `${id}-menu` } : {})}
        aria-label={t('hub.rooms.line.menu', { time })}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{'\u22EF'}</span>
      </button>
      {open && (
        <span className="cw-line-menu-panel" role="group" id={`${id}-menu`} aria-label={t('hub.rooms.line.menu', { time })}>
          <button type="button" className="cw-btn" aria-disabled={retract.busy} onClick={() => void run(false)}>
            {t('hub.rooms.line.remove')}
          </button>
          <button type="button" className="cw-btn" aria-disabled={retract.busy} onClick={() => void run(true)}>
            {t('hub.rooms.line.removeAll')}
          </button>
          {retract.error !== null && (
            <span className="cw-error" role="alert">
              {roomErrorText(t, retract.error)}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
