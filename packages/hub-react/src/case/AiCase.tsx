import { useEffect, useMemo, useRef, useState } from 'react';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { isWaiting, useDecisions } from '../decisions.js';
import { initialForm, outcomeChoice, toInput } from '../decision.js';
import type { AiFromState, DecisionForm, FormSource } from '../decision.js';
import { isTypingTarget, modalIn } from '../dom.js';
import { personName } from '../excerpt.js';
import { useKeyListener } from '../keyScope.js';
import { useQuickKeys } from '../quickKeys.js';
import type { AiCaseApi } from '../ai/api.js';
import { useAiHidden } from '../ai/hide.js';
import { AI_KEYS, gateOf, prefillFrom } from '../ai/offer.js';
import { actsBlocked, isRepeatClick } from './actGuard.js';
import { useCase } from './CaseContext.js';
import { rememberQuick, shapeOf } from './useQuickActions.js';

// The AI's part of a case that carries a recommendation (level 2). A lazy part: a hub with the AI off never loads it. It tells the decision
// form what to open with (the AI's suggestion, or the ladder's when the AI is not sure or the moderator hid it), notices when the moderator changes
// it, keeps it current when a newer read arrives while it is untouched, and publishes what the buttons and keys need: whether the suggestion can
// be accepted with one key (and why not), how to send it, and what a decision says about the read that was shown. It renders nothing.
//
// "Edited" is told by identity: the form the suggestion was made into is one object, and every change to the form, even pressing 1 when Fair is
// already chosen, makes another.

