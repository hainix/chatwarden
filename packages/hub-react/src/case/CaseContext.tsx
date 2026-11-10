import { createContext, useCallback, useContext, useMemo, useState } from 'react';
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
import type { QueueGroup } from '../queue.js';
import type { PersonHistory, ReportDetail } from '../types.js';
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
  /** Who holds the case now. */
  holder: Holder;
  /** What is going on with this report's decision (held, sending, done, failed...), if anything. */
  entry: DecisionEntry | undefined;
  /** The decision was made in this visit and the case is off the screen (waiting or just sent). False for a later visit to a closed case. */
  left: boolean;
  /** The decision form, shared by the transcript's margin boxes and the decision bar. */
  draft: DecisionDraft;
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

/** The open case. Throws outside `<CaseProvider>`. */
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

  const claim = group !== null ? group.claim : (detail.data?.claim ?? null);
  const holder = holderOf(claim, me.actor, now());
  const entry = decisions.entry(reportId);
  // Until the report is loaded it counts as open (the entry then decides); once loaded as closed, a sent decision no longer hides it.
  const left = hasLeft(entry, report === undefined || report.status === 'open');
  const draft = useDecisionForm({ detail: detail.data, people, enabled: report?.status === 'open' && can('reports.decide') });

  const value: CaseValue = {
    reportId,
    detail,
    people,
    group,
    history: wantsHistory ? history : null,
    holder,
    entry,
    left,
    draft,
    reveal: { all: revealAll, setAll: setRevealAll, shows: (id) => revealAll || revealed.has(id), toggle },
  };
  return <CaseContext.Provider value={value}>{children}</CaseContext.Provider>;
}
