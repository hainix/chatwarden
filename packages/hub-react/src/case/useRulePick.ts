import { useEffect, useRef, useState } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { ruleChoiceOf } from '../simple.js';
import type { RuleChoice } from '../simple.js';
import type { ReportDetail, Suggestion } from '../types.js';

/**
 * Which rule the Simple card works from. The kit gives a case the rule its reason usually means; the card only trusts that when the reason
 * maps to exactly one rule in force (then it is preselected, and the moderator can change it). Otherwise (no reason, "Something else", a
 * reason with two rules or none) it asks which rule the report breaks, and the suggestion appears once one is picked. A rule picked other
 * than the one the case was read with is asked of the ladder (`POST /reports/:id/suggest`), the latest pick winning.
 *
 * `mode` is `none` when the card cannot tell (the role may not read the settings or apply steps): the card then works as it always has.
 */
export interface RulePick {
  mode: 'none' | 'known' | 'ask';
  choice: RuleChoice | null;
  /** The rule shown picked, or null while nothing is. */
  picked: number | null;
  pick: (rule: number | null) => void;
  /** The ladder's suggestion for the picked rule, or null while there is none (nothing picked, or the answer is on its way). */
  suggestion: Suggestion | null;
  busy: boolean;
  error: HubError | null;
}

export function useRulePick({
  detail,
  reasons,
  active,
  enabled,
}: {
  detail: ReportDetail | undefined;
  reasons: ReadonlyArray<{ id: string; rules: readonly number[] }> | undefined;
  /** The Community Rules in force, by number. */
  active: readonly number[];
  /** The role may read the settings and apply steps, and the rules are loaded. */
  enabled: boolean;
}): RulePick {
  const { client } = useHub();
  const report = detail?.report;
  const mode0 = enabled && reasons !== undefined && detail !== undefined;
  const choice: RuleChoice | null = mode0 ? ruleChoiceOf(report?.reportedReason ?? null, reasons, active) : null;
  // `undefined`: the moderator has not touched it, so the preselected rule (if any) stands.
  const [touched, setTouched] = useState<number | null | undefined>(undefined);
  const picked = touched !== undefined ? touched : choice?.kind === 'one' ? choice.rule : null;
  const [fetched, setFetched] = useState<{ rule: number; suggestion: Suggestion } | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const seq = useRef(0);

  const known = detail !== undefined && picked === detail.rule ? detail.suggest : fetched !== null && fetched.rule === picked ? fetched.suggestion : null;
  const target = report?.targetPerson;
  const reportId = report?.id;
  const need = mode0 && picked !== null && known === null && target !== undefined && reportId !== undefined;

  useEffect(() => {
    if (!need || picked === null || target === undefined || reportId === undefined) return undefined;
    const mine = (seq.current += 1);
    setError(null);
    client.suggest(reportId, { person: target, rule: picked }).then(
      (suggestion) => {
        if (mine !== seq.current) return;
        setFetched({ rule: picked, suggestion });
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setError(toHubError(e));
      },
    );
    // The latest pick is the one that counts: an older answer is dropped by the sequence.
    return () => {
      seq.current += 1;
    };
  }, [picked, need]);

  const pick = (rule: number | null): void => {
    setTouched(rule);
    setError(null);
  };
  return { mode: choice === null ? 'none' : choice.kind === 'one' ? 'known' : 'ask', choice, picked, pick, suggestion: known, busy: need && error === null, error };
}
