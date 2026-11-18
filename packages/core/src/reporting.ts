import { httpsUrl } from './settingsCheck.js';
import type { ReportCategory } from './types.js';
import type { SafetyResource } from './safety.js';

// The reporting settings: how a player reports (the flow), what they may say it is for (the reasons), and what they are
// told afterwards (the thank-you). Pure data and lookups: no store, no IO. The validation lives with the rest of the profile
// checks in profile.ts, which also applies the defaults below; this file has the shapes, the defaults and the lookups.
//
// The reporter's reason is a HINT, never the truth: it is stored as `reportedReason` and what settles a case is the
// moderator's decision (or, later, the AI read).

/** How the player's reporting screen works. The kit treats `one_tap` and `reason_first` the same; only `reason_required` refuses. */
export type ReportFlow = 'one_tap' | 'reason_first' | 'reason_required';

/** Every flow, in the order a settings screen lists them. */
export const REPORT_FLOWS: readonly ReportFlow[] = ['one_tap', 'reason_first', 'reason_required'];

/** The default flow: one step. The player may pick a reason and add a note in the same dialog; neither is needed to send. */
export const DEFAULT_REPORT_FLOW: ReportFlow = 'one_tap';

/** The default thank-you shown to the reporter. */
export const DEFAULT_REPORT_THANKS = "Thanks for the report. We'll look into it.";

/** The most reasons a profile may list. */
export const MAX_REPORT_REASONS = 20;
/** The longest reason id, label, hint, group and thank-you, in characters. */
export const REPORT_ID_MAX = 32;
export const REPORT_LABEL_MAX = 60;
export const REPORT_HINT_MAX = 160;
export const REPORT_GROUP_MAX = 40;
export const REPORT_THANKS_MAX = 300;
/** The most Community Rule numbers one reason may map to. */
export const MAX_REASON_RULES = 20;

/** True for a well-formed reason id: a lowercase slug of letters, digits, `_` and `-` (at most 32 characters), and not `none`. */
export function isReasonId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= REPORT_ID_MAX && /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(v) && v !== 'none';
}

/** The id of the reason that can never be removed or switched off: the fallback and what an old `other` category reads as. */
export const OTHER_REASON_ID = 'other';

/** The longest evidence link template (`reporting.evidenceUrl`), in characters. */
export const REPORT_EVIDENCE_URL_MAX = 300;

/**
 * One reason as you write it. `id` (a lowercase slug, unique) and `label` are required; the rest default to
 * `hint: ''`, `group: ''` (no group), `rules: []`, `asksNote: false`, `enabled: true`, `urgent: false`, `thanks: null` and
 * `showResources: false`.
 */
export interface ReportReasonInput {
  /** A unique lowercase slug of letters, digits, `_` and `-` (at most 32 characters). `none` is reserved. */
  id: string;
  /** What the player sees (at most 60 characters). */
  label: string;
  /** One line under the label (at most 160 characters). */
  hint?: string;
  /** The heading the reason is listed under, for example `Chat` or `Gameplay`; `''` lists it with no heading (at most 40 characters). */
  group?: string;
  /** The Community Rule numbers this reason usually means. The first one is the moderator's suggested rule; a decision under any of them counts as "matched" for the reporter. */
  rules?: number[];
  /** Ask the player for a short note when they pick it. */
  asksNote?: boolean;
  /** Offered to players. A switched-off reason stays valid for reports already filed. */
  enabled?: boolean;
  /** Reports filed under this reason are urgent: a snapshot taken when the report is filed. Default false (`threat` and `welfare` are urgent in the defaults). */
  urgent?: boolean;
  /** What the reporter is told after sending a report under this reason (at most 300 characters). `null` or absent: `reporting.thanks`. */
  thanks?: string | null;
  /** Show `safety.resources` to the reporter after the thank-you for this reason. Default false (`welfare` shows them in the defaults). */
  showResources?: boolean;
}

