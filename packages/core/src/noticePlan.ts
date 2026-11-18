// What a moderator's action sends to the player, worked out from the form alone: the notices the services would write, who gets them, in what
// order, and what else changes for the player. Part of the subpath `@chatwarden/core/notice-copy`, so the hub's "What the player sees" panel and
// the services cannot disagree (a parity suite runs the real services over a matrix and compares).
//
// Pure: no store, no clock of its own (the time is passed in), no Node built-in module. The input types carry NO moderator-only field: no reason,
// evidence, gap note, actor, staff ref, group id, IP flag, AI read or appeal statement. A leak needs a type change.

import { isEvidenceKind } from './evidenceKind.js';
import type { EvidenceKind } from './evidenceKind.js';
import type { PlayerNotice } from './notices.js';
import type { RuleRef } from './rules.js';
import type { NoticeKind, SanctionKind } from './types.js';

/** One of the player's own lines, already masked as the player will read it (the server's `noticeText`), with its UTC day. */
export interface PlanLine {
  text: string;
  day: string;
}

/** One action of a decision: a person, a kind and length, the rule and the chosen lines. */
export interface PlanAction {
  /** The person, as the caller names them (the services order people by this text). */
  person: string;
  kind: SanctionKind;
  /** `null` for no end (a warning, a permanent restriction). */
  durationMs: number | null;
  rule: RuleRef;
  /** At most five are shown. Only the person's own lines. */
  lines: PlanLine[];
}

/** The action to preview. `person` names the recipient where the action has one (default `'player'`). */
export type NoticeOp =
  | {
      op: 'decide';
      verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith';
      target: string;
      reporter: string;
      actions: PlanAction[];
      rename: { rule: number } | null;
      /** What the decision is about (0.2.2): the kind of the report's reason or the moderator's own choice. Optional: absent is neutral. */
      evidenceKind?: EvidenceKind | null;
    }
  | { op: 'sanction'; kind: SanctionKind; durationMs: number | null; person?: string }
  | { op: 'note'; person?: string }
  | { op: 'rename'; rule: number; person?: string }
  | { op: 'revoke'; kind: SanctionKind; person?: string }
  | {
      op: 'appeal';
      outcome: 'uphold' | 'reduce' | 'revoke';
      original: { kind: SanctionKind; startsAt: number; endsAt: number | null; rule: RuleRef | null; refCode: string; evidenceKind?: EvidenceKind | null };
      /** For `reduce`: the lighter kind and length. */
      to?: { kind: SanctionKind; durationMs: number | null };
      person?: string;
    }
  | { op: 'dismiss' };

/** What the plan needs besides the op. */
export interface PlanContext {
  now: () => number;
  /** "Community Rule 2: Title" for a rule, as the player will read it. */
  ruleLabel: (ref: RuleRef) => string;
  /** Whether the kit thanks a reporter whose report led to action (`GET /policy` `notices.reporterFeedback`). */
  reporterFeedback: boolean;
  /** Whether the kit's appeals are on. */
  appeals: boolean;
  /** What a sanction notice's reference reads until it is made. */
  refCode: string;
}

/** A notice the services would write, and who gets it. `notice.id` is a placeholder; `createdAt` is the time now. */
export interface PlannedNotice {
  to: string;
  notice: PlayerNotice;
}

/**
 * One thing that changes for the player besides a notice. The hub puts words to it. `until` is an epoch ms, or `null` for "until a moderator
 * lifts it". No code carries a reason, an actor or a reference.
 */
export type EffectCode =
  | { code: 'chat_off'; to: string; until: number | null }
  | { code: 'area_off'; to: string; until: number | null }
  | { code: 'banned'; to: string; until: number | null }
  | { code: 'warning_on_record'; to: string }
  | { code: 'warning_staff_only'; to: string }
  | { code: 'rename_asked'; to: string; later: boolean }
  | { code: 'reporter_not_told' }
  | { code: 'lifts'; kind: SanctionKind; to: string }
  | { code: 'appeal_closed' }
  | { code: 'sanction_stays' }
  | { code: 'first_withdrawn' }
  | { code: 'removed_withdrawn' }
  | { code: 'new_end'; kind: 'chat' | 'area' | 'ban'; to: string; until: number | null; was: number | null }
  | { code: 'ran_its_course'; to: string };

