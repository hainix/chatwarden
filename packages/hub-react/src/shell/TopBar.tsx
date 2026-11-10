import { actorName, teamOf } from '../claims.js';
import { useHub } from '../context.js';
import { absoluteTime } from '../format.js';
import { Icon, Mark } from '../icons.js';
import type { HubText } from '../i18n.js';
import { useOptionalQueue } from '../liveQueue.js';
import type { Role } from '../types.js';
import { keyLabel } from '../shortcuts.js';
import { Avatar, Kbd, Tag } from '../ui.js';

const ROLE_LABEL: Record<Role, HubText> = {
  moderator: 'hub.session.role.moderator',
  senior: 'hub.session.role.senior',
  owner: 'hub.session.role.owner',
};

/** How many people the top bar shows by name before it says "N more". */
const FACES = 4;

/**
 * The slim top bar: the product, the game, whether the queue is live, the command bar, and who is on. Everything here recedes;
 * the one thing that glows is the small green dot, which says the connection is up.
 */
export function TopBar({ gameName, shortcuts, onCommand }: { gameName?: string; shortcuts: boolean; onCommand: () => void }) {
  const { t, me, now, locale } = useHub();
  const queue = useOptionalQueue();
  const team = queue === null ? [] : teamOf(queue.groups, me.actor, now());
  const shown = team.slice(0, FACES);

  return (
    <header className="cw-top">
      <div className="cw-brand">
        <Mark />
        <h1 className="cw-title">{t('hub.title')}</h1>
        {gameName !== undefined && gameName !== '' && <span className="cw-game">{gameName}</span>}
      </div>
      {queue !== null && (
        <span
          className="cw-live"
          data-state={queue.connection}
          title={queue.updatedAt === null ? undefined : t('hub.shell.liveTitle', { time: absoluteTime(queue.updatedAt, locale) })}
        >
          <i className="cw-live-dot" aria-hidden="true" />
          {queue.connection === 'live' ? t('hub.shell.live') : queue.connection === 'lost' ? t('hub.shell.reconnecting') : t('hub.shell.offline')}
        </span>
      )}
      <div className="cw-top-gap" />
      <button type="button" className="cw-cmd" onClick={onCommand} {...(shortcuts ? { 'aria-keyshortcuts': 'Control+K Meta+K' } : {})}>
        <Icon name="search" />
        <span className="cw-cmd-text">{t('hub.shell.command')}</span>
        {shortcuts && (
          <span className="cw-cmd-keys" aria-hidden="true">
            <Kbd>{keyLabel(t, 'Ctrl')}</Kbd>
            <Kbd>K</Kbd>
          </span>
        )}
      </button>
      {queue !== null && (
        <ul className="cw-faces" aria-label={t('hub.shell.onNow.label')}>
          {shown.map((m) => (
            <li key={m.actor} title={actorName(m.actor)}>
              <Avatar actor={m.actor} you={m.you} />
              <span className="cw-sr">{m.you ? t('hub.shell.onNow.you', { name: actorName(m.actor) }) : t('hub.shell.onNow.person', { name: actorName(m.actor) })}</span>
            </li>
          ))}
          {team.length > shown.length && <li className="cw-faces-more">{t('hub.shell.onNow.more', { count: team.length - shown.length })}</li>}
        </ul>
      )}
      <div className="cw-who" role="group" aria-label={t('hub.session.label')}>
        <span className="cw-actor">{me.actor}</span>
        <Tag tone="accent">{t(ROLE_LABEL[me.role])}</Tag>
      </div>
    </header>
  );
}
