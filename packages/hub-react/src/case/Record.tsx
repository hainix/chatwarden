import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import { formatDuration } from '../format.js';
import { choiceLabel, ruleLabel, sanctionState, sourceLabel } from '../labels.js';
import type { SanctionState } from '../labels.js';
import type { HubText } from '../i18n.js';
import type { SanctionGroupView } from '../types.js';
import { Card, Tag, Time } from '../ui.js';

const STATE_KEY: Record<SanctionState, HubText> = {
  active: 'hub.sanction.status.active',
  ended: 'hub.sanction.status.ended',
  revoked: 'hub.sanction.status.revoked',
  pending: 'hub.sanction.status.pending',
};

const MINUTE = 60_000;

/**
 * One action on a person's record: its referee card, what it was, whether it still stands, and under which rule, by whom, when.
 * - `withReason` adds the reason the moderator wrote.
 * - `detail` is the person page's fuller line: every state is labelled (Ended too), and it adds where it came from (the AI label
 *   slot among them), the ref code, how long is left or when it ended, and who revoked it and why.
 * - `children` is a slot at the end for what can be done to it (the Revoke button).
 */
export function RecordItem({ s, withReason = false, detail = false, children }: { s: SanctionGroupView; withReason?: boolean; detail?: boolean; children?: ReactNode }) {
  const { t, locale, now } = useHub();
  const state = sanctionState(s);
  const label = choiceLabel(t, locale, { kind: s.kind, durationMs: s.endsAt === null ? null : s.endsAt - s.startsAt });
  const left = state === 'active' || state === 'pending' ? (s.endsAt === null ? null : s.endsAt - now()) : null;
  return (
    <li className="cw-rec" data-state={state}>
      <Card kind={s.kind} />
      <div className="cw-rec-body">
        <p className="cw-rec-head">
          <strong>{label}</strong>
          {(state !== 'ended' || detail) && <Tag>{t(STATE_KEY[state])}</Tag>}
          {detail && s.source !== 'moderator' && <Tag>{sourceLabel(t, s.source)}</Tag>}
        </p>
        <p className="cw-hint cw-rec-meta">
          <span>{s.automated ? t('hub.record.byAuto', { rule: ruleLabel(t, s.rule) }) : t('hub.record.byActor', { rule: ruleLabel(t, s.rule), actor: s.actor })}</span> <Time at={s.startsAt} />
        </p>
        {detail && (
          <p className="cw-facts cw-rec-meta">
            <span>{t('hub.person.ref', { code: s.refCode })}</span>
            {/* Rounded up to the minute, so a 7 day restriction a second old still reads "7d left". */}
            {left !== null && left > 0 && <span>{t('hub.person.left', { time: formatDuration(Math.ceil(left / MINUTE) * MINUTE, locale) })}</span>}
            {state === 'ended' && s.endsAt !== null && (
              <span>
                {t('hub.person.endedAt')} <Time at={s.endsAt} />
              </span>
            )}
            {state === 'revoked' && s.revokedAt !== null && (
              <span>
                {t('hub.person.revokedBy', { actor: s.revokedBy ?? '' })} <Time at={s.revokedAt} />
              </span>
            )}
          </p>
        )}
        {(withReason || detail) && s.reason !== '' && <p className="cw-rec-reason">{s.reason}</p>}
        {detail && state === 'revoked' && s.revokeReason !== null && s.revokeReason !== '' && <p className="cw-rec-reason">{s.revokeReason}</p>}
        {children}
      </div>
    </li>
  );
}
