import { useId, useState } from 'react';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { ruleLabel } from '../labels.js';
import type { AiGateCell, AiGatesView, ConductLevel } from '../types.js';
import { ErrorBlock, Scroll, Time } from '../ui.js';
import { useAiT } from './i18n.js';
import type { AiT } from './i18n.js';

// Settings > AI > Advanced > "Where the AI may act" (AI levels 3 and 4, release 1, design 9.2). A read-only table of the server's own answer (`GET /ai/gates`): one row
// for each rule and conduct level the AI could ever act on, each gate as a tick or a cross with its number against the need, the reach in words and the cooling date.
// The hub computes no gate, no rate and no state: every verdict and number is shown as it was sent. Cells whose step is over the AI's ceiling can never act and sit
// in a closed list with the reason. In this release acting does not exist, and the table says so.

const GATES = ['volume', 'breadth', 'agreement', 'override', 'recency', 'appeals_rule', 'appeals_acts', 'keep'] as const;
type Gate = (typeof GATES)[number];

/** A need code (`recent>=5;rate>=0.90`) as its parts (`{ recent: '5', rate: '0.90' }`). A part it cannot read is left out. */
function parts(code: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of code.split(';')) {
    const m = /^([a-z_]+)(?:>=|<=|<|>|:)(.+)$/.exec(piece);
    if (m !== null) out[m[1] as string] = m[2] as string;
  }
  return out;
}

const dayCount = (v: string | undefined): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};

/** One gate's number against its need, in words. */
function gateText(gate: Gate, check: { value: number | null; need: string }, cell: AiGateCell, t: AiT, locale: string): string {
  const need = parts(check.need);
  const pct = (v: number): string => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(v);
  const percentNeed = (v: string | undefined): string => (v === undefined || !Number.isFinite(Number(v)) ? '' : pct(Number(v)));
  const value = check.value;
  switch (gate) {
    case 'volume':
      return t('hub.settings.ai.gates.volume', { value: value ?? 0, need: need.min ?? '' });
    case 'breadth':
      return t('hub.settings.ai.gates.breadth', { value: value ?? 0, need: need.deciders ?? '', days: dayCount(need.span) });
    case 'agreement':
      return cell.counts.qualifying === 0 || value === null ? t('hub.settings.ai.gates.noData') : t('hub.settings.ai.gates.atLeast', { value: pct(value), need: percentNeed(need.lower) });
    case 'override':
      return cell.counts.qualifying === 0 || value === null ? t('hub.settings.ai.gates.noData') : t('hub.settings.ai.gates.atMost', { value: pct(value), need: percentNeed(need.upper) });
    case 'recency':
      return value === null
        ? t('hub.settings.ai.gates.recent.none', { need: need.recent ?? '', rate: percentNeed(need.rate) })
        : t('hub.settings.ai.gates.recent', { value: pct(value), need: need.recent ?? '', rate: percentNeed(need.rate) });
    case 'appeals_rule':
      if (!cell.appeals.available) return t('hub.settings.ai.gates.na');
      return value === null ? t('hub.settings.ai.gates.rule.none', { min: need.min ?? '', need: percentNeed(need.rate) }) : t('hub.settings.ai.gates.below', { value: pct(value), need: percentNeed(need.rate) });
    case 'appeals_acts':
      if (!cell.appeals.available) return t('hub.settings.ai.gates.na');
      return value === null
        ? t('hub.settings.ai.gates.acts.none', { days: dayCount(need.none) })
        : t('hub.settings.ai.gates.acts.ago', { days: Math.floor(value / 86_400_000), need: dayCount(need.none) });
    case 'keep':
      return value === null ? t('hub.settings.ai.gates.keep.none') : t('hub.settings.ai.gates.atMost', { value: pct(value), need: percentNeed(need.lower) });
  }
}

const levelWord = (t: AiT, level: ConductLevel): string => t(`hub.decide.suggest.level.${level}`);

/** The cell's name for a reader: `Rule 2, Hostile`. */
function cellName(hubT: Parameters<typeof ruleLabel>[0], t: AiT, cell: AiGateCell): string {
  return `${ruleLabel(hubT, cell.rule)}, ${levelWord(t, cell.level)}`;
}

/** What the ladder gives for a clean record: the first reach row (the server fixes the order). */
const clean = (cell: AiGateCell): AiGateCell['reach'][number] | undefined => cell.reach.find((r) => r.record === 'clean');
/** A cell the AI can never act on: not even a clean record's step is within what it may ever apply. */
const neverActs = (cell: AiGateCell): boolean => clean(cell)?.withinCeilings !== true;

