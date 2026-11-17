import { randomId } from '../crypto.js';
import type { ConductLevel, ReportRecord, SubjectId } from '../types.js';
import type { ResolvedProfile } from '../profile.js';
import type { CommunityRules } from '../rules.js';
import { actCeiling, dueAt, isHeldBack, isSystemReport, preFilter } from './actPlan.js';
import type { ActFacts, ActStep, CapUse, HoldbackHasher } from './actPlan.js';
import type { AiActingState } from './acting.js';
import type { AiActCaps } from './caps.js';
import type { Prepared } from './case.js';
import { automationAllowed } from './ceilings.js';
import { confirmAgrees } from './confirm.js';
import { startOfUtcDay } from './budget.js';
import type { AiActionRow, AiReadRow } from '../types.js';
import type { AiGatesView, ConfirmEnd } from './service.js';
import type { AiStore } from './worker.js';
import type { ActionProposer, AiActRefusal } from './types.js';

// The act path of the AI module (design 4.1): `consider` after a read, and the sweeper's `advance` of the queued rows. It decides only what it can read before it spends a call (the cheap
// checks of design 4.2), asks for the confirming read, and hands the actor three ids. It never writes anything to a person: the one thing it writes is the action row (queued, held back,
// refused), through the narrowed store, and the actor, which re-checks everything from the store, is the only one that records what the AI would have done.

const HOUR_MS = 3_600_000;
/** The most due rows one sweep advances (each may call the model for the confirming read). */
export const ACT_BATCH = 5;
/** The most action rows one sweep makes for open reports that have none yet. */
export const CONSIDER_BATCH = 20;

/** What the act path needs from the service around it. Every read is a function so the path holds no state of its own. */
export interface ActPathEnv {
  readonly store: AiStore;
  readonly clock: { now(): number };
  readonly adapterId: string;
  readonly caps: AiActCaps;
  /** The code allows acting (`maxLevel` 3 or more, `ai.act` given and enabled), a store with the action methods, and a proposer. */
  available(): boolean;
  level(): number;
  acting(): AiActingState;
  profile(): ResolvedProfile;
  rules: CommunityRules;
  prepare(report: ReportRecord): Prepared;
  /** The ladder's step now for the AI's own rule and conduct level, or null when it names none. */
  stepOf(report: ReportRecord, rec: NonNullable<NonNullable<AiReadRow['read']>['recommendation']>): ActStep | null;
  gates(): AiGatesView;
  confirmRead(reportId: string): Promise<ConfirmEnd>;
  propose: ActionProposer | undefined;
  appealsEnabled(): boolean;
  /** Fails closed: without it nobody may be acted on. */
  automationAllowed: ((person: SubjectId) => boolean) | undefined;
  reporter: ((subject: SubjectId) => { habitual: boolean; badFaith: boolean }) | undefined;
  aliases: ((subject: SubjectId) => SubjectId[]) | undefined;
  holdback: HoldbackHasher | undefined;
  warn(event: string, err: unknown): void;
}

type Rec = NonNullable<NonNullable<AiReadRow['read']>['recommendation']>;

/** The codes that are recorded on a row when the AI module meets them (a stable fact about the person, the reporter or the report, not a passing state). */
const RECORDED: ReadonlySet<AiActRefusal> = new Set<AiActRefusal>(['do_not_automate', 'reporter_habitual', 'system_report', 'not_open']);

export class ActPath {
  private readonly env: ActPathEnv;

  constructor(env: ActPathEnv) {
    this.env = env;
  }

