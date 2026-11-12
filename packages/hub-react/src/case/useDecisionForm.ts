import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { useDecisions } from '../decisions.js';
import {
  LINES_MAX,
  MAX_ACTIONS,
  addAction,
  dropTargetActions,
  emptyForm,
  defaultLines,
  initialForm,
  outcomeChoice,
  presets,
  resolveDraft,
  validate,
  whyNotAdded,
  withSuggestion,
} from '../decision.js';
import type { Choice, DecisionForm, Draft, NotAdded, Problems, UiVerdict, ValidationContext } from '../decision.js';
import type { ReportPerson } from '../excerpt.js';
import { useHubData } from '../hooks.js';
import type { HubData } from '../hooks.js';
import { outcomeLabel } from '../labels.js';
import { lengthsOf } from '../policy/lengths.js';
import type { LengthPolicy } from '../policy/lengths.js';
import type { ConductLevel, PolicyDocs, ReportDetail, Suggestion } from '../types.js';

// The decision form's state, kept above both the transcript (its margin boxes pick the lines the player sees) and the decision
// bar. It starts from what the ladder suggests (so most decisions are a verdict, a reason and one key) and gives back the form
// as it was after an Undo or a failed send.

export type RulesState = 'loading' | 'ok' | 'denied' | 'failed';

export interface Announcement {
  text: string;
  /** Changes on every announcement, so the same words said twice are heard twice. */
  n: number;
}

const NO_PROBLEMS: Problems = { actions: {}, count: 0 };

export interface DecisionDraft {
  /** `loading` until the rules are known; `ready` once the form exists. */
  status: 'loading' | 'ready';
  form: DecisionForm;
  setForm: (update: (form: DecisionForm) => DecisionForm) => void;
  ctx: ValidationContext;
  problems: Problems;
  rules: ReadonlyArray<{ number: number; title: string }>;
  /** The reporting reasons and the rules each usually means, or undefined until the policy is read (or when the kit sends none). */
  reportReasons: ReadonlyArray<{ id: string; rules: readonly number[] }> | undefined;
  /** Whether the rules are loaded; a verdict can still be sent without them (no actions). */
  rulesState: RulesState;
  rulesError: HubError | null;
  reloadRules: () => void;
  /** What the "What happens" menu offers. */
  choices: Choice[];
  /** The lengths the profile offers (and whether a custom one is allowed), or undefined until the policy is read. */
  lengths: LengthPolicy | undefined;
  suggestion: Suggestion;
  level: ConductLevel | null;
  /** A level was picked and its answer has not come back. */
  levelBusy: boolean;
  levelError: HubError | null;
  pickLevel: (level: ConductLevel) => void;
  /** Why the suggestion cannot be added as an action, or null when it can. */
  cannotAdd: NotAdded | null;
  /** The suggested outcome is already an action of the reported person (same kind and length). */
  suggestionIndex: number;
  useSuggestion: () => void;
  setVerdict: (verdict: UiVerdict) => void;
  patchAction: (uid: string, patch: Partial<Draft>) => void;
  toggleLine: (uid: string, lineId: string) => void;
  addEmptyAction: () => string | null;
  removeAction: (uid: string, n: number) => void;
  announcement: Announcement;
  announce: (text: string) => void;
  /** The action whose lines the transcript's margin boxes edit: the reported person's first action that shows lines. */
  primary: Draft | null;
  /** The AI level the hub is set to (0 off, 1 read, 2 recommend), from the policy; 0 when the role cannot read it. A hint that a read is on its way, nothing more. */
  aiLevel: number;
}

/**
 * The form for the open report. `enabled` is false for a closed report or a role that cannot decide: then nothing is read, and
 * `status` stays `loading` (the bar shows its own message).
 */
