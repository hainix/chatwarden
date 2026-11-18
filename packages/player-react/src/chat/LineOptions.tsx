import { useEffect, useState } from 'react';
import type { PlayerT } from '../i18n.js';
import type { WireLine } from './wire.js';

export interface LineOptionsProps {
  t: PlayerT;
  line: WireLine;
  open: boolean;
  onToggle: (id: string) => void;
  onReport: (line: WireLine) => void;
  onMute: (line: WireLine) => void;
  /** Called once the player has confirmed the block. */
  onBlock: (line: WireLine) => void;
  /** Hands the control to the box, which gives it focus back when a row or the report dialog closes. */
  register: (id: string, el: HTMLButtonElement | null) => void;
}

/**
 * The one control on another player's line, and the inline row it opens: Report, Mute {name} and Block {name}. The control is quiet (see chat.css:
 * shown on hover and focus, and always, dimmed, on a touch screen); the row exists only while it is open. Block asks once, in one line, before it does anything.
 */
export function LineOptions({ t, line, open, onToggle, onReport, onMute, onBlock, register }: LineOptionsProps) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!open) setAsking(false);
  }, [open]);
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
      {open && !asking && (
        <span className="cw-chat-optrow">
          <button type="button" className="cw-btn cw-chat-optact" onClick={() => onReport(line)}>
            {t('player.chat.report')}
          </button>
          <button type="button" className="cw-btn cw-chat-optact" onClick={() => onMute(line)}>
            {t('player.chat.mute', { name: line.name })}
          </button>
          <button type="button" className="cw-btn cw-chat-optact" onClick={() => setAsking(true)}>
            {t('player.chat.block', { name: line.name })}
          </button>
        </span>
      )}
      {open && asking && (
        <span className="cw-chat-optrow" role="group" aria-label={t('player.chat.block', { name: line.name })}>
          <span className="cw-chat-text">{t('player.chat.blockConfirm')}</span>
          <button type="button" className="cw-btn cw-chat-optact" onClick={() => onBlock(line)}>
            {t('player.chat.block', { name: line.name })}
          </button>
          {/* Focus lands on the safe choice, so Escape and Enter do the cautious thing and keyboard users are not left on a button that went away. */}
          <button type="button" className="cw-btn cw-chat-optact" ref={(el) => el?.focus()} onClick={() => setAsking(false)}>
            {t('player.chat.blockCancel')}
          </button>
        </span>
      )}
    </>
  );
}
