import { useId, useState } from 'react';
import { DEFAULT_ROOM_MS, DurationSelect, roomErrorText } from '../case/RoomActions.js';
import type { HubError } from '../client.js';
import { toHubError } from '../client.js';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import type { HubT } from '../i18n.js';
import type { RoomMode, RoomRow } from '../types.js';
import { Fetched, Panel } from '../ui.js';

// Settings > Advanced > "Rooms" (design 9 and 16): the rooms this server process knows, a labelled radio group per room (Normal, Locked, Emergency), a length for the two that restrict, and the
// time a mode ends. Normal is at once and needs no question; Locked and Emergency ask how long (15 minutes, 30 minutes by default, 1 hour, 4 hours) and can be cancelled. Every mode ends by
// itself, is per server process (the panel says so), and is never a sanction. The list is capped at 500 rooms (the panel says so). A role that may read but not manage sees each mode as text.

/** The most rooms the kit lists. */
const LIST_MAX = 500;
const MODES: ReadonlyArray<{ mode: RoomMode; label: 'hub.rooms.mode.normal' | 'hub.rooms.mode.locked' | 'hub.rooms.mode.emergency' }> = [
  { mode: 'normal', label: 'hub.rooms.mode.normal' },
  { mode: 'locked', label: 'hub.rooms.mode.locked' },
  { mode: 'emergency', label: 'hub.rooms.mode.emergency' },
];

const clock = (at: number, locale: string): string => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(at);

/** What a room's mode is, in words: "Locked until 2:30 PM", "Emergency mode until 2:30 PM", or "Normal". */
function modeText(t: HubT, locale: string, row: RoomRow): string {
  if (row.mode === 'normal' || row.until === null) return t('hub.rooms.mode.normal');
  return t(row.mode === 'locked' ? 'hub.rooms.until.locked' : 'hub.rooms.until.emergency', { time: clock(row.until, locale) });
}

function Room({ row, editable, onChanged }: { row: RoomRow; editable: boolean; onChanged: () => void }) {
  const { t, locale, client } = useHub();
  const id = useId();
  // A restrictive mode chosen and not yet confirmed: the control shows it, the server knows nothing of it until Confirm.
  const [chosen, setChosen] = useState<'locked' | 'emergency' | null>(null);
  const [ms, setMs] = useState(DEFAULT_ROOM_MS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const seated = t('hub.rooms.seated', { count: row.seated });
  if (!editable) {
    return (
      <li className="cw-room">
        <strong>{row.roomId}</strong> <span className="cw-hint">{seated}</span>
        <p className="cw-hint">{modeText(t, locale, row)}</p>
      </li>
    );
  }
  const send = async (mode: RoomMode, forMs?: number): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.setRoomMode(row.roomId, mode, forMs);
      setChosen(null);
      onChanged();
    } catch (e) {
      // The control goes back to what the server has: nothing changed, and the reason is said.
      setChosen(null);
      setError(toHubError(e));
    } finally {
      setBusy(false);
    }
  };
  const value = chosen ?? row.mode;
  return (
    <li className="cw-room">
      <fieldset className="cw-room-modes">
        <legend>{t('hub.rooms.legend', { room: row.roomId })}</legend>
        <span className="cw-hint">{seated}</span>
        <div className="cw-room-radios">
          {MODES.map((m) => (
            <label key={m.mode} className="cw-choice">
              <input
                type="radio"
                name={`${id}-mode`}
                checked={value === m.mode}
                aria-disabled={busy}
                onChange={() => {
                  setError(null);
                  if (m.mode === 'normal') {
                    setChosen(null);
                    // Back to normal needs no question: it is at once.
                    if (row.mode !== 'normal') void send('normal');
                  } else {
                    setMs(DEFAULT_ROOM_MS);
                    setChosen(m.mode);
                  }
                }}
              />
              <span>{t(m.label)}</span>
            </label>
          ))}
        </div>
        {chosen === null && row.mode !== 'normal' && <p className="cw-hint">{modeText(t, locale, row)}</p>}
        {chosen !== null && (
          <div className="cw-room-confirm">
            <DurationSelect id={`${id}-for`} value={ms} onChange={setMs} />
            {chosen === 'emergency' && <p className="cw-hint">{t('hub.rooms.emergency.line')}</p>}
            <div className="cw-whattodo-actions">
              <button type="button" className="cw-btn cw-btn--primary" aria-disabled={busy} onClick={() => void send(chosen, ms)}>
                {t(chosen === 'locked' ? 'hub.rooms.set.lock' : 'hub.rooms.set.emergency')}
              </button>
              <button
                type="button"
                className="cw-btn"
                onClick={() => {
                  setChosen(null);
                  setError(null);
                }}
              >
                {t('hub.rooms.cancel')}
              </button>
            </div>
          </div>
        )}
        {error !== null && (
          <p className="cw-error" role="alert">
            {roomErrorText(t, error)}
          </p>
        )}
      </fieldset>
    </li>
  );
}

export function RoomsSettings() {
  const { t, client, can } = useHub();
  const editable = can('rooms.manage');
  const state = useHubData('rooms:list', () => client.rooms());
  return (
    <div className="cw-settings cw-rooms">
      <Panel title={t('hub.rooms.title')}>
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.rooms.intro')}</p>
          <p className="cw-hint">{t('hub.rooms.serverOnly')}</p>
          <div className="cw-settings-all">
            <button type="button" className="cw-btn" onClick={state.reload}>
              {t('hub.rooms.refresh')}
            </button>
          </div>
          <Fetched state={state} what={t('hub.state.what.rooms')}>
            {(data) =>
              data.rooms.length === 0 ? (
                <p className="cw-hint">{t('hub.rooms.empty')}</p>
              ) : (
                <>
                  <ul className="cw-rooms-list" aria-label={t('hub.rooms.list')}>
                    {data.rooms.map((row) => (
                      <Room key={row.roomId} row={row} editable={editable} onChanged={state.reload} />
                    ))}
                  </ul>
                  {data.rooms.length >= LIST_MAX && <p className="cw-hint">{t('hub.rooms.capped', { count: LIST_MAX })}</p>}
                </>
              )
            }
          </Fetched>
        </div>
      </Panel>
    </div>
  );
}
