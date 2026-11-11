import type { HubText } from './i18n.js';
import { SECTION_ORDER } from './policy/model.js';

// A settings save or reset is one audit action for two screens. The row's detail names the sections it changed, so its words can say which
// screen: only the reporting section, only steps and ladder sections, or the general words (both, none named, or a section this hub does not know).

const LADDER = new Set<string>(SECTION_ORDER);

/** The catalog key for a `policy.update` or `policy.reset` row, by the sections its detail names; null for any other action. */
export function policyAuditKey(action: string, detail: unknown): HubText | null {
  if (action !== 'policy.update' && action !== 'policy.reset') return null;
  const general: HubText = action === 'policy.update' ? 'hub.audit.label.policy.update' : 'hub.audit.label.policy.reset';
  const sections = typeof detail === 'object' && detail !== null && !Array.isArray(detail) ? (detail as { sections?: unknown }).sections : undefined;
  if (!Array.isArray(sections) || sections.length === 0 || !sections.every((s) => typeof s === 'string')) return general;
  const names = sections as string[];
  if (names.every((s) => s === 'reporting')) return action === 'policy.update' ? 'hub.audit.label.policy.update.reporting' : 'hub.audit.label.policy.reset.reporting';
  if (names.every((s) => LADDER.has(s))) return action === 'policy.update' ? 'hub.audit.label.policy.update.ladder' : 'hub.audit.label.policy.reset.ladder';
  return general;
}
