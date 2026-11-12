import { useEffect, useMemo, useRef } from 'react';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { isWaiting, useDecisions } from '../decisions.js';
import { outcomeChoice, toInput } from '../decision.js';
import type { Choice, DecisionForm } from '../decision.js';
import { personName } from '../excerpt.js';
import { noActionForm, oneClickOf } from '../simple.js';
import type { OneClick } from '../simple.js';
import type { Suggestion } from '../types.js';
import { QUICK_ACT_COOLDOWN_MS, isRepeatClick } from './actGuard.js';
import { useCase } from './CaseContext.js';
import { useRulePick } from './useRulePick.js';
import type { RulePick } from './useRulePick.js';

// What a case offers as one tap: the suggested step, "nothing wrong here", and a warning when the ladder suggests more. The Simple
// card and the Detailed decision bar both read it, so there is one rule for what is offered, when it may be sent, and where the
// moderator goes next. Every send hands a form to the same hold the decision bar uses (the five second Undo, the claim given back on
// Undo) and then goes on to the person's next open report, else Take next, else the team view.

/** The uid of the one action a one-click decision holds. */
const UID = 'a1';

export { QUICK_ACT_COOLDOWN_MS };

export type QuickKind = 'primary' | 'none' | 'warning';

// The button that last sent a report's quick action, kept so that Undo (which shows the case again in a new view) can put focus back
// on it. Taken once.
const lastSent = new Map<string, QuickKind>();
const LAST_SENT_MAX = 50;
/** Remembers the button that sent a report's quick action (the AI's accept uses it too), so Undo can put focus back on it. */
export function rememberQuick(reportId: string, kind: QuickKind): void {
  if (lastSent.size >= LAST_SENT_MAX) lastSent.clear();
  lastSent.set(reportId, kind);
}

/** The button that sent this report's last quick action, once; undefined when it was not a quick action. */
export function takeLastQuick(reportId: string): QuickKind | undefined {
  const kind = lastSent.get(reportId);
  lastSent.delete(reportId);
  return kind;
}

export interface QuickActions {
  /** The case is open, loaded, fresh, editable, not read-only and nothing is waiting: a quick action may be sent. */
  usable: boolean;
  /** The suggested step, or null when the card must not offer one. */
  primary: OneClick | null;
  /** A warning, when the ladder suggests something harsher. */
  warning: OneClick | null;
  /** The case is old enough (the quick-act cooldown) for a button to be drawn enabled. */
  cooled: boolean;
  /** 1 and Ctrl+Enter: the suggested step, then the next case. Given a click, a repeat click (the second of a double click) is ignored. */
  sendPrimary: (click?: { detail?: number }) => void;
  /** 2 and the button: "nothing wrong here" with no reason, then the next case. */
  sendDismiss: (click?: { detail?: number }) => void;
  /** 3: a warning, then the next case. */
  sendWarning: (click?: { detail?: number }) => void;
  /** The case's read is current (no newer report has arrived since). */
  fresh: boolean;
  /** The AI's suggestion can be accepted: 1, A and Ctrl+Enter on a card send it (`sendPrimary`) in place of the ladder's step. */
  aiOk: boolean;
  /** Which rule the card works from, for the rule field and "Something else". */
  pick: RulePick;
  suggest: Suggestion | undefined;
  choice: Choice | null;
}

export interface QuickActionsOptions {
  /**
   * Work out the suggested step and the warning (needs the rules and the rule pick). Off, only "nothing wrong here" is offered: for a
   * part that has just the dismiss button and no keys. Default true.
   */
  enabled?: boolean;
  /** Something else is going on in the case (the card's "Something else" is open): nothing is usable. */
  paused?: boolean;
  /** Read the case again when a newer report arrives (one part of a case does it, not each). Default false. */
  refresh?: boolean;
}

/** A form without its action ids, to tell whether the moderator has changed it. */
export const shapeOf = (form: DecisionForm): string => JSON.stringify({ verdict: form.verdict, reason: form.reason, actions: form.actions.map((a) => ({ ...a, uid: '' })) });

