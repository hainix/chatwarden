import { useEffect, useMemo, useRef, useState } from 'react';
import { communityRuleLabel, planNotices } from '@chatwarden/core/notice-copy';
import type { NoticeOp, NoticePlan, PlanContext } from '@chatwarden/core/notice-copy';
import { useHub } from '../context.js';
import { useFeatures } from '../features.js';
import { useHubData } from '../hooks.js';
import type { PolicyDocs } from '../types.js';

// The data behind the "What the player sees" panel (design 4.6): the plan's context (the kit's own settings, the rules' titles, the time) and the plan itself,
// recomputed on every change. Everything here reads what the hub already reads; nothing is sent and nothing is stored.

const MINUTE = 60_000;
/** A polite sentence is said once the form has been still for this long. */
export const ANNOUNCE_MS = 600;

/** The time now, set again each minute while the panel is open, so an end ("in 24 hours") moves with the clock. */
export function useMinuteClock(): () => number {
  const { now } = useHub();
  const [at, setAt] = useState(() => now());
  useEffect(() => {
    const id = setInterval(() => setAt(now()), MINUTE);
    return () => clearInterval(id);
  }, [now]);
  return useMemo(() => () => at, [at]);
}

/**
 * What the plan needs from the hub: whether appeals are on, whether a reporter is thanked, the rules' titles, and the placeholder for a reference code.
 * `ready` is false until the policy (the source of the rules' titles) has answered, so a label is never drawn without its title and then changed; a policy
 * that cannot be read (a role without `policy.read`, or an error) is ready at once and the labels read by number alone.
 */
export function usePlanContext(): PlanContext & { ready: boolean } {
  const { t, can, session } = useHub();
  const { appeals } = useFeatures();
  const wants = can('policy.read');
  const policy = useHubData<PolicyDocs | null>(wants ? 'policy' : 'policy:idle', () => (wants ? session.policy() : Promise.resolve(null)));
  const clock = useMinuteClock();
  const titles = useMemo(() => new Map((policy.data?.rules ?? []).map((r) => [r.number, r.title] as const)), [policy.data]);
  // The kit thanks a reporter by default; a server that does not say (or a role that cannot read the policy) is read as the default.
  const reporterFeedback = policy.data?.notices.reporterFeedback ?? true;
  const refCode = t('hub.preview.refMade');
  const ready = !wants || !policy.loading;
  return useMemo(
    () => ({
      now: clock,
      ruleLabel: (ref) => communityRuleLabel(ref, ref === 'uncovered' ? undefined : titles.get(ref)),
      reporterFeedback,
      appeals,
      refCode,
      ready,
    }),
    [clock, titles, reporterFeedback, appeals, refCode, ready],
  );
}

/**
 * The plan for an op (null while nothing is chosen), with the context it was made in. The time is read when the form changes (and when the minute clock
 * ticks), so an end is worded against the moment the moderator looked, not up to a minute earlier; the plan and the words drawn from it share that one time.
 * The callers build the op afresh in each render, so the hook holds on to the first of equal ops: what is in it, not which object it is, says the form changed.
 */
export function usePlan(op: NoticeOp | null): { plan: NoticePlan | null; ctx: PlanContext; ready: boolean } {
  const { ready, ...base } = usePlanContext();
  const { now } = useHub();
  const key = op === null ? '' : JSON.stringify(op);
  const held = useRef<{ key: string; op: NoticeOp | null }>({ key, op });
  if (held.current.key !== key) held.current = { key, op };
  const stable = held.current.op;
  const at = useMemo(() => now(), [stable, base.now, now]);
  const ctx = useMemo<PlanContext>(() => ({ ...base, now: () => at }), [base.now, base.ruleLabel, base.reporterFeedback, base.appeals, base.refCode, at]);
  const plan = useMemo(() => (stable === null ? null : planNotices(stable, ctx)), [stable, ctx]);
  return { plan, ctx, ready };
}

/**
 * One short sentence for a screen reader, said after a change and not on the first render. It is `sentence` once the form has been still for 600 ms
 * (a change made inside that time restarts the wait), and only when it differs from the one said last. `null` until there is something to say.
 */
export function useAnnouncement(sentence: string, say?: (sentence: string) => void): string | null {
  const [said, setSaid] = useState<string | null>(null);
  const last = useRef(sentence);
  const sayRef = useRef(say);
  sayRef.current = say;
  useEffect(() => {
    // The first render is silent: what is there at the start is not news.
    if (last.current === sentence) return undefined;
    const id = setTimeout(() => {
      last.current = sentence;
      if (sayRef.current === undefined) setSaid(sentence);
      else sayRef.current(sentence);
    }, ANNOUNCE_MS);
    return () => clearTimeout(id);
  }, [sentence]);
  return said;
}
