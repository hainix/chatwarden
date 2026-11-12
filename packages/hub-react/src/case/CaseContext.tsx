import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { holderOf } from '../claims.js';
import type { Holder } from '../claims.js';
import { useHub } from '../context.js';
import { hasLeft, useDecisions } from '../decisions.js';
import type { DecisionEntry } from '../decisions.js';
import { peopleOfReport } from '../excerpt.js';
import type { ReportPerson } from '../excerpt.js';
import { useHubData } from '../hooks.js';
import type { HubData } from '../hooks.js';
import { useOptionalQueue } from '../liveQueue.js';
import { nextOpenReport } from '../queue.js';
import type { NextReport, QueueGroup } from '../queue.js';
import type { AiBus, AiCaseApi } from '../ai/api.js';
import type { DecisionForm } from '../decision.js';
import { LazyAiParts } from '../lazyParts.js';
import type { AiReadView, DecideInput, PersonHistory, ReportDetail } from '../types.js';
import { QUICK_ACT_COOLDOWN_MS, hasAged, monotonicNow } from './actGuard.js';
import { useDecisionForm } from './useDecisionForm.js';
import type { DecisionDraft } from './useDecisionForm.js';

// Everything the case pane, the decision bar and the context pane share about the case that is open: the one read of the report
// (audited), the reported person's record, who holds the case, and which blocked lines the moderator has chosen to see.

export interface CaseValue {
  reportId: string;
  /** The one read of this report. A decision does not read it again. */
  detail: HubData<ReportDetail>;
  people: ReportPerson[];
  /** The case in the queue (the reported person's open reports), or null when it is not open any more. */
  group: QueueGroup | null;
  /** The reported person's record, or null when the role cannot read histories. */
  history: HubData<PersonHistory | null> | null;
  /** The same person's next open report (the oldest other one) and how many are left, or null when this is their last. */
  next: NextReport | null;
  /** Who holds the case now. */
  holder: Holder;
  /** What is going on with this report's decision (held, sending, done, failed...), if anything. */
  entry: DecisionEntry | undefined;
  /** The decision was made in this visit and the case is off the screen (waiting or just sent). False for a later visit to a closed case. */
  left: boolean;
  /** The decision form, shared by the transcript's margin boxes and the decision bar. */
  draft: DecisionDraft;
  /** What the AI read of this report, or null (the AI is off, or no read yet). Advice, never a decision. */
  aiRead: AiReadView | null;
  /** What the AI's part of the case published (case/AiCase.tsx): its suggestion, whether it can be accepted, and how. Null until it has, and for a case with no recommendation. */
  aiCase: AiCaseApi | null;
  /** How the AI's part of the case talks to the case: what the form opens with, that it has decided, what it publishes, and the way to the editor. */
  aiBus: AiBus;
  /** What a decision says about the AI read that was shown (the server checks it against the decision), or undefined when none was shown. */
  echo: (accepted: boolean | undefined, form: DecisionForm) => NonNullable<DecideInput['ai']> | undefined;
  /** The case was drawn long enough ago (the quick-act cooldown, on a monotonic clock) for an act key or a quick button to act on it. Read when a key is pressed. */
  settled: () => boolean;
  /** The same, as state, so a button can be drawn disabled for that moment. */
  cooled: boolean;
  /** Blocked words are hidden until shown: for the whole case, or one line. */
  reveal: {
    all: boolean;
    setAll: (on: boolean) => void;
    /** Whether this line's text is on show. */
    shows: (lineId: string) => boolean;
    toggle: (lineId: string) => void;
  };
}

const CaseContext = createContext<CaseValue | null>(null);

export function useCase(): CaseValue {
  const value = useContext(CaseContext);
  if (value === null) throw new Error('useCase must be used inside <CaseProvider>');
  return value;
}

/** Same, for the parts that also show without a case (the context pane on a screen with no case). */
export function useOptionalCase(): CaseValue | null {
  return useContext(CaseContext);
}

