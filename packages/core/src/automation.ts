import { isValidAuditActor } from './audit.js';
import { safeWarn } from './log.js';
import type { SubjectIndex } from './subjects.js';
import type { Clock, Logger, Store, SubjectId } from './types.js';

// "Do not automate" (AI levels 3 and 4, design 6.4, ruling 17): a mark a senior puts on a person so the AI never acts on them. It sits outside `ai/`
// because it is a person's mark, not an AI concept; the AI module only asks (through the lookup `automationAllowed` is given). The mark carries a
// closed reason code and no free text. Reads and drafts are still produced for a marked person; acting is what is refused.

/**
 * The closed reasons a person can be marked "do not automate" for. A frozen list, not an option.
 */
export const AUTOMATION_CODES: readonly AutomationCode[] = Object.freeze(['vulnerable', 'under_review', 'staff', 'sensitive_case', 'other'] as const);

export type AutomationCode = 'vulnerable' | 'under_review' | 'staff' | 'sensitive_case' | 'other';

/**
 * What `cw.people.automation.get` answers: whether the AI may ever act on this person, the closed reason when it may not, and when the mark was set.
 * No actor and no text: the senior's ref stays in the store.
 */
export interface AutomationMark {
  allowed: boolean;
  code: AutomationCode | null;
  at: number | null;
}

/**
 * `cw.people.automation`: a senior's mark that the AI never acts on a person (staff only; `automation.write` in the HTTP layer). It follows a merge:
 * a mark is kept under the canonical person, and a read looks at every alias, the newest mark winning, so a mark set before two people merged is not lost.
 */
export interface AutomationFacade {
  /**
   * The mark of this person (merged aliases folded in). `{ allowed: true, code: null, at: null }` for a person with none, an unknown id, a non-string and a
   * store without the methods. A store that fails on the read answers "not allowed" (fail closed: the AI must not act on a person it could not check).
   */
  get(subject: SubjectId): AutomationMark;
  /**
   * Set (`allowed: false` with one of {@link AUTOMATION_CODES}) or clear (`allowed: true`, no code) the mark. `actor` is the senior's staff ref (the audit
   * rule). `invalid` for an unknown person, a bad or missing code, a code on a clear, or a bad actor; `unsupported` for a store without the methods.
   * Clearing removes the rows of every alias. A store error is thrown as the store's own.
   */
  set(subject: SubjectId, input: { allowed: boolean; code?: AutomationCode; actor: string }): { ok: true } | { ok: false; error: 'invalid' | 'unsupported' };
}

const ALLOWED: AutomationMark = Object.freeze({ allowed: true, code: null, at: null });

/** @internal */
export function createAutomation(deps: { store: Store; subjects: SubjectIndex; clock: Clock; logger?: Logger }): AutomationFacade {
  const { store, subjects, clock } = deps;
  const supported = (): boolean => typeof store.setNoAutomation === 'function' && typeof store.loadNoAutomation === 'function';
  return {
    get(subject) {
      if (typeof subject !== 'string' || subject === '' || !supported()) return { ...ALLOWED };
      try {
        let best: { code: string; at: number } | null = null;
        for (const alias of subjects.aliasesOf(subject)) {
          const row = store.transaction(() => store.loadNoAutomation?.(alias) ?? null);
          if (row !== null && (best === null || row.setAt > best.at)) best = { code: row.code, at: row.setAt };
        }
        if (best === null) return { ...ALLOWED };
        const code = (AUTOMATION_CODES as readonly string[]).includes(best.code) ? (best.code as AutomationCode) : 'other';
        return { allowed: false, code, at: best.at };
      } catch {
        safeWarn(deps.logger, 'chatwarden.automation_read_failed', { class: 'store' });
        return { allowed: false, code: 'other', at: null };
      }
    },
    set(subject, input) {
      if (typeof subject !== 'string' || subject === '' || !subjects.knows(subject)) return { ok: false, error: 'invalid' };
      if (typeof input !== 'object' || input === null) return { ok: false, error: 'invalid' };
      const { allowed, code } = input as { allowed: unknown; code: unknown };
      const actor = typeof input.actor === 'string' ? input.actor.trim() : '';
      if (typeof allowed !== 'boolean' || !isValidAuditActor(actor)) return { ok: false, error: 'invalid' };
      if (allowed ? code !== undefined : typeof code !== 'string' || !(AUTOMATION_CODES as readonly string[]).includes(code)) {
        return { ok: false, error: 'invalid' };
      }
      if (!supported()) return { ok: false, error: 'unsupported' };
      const now = clock.now();
      store.transaction(() => {
        const root = subjects.canonical(subject);
        // The aliases' own rows go either way: a clear must clear them all, and a set leaves exactly one row, under the canonical person.
        for (const alias of subjects.aliasesOf(subject)) if (alias !== root) store.setNoAutomation?.(alias, null);
        store.setNoAutomation?.(root, allowed ? null : { code: code as string, setBy: actor, setAt: now });
      });
      return { ok: true };
    },
  };
}