/** The quick actions of the open case. Used inside `<CaseProvider>`. */
export function useQuickActions({ enabled = true, paused = false, refresh = false }: QuickActionsOptions = {}): QuickActions {
  const { t, can } = useHub();
  const c = useCase();
  const decisions = useDecisions();
  const actions = useCaseActions();
  const { detail, entry, holder, people, group, left, draft } = c;
  const report = detail.data?.report;
  const status = entry?.state.status;
  const open = report?.status === 'open';
  const waiting = isWaiting(entry);
  const readOnly = holder.kind === 'other';
  const editable = open && can('reports.decide') && draft.status === 'ready' && !waiting && status !== 'done' && status !== 'conflict';

  const pick = useRulePick({
    detail: detail.data,
    reasons: draft.reportReasons,
    active: draft.rules.map((r) => r.number),
    enabled: enabled && draft.rulesState === 'ok' && can('sanctions.apply'),
  });

  // The suggestion and the rule come from the read of the case. A newer report about the person means the ladder may have moved
  // (and the case with it), so the case is read again, and until that read is in, one tap offers nothing it could send stale.
  // A decision of your own that is on its way changes the count too: that is not news, so it reads nothing.
  const count = group?.reports ?? null;
  const readAt = useRef<number | null>(count);
  const behind = refresh && readAt.current !== null && count !== null && readAt.current !== count;
  const fresh = !behind && !detail.loading;
  const settled = useRef(left);
  settled.current = left;
  useEffect(() => {
    if (!refresh || count === null) return;
    const before = readAt.current;
    readAt.current = count;
    if (before !== null && before !== count && !settled.current) detail.reload();
  }, [count, refresh]);

  const usable = editable && !readOnly && !paused && fresh;

  const suggest = pick.mode === 'none' ? detail.data?.suggest : (pick.suggestion ?? undefined);
  const ruleCited = pick.mode === 'none' ? detail.data?.rule : pick.picked;
  const choice = suggest === undefined ? null : outcomeChoice(suggest.outcome);
  const primary: OneClick | null = useMemo(
    () =>
      !enabled || suggest === undefined || detail.data === undefined || ruleCited === undefined || ruleCited === null
        ? null
        : oneClickOf(draft.ctx, draft.rules, suggest.outcome, ruleCited, detail.data.report.lineId, UID),
    [enabled, draft.ctx, draft.rules, suggest, detail.data, ruleCited],
  );
  // The light tap: when the ladder suggests more than a warning, a warning is one tap too (same hold, same Undo, the rule's title as the reason).
  const warning: OneClick | null = useMemo(
    () =>
      !enabled || detail.data === undefined || choice === null || choice.kind === 'warning' || choice.kind === 'note' || ruleCited === undefined || ruleCited === null
        ? null
        : oneClickOf(draft.ctx, draft.rules, 'warning', ruleCited, detail.data.report.lineId, UID),
    [enabled, draft.ctx, draft.rules, choice, detail.data, ruleCited],
  );

  const target = people.find((p) => p.role === 'target');
  const name = target === undefined ? '' : personName(target, people, t);

  /** Hands a form to the hold and goes on. Nothing is sent unless the case is usable. */
  const send = (form: DecisionForm, kind: QuickKind, click?: { detail?: number }): void => {
    // Keys and clicks alike: the case must have aged, and the second click of a double click is the first one's echo.
    if (!usable || report === undefined || !c.settled() || isRepeatClick(click)) return;
    rememberQuick(report.id, kind);
    const ai = c.echo(false, form);
    const input = toInput(form);
    decisions.submit({ reportId: report.id, person: report.targetPerson, name, input: ai === undefined ? input : { ...input, ai }, snapshot: form });
    void actions.continueFrom({ reportId: report.id, person: report.targetPerson }, { quick: true });
  };

  return {
    usable,
    primary,
    warning,
    fresh,
    pick,
    suggest,
    choice,
    cooled: c.cooled,
    aiOk: c.aiCase?.gate?.ok === true,
    sendPrimary: (click) => (c.aiCase?.gate?.ok === true ? c.aiCase.accept(click) : primary !== null && send(primary.form, 'primary', click)),
    sendDismiss: (click) => send(noActionForm(), 'none', click),
    sendWarning: (click) => warning !== null && send(warning.form, 'warning', click),
  };
}
