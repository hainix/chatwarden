import { useHub } from '../context.js';
import { choiceLabel, ruleLabel, sanctionState } from '../labels.js';
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

/** One action on a person's record: its referee card, what it was, whether it still stands, and under which rule, by whom, when. */
export function RecordItem({ s, withReason = false }: { s: SanctionGroupView; withReason?: boolean }) {
  const { t, locale } = useHub();
  const state = sanctionState(s);
  const label = choiceLabel(t, locale, { kind: s.kind, durationMs: s.endsAt === null ? null : s.endsAt - s.startsAt });
  return (
    <li className="cw-rec" data-state={state}>
      <Card kind={s.kind} />
      <div className="cw-rec-body">
        <p className="cw-rec-head">
          <strong>{label}</strong>
          {state !== 'ended' && <Tag>{t(STATE_KEY[state])}</Tag>}
        </p>
        <p className="cw-hint cw-rec-meta">
          <span>{s.automated ? t('hub.record.byAuto', { rule: ruleLabel(t, s.rule) }) : t('hub.record.byActor', { rule: ruleLabel(t, s.rule), actor: s.actor })}</span> <Time at={s.startsAt} />
        </p>
        {withReason && s.reason !== '' && <p className="cw-rec-reason">{s.reason}</p>}
      </div>
    </li>
  );
}
