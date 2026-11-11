import { useId } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import type { StaffReport } from '../types.js';
import { Field } from './ActionEditor.js';
import type { RulePick } from './useRulePick.js';

/**
 * The rule the report breaks. When the reason points at one rule it is preselected and says what the report was filed as, so it can be
 * changed; when no rule is clear it asks, leading with the rules the reason usually means. Nothing is suggested until one is picked. A
 * suggestion that could not be fetched says so, with Try again.
 */
export function RuleField({ pick, rules, report }: { pick: RulePick; rules: ReadonlyArray<{ number: number; title: string }>; report: StaffReport & { reportedReasonLabel?: string | null } }) {
  const { t } = useHub();
  const id = useId();
  const ask = pick.mode === 'ask';
  const mapped = pick.choice?.kind === 'ask' ? pick.choice.mapped : [];
  const option = (r: { number: number; title: string }): ReactNode => (
    <option key={r.number} value={r.number}>
      {t('hub.guide.rule.named', { number: r.number, title: r.title })}
    </option>
  );
  const lead = rules.filter((r) => mapped.includes(r.number));
  const rest = rules.filter((r) => !mapped.includes(r.number));
  const hint = ask
    ? pick.picked === null
      ? t('hub.simple.rule.askHint')
      : undefined
    : t('hub.simple.rule.knownHint', { reason: report.reportedReasonLabel ?? report.reportedReason ?? '', rule: pick.picked ?? '' });
  return (
    <div className="cw-scard-rule">
      <Field id={`${id}-rule`} label={t(ask ? 'hub.simple.rule.ask' : 'hub.simple.rule.known')} {...(hint === undefined ? {} : { hint })}>
        {(a) => (
          <select {...a} value={pick.picked ?? ''} onChange={(e) => pick.pick(e.target.value === '' ? null : Number(e.target.value))}>
            {ask && <option value="">{t('hub.simple.rule.pick')}</option>}
            {lead.length > 0 ? (
              <>
                <optgroup label={t('hub.simple.rule.usual')}>{lead.map(option)}</optgroup>
                <optgroup label={t('hub.simple.rule.rest')}>{rest.map(option)}</optgroup>
              </>
            ) : (
              rules.map(option)
            )}
          </select>
        )}
      </Field>
      {pick.error !== null && (
        <div className="cw-error" role="alert">
          <p>{t('hub.simple.rule.failed')}</p>
          <button type="button" className="cw-btn" onClick={pick.retry}>
            {t('hub.state.retry')}
          </button>
        </div>
      )}
    </div>
  );
}
