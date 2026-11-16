import { lengthLabel, suggestedRule } from '@chatwarden/core';
import type { Chatwarden, Role, StaffReport } from '@chatwarden/core';
import type { ParsedDecision } from '../admin/apply.js';
import { decideAs } from '../admin/decideAs.js';
import { ClaimedError, HttpError } from '../errors.js';
import { roleAtLeast } from '../permissions.js';
import { TEXT, ephemeral, updateMessage } from './answers.js';
import type { InteractionAnswer } from './answers.js';
import { auditBestEffort, auditRequired } from './audit.js';
import { DISMISS_CODE, codeOf, encodeCustomId, parseCode } from './customId.js';
import type { ParsedCustomId } from './customId.js';
import { ruleText } from './lookup.js';
import type { ResolvedBotOptions } from './options.js';
import { DOT, KIND_LABELS, hubUrl, labelOf, safeText } from './text.js';
import type { DiscordActionRow, DiscordButton } from './types.js';

// Acting from Discord (K5 design 6.5 and 6.6, steps 4 to 10): the buttons on a report post, the preview and the confirm. Nothing here trusts what the
// message said: every step re-reads the report, the claim, the rule and the profile. The decision itself is `decideAs`, the hub's own path, run as the
// person who clicked (their role and actor come from the signed payload and the adopter's map, never from the custom_id), source `moderator`, claims
// gated, never a takeover.

/** The fixed reason stored with a decision taken from the suggestion (a suggestion has no typed reason). */
export const SUGGESTION_REASON = 'Profile suggestion, accepted in Discord';
const WHY_MAX = 300;
const LABEL_MAX = 80;
const REPORT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Who is acting: from the signed payload and the adopter's role map. */
export interface Acting {
  actor: string;
  role: Role;
}

export interface ActDeps {
  cw: Chatwarden;
  o: ResolvedBotOptions;
  denied: (reason: 'role' | 'off' | 'claimed') => void;
}

/** The link row of an answer that points at the report in the hub (none when `hubLink` gives nothing usable). */
function linkRow(o: ResolvedBotOptions, reportId: string): DiscordActionRow[] {
  const url = hubUrl(o.hubLink, 'report', reportId);
  return url === null ? [] : [{ type: 1, components: [{ type: 2, style: 5, label: 'Open report', url }] }];
}

/**
 * The buttons for a report post: `[Nothing wrong here] [Apply suggestion]? [Open report]` in one row, or undefined when `actions` is not set (or both
 * buttons are off, or the id cannot be held in a custom_id). A link that `hubLink` cannot give is left out, not the row.
 */
export function buttonsFor(o: ResolvedBotOptions, post: unknown): readonly DiscordActionRow[] | undefined {
  const actions = o.actions;
  if (actions === null || typeof post !== 'object' || post === null) return undefined;
  const { kind, reportId } = post as { kind?: unknown; reportId?: unknown };
  if (kind !== 'report' || typeof reportId !== 'string' || !REPORT_ID_RE.test(reportId)) return undefined;
  const buttons: DiscordButton[] = [];
  if (actions.dismiss) buttons.push({ type: 2, style: 2, label: 'Nothing wrong here', custom_id: encodeCustomId({ verb: 'dis', reportId }) });
  if (actions.suggestion) buttons.push({ type: 2, style: 1, label: 'Apply suggestion', custom_id: encodeCustomId({ verb: 'sug', reportId }) });
  if (buttons.length === 0) return undefined;
  const url = hubUrl(o.hubLink, 'report', reportId);
  if (url !== null) buttons.push({ type: 2, style: 5, label: 'Open report', url });
  return [{ type: 1, components: buttons }];
}

/** The word for how a closed report ended, from the report alone. */
const verdictWord = (report: StaffReport): string | null =>
  report.badFaith ? 'bad faith' : report.status === 'dismissed' ? 'no action' : report.status === 'actioned' ? 'action taken' : null;

/** What the profile suggests: nothing, a note, a warning, or a length of one kind. */
type Outcome = ReturnType<Chatwarden['suggest']>['outcome'];

/** The code of a suggestion's outcome. */
function codeOfOutcome(outcome: Outcome, rule: number): string {
  if (outcome === 'none') return DISMISS_CODE;
  if (outcome === 'note' || outcome === 'warning') return codeOf({ kind: outcome, durationMs: null, rule });
  return codeOf({ kind: outcome.kind, durationMs: outcome.durationMs, rule });
}

/** What a code does, in words: `No action`, `Warning`, `Chat restriction`, a middle dot, then the length. */
function describeCode(code: string): string {
  const parsed = parseCode(code);
  if (parsed === null || parsed.dismiss) return 'No action';
  const { kind, durationMs } = parsed.action;
  const label = labelOf(KIND_LABELS, kind) ?? 'Sanction';
  if (kind === 'warning' || kind === 'note') return label;
  return `${label}${DOT}${durationMs === null ? 'permanent' : lengthLabel(durationMs)}`;
}

