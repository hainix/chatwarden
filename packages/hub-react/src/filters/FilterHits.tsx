import { useEffect, useId, useState } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { errorText, filterKeyLabel } from '../labels.js';
import type { FilterStatsView } from '../types.js';

/**
 * "What the filters did": a collapsed table of the last 7 or 30 days, a row for each rule, counts as plain numbers (no band, no colour). Nothing is asked of the server
 * until the disclosure is opened. A phrase rule is named by its rule's label as the server sends it; `flag_capped` reads "Not filed (daily limit)".
 */
export function FilterHits({ labelOf }: { labelOf: (key: string) => string | undefined }) {
  const { t, client } = useHub();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<FilterStatsView | null>(null);
  const [error, setError] = useState<HubError | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    client.filterStats(days).then(
      (view) => live && setData(view),
      (e: unknown) => live && (setData(null), setError(toHubError(e))),
    );
    return () => {
      live = false;
    };
  }, [open, days, client]);

  // Filter reports overturned on appeal (90 days, fixed) sit in their rule's own row; a rule with a count and no hits in the window still has a row, of zeros.
  const overturned = data?.overturned ?? {};
  const turned = (key: string): number => (Object.hasOwn(overturned, key) && typeof overturned[key] === 'number' ? (overturned[key] as number) : 0);
  const keys = data === null ? [] : [...Object.keys(data.keys), ...Object.keys(overturned).filter((k) => turned(k) > 0 && !Object.hasOwn(data.keys, k))];
  const rows =
    data === null
      ? []
      : keys.map((key) => {
          const c = Object.hasOwn(data.keys, key) ? (data.keys[key] as FilterStatsView['keys'][string]) : { count: 0, flag: 0, mask: 0, refuse: 0, flag_capped: 0 };
          return { key, label: filterKeyLabel(t, key, c.label ?? labelOf(key)), counts: c, overturned: turned(key) };
        });
  return (
    <details
      className="cw-fhits"
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now !== open) setOpen(now);
      }}
    >
      <summary>{t('hub.settings.filters.hits.title')}</summary>
      <fieldset className="cw-fchoice">
        <legend>{t('hub.settings.filters.hits.windows')}</legend>
        <div className="cw-fchoice-row">
          {([7, 30] as const).map((d) => (
            <label key={d} className="cw-choice">
              <input type="radio" name={`${id}-days`} checked={days === d} onChange={() => setDays(d)} />
              <span>{t(d === 7 ? 'hub.settings.filters.hits.days.week' : 'hub.settings.filters.hits.days.month')}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error !== null && (
        <div className="cw-error" role="alert">
          <p>{error.status === 404 ? t('hub.settings.filters.hits.unavailable') : errorText(t, error)}</p>
        </div>
      )}
      {open && data !== null && rows.length === 0 && <p className="cw-hint">{t('hub.settings.filters.hits.none')}</p>}
      {open && rows.length > 0 && (
        <div className="cw-table-wrap">
          <table className="cw-table" aria-label={t('hub.settings.filters.hits.title')} aria-describedby={`${id}-flag`}>
            <thead>
              <tr>
                <th scope="col">{t('hub.settings.filters.hits.rule')}</th>
                <th scope="col">{t('hub.settings.filters.hits.count')}</th>
                <th scope="col">{t('hub.settings.filters.hits.flag')}</th>
                <th scope="col">{t('hub.settings.filters.hits.mask')}</th>
                <th scope="col">{t('hub.settings.filters.hits.refuse')}</th>
                <th scope="col">{t('hub.settings.filters.hits.capped')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.label}
                    {r.overturned > 0 && <span className="cw-hint cw-fhits-overturned">{t('hub.settings.filters.hits.overturned', { count: r.overturned })}</span>}
                  </td>
                  <td>{r.counts.count}</td>
                  <td>{r.counts.flag}</td>
                  <td>{r.counts.mask}</td>
                  <td>{r.counts.refuse}</td>
                  <td>{r.counts.flag_capped}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && rows.length > 0 && (
        <p id={`${id}-flag`} className="cw-hint">
          {t('hub.settings.filters.hits.flagHint')}
        </p>
      )}
    </details>
  );
}