/** The plan: notices in the order the services write them, the other effects, and why nothing is sent when nothing is. */
export interface NoticePlan {
  notices: PlannedNotice[];
  effects: EffectCode[];
  /** Why no notice is sent: a note, a one-click dismissal, or a direct sanction. `null` when notices are sent, or when nothing was chosen. */
  nothing: 'note' | 'dismissal' | 'direct' | null;
}

const KINDS: readonly string[] = ['warning', 'chat', 'area', 'ban', 'note'];
const ORDER: readonly string[] = ['warning', 'chat', 'area', 'ban'];
const SHOWN_LINES_MAX = 5;
const PLAYER = 'player';
const EMPTY: NoticePlan = Object.freeze({ notices: [], effects: [], nothing: null }) as NoticePlan;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isKind = (k: unknown): k is SanctionKind => typeof k === 'string' && KINDS.includes(k);
const isLength = (n: unknown): n is number | null => n === null || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
const isRule = (r: unknown): r is RuleRef => r === 'uncovered' || (typeof r === 'number' && Number.isSafeInteger(r) && r >= 1);

/**
 * The end of the sanction an appeal's reduction writes: the original's start plus the chosen length, never later than the original's end. A
 * permanent choice (`durationMs: null`) keeps the original end; a permanent original takes the chosen length. `null` is no end. The one function
 * the appeals service and the plan share.
 */
export function appealReplacementEnd(original: { startsAt: number; endsAt: number | null }, to: { durationMs: number | null }): number | null {
  if (to.durationMs === null) return original.endsAt;
  const chosen = original.startsAt + to.durationMs;
  return original.endsAt === null ? chosen : Math.min(original.endsAt, chosen);
}

/**
 * What a reduction becomes: the kind and length of the replacement, or null when `to` is not lighter than the sanction (a lower kind, or the same
 * kind and shorter, permanent being the longest; a warning cannot be reduced). The replacement keeps the original start and ends at
 * {@link appealReplacementEnd}, so it is never later than the original.
 */
export function appealReduction(
  original: { kind: string; startsAt: number; endsAt: number | null },
  to: { kind: string; durationMs: number | null } | null,
): { kind: 'warning' | 'chat' | 'area' | 'ban'; durationMs: number | null } | null {
  if (to === null) return null;
  const from = ORDER.indexOf(original.kind);
  const target = ORDER.indexOf(to.kind);
  if (from <= 0 || target < 0) return null; // not an appealable kind, or a warning (the lightest: nothing to reduce to)
  const origLength = original.endsAt === null ? Infinity : original.endsAt - original.startsAt;
  const newLength = to.durationMs === null ? Infinity : to.durationMs;
  if (!(target < from || (target === from && newLength < origLength))) return null;
  if (to.kind === 'warning') return { kind: 'warning', durationMs: null };
  const end = appealReplacementEnd(original, to);
  if (end !== null && end <= original.startsAt) return null;
  return { kind: to.kind as 'chat' | 'area' | 'ban', durationMs: end === null ? null : end - original.startsAt };
}

class Context {
  private seq = 0;
  readonly ctx: PlanContext;
  constructor(ctx: PlanContext) {
    this.ctx = ctx;
  }
  now(): number {
    return this.ctx.now();
  }
  label(rule: RuleRef | null): string | null {
    return rule === null ? null : this.ctx.ruleLabel(rule);
  }
  /** A notice draft: the shape the player reads, with a placeholder id. */
  notice(kind: NoticeKind, o: { rule: RuleRef | null; until: number | null; refCode: string | null; excerpt?: PlanLine[]; evidence?: unknown }): PlayerNotice {
    return {
      id: `plan-${++this.seq}`,
      kind,
      rule: o.rule,
      ruleLabel: this.label(o.rule),
      until: o.until,
      refCode: o.refCode,
      excerpt: (o.excerpt ?? []).slice(0, SHOWN_LINES_MAX).map((l) => ({ text: l.text, day: l.day })),
      createdAt: this.now(),
      mustAcknowledge: kind === 'warning',
      ...(isEvidenceKind(o.evidence) ? { evidence: o.evidence } : {}),
    };
  }
}

