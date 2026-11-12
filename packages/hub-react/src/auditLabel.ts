import type { HubText } from './i18n.js';
import { SECTION_ORDER } from './policy/model.js';
import type { AuditAction } from './types.js';

// One plain label for each action the kit records, typed against the kit's own list: a new action is a compile error until it has
// a word here. An action from a newer kit than this hub is shown as it is.
export const ACTION_LABEL: Record<AuditAction, HubText> = {
  'report.view': 'hub.audit.label.report.view',
  'report.decide': 'hub.audit.label.report.decide',
  'report.dismiss_case': 'hub.audit.label.report.dismissCase',
  'report.dismiss_reporter': 'hub.audit.label.report.dismissReporter',
  'sanction.apply': 'hub.audit.label.sanction.apply',
  'sanction.revoke': 'hub.audit.label.sanction.revoke',
  'gap.close': 'hub.audit.label.gap.close',
  'term.add': 'hub.audit.label.term.add',
  'term.update': 'hub.audit.label.term.update',
  'term.toggle': 'hub.audit.label.term.toggle',
  'exception.add': 'hub.audit.label.exception.add',
  'exception.update': 'hub.audit.label.exception.update',
  'exception.toggle': 'hub.audit.label.exception.toggle',
  'history.view': 'hub.audit.label.history.view',
  suggest: 'hub.audit.label.suggest',
  'policy.view': 'hub.audit.label.policy.view',
  'blocked.view': 'hub.audit.label.blocked.view',
  'case.takeover': 'hub.audit.label.case.takeover',
  'reason.add': 'hub.audit.label.reason.add',
  'reason.update': 'hub.audit.label.reason.update',
  'reason.toggle': 'hub.audit.label.reason.toggle',
  'policy.update': 'hub.audit.label.policy.update',
  'policy.reset': 'hub.audit.label.policy.reset',
  'ai.read': 'hub.audit.label.ai.read',
  'ai.rerun': 'hub.audit.label.ai.rerun',
  'ai.outcome': 'hub.audit.label.ai.outcome',
  'appeal.view': 'hub.audit.label.appeal.view',
  'appeal.decide': 'hub.audit.label.appeal.decide',
  'name.rename_required': 'hub.audit.label.name.renameRequired',
};

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
