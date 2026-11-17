import { startOfUtcDay } from '../ai/budget.js';
import { actCeiling, evaluateChecks, isHeldBack, isSystemReport } from '../ai/actPlan.js';
import type { ActFacts, ActStep, HoldbackHasher } from '../ai/actPlan.js';
import type { AiActingMode } from '../ai/acting.js';
import type { AiActCaps } from '../ai/caps.js';
import { prepareCase } from '../ai/case.js';
import { automationAllowed } from '../ai/ceilings.js';
import { confirmAgrees } from '../ai/confirm.js';
import type { AiGatesView } from '../ai/service.js';
import type { AiActionProposal, AiActRefusal } from '../ai/types.js';
import type { Suggestion } from '../ladder.js';
import type { ResolvedProfile } from '../profile.js';
import type { CommunityRules, RuleRef } from '../rules.js';
import type { AiReadRow, ConductLevel, Clock, ReportRecord, Store, SubjectId } from '../types.js';

// The actor's recheck (design 4.2, 6.1): everything the twelve checks need is read again from the store, at the moment of use, and the proposal is only a hint. This file
// builds the facts and hands them to the same pure function the AI module's pre-filter uses (`evaluateChecks`), so the order and the codes are written once. It reads; it does not
// write. It imports nothing that calls an adapter.

/** What the actor needs from the kit. Every read is a function, so a test builds the actor from the public kit and nothing hides in a closure. */
export interface RecheckDeps {
  store: Store;
  clock: Clock;
  profile: () => ResolvedProfile;
  rules: CommunityRules;
  /** `cw.suggest`. */
  suggest: (subject: SubjectId, level: ConductLevel | null, rule: RuleRef, ctx: { roomId: string | null }) => Suggestion;
  /** The acting state now, read from the store at every call. */
  acting: () => { mode: AiActingMode; paused: boolean };
  appealsEnabled: () => boolean;
  /** `cw.ai.gates()`: computed from the store at the moment of use, never cached. */
  gates: () => AiGatesView;
  /** `cw.people.automation.get(person).allowed`, false for a store that cannot say. `automationAllowed` fails closed on a throw. */
  automationAllowed: (person: SubjectId) => boolean;
  /** The reporter's record: a habitual false reporter, or one with a bad-faith mark. */
  reporter: (subject: SubjectId) => { habitual: boolean; badFaith: boolean };
  /** A person's canonical id and every merged alias. */
  aliases: (subject: SubjectId) => SubjectId[];
  /** The adapter ids the stored reads were made for: the case's read and the confirming read. */
  adapterId: string;
  confirmAdapterId: string;
  /** `blockedLines: 'mask'`, as the AI service was given it (it changes the prompt, so the hash). */
  mask: boolean;
  caps: AiActCaps;
  holdback: HoldbackHasher;
}

/** What a recheck found. `facts` is everything it read, for tests; a refusal is the code of the first check that fails. */
export type Recheck =
  | { ok: false; refused: AiActRefusal }
  | { ok: true; report: ReportRecord; read: AiReadRow; confirm: AiReadRow; rule: number; severity: ConductLevel; step: ActStep };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A suggestion's outcome as a step; `none` is no step. */
function stepOf(s: Suggestion): ActStep | null {
  const o = s.outcome;
  if (o === 'none') return null;
  if (o === 'note' || o === 'warning') return { kind: o, durationMs: null };
  return { kind: o.kind, durationMs: o.durationMs };
}

/**
 * Read everything again and decide. The proposal names three ids; every other thing, the report, the reads, the profile, the person, the claims, the marks, the appeals, the gates
 * and the caps, comes from the store now. A proposal that disagrees with what is found (not the newest read, a read that has gone stale, a step that is not the one the AI module
 * queued) is refused as `read_not_usable`, never corrected.
 */