/** One reason with every field filled in. */
export interface ReportReason {
  id: string;
  label: string;
  hint: string;
  group: string;
  rules: number[];
  asksNote: boolean;
  enabled: boolean;
  /** Reports filed under this reason are urgent. */
  urgent: boolean;
  /** The reporter's own thank-you for this reason, or `null` for the global one. */
  thanks: string | null;
  /** Show the owner's resource list after the thank-you. */
  showResources: boolean;
}

/** The reporting settings as you write them: every field is optional and defaulted. */
export interface ReportingSettings {
  /** Default `'one_tap'`. */
  flow?: ReportFlow;
  /** The whole ordered list (a layer or an override replaces it, never merges). Default {@link DEFAULT_REPORT_REASONS}. 1 to 20 reasons, at least one enabled, and `other` present and enabled. */
  reasons?: ReportReasonInput[];
  /** What the reporter is told after sending a report (at most 300 characters). Default {@link DEFAULT_REPORT_THANKS}. */
  thanks?: string;
  /**
   * A link template for the case's evidence link: `https://`, exactly one `{ref}` placeholder (never in the host), at most 300
   * characters, no credentials. `null` or absent: no link.
   */
  evidenceUrl?: string | null;
}

/** The reporting settings in force: every field filled in. */
export interface ResolvedReporting {
  flow: ReportFlow;
  reasons: ReportReason[];
  thanks: string;
  /** The evidence link template, or `null`. */
  evidenceUrl: string | null;
}

/**
 * What a player's client may read: the enabled reasons and nothing of the staff side (no rule mapping, no urgent flag, no safety
 * guidance or contact line). A reason's `thanks` is `null` when the global `thanks` applies; the top-level `resources` are shown after
 * the thank-you for a reason whose `showResources` is true. The server always sends the three new fields, and a client reads a missing one as `null`, `false` and no resources.
 */
export interface PlayerReporting {
  flow: ReportFlow;
  reasons: Array<{ id: string; label: string; hint: string; group: string; asksNote: boolean; thanks: string | null; showResources: boolean }>;
  thanks: string;
  resources: SafetyResource[];
}

const reason = (
  id: string,
  label: string,
  hint: string,
  group: string,
  rules: number[],
  asksNote = false,
  extra: { urgent?: boolean; showResources?: boolean; enabled?: boolean } = {},
): ReportReason => ({
  id,
  label,
  hint,
  group,
  rules,
  asksNote,
  enabled: extra.enabled ?? true,
  urgent: extra.urgent ?? false,
  thanks: null,
  showResources: extra.showResources ?? false,
});

/**
 * The default reasons, deep-frozen: Chat (insults or harassment, hate, sexual content, threats, spam or ads, sharing personal
 * info, an inappropriate name, a disabled "Pretending to be staff or someone else" and a disabled "Someone may be in trouble"), Gameplay (cheating, throwing or griefing, leaving or AFK), then Something else. Each maps to the starter Community
 * Rules it usually means: harassment, threats and personal info to CR 2, a name to CR 7, hate to CR 1, sexual content to CR 3, spam to CR 4,
 * cheating to CR 5, griefing and AFK to CR 6; `impersonation` to CR 2, switched off until the owner turns it on (it appears in Settings > Reporting and in no player's report dialog until then). `other` and `welfare` map to none. `threat` is urgent; `welfare` is urgent, shows the owner's
 * resources and is switched off until the owner turns it on.
 */
