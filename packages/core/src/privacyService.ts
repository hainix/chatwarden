// `cw.privacy` (0.2.0, design section 5): find a person, export what the kit holds, erase it (with a receipt and a stated safety remainder), and say what the kit keeps.
// The store does the rows (`exportSubjects`, `eraseSubjects`, one transaction); this file resolves the alias set, drives the order of 5.3 and forgets what the kit
// holds in memory. The kit never verifies a requester, never tells the player and never judges a request: the adopter does all three before it calls this.

import { isValidAuditActor } from './audit.js';
import type { AuditRecordInput } from './audit.js';
import { randomId } from './crypto.js';
import { hashWho } from './hasher.js';
import { safeWarn } from './log.js';
import { PRIVACY_REGISTRY } from './privacy.js';
import type { ErasePreview, ErasureCounts, ErasureReceipt, EraseMode, PrivacyCategory, PrivacyClock, PrivacyExport } from './privacy.js';
import { RETENTION_DEFAULTS } from './retention.js';
import type { RetentionPolicy } from './retention.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Hasher, Logger, RawWho, Store, SubjectId } from './types.js';

/** What the kit keeps and for how long: every category with the rule for an export and each erase mode, and the retention clock now in force. */
export interface PrivacyStatement {
  categories: Array<{
    category: PrivacyCategory;
    export: string;
    eraseSafety: string;
    eraseNone: string;
    /** How long the rows live when nobody erases them (ms), or null when they have no clock. Read live: it follows the retention policy in force. */
    retentionMs: number | null;
    /**
     * For the report categories only: how long the rows of a report filed under the `welfare` reason live (ms), never more than `retentionMs` (the earlier deletion wins). Null for every other
     * category. Read live.
     */
    retentionWelfareMs: number | null;
  }>;
  /** Fixed words: the statement is a mechanism, not a legal conclusion. */
  disclaimer: string;
}

/** What the statement says about itself. */
export const PRIVACY_DISCLAIMER =
  'This describes what the kit stores and what an export or an erase does with it. It is not legal advice and it makes no claim that any law is met.';

/** What `export` says is left out, from the registry's wording of what never leaves the store. */
export const EXPORT_NOTES: readonly string[] = [
  'Keys and addresses are held only as keyed hashes, and a hash never leaves the store: the export shows counts and first and last seen.',
  'Other players are not included: no id, name or line of anyone else, and no mute is named (counts only).',
  'Who reported the person, and which staff member acted, is not included: a reporter and a staff reference stay out.',
  'The staff workflow rows (a claim on the case, a Discord thread, an outside link) are not exported; of the staff comments only how many sit on reports that name the person is.',
];

/** What `erase` answers when it cannot: an unknown person, or an input outside the closed lists. */
export type PrivacyRefusal = { ok: false; error: 'not_found' | 'invalid' };

/** `cw.privacy`. */
export interface PrivacyService {
  /** Find a person by what the game knows (an account id or a client key). Never creates a subject; null for an unknown caller; an address alone finds nobody. */
  find(who: RawWho): SubjectId | null;
  /** Everything held about the person (the canonical subject and every alias) as one JSON-safe object. `not_found` for an unknown subject. Writes nothing. */
  export(person: SubjectId): Promise<PrivacyExport | { ok: false; error: 'not_found' }>;
  /** Erase the person. `dryRun` returns what a run would remove and keep and writes nothing. Owner-only in the HTTP layer. */
  erase(person: SubjectId, opts: { keep: EraseMode; actor: string; dryRun?: boolean }): Promise<ErasePreview | ErasureReceipt | PrivacyRefusal>;
  /** What the kit keeps and for how long, from the registry and the live retention policy. */
  statement(): PrivacyStatement;
}

export interface PrivacyDeps {
  store: Store;
  clock: Clock;
  subjects: SubjectIndex;
  hasher: Hasher;
  logger: Logger | undefined;
  /** The audit trail's `record` (never throws; false on a refusal or a store failure). */
  audit: (input: AuditRecordInput) => boolean;
  /** The retention policy now in force (the policy given at creation over the defaults). */
  retention: () => Partial<RetentionPolicy>;
  /**
   * Forget what the kit holds in memory about these people (the whole alias set), after the store rows are gone: evidence lines, caches, pacing, claims and viewing
   * hints, and the sanction and mute indexes (reloaded from the store, so a sanction the remainder keeps still applies). With `whole` (the subject and identifier rows
   * are gone) also the room seats (they become guests) and the subject index (a returning key makes a new person).
   */
  forget: (people: ReadonlySet<SubjectId>, whole: boolean) => void;
}

const isMode = (v: unknown): v is EraseMode => v === 'safety' || v === 'none';