  /** What the cheap checks can say about this report and its read. `atDue` adds the gates, the claim and the caps (they move, so they are read at the moment of use). */
  private cheap(report: ReportRecord, row: AiReadRow | null, now: number, atDue: boolean, view: AiGatesView | null): { facts: ActFacts; rec: Rec | null; step: ActStep | null } {
    const { env } = this;
    const profile = env.profile();
    const state = env.acting();
    const prepared = env.prepare(report);
    const rec = row?.read?.recommendation ?? null;
    const aliases = env.aliases?.(report.targetSubject) ?? [report.targetSubject];
    const facts: ActFacts = {
      mode: state.mode,
      paused: state.paused,
      appealsEnabled: env.appealsEnabled(),
      report: {
        open: report.status === 'open',
        badFaith: report.badFaith === true,
        ageMs: now - report.createdAt,
        claimed: atDue && env.store.loadClaims(aliases, now).length > 0,
        system: isSystemReport(report),
      },
    };
    const step = rec !== null && typeof rec.rule === 'number' ? env.stepOf(report, rec) : null;
    facts.readUsable =
      row !== null &&
      row.read !== null &&
      row.status === 'ok' &&
      row.inputHash === prepared.hash &&
      row.read.injectionSuspected === false &&
      !prepared.injection &&
      row.read.confidence === 'high' &&
      rec !== null &&
      rec.verdict === 'upheld';
    if (rec !== null && facts.readUsable) {
      const rule = rec.rule;
      const excluded = new Set(profile.ai.actExcludeRules ?? []);
      facts.cellAllowed =
        typeof rule === 'number' &&
        env.rules.active().some((r) => r.number === rule) &&
        !excluded.has(rule) &&
        (rec.severity === 'hostile' || rec.severity === 'severe') &&
        profile.aiAutoAct.includes(rec.severity);
      if (atDue && facts.cellAllowed && view !== null) {
        const cell = view.cells.find((c) => c.rule === rule && c.level === rec.severity);
        if (cell === undefined) facts.cellAllowed = false;
        else if (!cell.open) facts.gateFailed = cell.checks.find((c) => !c.ok)?.name ?? (cell.coolingCode === 'appeal_revoked' ? 'appeals_acts' : 'keep');
      }
      facts.ceiling = actCeiling(step, rec.evidence, prepared.ownLineIds);
    }
    // Every act call site passes a lookup; without one nobody may be acted on.
    facts.automationAllowed = automationAllowed(report.targetSubject, env.automationAllowed ?? (() => false));
    const who = report.reporterSubject === '' ? { habitual: false, badFaith: false } : (env.reporter?.(report.reporterSubject) ?? { habitual: true, badFaith: true });
    facts.reporterHabitual = who.habitual || who.badFaith;
    if (atDue) {
      const unreviewed = env.store.aiUnreviewed?.() ?? { n: Number.POSITIVE_INFINITY, oldestActedAt: null };
      const use: CapUse = {
        hour: env.store.aiActedCount?.(now - HOUR_MS) ?? Number.POSITIVE_INFINITY,
        day: env.store.aiActedCount?.(startOfUtcDay(now)) ?? Number.POSITIVE_INFINITY,
        unreviewed: unreviewed.n,
        oldestUnreviewedAt: unreviewed.oldestActedAt,
      };
      facts.caps = use;
    }
    return { facts, rec, step };
  }

  /**
   * After a read of the case: when it is a candidate (acting is shadow or on and not paused, appeals are on, the read is usable, the cell may be acted on, the step is within the ceilings), queue
   * it for the hold and the confirming read, or record it as held back (the 20% holdback: a person decides it as at level 2). A report that meets a hard stop (a person marked "do not
   * automate", a reporter with a bad-faith mark or a habitual false reporter, a system report, a report marked bad faith) is recorded as refused, with the code. Anything else leaves no
   * row. One row per report, ever. Fenced by the caller.
   */
  consider(reportId: string): void {
    const { env } = this;
    if (!env.available() || env.level() < 2) return;
    const state = env.acting();
    if (state.mode === 'off' || state.paused) return;
    const report = env.store.loadReport(reportId);
    if (report === null) return;
    if ((env.store.loadAiAction?.(reportId) ?? null) !== null) return;
    const row = env.store.loadAiRead(reportId);
    const now = env.clock.now();
    const { facts, rec } = this.cheap(report, row, now, false, null);
    // The hold has not run yet at this point: the report is queued for it (`notBefore`), so it is not "too new" here, and a person's claim is looked at when the row is due.
    const code = preFilter(facts, { ...env.caps, holdMs: 0 }, now);
    if (rec === null || row === null) return;
    const base = {
      id: '',
      reportId,
      readId: row.id,
      confirmReadId: null,
      rule: String(rec.rule),
      severity: rec.severity as ConductLevel,
      refusedCode: null,
      notBefore: dueAt(report.createdAt, env.caps.holdMs),
      createdAt: now,
      groupId: null,
      kind: null,
      durationMs: null,
      actedAt: null,
      reviewDueAt: null,
      reviewedAt: null,
      reviewedBy: null,
      undoCode: null,
      undoNote: null,
      adapter: env.adapterId,
      promptVersion: row.promptVersion,
    };
    // A report that is not open is no candidate, but one a person marked bad faith is a hard stop and is recorded as such.
    if (code !== null && (!RECORDED.has(code) || (code === 'not_open' && report.badFaith !== true))) return;
    if (code !== null) {
      env.store.insertAiAction?.({ ...base, id: newId(), state: 'refused', refusedCode: code });
      return;
    }
    const held = isHeldBack(reportId, env.holdback ?? (() => '00000000'), env.caps.holdbackShare);
    // The step the AI module expects is kept on the queued row: the actor refuses a proposal whose recomputed step is another (the case moved), it never corrects it.
    const step = typeof rec.rule === 'number' ? env.stepOf(report, rec) : null;
    env.store.insertAiAction?.({ ...base, id: newId(), state: held ? 'held_back' : 'queued', kind: held || step === null ? null : step.kind, durationMs: held || step === null ? null : step.durationMs });
  }

