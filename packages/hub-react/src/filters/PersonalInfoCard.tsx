import type { PersonalInfoSettings, PersonalKind } from '@chatwarden/core';
import { FILTER_RULE_DEFAULTS, PERSONAL_KINDS } from '@chatwarden/core';
import { useHub } from '../context.js';
import { ActionChoice, Card, ProblemLine, RuleField } from './parts.js';
import type { Problem } from './parts.js';

/** Personal info: phone numbers, emails, card numbers and "add me on" lines, and a street address that can only count or go to the queue. */
export function PersonalInfoCard({ value, onChange, problem, flagCap }: { value: PersonalInfoSettings | null; onChange: (v: PersonalInfoSettings | null) => void; problem: Problem | null; flagCap: number }) {
  const { t } = useHub();
  const v = value;
  const set = (patch: Partial<PersonalInfoSettings>): void => {
    if (v !== null) onChange({ ...v, ...patch });
  };
  const kinds: readonly PersonalKind[] = v?.kinds ?? PERSONAL_KINDS;
  const toggle = (k: PersonalKind, on: boolean): void => set({ kinds: PERSONAL_KINDS.filter((x) => (x === k ? on : kinds.includes(x))) });
  return (
    <Card
      title={t('hub.settings.filters.personal.title')}
      hint={t('hub.settings.filters.personal.hint')}
      on={v !== null}
      onToggle={(on) => onChange(on ? { action: 'count', rule: FILTER_RULE_DEFAULTS.personalInfo, kinds: [...PERSONAL_KINDS], phone: 'formatted', address: null } : null)}
    >
      {v !== null && (
        <>
          <ActionChoice
            value={v.action}
            onChange={(action) => set({ action })}
            about={(a) => (a === 'flag' ? t('hub.settings.filters.action.flag.about', { count: flagCap }) : t(`hub.settings.filters.action.${a}.about` as never))}
          />
          <RuleField value={v.rule} onChange={(rule) => set({ rule })} />
          <fieldset className="cw-fchoice">
            <legend>{t('hub.settings.filters.personal.kinds')}</legend>
            <div className="cw-fchoice-row">
              {PERSONAL_KINDS.map((k) => (
                <label key={k} className="cw-choice">
                  <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => toggle(k, e.target.checked)} />
                  <span>{t(`hub.settings.filters.personal.kind.${k}` as never)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="cw-field">
            <label htmlFor="cw-fp-phone">{t('hub.settings.filters.personal.phone')}</label>
            <select id="cw-fp-phone" value={v.phone ?? 'formatted'} onChange={(e) => set({ phone: e.target.value === 'any' ? 'any' : 'formatted' })}>
              <option value="formatted">{t('hub.settings.filters.personal.phone.formatted')}</option>
              <option value="any">{t('hub.settings.filters.personal.phone.any')}</option>
            </select>
          </div>
          <div className="cw-field">
            <label htmlFor="cw-fp-address">{t('hub.settings.filters.personal.address')}</label>
            <select id="cw-fp-address" value={v.address ?? 'off'} onChange={(e) => set({ address: e.target.value === 'count' || e.target.value === 'flag' ? e.target.value : null })}>
              <option value="off">{t('hub.settings.filters.personal.address.off')}</option>
              <option value="count">{t('hub.settings.filters.personal.address.count')}</option>
              <option value="flag">{t('hub.settings.filters.personal.address.flag')}</option>
            </select>
            <p className="cw-hint">{t('hub.settings.filters.personal.address.hint')}</p>
          </div>
          <ProblemLine problem={problem} card="personalInfo" />
        </>
      )}
    </Card>
  );
}
