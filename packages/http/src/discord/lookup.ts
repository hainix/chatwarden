import { lengthLabel } from '@chatwarden/core';
import type { Chatwarden, PersonSanctionView, Role } from '@chatwarden/core';
import { TEXT, ephemeral } from './answers.js';
import type { InteractionAnswer } from './answers.js';
import { auditRequired } from './audit.js';
import { DOT, KIND_LABELS, SOURCE_WORDS, hubUrl, labelOf, safeText } from './text.js';
import type { DiscordActionRow } from './types.js';

// `/chatwarden lookup <ref>` (K5 design 6.5): what a moderator needs to answer a player who quotes a reference code, and nothing of the case: no
// reason, actor, handle, subject id (outside the person link), room or note. Unknown and malformed codes are the same text, so a probe learns nothing.

const RULE_TITLE_MAX = 120;
/** A code is `M-` plus five characters: anything shorter or longer than this cannot be one. */
const REF_MIN = 5;
const REF_MAX = 12;

/** A Discord timestamp: `<t:1800000000:R>`. */
const stamp = (ms: number, style: 'R' | 'f'): string => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** `Rule 2 (Be kind)`, the title escaped and cut; `No Community Rule yet` for an uncovered rule; undefined for none. */
export function ruleText(cw: Chatwarden, rule: PersonSanctionView['rule']): string | undefined {
  if (rule === 'uncovered') return 'No Community Rule yet';
  if (typeof rule !== 'number') return undefined;
  const title = cw.rules.all().find((r) => r.number === rule)?.title;
  return title === undefined ? `Rule ${rule}` : `Rule ${rule} (${safeText(title, RULE_TITLE_MAX)})`;
}

/** Where the sanction stands now, in words. */
function statusText(view: PersonSanctionView, now: number): string {
  if (view.revokedAt !== null) return 'Lifted';
  if (view.kind === 'warning' || view.kind === 'note') return 'Recorded';
  if (view.endsAt === null) return 'Active';
  return view.endsAt > now ? `Active until ${stamp(view.endsAt, 'R')}` : 'Ended';
}

export interface LookupDeps {
  cw: Chatwarden;
  hubLink: (kind: 'report' | 'person', id: string) => string;
  now: () => number;
  who: { actor: string; role: Role };
}

/**
 * The answer to a lookup of `ref` (the option as typed). Throws when the audit row cannot be written (the caller shows a fixed failure and logs the
 * class): a lookup that cannot be recorded shows nothing, as the staff reads do. A code nobody holds writes no row.
 */
export function lookupAnswer(deps: LookupDeps, ref: string | null): InteractionAnswer {
  const { cw, who } = deps;
  if (ref === null || ref.length < REF_MIN || ref.length > REF_MAX) return ephemeral(TEXT.noSanction);
  const view = cw.sanctions.byRef(ref);
  if (view === null) return ephemeral(TEXT.noSanction);
  // Required: the row first, then the answer.
  auditRequired(cw, who, 'history.view', { type: 'sanction', ref: view.groupId });

  const timed = view.kind !== 'warning' && view.kind !== 'note';
  const length = timed ? (view.endsAt === null ? 'permanent' : lengthLabel(view.endsAt - view.startsAt)) : undefined;
  const head = [`**${view.refCode}**`, labelOf(KIND_LABELS, view.kind) ?? 'Sanction', ...(length === undefined ? [] : [length])].join(DOT);
  const rule = ruleText(cw, view.rule);
  const second = [...(rule === undefined ? [] : [rule]), statusText(view, deps.now())].join(DOT);
  const third = `Given ${stamp(view.startsAt, 'f')}${DOT}By ${labelOf(SOURCE_WORDS, view.source) ?? 'the kit'}`;

  const url = hubUrl(deps.hubLink, 'person', view.person);
  const rows: DiscordActionRow[] = url === null ? [] : [{ type: 1, components: [{ type: 2, style: 5, label: 'Open person', url }] }];
  return ephemeral([head, second, third].join('\n'), rows);
}