const endOf = (kind: SanctionKind, durationMs: number | null, now: number): number | null => (kind === 'warning' || durationMs === null ? null : now + durationMs);

function restriction(kind: SanctionKind, to: string, until: number | null): EffectCode | null {
  if (kind === 'chat') return { code: 'chat_off', to, until };
  if (kind === 'area') return { code: 'area_off', to, until };
  if (kind === 'ban') return { code: 'banned', to, until };
  return null;
}

function decide(op: Extract<NoticeOp, { op: 'decide' }>, c: Context): NoticePlan {
  if (!Array.isArray(op.actions) || typeof op.target !== 'string' || typeof op.reporter !== 'string') return EMPTY;
  if (op.verdict !== 'upheld' && op.verdict !== 'noted' && op.verdict !== 'no_action' && op.verdict !== 'bad_faith') return EMPTY;
  const rename = op.rename === null ? null : op.rename;
  if (rename !== null && !(typeof rename === 'object' && typeof rename.rule === 'number' && Number.isSafeInteger(rename.rule))) return EMPTY;
  for (const a of op.actions) {
    if (typeof a !== 'object' || a === null || typeof a.person !== 'string' || a.person === '' || !isKind(a.kind) || !isLength(a.durationMs) || !isRule(a.rule) || !Array.isArray(a.lines)) return EMPTY;
  }
  const now = c.now();
  // The core's order: by person, then by kind.
  const actions = [...op.actions].sort((x, y) => byText(x.person, y.person) || byText(x.kind, y.kind));
  const notices: PlannedNotice[] = [];
  const effects: EffectCode[] = [];
  const held = new Set<string>(); // people who cannot play for now (a ban, a public-rooms restriction)
  for (const a of actions) {
    if (a.kind === 'note') continue;
    const until = endOf(a.kind, a.durationMs, now);
    notices.push({ to: a.person, notice: c.notice(a.kind, { rule: a.rule, until, refCode: c.ctx.refCode, excerpt: a.lines, evidence: op.evidenceKind }) });
    const effect = restriction(a.kind, a.person, until);
    effects.push(effect ?? { code: 'warning_on_record', to: a.person });
    if (a.kind === 'ban' || a.kind === 'area') held.add(a.person);
  }
  const acted = notices.length > 0;
  // The reporter is thanked only on `upheld` with a non-note action, and only when the kit does it.
  const thanked = acted && op.verdict === 'upheld' && c.ctx.reporterFeedback === true;
  if (thanked) notices.push({ to: op.reporter, notice: c.notice('report_outcome', { rule: null, until: null, refCode: null }) });
  if (rename !== null) {
    notices.push({ to: op.target, notice: c.notice('rename_required', { rule: rename.rule, until: null, refCode: null }) });
    effects.push({ code: 'rename_asked', to: op.target, later: held.has(op.target) });
  }
  // "Not told" is only said when the reporter has no notice at all in the plan (a sanction on the reporter is a notice they are sent).
  if (notices.length > 0 && !notices.some((n) => n.to === op.reporter)) effects.push({ code: 'reporter_not_told' });
  const nothing = notices.length > 0 ? null : actions.length > 0 ? 'note' : op.verdict === 'no_action' || op.verdict === 'bad_faith' ? 'dismissal' : null;
  return { notices, effects, nothing };
}

function sanction(op: Extract<NoticeOp, { op: 'sanction' }>, c: Context): NoticePlan {
  if (!isKind(op.kind) || !isLength(op.durationMs)) return EMPTY;
  if (op.kind === 'note') return { notices: [], effects: [], nothing: 'note' };
  const to = op.person ?? PLAYER;
  const effect = restriction(op.kind, to, endOf(op.kind, op.durationMs, c.now()));
  return { notices: [], effects: [effect ?? { code: 'warning_staff_only', to }], nothing: 'direct' };
}

