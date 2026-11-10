import { timeLeft, untilText } from './format.js';
import { Card, Root, useUi } from './ui.js';
import type { PlayerUiProps } from './ui.js';

export interface RestrictedChatLineProps extends PlayerUiProps {
  /** When the restriction ends (epoch ms), or `null` for no end. From `cw.chat.restricted(...)`. */
  until: number | null;
  /** `true` when a moderator turned the chat off, `false` when the automatic filter did (kind `auto`). */
  byModerator: boolean;
  /** The reference code to quote to a moderator, when you have one. */
  refCode?: string;
}

/** One line for the place a chat box would be, saying why the player cannot type, until when, and who did it. */
export function RestrictedChatLine(props: RestrictedChatLineProps) {
  const { until, byModerator, refCode, theme, className } = props;
  const ui = useUi(props);
  const { t, locale, timeZone } = ui;
  const ends = typeof until === 'number' && Number.isFinite(until);
  const when = ends ? untilText(until, locale, timeZone) : '';
  const left = ends ? timeLeft(until, ui.now(), locale) : null;
  const text = !ends
    ? t(byModerator ? 'player.restricted.moderator.noEnd' : 'player.restricted.filter.noEnd')
    : left === null
      ? t('player.restricted.ended', { when })
      : t(byModerator ? 'player.restricted.moderator.until' : 'player.restricted.filter.until', { when, left });

  return (
    <Root theme={theme} className={className}>
      <p className="cw-restricted" role="status">
        <Card kind="chat" />
        <span className="cw-text">{text}</span>
        {refCode !== undefined && (
          <>
            {' '}
            <span className="cw-ref">{t('player.restricted.ref', { code: refCode })}</span>
          </>
        )}
      </p>
    </Root>
  );
}
