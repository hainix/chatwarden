import { useRef } from 'react';
import { secondsLeft, timeLeft, untilText } from './format.js';
import { Card, Root, useUi } from './ui.js';
import type { PlayerUiProps } from './ui.js';

export interface RestrictedChatLineProps extends PlayerUiProps {
  /** When the restriction ends (epoch ms), or `null` for no end. From `cw.chat.restricted(...)`. Not used with `pace`. */
  until?: number | null;
  /** `true` when a moderator turned the chat off, `false` when the automatic filter did (kind `auto`). Not used with `pace`. */
  byModerator?: boolean;
  /** The reference code to quote to a moderator, when you have one. Not shown for a pause. */
  refCode?: string;
  /**
   * A pause, not a sanction: pass the refusal's `reason` and `retryAfterMs`. When given it replaces `until` and `byModerator`, draws no
   * referee card, and says how long to wait in seconds. The end is worked out once, when the line first renders, so a re-render does not
   * restart the wait.
   * @experimental
   */
  pace?: { reason: 'slow_mode' | 'flood' | 'duplicate'; retryAfterMs: number };
}

/** One line for the place a chat box would be, saying why the player cannot type, until when, and who did it (or, for a pause, how long to wait). */
export function RestrictedChatLine(props: RestrictedChatLineProps) {
  const { until = null, byModerator = false, refCode, pace, theme, className } = props;
  const ui = useUi(props);
  const { t, locale, timeZone } = ui;
  // A pause ends once: the first render fixes `now + retryAfterMs`, and later renders count down to it.
  const paceEnd = useRef<number | null>(null);
  if (pace !== undefined && paceEnd.current === null) paceEnd.current = ui.now() + (Number.isFinite(pace.retryAfterMs) ? pace.retryAfterMs : 0);

  if (pace !== undefined) {
    const wait = secondsLeft((paceEnd.current ?? 0) - ui.now(), locale);
    const reason = pace.reason === 'flood' || pace.reason === 'duplicate' ? pace.reason : 'slow_mode';
    return (
      <Root theme={theme} className={className}>
        <p className="cw-restricted" role="status">
          <span className="cw-text">{wait === null ? t('player.pace.ready') : t(`player.pace.${reason}`, { left: wait })}</span>
        </p>
      </Root>
    );
  }

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