export function createPrivacy(deps: PrivacyDeps): PrivacyService {
  const { store, clock, subjects } = deps;

  /** The person's alias set, or null for an id the kit has never seen (nothing to look up). */
  const aliasSet = (person: unknown): SubjectId[] | null => {
    if (typeof person !== 'string' || person === '' || !subjects.knows(person)) return null;
    return subjects.aliasesOf(person);
  };

  return {
    find(who) {
      try {
        if (typeof who !== 'object' || who === null) return null;
        // `lookup` is read-only: it creates no subject, links nothing and queues no write; an address alone finds nobody.
        const found = subjects.lookup(hashWho(deps.hasher, who));
        return found === null ? null : subjects.canonical(found);
      } catch (err) {
        safeWarn(deps.logger, 'chatwarden.privacy_failed', { error: err instanceof Error ? err.name : typeof err });
        return null;
      }
    },

    async export(person) {
      await subjects.flush();
      const set = aliasSet(person);
      if (set === null) return { ok: false, error: 'not_found' };
      const out = store.exportSubjects(set);
      if (!out.found) return { ok: false, error: 'not_found' };
      const { createdAt, aliases, accounts, identifiers, truncated } = out;
      const { sanctions, notices, reportsFiled, reportsAbout, strikes, blockedNames, appeals, signals, mutes, ai, audit, holds, workflow, pace } = out;
      return {
        format: 'chatwarden.privacy-export',
        version: 1,
        generatedAt: clock.now(),
        person: { ref: subjects.canonical(person), createdAt, aliases },
        accounts,
        identifiers,
        sections: { sanctions, notices, reportsFiled, reportsAbout, strikes, blockedNames, appeals, signals, mutes, ai, audit, holds, workflow, pace },
        truncated,
        notes: [...EXPORT_NOTES],
      };
    },

    async erase(person, opts) {
      if (!isMode(opts?.keep) || !isValidAuditActor(opts?.actor)) return { ok: false, error: 'invalid' };
      const keep = opts.keep;
      const dryRun = opts.dryRun === true;
      // 1. flush queued identifier writes, 2. resolve the alias set
      await subjects.flush();
      const set = aliasSet(person);
      if (set === null) return { ok: false, error: 'not_found' };
      const at = clock.now();
      const receiptId = `e_${randomId(16)}`;
      const plan = { subjects: set, mode: keep, heldReportIds: new Set(store.heldSet().reportIds), receiptId, at };

      // 3. a dry run counts and returns, and writes nothing
      if (dryRun) {
        const preview = store.transaction(() => store.eraseSubjects({ ...plan, dryRun: true }));
        if (!preview.found) return { ok: false, error: 'not_found' };
        return { dryRun: true, mode: keep, removed: preview.removed, kept: preview.kept };
      }

      // 4. one store transaction: the table rules, the receipt row (with the pending subject while a remainder is kept)
      const counts: ErasureCounts = store.transaction(() => {
        const done = store.eraseSubjects(plan);
        if (done.found) store.insertErasure({ id: receiptId, at, mode: keep, actor: opts.actor, removed: done.removed, kept: done.kept, pendingSubject: done.pending });
        return done;
      });
      if (!counts.found) return { ok: false, error: 'not_found' };

      // 5. after the commit: forget in memory, then flush and sweep once more (a write queued for the person cannot resurrect a row). The set is the one the STORE
      // erased (its closure over `merged_into`), which can be larger than this process's view when another process merged an alias in.
      const people = new Set([...set, ...counts.closure]);
      const whole = counts.pending === null;
      deps.forget(people, whole);
      await subjects.flush();
      if (whole) store.transaction(() => store.purgeStrayRows(Number.MAX_SAFE_INTEGER, [...people]));

      // 6. the audit row, after the commit: a failure is returned in the receipt and never undoes the erase. While a remainder stands the row names the person (the finish
      // rewrites it to the receipt); once nothing keeps the person it names the receipt.
      const receipt: ErasureReceipt = { id: receiptId, at, mode: keep, removed: counts.removed, kept: counts.kept };
      const audited = deps.audit({ actor: opts.actor, role: 'owner', action: 'privacy.erase', target: { type: 'person', ref: counts.pending === null ? receiptId : counts.pending } });
      if (!audited) receipt.auditFailed = true;
      return receipt;
    },

    statement() {
      const live = { ...RETENTION_DEFAULTS, ...deps.retention() } as Record<string, number>;
      const clockOf = (c: PrivacyClock): number | null => (c === null ? null : (live[c] ?? null));
      const welfareOf = (r: (typeof PRIVACY_REGISTRY)[number]): number | null => {
        if (r.welfareClock === undefined) return null;
        const own = live[r.welfareClock];
        const general = clockOf(r.retention);
        if (typeof own !== 'number') return null;
        return general === null ? own : Math.min(own, general);
      };
      return {
        categories: PRIVACY_REGISTRY.map((r) => ({
          category: r.category,
          export: r.export,
          eraseSafety: r.eraseSafety,
          eraseNone: r.eraseNone,
          retentionMs: clockOf(r.retention),
          retentionWelfareMs: welfareOf(r),
        })),
        disclaimer: PRIVACY_DISCLAIMER,
      };
    },
  };
}