  /**
   * Open reports that have a read and no action row yet (a restart, a pause that ended, a read that finished before acting was on): considered. The bound counts the reports that
   * got a row (a candidate or a hard stop), not every report looked at: most reports never get one, and counting them would leave a candidate behind twenty of them unconsidered
   * for good. The look itself is bounded by the page the sweeper hands in.
   */
  considerAll(page: readonly { id: string }[]): void {
    let made = 0;
    for (const r of page) {
      if (made >= CONSIDER_BATCH) break;
      try {
        if ((this.env.store.loadAiAction?.(r.id) ?? null) !== null) continue;
        this.consider(r.id);
        if ((this.env.store.loadAiAction?.(r.id) ?? null) !== null) made += 1;
      } catch (err) {
        this.env.warn('ai.consider_failed', err);
      }
    }
  }

  /** Advance the queued rows that are due: the cheap checks again, the confirming read, then the proposal. A row that cannot go on stays queued (waiting) or is refused with a code. */
  async advanceDue(now: number): Promise<void> {
    const { env } = this;
    if (!env.available() || env.level() < 2) return;
    let view: AiGatesView | null = null;
    for (const row of env.store.dueAiActions?.(now, ACT_BATCH) ?? []) {
      try {
        view ??= env.gates();
        await this.advance(row, now, view);
      } catch (err) {
        // Fail soft toward the human: the row stays queued, the report stays in the queue as at level 2, and only the class is logged.
        env.warn('ai.act_failed', err);
      }
    }
  }

  private refuse(row: AiActionRow, code: AiActRefusal): void {
    this.env.store.transitionAiAction?.(row.id, ['queued'], { state: 'refused', refusedCode: code });
  }

  private async advance(row: AiActionRow, now: number, view: AiGatesView): Promise<void> {
    const { env } = this;
    const report = env.store.loadReport(row.reportId);
    if (report === null || report.status !== 'open' || report.badFaith === true) return this.refuse(row, 'not_open');
    const state = env.acting();
    if (state.mode === 'off') return this.refuse(row, 'acting_off');
    if (state.paused) return;
    const caseRead = env.store.loadAiRead(row.reportId);
    const { facts } = this.cheap(report, caseRead, now, true, view);
    const code = preFilter(facts, env.caps, now);
    if (code === 'paused') return;
    if (code !== null) return this.refuse(row, code);
    if (caseRead === null || caseRead.read === null || env.propose === undefined) return;
    // The confirming read: a clean prompt that looks for the innocent reading. Asked once; no answer yet means ask again at the next sweep.
    const confirm = await env.confirmRead(row.reportId);
    if (confirm.state === 'wait') return;
    if (confirm.state === 'none') return this.refuse(row, 'confirm_disagrees');
    const prepared = env.prepare(report);
    if (!confirmAgrees(caseRead.read, confirm.read, prepared.ownLineIds)) return this.refuse(row, 'confirm_disagrees');
    env.store.transitionAiAction?.(row.id, ['queued'], { confirmReadId: confirm.readId });
    // Ids only: the actor reads everything again and decides for itself.
    const result = await env.propose({ reportId: row.reportId, readId: caseRead.id, confirmReadId: confirm.readId });
    if (result.ok) return;
    if (result.refused === 'paused') return;
    this.refuse(row, result.refused);
  }
}

const newId = (): string => randomId(16);