/** The decision a code stands for, on the report's own target. */
function decisionOf(code: string, report: StaffReport): ParsedDecision | null {
  const parsed = parseCode(code);
  if (parsed === null) return null;
  if (parsed.dismiss) return { verdict: 'no_action', actions: [] };
  const { kind, durationMs, rule } = parsed.action;
  return {
    verdict: kind === 'note' ? 'noted' : 'upheld',
    actions: [{ subject: report.targetPerson, kind, durationMs, rule }],
    reason: SUGGESTION_REASON,
  };
}

/** Handles one button click (verbs `dis`, `sug` and `ok`; the bot answers `x` itself). */
export class ActFlow {
  private readonly cw: Chatwarden;
  private readonly o: ResolvedBotOptions;
  private readonly denied: ActDeps['denied'];

  constructor(deps: ActDeps) {
    this.cw = deps.cw;
    this.o = deps.o;
    this.denied = deps.denied;
  }

  /** The permission a click needs: a confirm (and a click with no confirm step) decides; a preview only reads. */
  needs(parsed: ParsedCustomId): 'reports.read' | 'reports.decide' {
    const direct = this.o.actions !== null && !this.o.actions.confirm;
    return parsed.verb === 'ok' || direct ? 'reports.decide' : 'reports.read';
  }

  async click(parsed: Exclude<ParsedCustomId, { verb: 'x' }>, who: Acting): Promise<InteractionAnswer> {
    const reply = parsed.verb === 'ok' ? updateMessage : ephemeral;
    const actions = this.o.actions;
    // Step 4 (off): no `actions`, or the button's own kind turned off.
    if (actions === null || !this.allowed(parsed)) {
      this.denied('off');
      return reply(TEXT.actionsOff);
    }
    const report = this.cw.reports.get(parsed.reportId);
    if (parsed.verb === 'ok') return this.decide(report, parsed.code, who, parsed.reportId);
    // Step 5 (state): the report, not the message, is the truth.
    if (report === null || report.status !== 'open') return this.decided(report, parsed.reportId, reply);
    // Step 6 (claim).
    const claimed = this.claimRefusal(report, who, reply);
    if (claimed !== null) return claimed;
    if (parsed.verb === 'dis') {
      if (!actions.confirm) return this.decide(report, DISMISS_CODE, who, parsed.reportId);
      return reply('Nothing wrong here? This closes the report with no action.', this.confirmRow(parsed.reportId, DISMISS_CODE));
    }
    // 'sug'. Step 7 (rule) and step 8 (preview: the suggestion, and its audit row in required mode).
    const derived = this.derive(report, who, true);
    if (derived === null) return reply(TEXT.needsRule, linkRow(this.o, parsed.reportId));
    if (!actions.confirm) return this.decide(report, derived.code, who, parsed.reportId, derived.code);
    const head = `**Apply this step?**\n${safeText(derived.label, LABEL_MAX)}${DOT}${ruleText(this.cw, derived.rule) ?? `Rule ${derived.rule}`}`;
    return reply(`${head}\n${safeText(derived.why, WHY_MAX)}`, this.confirmRow(parsed.reportId, derived.code));
  }

  /** Whether the button's own kind is turned on. A dismissal code is allowed by either kind (the suggestion can be "no action"). */
  private allowed(parsed: Exclude<ParsedCustomId, { verb: 'x' }>): boolean {
    const a = this.o.actions;
    if (a === null) return false;
    if (parsed.verb === 'dis') return a.dismiss;
    if (parsed.verb === 'sug') return a.suggestion;
    return parseCode(parsed.code)?.dismiss === true ? a.dismiss || a.suggestion : a.suggestion;
  }

