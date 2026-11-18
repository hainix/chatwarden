import { choiceLabel, outcomeLabel } from '../labels.js';
import type { HubT } from '../i18n.js';
import type { SetupOption } from '../types.js';

// The one line the first-run panel says about what a choice does to the steps: the first offence for each of the three levels that have one, and where the repeat steps end. In words from
// the catalog, never the layer's JSON. Pure.

const LEVELS = ['rude', 'hostile', 'severe'] as const;

/** "First offences: Rude, Warning; Hostile, Chat restriction, 24 hours; ... Repeated offences end at <the heaviest step>." */
export function ladderSummary(option: SetupOption, t: HubT, locale = 'en'): string {
  const first = option.layer.firstOffense ?? {};
  const said = LEVELS.map((level) => t('hub.setup.summary.level', { level: t(`hub.settings.cover.${level}`), outcome: outcomeLabel(t, locale, first[level] ?? 'none') })).join('; ');
  const heaviest = option.layer.ladder?.at(-1)?.high;
  if (heaviest === undefined) return t('hub.setup.summary.first', { first: said });
  const last = heaviest.label ?? choiceLabel(t, locale, { kind: heaviest.kind, durationMs: heaviest.durationMs });
  return t('hub.setup.summary', { first: said, last });
}
