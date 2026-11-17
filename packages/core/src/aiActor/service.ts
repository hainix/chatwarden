import { dueAt } from '../ai/actPlan.js';
import { checkActCaps } from '../ai/caps.js';
import { aiActorOf } from '../ai/actorId.js';
import type { AiActionProposal, AiActResult, AiActRefusal } from '../ai/types.js';
import type { AuditRecordInput } from '../audit.js';
import { randomId } from '../crypto.js';
import { safeWarn } from '../log.js';
import type { Logger } from '../types.js';
import type { AiActionRow } from '../types.js';
import { recheck } from './recheck.js';
import type { RecheckDeps } from './recheck.js';

// The actor (design 4.1, 6.1 and 6.2): the ONLY module that may ever write what the AI does to a person. It is handed ids and nothing else, reads everything again from the store
// (`recheck`), runs all twelve checks, and then, in this release, does the one thing a shadow can do: it records a `shadow` row and returns. There is NO branch that writes a
// sanction, a notice, a strike, a mute or a decision here, not behind a flag and not behind a mode: acting on a person arrives in a later release, and `scripts/ai-seam.test.ts`
// pins that nothing in this file spells a sanction with the AI as its source. It never calls an adapter.

/** The caps check the kit applies to `ai.act.caps`, reached through this module so the browser build never holds it. */
export { checkActCaps };

/** What the actor needs of the kit: everything `recheck` reads, the audit trail, and the adapter id the `ai.act` row is written under. */
export interface AiActionDeps extends RecheckDeps {
  /** `cw.audit.record`. */
  audit: (input: AuditRecordInput) => boolean;
  logger?: Logger;
}

/** The refusal codes that are stored on a `refused` row: the closed set the actor and the AI module share. */
const REFUSAL_PREFIX = 'gate_failed:';

/**
 * Turn a stored code back into a refusal, for a replay: a row that was refused says the same thing again. A code this version does not know reads as `read_not_usable` (a row from
 * a newer kit, a hand edit): never a code that would let the caller go on.
 */
function refusalOf(code: string | null): AiActRefusal {
  if (code === null) return 'read_not_usable';
  if (code.startsWith(REFUSAL_PREFIX)) return code as AiActRefusal;
  return KNOWN.has(code) ? (code as AiActRefusal) : 'read_not_usable';
}
const KNOWN: ReadonlySet<string> = new Set([
  'acting_off', 'paused', 'no_appeals', 'not_open', 'too_old', 'too_new', 'claimed', 'read_not_usable', 'confirm_disagrees', 'cell_not_allowed', 'ceiling_kind', 'ceiling_duration',
  'ceiling_evidence', 'evidence_missing', 'do_not_automate', 'person_protected', 'reporter_habitual', 'system_report', 'cap_hour', 'cap_day', 'review_debt', 'held_back',
]);

/**
 * `AiActionService.propose` (design 6.3's `ActionProposer`). Idempotent: one action row per report, ever (`UNIQUE (report_id)`), so a retry, a restart or a second process finds the
 * row and returns it (`replay: true`). A refusal writes nothing: the AI module records it on the row, and refusals are counted by code, not audited per attempt.
 */
export class AiActionService {
  private readonly deps: AiActionDeps;
  private readonly actor: string;

  constructor(deps: AiActionDeps) {
    this.deps = deps;
    this.actor = aiActorOf(deps.adapterId);
  }

  /** The `ActionProposer` the AI module is given. Throws only what the store throws; the caller fences it and leaves the report in the human queue. */
  readonly propose = (p: AiActionProposal): Promise<AiActResult> => {
    try {
      return Promise.resolve(this.run(p));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error('propose failed'));
    }
  };

  private run(p: AiActionProposal): AiActResult {
    const { store } = this.deps;
    // A row that already says what became of this report answers for it: an action recorded is a replay, a refusal recorded is the same refusal, a held-back case stays held back.
    const existing = store.loadAiAction?.(p.reportId) ?? null;
    if (existing !== null) {
      if (existing.state === 'shadow') return { ok: true, actionId: existing.id, mode: 'shadow', replay: true };
      if (existing.state === 'active' || existing.state === 'confirmed' || existing.state === 'undone') return { ok: true, actionId: existing.id, mode: 'acted', replay: true };
      if (existing.state === 'held_back') return { ok: false, refused: 'held_back' };
      if (existing.state === 'refused') return { ok: false, refused: refusalOf(existing.refusedCode) };
    }
    const found = recheck(this.deps, p);
    if (!found.ok) return found;

    // Every check holds. In this release the only thing to do is to record that the AI would have acted, in one conditional write: the row moves from `queued` to `shadow`
    // (or is created as `shadow`), and of two processes exactly one writes it. Nothing else is written, whatever the acting mode says.
    const now = this.deps.clock.now();
    const patch = {
      state: 'shadow' as const,
      confirmReadId: found.confirm.id,
      kind: found.step.kind,
      durationMs: found.step.durationMs,
      actedAt: now,
      adapter: this.deps.adapterId,
      promptVersion: found.read.promptVersion,
    };
    let actionId: string;
    let won: boolean;
    if (existing === null) {
      const row: AiActionRow = {
        id: randomId(16),
        reportId: p.reportId,
        readId: p.readId,
        confirmReadId: found.confirm.id,
        rule: String(found.rule),
        severity: found.severity,
        state: 'shadow',
        refusedCode: null,
        notBefore: dueAt(found.report.createdAt, this.deps.caps.holdMs),
        createdAt: now,
        groupId: null,
        kind: found.step.kind,
        durationMs: found.step.durationMs,
        actedAt: now,
        reviewDueAt: null,
        reviewedAt: null,
        reviewedBy: null,
        undoCode: null,
        undoNote: null,
        adapter: this.deps.adapterId,
        promptVersion: found.read.promptVersion,
      };
      actionId = row.id;
      won = store.insertAiAction?.(row) === true;
    } else {
      actionId = existing.id;
      won = store.transitionAiAction?.(existing.id, ['queued'], patch) === true;
    }
    if (!won) {
      // Someone else got there first (or the row moved): answer from the row as it is now.
      const now2 = store.loadAiAction?.(p.reportId) ?? null;
      if (now2 !== null && now2.state === 'shadow') return { ok: true, actionId: now2.id, mode: 'shadow', replay: true };
      if (now2 !== null && now2.state === 'refused') return { ok: false, refused: refusalOf(now2.refusedCode) };
      return { ok: false, refused: 'read_not_usable' };
    }
    // The one audit row of an action, the AI's own (an `ai:` actor, no role). The state is in the action row, not the trail. Best effort: the row is written.
    try {
      this.deps.audit({ actor: this.actor, role: null, action: 'ai.act', target: { type: 'report', ref: p.reportId } });
    } catch {
      safeWarn(this.deps.logger, 'chatwarden.ai_act_audit_failed');
    }
    return { ok: true, actionId, mode: 'shadow', replay: false };
  }
}
