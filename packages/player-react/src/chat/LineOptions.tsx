import type { PlayerT } from '../i18n.js';
import type { WireLine } from './wire.js';

export interface LineOptionsProps {
  t: PlayerT;
  line: WireLine;
  open: boolean;
  onToggle: (id: string) => void;
  onReport: (line: WireLine) => void;
  onMute: (line: WireLine) => void;
  /** Hands the control to the box, which gives it focus back when a row or the report dialog closes. */
  register: (id: string, el: HTMLButtonElement | null) => void;
}

/**
 * The one control on another player's line, and the inline row it opens: Report and Mute {name}. The control is quiet (see chat.css:
 * shown on hover and focus, and always, dimmed, on a touch screen); the row exists only while it is open.
 */
export function LineOptions({ t, line, open, onToggle, onReport, onMute, register }: LineOptionsProps) {
  return (
    <>
      <button
        type="button"
        ref={(el) => register(line.id, el)}
        className="cw-chat-optbtn"
        aria-expanded={open}
        aria-label={t('player.chat.line.options', { name: line.name })}
        onClick={() => onToggle(line.id)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <span className="cw-chat-optrow">
          <button type="button" className="cw-btn cw-chat-optact" onClick={() => onReport(line)}>
            {t('player.chat.report')}
          </button>
          <button type="button" className="cw-btn cw-chat-optact" onClick={() => onMute(line)}>
            {t('player.chat.mute', { name: line.name })}
          </button>
        </span>
      )}
    </>
  );
}
