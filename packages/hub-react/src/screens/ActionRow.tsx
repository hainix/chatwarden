import { useHub } from '../context.js';
import { kindLabel, ruleLabel, sanctionLength, sanctionState, sourceLabel } from '../labels.js';
import type { SanctionRow } from '../types.js';
import { Card, Link, PersonChip, Tag, Time } from '../ui.js';

const STATE_KEY = {
  active: 'hub.sanction.status.active',
  pending: 'hub.sanction.status.pending',
  ended: 'hub.sanction.status.ended',
  revoked: 'hub.sanction.status.revoked',
} as const;

/**
 * One sanction in a list of everyone's: the referee card for its kind, what and how long, its state, who it is on (their handle
 * from the latest report against them, and always the short tag, never the ref; a link to their page), the rule, who made it, and when.
 */
export function ActionRow({ sanction: s }: { sanction: SanctionRow }) {
  const { t, locale, can } = useHub();
  const state = sanctionState(s);
  const length = sanctionLength(t, locale, s);
  const who = (
    <>
      {s.handle !== null && <strong className="cw-arow-who">{s.handle}</strong>}
      <PersonChip person={s.person} />
    </>
  );
  return (
    <li className="cw-arow">
      <Card kind={s.kind} />
      <div className="cw-arow-body">
        <div className="cw-arow-head">
          <strong>{kindLabel(t, s.kind)}</strong>
          {length !== '' && <span className="cw-arow-length">{length}</span>}
          <Tag>{t(STATE_KEY[state])}</Tag>
          {s.source !== 'moderator' && <Tag>{sourceLabel(t, s.source)}</Tag>}
        </div>
        <div className="cw-facts">
          {can('history.read') ? (
            <Link to={{ name: 'person', ref: s.person }} className="cw-link">
              {who}
            </Link>
          ) : (
            <span>{who}</span>
          )}
          <span>{ruleLabel(t, s.rule)}</span>
          <span>{s.automated ? t('hub.sanction.automatic') : t('hub.sanction.by', { actor: s.actor })}</span>
          <Time at={s.startsAt} />
        </div>
      </div>
    </li>
  );
}
