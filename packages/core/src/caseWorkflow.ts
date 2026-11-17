import { isValidAuditActor } from './audit.js';
import type { KitEvent } from './events.js';
import type { Clock, Store } from './types.js';

// The urgent lane's two marks on a case (spec section 5.2): a moderator may raise or lower `urgent` on an open report, and may mark it as passed to the game's safety team (the
// hand-off). Both are notes for colleagues: neither contacts anyone, writes a notice, a strike or a sanction, or reads the AI. The staff layer writes the audit trail around them.
// Comments and escalation (spec 6) live in commentService.ts.

/**
 * What `setUrgent` and `handoff` answer: done (including a repeat that changed nothing), or why not. `not_found` is an unknown report id; `closed` is a report that has been decided.
 * @experimental
 */
export type CaseMarkResult = { ok: true } | { ok: false; refused: 'not_found' | 'closed' };

export interface CaseWorkflowDeps {
  store: Store;
  clock: Clock;
  /** Announce an event (the facade's bus: fenced, never throws). Called after the write has committed. */
  emit: (event: KitEvent) => void;
}

const needActor = (actor: unknown): string => {
  if (!isValidAuditActor(actor)) throw new RangeError('cases: the actor is not a valid staff ref');
  return actor;
};

const unsupported = (method: string): never => {
  throw new TypeError(`cases.${method}: the store does not support the urgent lane (it lacks the optional report methods)`);
};

/** `cw.cases.setUrgent`, `cw.cases.handoff` and `cw.cases.urgentCount`. */
export class CaseWorkflow {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly emit: (event: KitEvent) => void;

  constructor(deps: CaseWorkflowDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.emit = deps.emit;
  }

  /**
   * Mark an open report urgent or not urgent. Any moderator, both directions. `ok: true` also for a report already in that state (nothing changes). A decided report is `closed` and an
   * unknown id `not_found`. Moves the change token when it changed something; announces nothing; touches no claim and nothing about a person. A store failure throws.
   */
  setUrgent(reportId: string, actor: string, on: boolean): CaseMarkResult {
    needActor(actor);
    if (typeof on !== 'boolean') throw new RangeError('cases: urgent must be true or false');
    const set = this.store.setReportUrgent;
    if (typeof set !== 'function') return unsupported('setUrgent');
    return this.store.transaction(() => {
      const report = typeof reportId === 'string' && reportId !== '' ? this.store.loadReport(reportId) : null;
      if (report === null) return { ok: false, refused: 'not_found' } as const;
      if (report.status !== 'open') return { ok: false, refused: 'closed' } as const;
      if (report.urgent !== on) set.call(this.store, reportId, on);
      return { ok: true } as const;
    });
  }

  /**
   * Record that a moderator passed the case to the game's safety team: who and when, once. The first call wins; a second answers `ok: true`, changes nothing and announces nothing.
   * Allowed on an urgent or an ordinary open report. Emits `report.handoff` (the report id and the time) after the write has committed; the event is fenced, so a listener can never
   * change the answer. It contacts no one and writes nothing to the person. A store failure throws and announces nothing.
   */
  handoff(reportId: string, actor: string): CaseMarkResult {
    needActor(actor);
    const set = this.store.setHandoff;
    if (typeof set !== 'function') return unsupported('handoff');
    const now = this.clock.now();
    const done = this.store.transaction((): { refused: 'not_found' | 'closed' } | { first: boolean } => {
      const report = typeof reportId === 'string' && reportId !== '' ? this.store.loadReport(reportId) : null;
      if (report === null) return { refused: 'not_found' };
      if (report.status !== 'open') return { refused: 'closed' };
      return { first: set.call(this.store, reportId, actor, now) };
    });
    if ('refused' in done) return { ok: false, refused: done.refused };
    if (done.first) this.emit({ type: 'report.handoff', reportId, at: now });
    return { ok: true };
  }

  /** How many open reports are urgent. 0 for a store without the urgent lane. */
  urgentCount(): number {
    return typeof this.store.countOpenUrgent === 'function' ? this.store.countOpenUrgent() : 0;
  }
}