  private confirmRow(reportId: string, code: string): DiscordActionRow[] {
    return [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Confirm', custom_id: encodeCustomId({ verb: 'ok', reportId, code }) },
          { type: 2, style: 2, label: 'Cancel', custom_id: encodeCustomId({ verb: 'x' }) },
        ],
      },
    ];
  }

  /** Another moderator's live claim on the reported person stops the click (a Discord click never takes a case over). */
  private claimRefusal(report: StaffReport, who: Acting, reply: (text: string, rows?: readonly DiscordActionRow[]) => InteractionAnswer): InteractionAnswer | null {
    const holder = this.cw.cases.holder(report.targetPerson);
    if (holder === null || holder.by === who.actor) return null;
    this.denied('claimed');
    return reply(TEXT.claimed);
  }

  /**
   * The profile's suggested step for the report: the rule (null when it is uncovered: a person must choose one) and the suggestion with its code.
   * `audit` writes the `suggest` row in required mode first, so a step that cannot be recorded is not shown.
   */
  private derive(report: StaffReport, who: Acting, audit: boolean): { rule: number; code: string; label: string; why: string } | null {
    const rule = suggestedRule(this.cw.profile.reporting.reasons, report.reportedReason, this.cw.rules);
    if (typeof rule !== 'number') return null;
    const hide = !roleAtLeast(who.role, this.o.permissions['history.read']);
    const suggestion = this.cw.suggest(report.targetPerson, null, rule, {
      roomId: report.roomId === '' ? null : report.roomId,
      ...(hide ? { hideSignalText: true as const } : {}),
    });
    if (audit) auditRequired(this.cw, who, 'suggest', { type: 'report', ref: report.id });
    return { rule, code: codeOfOutcome(suggestion.outcome, rule), label: suggestion.label, why: suggestion.why };
  }

  /** The answer for a report that is closed (or gone): the verdict word, and the link. */
  private decided(report: StaffReport | null, reportId: string, reply: (text: string, rows?: readonly DiscordActionRow[]) => InteractionAnswer): InteractionAnswer {
    const word = report === null ? null : verdictWord(report);
    return reply(word === null ? 'This report was already decided.' : `This report was already decided (${word}).`, linkRow(this.o, reportId));
  }

  /**
   * Steps 9 and 10: re-check what the code says against the report as it is now, then decide through `decideAs` as the clicker. A closed report is
   * not re-derived (the suggestion has moved on after a decision): the same decision again is a replay, "Already done", and a different one is "already
   * decided". `knownCode` is a code this very click just derived (the no-confirm path), so it is not derived twice.
   */
  private async decide(report: StaffReport | null, code: string, who: Acting, reportId: string, knownCode?: string): Promise<InteractionAnswer> {
    const reply = updateMessage;
    if (report === null) return this.decided(null, reportId, reply);
    const parsed = parseCode(code);
    if (parsed === null) return reply(TEXT.changed, linkRow(this.o, reportId));
    if (report.status === 'open') {
      const claimed = this.claimRefusal(report, who, reply);
      if (claimed !== null) return claimed;
      const a = this.o.actions;
      // A dismissal needs the dismiss button on, or the profile's own suggestion to be "no action"; a step must be the profile's current suggestion.
      const needsDerive = knownCode === undefined && (parsed.dismiss ? a !== null && !a.dismiss : true);
      if (needsDerive) {
        const derived = this.derive(report, who, false);
        if (derived === null) return reply(TEXT.needsRule, linkRow(this.o, reportId));
        if (derived.code !== code) return reply(TEXT.changed, linkRow(this.o, reportId));
      }
    }
    const decision = decisionOf(code, report);
    if (decision === null) return reply(TEXT.changed, linkRow(this.o, reportId));
    let outcome: Awaited<ReturnType<typeof decideAs>>;
    try {
      outcome = await decideAs(this.cw, {
        reportId,
        decision,
        actor: who.actor,
        role: who.role,
        permissions: this.o.permissions,
        source: 'moderator',
        claims: 'gate',
        ...(this.o.logger === undefined ? {} : { logger: this.o.logger }),
      });
    } catch (err) {
      return this.refusalOf(err, reportId, reply);
    }
    // The decision has committed (a replay included, which was audited when it was made): an audit failure is logged, never turned into an error.
    if (!outcome.replay) auditBestEffort(this.cw, this.o.logger, who, 'report.decide', { type: 'report', ref: reportId });
    const ref = outcome.groups[0]?.refCode;
    return reply(`${outcome.replay ? 'Already done' : 'Done'}${DOT}${describeCode(code)}${ref === undefined ? '' : `${DOT}${safeText(ref, 40)}`}`, []);
  }

  /** What the hub's own refusals say to a person on Discord; anything else (a store failure) is rethrown for the bot to log by class. */
  private refusalOf(err: unknown, reportId: string, reply: (text: string, rows?: readonly DiscordActionRow[]) => InteractionAnswer): InteractionAnswer {
    if (err instanceof ClaimedError || (err instanceof HttpError && err.code === 'claimed')) {
      this.denied('claimed');
      return reply(TEXT.claimed);
    }
    if (err instanceof HttpError) {
      if (err.status === 403) {
        this.denied('role');
        return reply(TEXT.noPermission);
      }
      if (err.code === 'already_decided' || err.status === 404) return this.decided(this.cw.reports.get(reportId), reportId, reply);
      if (err.status >= 400 && err.status < 500) return reply(TEXT.changed, linkRow(this.o, reportId));
    }
    throw err;
  }
}