function appeal(op: Extract<NoticeOp, { op: 'appeal' }>, c: Context): NoticePlan {
  const o = op.original;
  if (typeof o !== 'object' || o === null || !isKind(o.kind) || o.kind === 'note') return EMPTY;
  if (!Number.isFinite(o.startsAt) || !(o.endsAt === null || Number.isFinite(o.endsAt)) || typeof o.refCode !== 'string') return EMPTY;
  if (!(o.rule === null || isRule(o.rule))) return EMPTY;
  const to = op.person ?? PLAYER;
  const notices: PlannedNotice[] = [];
  const effects: EffectCode[] = [];
  const outcome = (kind: 'appeal_upheld' | 'appeal_reduced' | 'appeal_revoked'): PlannedNotice => ({ to, notice: c.notice(kind, { rule: o.rule, until: null, refCode: o.refCode }) });
  if (op.outcome === 'uphold') {
    notices.push(outcome('appeal_upheld'));
    effects.push({ code: 'sanction_stays' });
  } else if (op.outcome === 'revoke') {
    notices.push(outcome('appeal_revoked'));
    effects.push({ code: 'removed_withdrawn' }, { code: 'lifts', kind: o.kind, to });
  } else if (op.outcome === 'reduce') {
    const replacement = appealReduction(o, op.to ?? null);
    if (replacement === null) return EMPTY;
    const end = replacement.kind === 'warning' ? null : appealReplacementEnd(o, replacement.durationMs === null ? { durationMs: null } : { durationMs: replacement.durationMs });
    notices.push({ to, notice: c.notice(replacement.kind, { rule: o.rule, until: end, refCode: c.ctx.refCode, evidence: o.evidenceKind }) });
    notices.push(outcome('appeal_reduced'));
    effects.push({ code: 'first_withdrawn' });
    if (replacement.kind !== 'warning') {
      effects.push({ code: 'new_end', kind: replacement.kind, to, until: end, was: o.endsAt });
      if (end !== null && end <= c.now()) effects.push({ code: 'ran_its_course', to });
    }
  } else return EMPTY;
  return { notices, effects, nothing: null };
}

/**
 * The notices an action would send, from the form alone. Never throws: a malformed op, or a context that throws, is an empty plan with
 * `nothing: null`.
 *
 * - `decide`: a notice for each non-note action in the core's order (by person, then kind), then the reporter's thank-you (only on `upheld` with a
 *   non-note action and `reporterFeedback`), then the rename notice for the target.
 * - `sanction` and `note`: no notice (`nothing` says why) and the effect the player does see.
 * - `rename`: the rename notice.
 * - `revoke`: no notice; the effects say what lifts.
 * - `appeal`: the outcome notice; a reduction first writes the replacement sanction's notice (ending at `appealReplacementEnd`).
 * - `dismiss`: nothing is sent.
 */
export function planNotices(op: NoticeOp, ctx: PlanContext): NoticePlan {
  try {
    const c = new Context(ctx);
    if (typeof op !== 'object' || op === null) return EMPTY;
    switch (op.op) {
      case 'decide':
        return decide(op, c);
      case 'sanction':
        return sanction(op, c);
      case 'note':
        return { notices: [], effects: [], nothing: 'note' };
      case 'rename': {
        if (typeof op.rule !== 'number' || !Number.isSafeInteger(op.rule)) return EMPTY;
        const to = op.person ?? PLAYER;
        return { notices: [{ to, notice: c.notice('rename_required', { rule: op.rule, until: null, refCode: null }) }], effects: [{ code: 'rename_asked', to, later: false }], nothing: null };
      }
      case 'revoke': {
        if (!isKind(op.kind)) return EMPTY;
        if (op.kind === 'note') return { notices: [], effects: [], nothing: 'note' };
        const effects: EffectCode[] = [{ code: 'lifts', kind: op.kind, to: op.person ?? PLAYER }];
        if (ctx.appeals === true) effects.push({ code: 'appeal_closed' });
        return { notices: [], effects, nothing: null };
      }
      case 'appeal':
        return appeal(op, c);
      case 'dismiss':
        return { notices: [], effects: [], nothing: 'dismissal' };
      default:
        return EMPTY;
    }
  } catch {
    return EMPTY;
  }
}