export const DEFAULT_REPORT_REASONS: readonly Readonly<ReportReason>[] = Object.freeze(
  [
    reason('harassment', 'Insults or harassment', 'Insults, put-downs or picking on someone', 'Chat', [2]),
    reason('hate', 'Hate', 'Hate aimed at who someone is', 'Chat', [1]),
    reason('sexual', 'Sexual content', 'Sexual messages or pressure', 'Chat', [3]),
    reason('threat', 'Threats', 'Threatening someone', 'Chat', [2], false, { urgent: true }),
    reason('spam', 'Spam or ads', 'Repeated messages, flooding or advertising', 'Chat', [4]),
    reason('personal_info', 'Sharing personal info', "Posting someone's private details", 'Chat', [2]),
    reason('name', 'Inappropriate name', 'An offensive or inappropriate player name', 'Chat', [7]),
    reason('impersonation', 'Pretending to be staff or someone else', 'A name or message that pretends to be a moderator, the game or another player', 'Chat', [2], false, { enabled: false }),
    reason('welfare', 'Someone may be in trouble', 'Someone who says they want to hurt themselves, or may be at risk', 'Chat', [], true, {
      urgent: true,
      showResources: true,
      enabled: false,
    }),
    reason('cheating', 'Cheating', 'Cheating or exploiting a bug', 'Gameplay', [5]),
    reason('griefing', 'Throwing or griefing', 'Losing on purpose or ruining the game', 'Gameplay', [6]),
    reason('afk', 'Leaving or AFK', 'Leaving the game or not playing', 'Gameplay', [6]),
    reason(OTHER_REASON_ID, 'Something else', 'Anything else you want us to look at', '', [], true),
  ].map((r) => Object.freeze({ ...r, rules: Object.freeze([...r.rules]) as unknown as number[] })),
);

/** A fresh, unfrozen copy of the default reporting settings. */
export function defaultReporting(): ResolvedReporting {
  return {
    flow: DEFAULT_REPORT_FLOW,
    reasons: DEFAULT_REPORT_REASONS.map((r) => ({ ...r, rules: [...r.rules] })),
    thanks: DEFAULT_REPORT_THANKS,
    evidenceUrl: null,
  };
}

/**
 * Old ids that read as a new one. `disruption` (the 0.1.1 category) is `griefing`. An exact id in the list always wins, so a
 * studio that defines its own `disruption` reason keeps it.
 */
export const LEGACY_REASON_ALIASES: Readonly<Record<string, string>> = Object.freeze({ disruption: 'griefing' });

/** The six 0.1.1 categories. They stay valid reason ids (through {@link LEGACY_REASON_ALIASES} for `disruption`). */
export const LEGACY_CATEGORIES: readonly ReportCategory[] = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];

/** The reason in `reasons` that `id` names (exactly, else as an old alias), or undefined. Disabled reasons are found too. */
export function findReason(reasons: readonly ReportReason[], id: string): ReportReason | undefined {
  const exact = reasons.find((r) => r.id === id);
  if (exact !== undefined) return exact;
  const alias = Object.hasOwn(LEGACY_REASON_ALIASES, id) ? LEGACY_REASON_ALIASES[id] : undefined;
  return alias === undefined ? undefined : reasons.find((r) => r.id === alias);
}

/** The id `id` stands for in `reasons` (`disruption` becomes `griefing` unless the list has its own), or `id` itself when it is in no list. */
export function canonicalReasonId(reasons: readonly ReportReason[], id: string): string {
  return findReason(reasons, id)?.id ?? id;
}

/** The player-facing label of a reason id (an old alias included), or null when there is no such reason. */
export function reasonLabel(reasons: readonly ReportReason[], id: string | null): string | null {
  return id === null ? null : (findReason(reasons, id)?.label ?? null);
}

/**
 * The 0.1.1 category a reason id is kept under in the stored report's `category` column (which old consumers still read): the
 * six old ids are themselves, `griefing` and `afk` are `disruption`, `threat` is `harassment`, and everything else (no reason,
 * `sexual`, `personal_info`, `name`, a studio's own) is `other`.
 */
export function legacyCategoryOf(id: string | null): ReportCategory {
  switch (id) {
    case 'harassment':
    case 'hate':
    case 'cheating':
    case 'spam':
    case 'other':
      return id;
    case 'griefing':
    case 'afk':
    case 'disruption':
      return 'disruption';
    case 'threat':
      return 'harassment';
    default:
      return 'other';
  }
}

/** The reason id a stored 0.1.1 category reads as: `disruption` is `griefing`, the others are themselves. */
export function reasonOfCategory(category: string): string {
  return Object.hasOwn(LEGACY_REASON_ALIASES, category) ? (LEGACY_REASON_ALIASES[category] as string) : category;
}

/**
 * The Community Rule a moderator is suggested for a reported reason: the first of the reason's rules that is still citable, or
 * `'uncovered'` (no reason, an unknown reason, a reason with no rules). The report is never decided by it.
 */
