import type { PlayerT } from '../i18n.js';
import type { WireMuted } from './wire.js';

export interface OptionsButtonProps {
  t: PlayerT;
  open: boolean;
  panelId: string;
  onToggle: () => void;
  register: (el: HTMLButtonElement | null) => void;
}

/** The one door at the box's corner: Chat options. */
export function OptionsButton({ t, open, panelId, onToggle, register }: OptionsButtonProps) {
  return (
    <button type="button" ref={register} className="cw-btn cw-chat-optionsbtn" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={t('player.chat.options')} onClick={onToggle}>
      <span aria-hidden="true">⋯</span>
    </button>
  );
}

export interface OptionsPanelProps {
  t: PlayerT;
  id: string;
  muted: WireMuted[];
  /** The profile's one-line standard, from `hello`. */
  summary: string;
  onUnmute: (ref: string) => void;
  /** When given, "Read the rules" is offered and calls it. */
  onOpenRules: (() => void) | undefined;
}

/** What the door opens: the players the viewer muted (each with Unmute), the standard in one line, and the rules when the game has a page for them. */
export function OptionsPanel({ t, id, muted, summary, onUnmute, onOpenRules }: OptionsPanelProps) {
  const titleId = `${id}-title`;
  return (
    <div id={id} className="cw-chat-panel" role="group" aria-labelledby={titleId}>
      <p id={titleId} className="cw-chat-panel-title">
        {t('player.chat.mutedList')}
      </p>
      {muted.length === 0 ? (
        <p className="cw-chat-panel-note">{t('player.chat.mutedNone')}</p>
      ) : (
        <ul className="cw-chat-muted">
          {muted.map((m) => (
            <li key={m.ref}>
              <span className="cw-chat-text">{m.name}</span>
              <button type="button" className="cw-btn cw-chat-optact" aria-label={t('player.chat.unmuteName', { name: m.name })} onClick={() => onUnmute(m.ref)}>
                {t('player.chat.unmute')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {summary !== '' && <p className="cw-chat-standard">{summary}</p>}
      {onOpenRules !== undefined && (
        <button type="button" className="cw-btn cw-chat-optact" onClick={onOpenRules}>
          {t('player.chat.openRules')}
        </button>
      )}
    </div>
  );
}