export function recheck(deps: RecheckDeps, p: AiActionProposal): Recheck {
  const { store, caps } = deps;
  const now = deps.clock.now();
  const refuse = (refused: AiActRefusal): Recheck => ({ ok: false, refused });

  const report = store.loadReport(p.reportId);
  if (report === null) return refuse('not_open');
  const profile = deps.profile();
  const aliases = deps.aliases(report.targetSubject);
  const state = deps.acting();
  const claimed = store.loadClaims(aliases, now).length > 0;
  const facts: ActFacts = {
    mode: state.mode,
    paused: state.paused,
    appealsEnabled: deps.appealsEnabled(),
    report: { open: report.status === 'open', badFaith: report.badFaith === true, ageMs: now - report.createdAt, claimed, system: isSystemReport(report) },
  };
  const early = (): Recheck | null => {
    const code = evaluateChecks(facts, caps, now);
    return code === null ? null : refuse(code);
  };
  // The checks that need only the report come first: nothing else is read for a report that is not open, too new or claimed.
  const first = early();
  if (first !== null) return first;

  // 3. The read: the newest finished read of the case, the one that was proposed, made for the case as it is now, at high confidence, recommending upheld.
  const prepared = prepareCase({ report, policy: { profile, rules: deps.rules }, reasons: profile.reporting.reasons, adapterId: deps.adapterId, mask: deps.mask });
  const read = store.loadAiReadById?.(p.readId) ?? null;
  const newest = store.loadAiRead?.(p.reportId) ?? null;
  const rec = read?.read?.recommendation ?? null;
  const ruleNumber = rec !== null && typeof rec.rule === 'number' ? rec.rule : null;
  // The step the ladder gives now, for the AI's own rule and conduct level. It is computed from the store here, whatever the proposal or the queue said.
  let step: ActStep | null = null;
  if (rec !== null && ruleNumber !== null) {
    step = stepOf(deps.suggest(report.targetSubject, rec.severity, ruleNumber, { roomId: report.roomId === '' ? null : report.roomId }));
  }
  const queued = store.loadAiAction?.(p.reportId) ?? null;
  // A step that is not the one the AI module queued the report for means the case moved under the proposal (a new sanction on the person, say): refused, never corrected.
  const sameStep = queued === null || queued.kind === null || (step !== null && queued.kind === step.kind && queued.durationMs === step.durationMs);
  const usable =
    read !== null &&
    read.purpose === 'read' &&
    read.reportId === report.id &&
    read.status === 'ok' &&
    read.read !== null &&
    newest !== null &&
    newest.id === read.id &&
    read.inputHash === prepared.hash &&
    read.read.injectionSuspected === false &&
    !prepared.injection &&
    read.read.confidence === 'high' &&
    rec !== null &&
    rec.verdict === 'upheld' &&
    sameStep;
  facts.readUsable = usable;
  if (!usable || read === null || read.read === null || rec === null) return early() ?? refuse('read_not_usable');

  // 4. The confirming read: its own row, for this case, made for the confirming adapter, finished, and in agreement.
  const confirm = store.loadAiReadById?.(p.confirmReadId) ?? null;
  const confirmRead = confirm !== null && confirm.purpose === 'confirm' && confirm.reportId === report.id && confirm.status === 'ok' && confirm.inputHash === prepared.confirm(deps.confirmAdapterId).hash ? confirm.read : null;
  facts.confirmAgrees = confirm !== null && confirmRead !== null && confirmAgrees(read.read, confirmRead, prepared.ownLineIds);
  const afterConfirm = early();
  if (afterConfirm !== null) return afterConfirm;

  // 5. The cell: a numbered, active rule that the owner has not excluded, at a conduct level the profile lets the AI act on.
  const excluded = new Set(profile.ai.actExcludeRules ?? []);
  const level = rec.severity;
  facts.cellAllowed =
    ruleNumber !== null &&
    deps.rules.active().some((r) => r.number === ruleNumber) &&
    !excluded.has(ruleNumber) &&
    (level === 'hostile' || level === 'severe') &&
    profile.aiAutoAct.includes(level);
  // 6. The cell's gates, computed from the store now; a cell the view does not hold cannot act.
  facts.gateFailed = null;
  if (facts.cellAllowed && ruleNumber !== null) {
    const cell = deps.gates().cells.find((c) => c.rule === ruleNumber && c.level === level);
    if (cell === undefined) facts.cellAllowed = false;
    else if (!cell.open) {
      const failing = cell.checks.find((c) => !c.ok);
      // No failing gate but not open: a cooling latch (an undo as not a violation closes keep, a revoke on appeal closes appeals_acts).
      facts.gateFailed = failing?.name ?? (cell.coolingCode === 'appeal_revoked' ? 'appeals_acts' : 'keep');
    }
  }
  // 7. The step: a warning or a chat restriction of at most 24 hours, with a line by the reported person cited.
  facts.ceiling = actCeiling(step, rec.evidence, prepared.ownLineIds);
  // 8. Every cited line is in the report's stored excerpt (the kit's own evidence buffer: the server saw them).
  const inExcerpt = new Set(report.excerpt.map((l) => l.lineId));
  const confirmRec = confirmRead?.recommendation ?? null;
  facts.evidenceInExcerpt = [...rec.evidence, ...(confirmRec?.evidence ?? [])].every((id) => inExcerpt.has(id));
  // 9. The person: not marked "do not automate" (a lookup that throws, or a store that cannot say, is a no), no open appeal, no AI action on them in the cap window, none undone as not a violation in 30 days.
  facts.automationAllowed = automationAllowed(report.targetSubject, deps.automationAllowed);
  const acted = store.aiActionsOnSubjects?.(aliases, now - caps.perPersonMs, now - 30 * DAY_MS);
  const openAppeal = (store.listAppealsBy?.(aliases, 200) ?? []).some((a) => a.status === 'open');
  facts.personProtected = acted === undefined || acted.acted > 0 || acted.undone > 0 || openAppeal;
  // 10. The reporter: not a habitual false reporter and not carrying a bad-faith mark.
  const who = isSystemReport(report) ? { habitual: false, badFaith: false } : deps.reporter(report.reporterSubject);
  facts.reporterHabitual = who.habitual || who.badFaith;
  // 11. Caps and review debt.
  const unreviewed = store.aiUnreviewed?.() ?? { n: Number.POSITIVE_INFINITY, oldestActedAt: null };
  facts.caps = {
    hour: store.aiActedCount?.(now - HOUR_MS) ?? Number.POSITIVE_INFINITY,
    day: store.aiActedCount?.(startOfUtcDay(now)) ?? Number.POSITIVE_INFINITY,
    unreviewed: unreviewed.n,
    oldestUnreviewedAt: unreviewed.oldestActedAt,
  };
  // 12. The deterministic holdback.
  facts.heldBack = isHeldBack(report.id, deps.holdback, caps.holdbackShare);

  const refused = evaluateChecks(facts, caps, now);
  if (refused !== null) return refuse(refused);
  if (step === null || ruleNumber === null) return refuse('read_not_usable');
  if (confirm === null) return refuse('confirm_disagrees');
  return { ok: true, report, read, confirm, rule: ruleNumber, severity: level, step };
}