export function AiCase() {
  const c = useCase();
  const { can, shortcuts, t } = useHub();
  const decisions = useDecisions();
  const actions = useCaseActions();
  const listen = useKeyListener();
  const keysOn = useQuickKeys().on;
  const { draft, detail, entry, holder, people, aiBus } = c;
  const data = detail.data;
  const report = data?.report;
  const [hidden] = useAiHidden(c.reportId);
  const read = hidden ? null : (data?.ai ?? null);

  const [aiFrom, setAiFrom] = useState<AiFromState | null>(null);
  // The form the suggestion became (or the ladder's, when there was none): any other object is the moderator's.
  const [adopted, setAdopted] = useState<DecisionForm | null>(null);
  const decided = useRef(false);
  const seen = useRef(false);

  /** The suggestion, as the read is now, made into a form with a fresh action id. */
  const make = (): AiFromState | null => (data === undefined ? null : prefillFrom(draft.ctx, draft.rules, read, data.rule, draft.newUid()));
  /** Opens the form as the suggestion, and asks the ladder what it gives for the AI's level, so "Add suggested step" is the ladder's for that level. */
  const take = (from: AiFromState, replace: boolean): void => {
    if (replace) draft.adopt(from.form);
    setAiFrom(from);
    setAdopted(from.form);
    draft.setAddHint(from.rule === '' ? null : { rule: from.rule, lines: from.lines });
    const ladder = data === undefined ? null : outcomeChoice(data.suggest.outcome);
    const step = from.choice ?? from.held;
    if (step !== null && !(ladder !== null && ladder.kind === step.kind && ladder.durationMs === step.durationMs)) draft.askLevel(from.severity, from.rule === '' ? null : from.rule);
  };

  // First, before the form exists: what the case opens with.
  useEffect(() => {
    if (decided.current || !draft.wantsAi || draft.status !== 'loading' || draft.rulesState === 'loading' || data === undefined) return;
    decided.current = true;
    const from = make();
    if (from !== null) take(from, false);
    aiBus.first(from === null ? null : from.form);
    aiBus.decided(true);
  }, [draft.status, draft.rulesState, draft.wantsAi, data]);

  // After it exists: a form that came back from an Undo is still the suggestion (the same shape); a read that arrives later (the case opened before it
  // was made, or this part loaded after the form), or a newer one, takes over a form nobody has touched. A form the moderator has changed is never
  // replaced: the bar then says Edited.
  const ladder = useRef<DecisionForm | null>(null);
  useEffect(() => {
    if (draft.status !== 'ready' || data === undefined || report === undefined) return;
    if (!seen.current) {
      seen.current = true;
      if (aiFrom !== null) {
        if (draft.form !== adopted && shapeOf(draft.form) === aiFrom.shape) setAdopted(draft.form);
        return;
      }
      const fresh = initialForm(draft.ctx, data.suggest.outcome, data.rule, report.lineId, 'x');
      ladder.current = shapeOf(draft.form) === shapeOf(fresh) ? draft.form : null;
    }
    if (read === null || read.recommendation === null) return;
    const untouched = aiFrom === null ? ladder.current !== null && draft.form === ladder.current : draft.form === adopted && aiFrom.readId !== read.id;
    if (aiFrom !== null && !untouched) return;
    const from = make();
    if (from !== null) take(from, untouched);
  }, [read?.id, draft.status]);

  const source: FormSource = aiFrom === null ? 'ladder' : draft.form === adopted ? 'ai' : 'edited';
  const open = report?.status === 'open';
  const status = entry?.state.status;
  const usable =
    open && can('reports.decide') && draft.status === 'ready' && !isWaiting(entry) && status !== 'done' && status !== 'conflict' && holder.kind !== 'other' && !detail.loading;
  const gate = aiFrom !== null && read !== null ? gateOf({ from: aiFrom, source, read, ctx: draft.ctx, rulesState: draft.rulesState, mayApply: can('sanctions.apply'), heldByOther: holder.kind === 'other' }) : null;
  const target = people.find((p) => p.role === 'target');

  // What the callbacks below read: always the latest, so the published object only changes when what the buttons draw does.
  const live = useRef({ c, read, aiFrom, source, usable, gate, level: draft.level, keysOn: shortcuts && keysOn, name: target === undefined ? '' : personName(target, people, t) });
  live.current = { c, read, aiFrom, source, usable, gate, level: draft.level, keysOn: shortcuts && keysOn, name: target === undefined ? '' : personName(target, people, t) };

  const api = useMemo<AiCaseApi>(() => {
    const echo: AiCaseApi['echo'] = (accepted, sent) => {
      const L = live.current;
      if (L.read === null) return undefined;
      const yes = accepted ?? L.source === 'ai';
      // A dismissal that is not the AI's own carries no conduct level of its own (the server files it as banter).
      const dismissed = sent.verdict === 'not_a_problem' || sent.verdict === 'bad_faith';
      const severity = dismissed && !yes ? undefined : (L.level ?? (yes && L.aiFrom !== null ? L.aiFrom.severity : undefined));
      return { readId: L.read.id, accepted: yes, ...(severity === undefined ? {} : { severity }) };
    };
    const accept: AiCaseApi['accept'] = (click) => {
      const L = live.current;
      const rep = L.c.detail.data?.report;
      if (L.gate?.ok !== true || L.aiFrom === null || !L.usable || rep === undefined || !L.c.settled() || isRepeatClick(click)) return;
      rememberQuick(rep.id, 'primary');
      const input = toInput(L.aiFrom.form);
      decisions.submit({ reportId: rep.id, person: rep.targetPerson, name: L.name, input: { ...input, ai: echo(true, L.aiFrom.form) as NonNullable<typeof input.ai> }, snapshot: L.aiFrom.form });
      void actions.continueFrom({ reportId: rep.id, person: rep.targetPerson }, { quick: true });
    };
    return { from: aiFrom, gate, source, usable, accept, echo };
  }, [aiFrom, gate?.ok, gate !== null && !gate.ok ? gate.why : '', source, usable]);
  useEffect(() => aiBus.publish(api), [api]);
  useEffect(() => () => aiBus.publish(null), []);

  // A accepts, E opens the editor: where Quick keys act (on in Simple, off in Detailed), through the act guard, never while typing.
  useEffect(() => {
    if (!shortcuts) return undefined;
    return listen((e, hub) => {
      const L = live.current;
      if (e.defaultPrevented || e.isComposing || e.repeat || !L.usable || !L.keysOn || L.aiFrom === null) return;
      if (e.ctrlKey || e.metaKey || e.altKey || modalIn(hub) !== null || isTypingTarget(e)) return;
      const key = e.key.toLowerCase();
      if (key !== AI_KEYS.accept && key !== AI_KEYS.edit) return;
      if (!L.c.settled() || actsBlocked(hub)) return;
      e.preventDefault();
      if (key === AI_KEYS.edit) aiBus.edit.current?.();
      else api.accept();
    });
  }, [shortcuts, api]);

  return null;
}