/** Loads the case once and shares it. Render it with `key={reportId}` so a new case starts clean. */
export function CaseProvider({ reportId, children }: { reportId: string; children: ReactNode }) {
  const { client, can, me, now } = useHub();
  const queue = useOptionalQueue();
  const decisions = useDecisions();
  const detail = useHubData(`report:${reportId}`, () => client.getReport(reportId));
  const report = detail.data?.report;
  const people = useMemo(() => (report === undefined ? [] : peopleOfReport(report)), [report]);
  const group = queue?.groups.find((g) => g.reportIds.includes(reportId)) ?? null;

  const person = report?.targetPerson ?? null;
  const wantsHistory = can('history.read') && person !== null;
  const history = useHubData<PersonHistory | null>(wantsHistory ? `history:${person}` : 'history:idle', () =>
    wantsHistory ? client.personHistory(person, { limit: 1 }) : Promise.resolve(null),
  );

  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((lineId: string): void => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }, []);

  // When the case was drawn (its read is in), on the monotonic clock: act keys and quick buttons wait a moment after it.
  const [aiCase, setAiCase] = useState<AiCaseApi | null>(null);
  const aiOk = aiCase?.gate?.ok === true;
  const shownAt = useRef<number | null>(null);
  const hasData = detail.data !== undefined;
  if (hasData && shownAt.current === null) shownAt.current = monotonicNow();
  // The AI's suggestion appearing or leaving changes what 1, A and Ctrl+Enter send: the quick-act wait starts again, as for a new case.
  const armedFor = useRef(aiOk);
  if (armedFor.current !== aiOk) {
    armedFor.current = aiOk;
    if (shownAt.current !== null) shownAt.current = monotonicNow();
  }
  // What the buttons are drawn from: set by a timer that re-reads the same guard clock `settled()` reads, never by the timer alone, so a
  // button can only read enabled when the guard would let the click through (they cannot disagree, on a slow machine or in a test that
  // holds the clock). A tick that finds the case not yet old enough waits for what is left.
  const [cooled, setCooled] = useState(false);
  useEffect(() => {
    if (!hasData) return undefined;
    setCooled(false);
    let id: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const shown = shownAt.current;
      if (shown !== null && hasAged(shown)) setCooled(true);
      else id = setTimeout(tick, Math.max(1, shown === null ? QUICK_ACT_COOLDOWN_MS : QUICK_ACT_COOLDOWN_MS - (monotonicNow() - shown)));
    };
    id = setTimeout(tick, QUICK_ACT_COOLDOWN_MS);
    return () => clearTimeout(id);
  }, [hasData, aiOk]);
  const settled = useCallback(() => hasAged(shownAt.current), []);

  const claim = group !== null ? group.claim : (detail.data?.claim ?? null);
  const holder = holderOf(claim, me.actor, now());
  const entry = decisions.entry(reportId);
  // Until the report is loaded it counts as open (the entry then decides); once loaded as closed, a sent decision no longer hides it.
  const left = hasLeft(entry, report === undefined || report.status === 'open');
  // The AI's part of the case (case/AiCase.tsx, a lazy part) tells the form what to open with and publishes what the keys and the buttons need.
  const aiRead = detail.data?.ai ?? null;
  const [aiFirst, setAiFirst] = useState<DecisionForm | null>(null);
  const [aiDecided, setAiDecided] = useState(false);
  const aiBus = useMemo<AiBus>(() => ({ first: setAiFirst, decided: setAiDecided, publish: setAiCase, edit: { current: null }, hidden: { current: false } }), []);
  // A part chunk that never arrives must not hold the form: after a few seconds it opens as the ladder's (a read that lands later takes over, see AiCase).
  const waitsForAi = aiRead?.recommendation != null && !aiDecided;
  useEffect(() => {
    if (!waitsForAi) return undefined;
    const id = setTimeout(() => setAiDecided(true), 4_000);
    return () => clearTimeout(id);
  }, [waitsForAi]);

  const draft = useDecisionForm({ detail: detail.data, people, enabled: report?.status === 'open' && can('reports.decide'), aiFirst, aiDecided });

  const value: CaseValue = {
    reportId,
    detail,
    people,
    group,
    history: wantsHistory ? history : null,
    holder,
    next: report === undefined ? null : nextOpenReport(queue?.groups ?? [], report.targetPerson, reportId, decisions.decidedIds()),
    entry,
    left,
    draft,
    aiRead,
    aiCase,
    aiBus,
    echo: (accepted, form) => (aiCase !== null ? aiCase.echo(accepted, form) : aiRead === null || aiBus.hidden.current ? undefined : { readId: aiRead.id, accepted: false }),
    settled,
    cooled,
    reveal: { all: revealAll, setAll: setRevealAll, shows: (id) => revealAll || revealed.has(id), toggle },
  };
  return (
    <CaseContext.Provider value={value}>
      {children}
      {aiRead?.recommendation != null && <LazyAiParts part="case" onFailed={() => setAiDecided(true)} />}
    </CaseContext.Provider>
  );
}