function Tick({ ok, t }: { ok: boolean; t: AiT }) {
  return (
    <>
      <span aria-hidden="true" className={ok ? 'cw-gate-ok' : 'cw-gate-no'}>
        {ok ? '\u2713' : '\u2717'}
      </span>{' '}
      <span className="cw-sr">{t(ok ? 'hub.settings.ai.gates.met' : 'hub.settings.ai.gates.unmet')}</span>
    </>
  );
}

function CellRow({ cell, t }: { cell: AiGateCell; t: AiT }) {
  const { t: hubT, locale } = useHub();
  const name = cellName(hubT, t, cell);
  const step = clean(cell)?.step ?? null;
  const status = cell.excluded ? 'excluded' : cell.open ? 'open' : 'closed';
  return (
    <tr>
      <th scope="row">
        {name}
        <span className="cw-hint cw-gate-reach">{t('hub.settings.ai.gates.reach', { step: step === null ? t('hub.settings.ai.gates.reach.person') : step.label })}</span>
      </th>
      <td>
        <strong>{t(`hub.settings.ai.gates.status.${status}`)}</strong>
        {cell.coolingUntil !== null && (
          <span className="cw-hint cw-gate-cooling">
            {t(cell.coolingCode === 'appeal_revoked' ? 'hub.settings.ai.gates.cooling.appeal' : 'hub.settings.ai.gates.cooling.undo')} <Time at={cell.coolingUntil} />
          </span>
        )}
      </td>
      {GATES.map((g) => {
        const check = cell.checks.find((c) => c.name === g);
        return (
          <td key={g}>
            {check === undefined ? (
              t('hub.settings.ai.gates.na')
            ) : (
              <>
                <Tick ok={check.ok} t={t} /> <span>{gateText(g, check, cell, t, locale)}</span>
              </>
            )}
          </td>
        );
      })}
    </tr>
  );
}

/** The gate table: loaded when Advanced is opened (one read), never on a timer. */
export function GateTable() {
  const t = useAiT();
  const { client, t: hubT } = useHub();
  const id = useId();
  const gates = useHubData<AiGatesView>('ai:gates', () => client.aiGates());
  const [showNever, setShowNever] = useState(false);

  let body;
  if (gates.error !== null) {
    body = gates.error.status === 404 ? <p className="cw-hint">{t('hub.settings.ai.gates.old')}</p> : <ErrorBlock error={gates.error} what={t('hub.settings.ai.gates.what')} onRetry={gates.reload} />;
  } else if (gates.data === undefined) {
    body = <p role="status">{hubT('hub.state.loading')}</p>;
  } else {
    const cells = gates.data.cells;
    const acting = cells.filter((c) => !neverActs(c));
    const never = cells.filter(neverActs);
    const noAppeals = acting.length > 0 && acting.every((c) => !c.appeals.available);
    body =
      cells.length === 0 ? (
        <p className="cw-hint">{t('hub.settings.ai.gates.none')}</p>
      ) : (
        <>
          {acting.length > 0 && (
            <Scroll label={t('hub.settings.ai.gates.table')}>
              <table className="cw-table cw-gate-table" aria-label={t('hub.settings.ai.gates.table')}>
                <thead>
                  <tr>
                    <th scope="col">{t('hub.settings.ai.gates.col.cell')}</th>
                    <th scope="col">{t('hub.settings.ai.gates.col.status')}</th>
                    {GATES.map((g) => (
                      <th key={g} scope="col">
                        {t(`hub.settings.ai.gates.gate.${g}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {acting.map((c) => (
                    <CellRow key={`${c.rule}/${c.level}`} cell={c} t={t} />
                  ))}
                </tbody>
              </table>
            </Scroll>
          )}
          {noAppeals && <p className="cw-hint">{t('hub.settings.ai.gates.noAppeals')}</p>}
          {never.length > 0 && (
            <div className="cw-gate-never">
              <button type="button" className="cw-btn" aria-expanded={showNever} aria-controls={`${id}-never`} onClick={() => setShowNever(!showNever)}>
                {t('hub.settings.ai.gates.never.title', { count: never.length })}
              </button>
              {showNever && (
                <ul id={`${id}-never`} aria-label={t('hub.settings.ai.gates.never.list')}>
                  {never.map((c) => {
                    const step = clean(c)?.step ?? null;
                    return (
                      <li key={`${c.rule}/${c.level}`}>
                        {step === null
                          ? t('hub.settings.ai.gates.never.nostep', { cell: cellName(hubT, t, c) })
                          : t('hub.settings.ai.gates.never.item', { cell: cellName(hubT, t, c), step: step.label })}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      );
  }

  return (
    <section className="cw-gates" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t('hub.settings.ai.gates.title')}</h3>
      <p className="cw-hint">{t('hub.settings.ai.gates.notAvailable')}</p>
      <p className="cw-hint">{t('hub.settings.ai.gates.intro')}</p>
      {body}
    </section>
  );
}
