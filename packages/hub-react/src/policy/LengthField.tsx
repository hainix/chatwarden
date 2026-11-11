import { useId } from 'react';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import { lengthPhrase } from '../labels.js';
import { LENGTH_UNITS, lengthValue, resolveLength } from './length.js';
import type { LengthDraft, LengthUnit } from './length.js';

/** What a length menu offers: the profile's lengths, permanent when the role may give it, and "Custom length" when the profile allows. */
export interface LengthMenu {
  durations: readonly number[];
  permanent: boolean;
  custom: boolean;
}

export interface LengthFieldProps {
  /** The id of the select. */
  id: string;
  /** The select's name. Shown as a label when `visible`, else only for assistive technology. */
  label: string;
  visible?: boolean;
  /** The names of the number and unit boxes of a custom length. */
  numberLabel: string;
  unitLabel: string;
  value: LengthDraft;
  menu: LengthMenu;
  onChange: (next: LengthDraft) => void;
  problem?: Problem | undefined;
  disabled?: boolean;
  /** Set on the select, so a refusal can put keyboard focus here (and on the number box when the length is custom). */
  field?: string;
}

/**
 * A length: a menu of the offered lengths, permanent and "Custom length", and for a custom one a number and a unit (hours or days)
 * with the kit's bounds. A length that is in the field but not on the menu (a ladder cell the owner set before) is still listed, so
 * the field always says what it holds.
 */
export function LengthField({ id, label, visible = false, numberLabel, unitLabel, value, menu, onChange, problem, disabled = false, field }: LengthFieldProps) {
  const { t, locale } = useHub();
  const errorId = useId();
  const listed = menu.durations.map((ms) => ({ value: lengthValue(ms), ms }));
  const current = resolveLength(value);
  const extra = value.value !== 'custom' && value.value !== 'permanent' && !listed.some((o) => o.value === value.value) && current.ok && current.ms !== null ? [{ value: value.value, ms: current.ms }] : [];
  const showCustom = menu.custom || value.value === 'custom';
  const showPermanent = menu.permanent || value.value === 'permanent';
  const describedBy = problem === undefined ? {} : { 'aria-describedby': errorId, 'aria-invalid': true as const };
  const custom = value.value === 'custom';
  return (
    <span className="cw-length">
      {visible && <label htmlFor={id}>{label}</label>}
      <span className="cw-length-row">
        <select
          id={id}
          {...(visible ? {} : { 'aria-label': label })}
          {...(custom ? {} : describedBy)}
          {...(field === undefined ? {} : { 'data-field': field })}
          disabled={disabled}
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        >
          {value.value === '' && <option value="">{t('hub.length.choose')}</option>}
          {[...listed, ...extra].sort((a, b) => a.ms - b.ms).map((o) => (
            <option key={o.value} value={o.value}>
              {lengthPhrase(t, locale, o.ms)}
            </option>
          ))}
          {showPermanent && <option value="permanent">{t('hub.decide.length.permanent')}</option>}
          {showCustom && <option value="custom">{t('hub.length.custom')}</option>}
        </select>
        {custom && (
          <>
            <input
              id={`${id}-number`}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              aria-label={numberLabel}
              {...describedBy}
              {...(field === undefined ? {} : { 'data-field': `${field}-number` })}
              disabled={disabled}
              value={value.amount}
              onChange={(e) => onChange({ ...value, amount: e.target.value })}
            />
            <select aria-label={unitLabel} disabled={disabled} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as LengthUnit })}>
              {LENGTH_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(u === 'hours' ? 'hub.length.unit.hours' : 'hub.length.unit.days')}
                </option>
              ))}
            </select>
          </>
        )}
      </span>
      {problem !== undefined && (
        <span id={errorId} className="cw-field-error">
          {t(problem.key, problem.params)}
        </span>
      )}
    </span>
  );
}
