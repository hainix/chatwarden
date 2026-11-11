import { useId } from 'react';
import type { RefObject } from 'react';
import type { ReasonGroup, ReasonItem } from './reporting.js';

/** The radios, by group. One radio group (one name) across the groups, so the arrow keys walk all of them and Tab stops once. */
export function Picker(props: {
  groups: readonly ReasonGroup[];
  name: string;
  value: string | null;
  onChange: (id: string) => void;
  legend: string;
  invalid?: boolean;
  describedBy?: string | undefined;
  fieldset?: RefObject<HTMLFieldSetElement | null>;
}) {
  const { groups, name, value, onChange, legend, invalid, describedBy, fieldset } = props;
  const base = useId();
  const choice = (r: ReasonItem) => {
    const label = `${base}-${r.id}-l`;
    const hint = `${base}-${r.id}-h`;
    return (
      <label key={r.id} className="cw-choice">
        <input
          type="radio"
          name={name}
          value={r.id}
          checked={value === r.id}
          aria-labelledby={label}
          aria-describedby={r.hint === '' ? undefined : hint}
          onChange={() => onChange(r.id)}
        />
        <span className="cw-choice-text">
          <span id={label}>{r.label}</span>
          {r.hint !== '' && (
            <span id={hint} className="cw-choice-hint">
              {r.hint}
            </span>
          )}
        </span>
      </label>
    );
  };
  return (
    <fieldset ref={fieldset} className="cw-fieldset" role="radiogroup" aria-invalid={invalid || undefined} aria-describedby={invalid ? describedBy : undefined}>
      <legend className="cw-legend">{legend}</legend>
      {groups.map((g, i) =>
        g.name === '' ? (
          <div key={`g${i}`} className="cw-group">
            {g.items.map(choice)}
          </div>
        ) : (
          <fieldset key={`g${i}`} className="cw-fieldset cw-group">
            <legend className="cw-group-legend">{g.name}</legend>
            {g.items.map(choice)}
          </fieldset>
        ),
      )}
    </fieldset>
  );
}