export function suggestedRule(
  reasons: readonly ReportReason[],
  id: string | null,
  rules: { isCitable(ref: number): boolean },
): number | 'uncovered' {
  if (id === null) return 'uncovered';
  const found = findReason(reasons, id);
  if (found === undefined) return 'uncovered';
  return found.rules.find((n) => rules.isCitable(n)) ?? 'uncovered';
}

/**
 * What a player may read: the enabled reasons in order, with no rule mapping, and the owner's resource list (`safety`, optional: none
 * when left out). Each field is copied by name, so nothing added later leaks (the safety guidance and contact line never do).
 */
export function playerReporting(reporting: ResolvedReporting, safety?: { resources: readonly SafetyResource[] }): PlayerReporting {
  return {
    flow: reporting.flow,
    reasons: reporting.reasons
      .filter((r) => r.enabled)
      .map((r) => ({ id: r.id, label: r.label, hint: r.hint, group: r.group, asksNote: r.asksNote, thanks: r.thanks, showResources: r.showResources })),
    thanks: reporting.thanks,
    resources: (safety?.resources ?? []).map((r) => ({ label: r.label, detail: r.detail, url: r.url })),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Fill the optional parts of reporting settings: a missing flow, thank-you, reason list or reason field gets its default. It never
 * throws and never judges: anything of the wrong shape is returned as it is, for the profile validator to name. Copies.
 */
export function fillReporting(value: unknown): unknown {
  if (value === undefined) return defaultReporting();
  if (!isObj(value)) return value;
  const out: Record<string, unknown> = { ...value };
  if (!Object.hasOwn(out, 'flow')) out['flow'] = DEFAULT_REPORT_FLOW;
  if (!Object.hasOwn(out, 'thanks')) out['thanks'] = DEFAULT_REPORT_THANKS;
  if (!Object.hasOwn(out, 'evidenceUrl')) out['evidenceUrl'] = null;
  if (!Object.hasOwn(out, 'reasons')) {
    out['reasons'] = defaultReporting().reasons;
  } else if (Array.isArray(out['reasons'])) {
    out['reasons'] = (out['reasons'] as unknown[]).map((r) => {
      if (!isObj(r)) return r;
      const filled: Record<string, unknown> = { ...r };
      if (!Object.hasOwn(filled, 'hint')) filled['hint'] = '';
      if (!Object.hasOwn(filled, 'group')) filled['group'] = '';
      if (!Object.hasOwn(filled, 'rules')) filled['rules'] = [];
      if (!Object.hasOwn(filled, 'asksNote')) filled['asksNote'] = false;
      if (!Object.hasOwn(filled, 'enabled')) filled['enabled'] = true;
      if (!Object.hasOwn(filled, 'urgent')) filled['urgent'] = false;
      if (!Object.hasOwn(filled, 'thanks')) filled['thanks'] = null;
      if (!Object.hasOwn(filled, 'showResources')) filled['showResources'] = false;
      return filled;
    });
  }
  return out;
}

/** {@link fillReporting} for settings already known to be valid: the typed result. */
export function resolveReporting(settings: ReportingSettings | undefined): ResolvedReporting {
  return fillReporting(settings) as ResolvedReporting;
}

/**
 * The link to the evidence behind a report: the owner's `reporting.evidenceUrl` template with `{ref}` replaced by `encodeURIComponent(ref)`, or `null` with no template. The template is
 * checked again here (an `https` URL with a host, no credentials and exactly one `{ref}`, never in the host): one that is not, say a layer edited to `http` after it was saved, gives `null`.
 * Pure; the kit fetches nothing.
 */
export function evidenceLink(settings: { evidenceUrl?: string | null }, ref: string): string | null {
  const template = settings.evidenceUrl;
  if (typeof template !== 'string' || template === '' || typeof ref !== 'string' || ref === '') return null;
  try {
    httpsUrl(template, 'reporting.evidenceUrl', REPORT_EVIDENCE_URL_MAX, true);
  } catch {
    return null;
  }
  const encoded = encodeURIComponent(ref);
  return template.replace('{ref}', () => encoded);
}
