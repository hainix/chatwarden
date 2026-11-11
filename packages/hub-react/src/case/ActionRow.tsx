import { useHub } from '../context.js';
import { resolveDraft } from '../decision.js';
import type { Draft, Problem } from '../decision.js';
import { personName } from '../excerpt.js';
import type { ReportPerson } from '../excerpt.js';
import { ActionTitle, Field, RuleOptions } from './ActionEditor.js';

/** One action in short: what, who, which rule, how many lines. Change opens the full editor. */
export function ActionRow({
  n,
  draft: d,
  base,
  people,
  rules,
  problems,
  onChange,
  onEdit,
  onRemove,
}: {
  n: number;
  draft: Draft;
  base: string;
  people: readonly ReportPerson[];
  rules: ReadonlyArray<{ number: number; title: string }>;
  problems: { rule?: Problem } | undefined;
  onChange: (patch: Partial<Draft>) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useHub();
  const person = people.find((p) => p.ref === d.person);
  const name = person === undefined ? '' : personName(person, people, t);
  const choice = resolveDraft(d);
  const labelId = `${base}-${d.uid}-row`;
  return (
    <div className="cw-sumrow" role="group" aria-labelledby={labelId}>
      <div className="cw-sumrow-head">
        <span id={labelId} className="cw-sr">
          {t('hub.decide.action.title', { n })}
        </span>
        <ActionTitle draft={d} />
        <span className="cw-hint">{t('hub.decide.action.for', { name })}</span>
        <span className="cw-sumrow-buttons">
          <button type="button" className="cw-btn" aria-label={t('hub.decide.action.changeLabel', { n })} onClick={onEdit}>
            {t('hub.decide.change')}
          </button>
          <button type="button" className="cw-btn" aria-label={t('hub.decide.action.removeLabel', { n })} onClick={onRemove}>
            {t('hub.decide.action.remove')}
          </button>
        </span>
      </div>
      <Field id={`${base}-${d.uid}-rule`} label={t('hub.decide.action.rule')} problem={problems?.rule}>
        {(a) => (
          <select {...a} value={d.rule} onChange={(e) => onChange({ rule: e.target.value })}>
            <RuleOptions rules={rules} />
          </select>
        )}
      </Field>
      {choice !== null && choice.kind !== 'note' && (
        <p className="cw-hint">{d.lineIds.length === 0 ? t('hub.decide.action.lines.noneChosen', { name }) : t('hub.decide.action.lines.summary', { count: d.lineIds.length, name })}</p>
      )}
    </div>
  );
}