export function useDecisionForm({ detail, people, enabled }: { detail: ReportDetail | undefined; people: ReportPerson[]; enabled: boolean }): DecisionDraft {
  const { t, locale, can, session, client } = useHub();
  const decisions = useDecisions();
  const report = detail?.report;

  const canRules = can('policy.read');
  const wantsRules = enabled && canRules && report !== undefined;
  const policy: HubData<PolicyDocs | null> = useHubData<PolicyDocs | null>(wantsRules ? 'policy' : 'policy:idle', () => (wantsRules ? session.policy() : Promise.resolve(null)));
  const rulesState: RulesState = !canRules ? 'denied' : policy.data !== undefined ? 'ok' : policy.error !== null ? 'failed' : 'loading';
  const rules = useMemo(
    () => (policy.data?.rules ?? []).filter((r) => r.retired !== true).sort((a, b) => a.number - b.number).map((r) => ({ number: r.number, title: r.title })),
    [policy.data],
  );

  const reportReasons = useMemo(() => policy.data?.profile.reporting?.reasons.map((r) => ({ id: r.id, rules: r.rules })), [policy.data]);

  const canApply = can('sanctions.apply') && rulesState === 'ok';
  const canPermanent = can('sanctions.apply.ban_permanent');
  const target = report?.targetPerson ?? '';

  const ctx: ValidationContext = useMemo(
    () => ({
      target,
      people: people.map((p) => p.ref),
      rules: rules.map((r) => r.number),
      canApply,
      canPermanent,
      ownLineIds: report?.ownLineIds ?? {},
    }),
    [target, people, rules, canApply, canPermanent, report?.ownLineIds],
  );

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [level, setLevel] = useState<ConductLevel | null>(null);
  const [levelBusy, setLevelBusy] = useState(false);
  const [levelError, setLevelError] = useState<HubError | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement>({ text: '', n: 0 });
  const [formState, setFormState] = useState<DecisionForm | null>(null);
  const uids = useRef(0);
  const levelSeq = useRef(0);
  // Whether the suggestion's action was taken off by a verdict that cannot act on the reported person (it comes back with "fair").
  const dropped = useRef(false);

  const announce = useCallback((text: string): void => setAnnouncement((a) => ({ text, n: a.n + 1 })), []);
  const nextUid = useCallback((): string => {
    uids.current += 1;
    return `a${uids.current}`;
  }, []);

  const current = suggestion ?? detail?.suggest;
  const reportedLine = report?.lineId ?? null;

  // The form, once the rules are known (or known to be unavailable). After an Undo or a failed send, the form as it was.
  const ready = enabled && report !== undefined && detail !== undefined && rulesState !== 'loading';
  useEffect(() => {
    if (!ready || formState !== null || detail === undefined) return;
    const before = decisions.entry(detail.report.id);
    if (before !== undefined && (before.state.status === 'failed' || before.state.status === 'undone')) {
      uids.current = Math.max(uids.current, ...before.snapshot.actions.map((a) => Number(a.uid.slice(1)) || 0));
      setFormState(before.snapshot);
      if (before.state.status === 'undone') decisions.dismiss(before.reportId);
      return;
    }
    setFormState(initialForm(ctx, detail.suggest.outcome, detail.rule, reportedLine, nextUid()));
  }, [ready]);

  // The entry for this report: after an Undo the snapshot has been taken back (nothing stale is left to be restored over newer
  // edits), and when a send fails while the form is up, the form is what it was when Decide was pressed.
  const entryState = detail === undefined ? undefined : decisions.entry(detail.report.id);
  const entryStatus = entryState?.state.status;
  useEffect(() => {
    if (formState === null || entryState === undefined) return;
    if (entryStatus === 'undone') decisions.dismiss(entryState.reportId);
    else if (entryStatus === 'failed') setFormState(entryState.snapshot);
    // Only when the entry's state changes.
  }, [entryStatus]);

  // The rules came in after the form started without them (a retry worked): fill in the suggestion if nothing was touched yet.
  useEffect(() => {
    if (rulesState !== 'ok' || formState === null || detail === undefined) return;
    if (formState.verdict !== null || formState.reason !== '' || formState.actions.length > 0) return;
    const next = initialForm(ctx, detail.suggest.outcome, detail.rule, reportedLine, nextUid());
    if (next.actions.length > 0) setFormState(next);
  }, [rulesState]);

  const formRef = useRef<DecisionForm | null>(formState);
  formRef.current = formState;
  const form = formState ?? emptyForm();
  const setForm = useCallback((update: (f: DecisionForm) => DecisionForm): void => setFormState((f) => update(f ?? emptyForm())), []);
  const problems = formState === null ? NO_PROBLEMS : validate(formState, ctx);

  const choices = useMemo(() => {
    const suggested = current === undefined ? null : outcomeChoice(current.outcome);
    return presets(policy.data?.profile ?? {}, suggested === null ? [] : [suggested]);
  }, [policy.data, current]);

  const lengths = useMemo(() => lengthsOf(policy.data?.profile), [policy.data]);

  const suggestionChoice = current === undefined ? null : outcomeChoice(current.outcome);
  const suggestionIndex =
    suggestionChoice === null
      ? -1
      : form.actions.findIndex((a) => {
          const c = resolveDraft(a);
          return a.person === target && c !== null && c.kind === suggestionChoice.kind && c.durationMs === suggestionChoice.durationMs;
        });
  const cannotAdd: NotAdded | null = current === undefined || formState === null ? 'none' : whyNotAdded(formState, ctx, current.outcome);

  const primary = useMemo<Draft | null>(() => {
    for (const a of form.actions) {
      const c = resolveDraft(a);
      if (a.person === target && c !== null && c.kind !== 'note') return a;
    }
    return null;
  }, [form.actions, target]);

  // Not an updater: React may run an updater twice (StrictMode) and keeps the second result, so nothing here may touch a ref, make
  // an id or announce from inside one. The form is read from the ref (the latest committed or queued one) and set once.
  const setVerdict = useCallback(
    (verdict: UiVerdict): void => {
      const base = formRef.current ?? emptyForm();
      let next: DecisionForm = { ...base, verdict };
      if (verdict === 'fair') {
        // Back to fair: the suggestion that a dismissal took off comes back.
        if (dropped.current && base.actions.length === 0 && detail !== undefined) {
          dropped.current = false;
          next = { ...next, actions: initialForm(ctx, detail.suggest.outcome, detail.rule, reportedLine, nextUid()).actions };
        }
      } else {
        const result = dropTargetActions(next, ctx.target);
        if (result.dropped > 0) {
          dropped.current = true;
          announce(t('hub.decide.announce.dropped', { count: result.dropped }));
        }
        next = result.form;
      }
      formRef.current = next;
      setFormState(next);
    },
    [announce, ctx, detail, nextUid, reportedLine, t],
  );

  /** Asks the ladder again: for another conduct level, and for the rule the reported person's action cites. The latest ask wins. */
  const ask = useCallback(
    (picked: ConductLevel | null, rule: number | null): void => {
      if (report === undefined) return;
      const mine = (levelSeq.current += 1);
      setLevelError(null);
      // The pick shows at once; the answer follows. A slower answer to an earlier ask never replaces a later one.
      const before = levelRef.current;
      if (picked !== null) setLevel(picked);
      setLevelBusy(true);
      const input = { level: picked, person: report.targetPerson, ...(rule === null ? {} : { rule }) };
      client.suggest(report.id, input).then(
        (answer) => {
          if (mine !== levelSeq.current) return;
          setSuggestion(answer);
          setLevelBusy(false);
          announce(t('hub.decide.suggest.updated', { label: outcomeLabel(t, locale, answer.outcome) }));
        },
        (e: unknown) => {
          if (mine !== levelSeq.current) return;
          setLevelBusy(false);
          // The suggestion did not change, so the pick that was meant to change it is taken back.
          setLevel(before);
          setLevelError(toHubError(e));
        },
      );
    },
    [announce, client, locale, report, t],
  );
  const levelRef = useRef(level);
  levelRef.current = level;

  const patchAction = useCallback(
    (uid: string, patch: Partial<Draft>): void => {
      setFormState((f) => (f === null ? f : { ...f, actions: f.actions.map((a) => (a.uid === uid ? { ...a, ...patch } : a)) }));
      // The suggestion depends on the rule cited (a severe rule reads the severe column): citing another rule on the reported
      // person's action asks the ladder again.
      if (patch.rule !== undefined && uid === primary?.uid && /^[1-9]\d*$/.test(patch.rule)) ask(levelRef.current, Number(patch.rule));
    },
    [ask, primary?.uid],
  );
  const toggleLine = useCallback((uid: string, lineId: string): void => {
    setFormState((f) =>
      f === null
        ? f
        : {
            ...f,
            actions: f.actions.map((a) => {
              if (a.uid !== uid) return a;
              if (a.lineIds.includes(lineId)) return { ...a, lineIds: a.lineIds.filter((x) => x !== lineId) };
              return a.lineIds.length >= LINES_MAX ? a : { ...a, lineIds: [...a.lineIds, lineId] };
            }),
          },
    );
  }, []);

  const addEmptyAction = useCallback((): string | null => {
    if (formState === null || !ctx.canApply || formState.actions.length >= MAX_ACTIONS || detail === undefined) return null;
    const uid = nextUid();
    setFormState(addAction(formState, ctx, detail.rule, uid));
    announce(t('hub.decide.announce.added', { n: formState.actions.length + 1 }));
    return uid;
  }, [announce, ctx, detail, formState, nextUid, t]);

  const removeAction = useCallback(
    (uid: string, n: number): void => {
      setFormState((f) => (f === null ? f : { ...f, actions: f.actions.filter((a) => a.uid !== uid) }));
      announce(t('hub.decide.announce.removed', { n }));
    },
    [announce, t],
  );

  const useSuggestion = useCallback((): void => {
    if (formState === null || current === undefined || detail === undefined) return;
    const lines = defaultLines(ctx.ownLineIds[target] ?? [], reportedLine);
    const next = withSuggestion(formState, ctx, current.outcome, detail.rule, nextUid(), lines);
    if (next === null) return;
    setFormState(next);
    announce(formState.verdict === null ? t('hub.decide.announce.addedFair', { n: next.actions.length }) : t('hub.decide.announce.added', { n: next.actions.length }));
  }, [announce, ctx, current, detail, formState, nextUid, reportedLine, t, target]);

  const pickLevel = useCallback(
    (picked: ConductLevel): void => ask(picked, primary !== null && /^[1-9]\d*$/.test(primary.rule) ? Number(primary.rule) : null),
    [ask, primary],
  );

  return {
    status: formState === null ? 'loading' : 'ready',
    form,
    setForm,
    ctx,
    problems,
    rules,
    reportReasons,
    rulesState,
    rulesError: policy.error,
    reloadRules: policy.reload,
    choices,
    lengths,
    suggestion: current ?? ({ outcome: 'none', why: '' } as Suggestion),
    level,
    levelBusy,
    levelError,
    pickLevel,
    cannotAdd,
    suggestionIndex,
    useSuggestion,
    setVerdict,
    patchAction,
    toggleLine,
    addEmptyAction,
    removeAction,
    announcement,
    announce,
    primary,
    aiLevel: (policy.data?.profile as { ai?: { level?: number } } | undefined)?.ai?.level ?? 0,
  };
}
