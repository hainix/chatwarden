import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ReplayIcon } from '../components/Icons';
import './demo.css';
import { CodeDrawer } from './CodeDrawer';
import { CODE_STEPS } from './codeSteps';
import type { DemoEngine, PlayerNotice, SeatState, StaffReport, Suggestion } from './engine';
import { FakeEngine } from './fakeEngine';
import { GamePane } from './GamePane';
import { PauseIcon, PlayIcon, CodeIcon } from './icons';
import { ModPane } from './ModPane';
import type { DecideKind } from './ModPane';
import { ReportDialog } from './ReportDialog';
import { LOOP, NO_NOTICE_HINT, NO_REPORT_HINT, SEED, TOUR_STEPS } from './script';
import type { ScriptLine } from './script';
import { TourCard } from './TourCard';
import type { TourPos } from './TourCard';
import type { FeedItem, PendingBySeat } from './types';
import { useMediaQuery } from './useMediaQuery';

export interface DemoProps {
  /** The engine behind the demo. Defaults to the in-browser stand-in. */
  engine?: DemoEngine;
  /** Whether Ada and Bo chat on their own after the opening conversation. */
  scripted?: boolean;
}

const STACK_QUERY = '(max-width: 899px)';
const FEED_MAX = 60;
const TOTAL = TOUR_STEPS.length;

interface TourState {
  on: boolean;
  /** 0 to 3 for the four steps, 4 when finished. */
  step: number;
  hint: string | null;
}

interface Say {
  id: number;
  text: string;
}

/** Where the tour tooltip for a step points. Falls back to something visible when the target's pane is hidden. */
function findTarget(root: HTMLElement, step: number, paneHidden: { game: boolean; mod: boolean }): HTMLElement | null {
  const visible = (el: HTMLElement | null) => (el !== null && el.closest('[hidden]') === null ? el : null);
  const q = (name: string) => visible(root.querySelector<HTMLElement>(`[data-tour="${name}"]`));
  switch (step) {
    case 0:
      return q('composer') ?? q('tab-game');
    case 1:
      return q('report') ?? q('composer') ?? q('tab-game');
    case 2:
      return q('decide') ?? q('queue-tab') ?? q('tab-mod');
    case 3:
      return q('ack') ?? q('seats') ?? (paneHidden.game ? q('tab-game') : null);
    default:
      return q('queue-tab') ?? q('reset');
  }
}

export default function Demo({ engine: given, scripted = true }: DemoProps) {
  const [engine] = useState<DemoEngine>(() => given ?? new FakeEngine());
  const stacked = useMediaQuery(STACK_QUERY);

  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [seats, setSeats] = useState<SeatState[]>([]);
  const [reports, setReports] = useState<StaffReport[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [pending, setPending] = useState<PendingBySeat>({});
  const [record, setRecord] = useState<PlayerNotice[]>([]);
  const [recordSeat, setRecordSeat] = useState('bo');
  const [modTab, setModTab] = useState<'reports' | 'record'>('reports');
  const [paneTab, setPaneTab] = useState<'game' | 'mod'>('game');
  const [says, setSays] = useState<Say[]>([]);
  const [paused, setPaused] = useState(false);
  const [tour, setTour] = useState<TourState>({ on: true, step: 0, hint: null });
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeStep, setCodeStep] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ item: FeedItem; opener: HTMLElement } | null>(null);
  const [draft, setDraft] = useState('');
  const [composerNote, setComposerNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [pos, setPos] = useState<TourPos | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const tourEl = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const gen = useRef(0);
  const sayId = useRef(0);
  const loopAt = useRef(0);
  const live = useRef({ paused, ready, dialog: false });
  live.current = { paused, ready, dialog: dialog !== null };

  const announce = useCallback((text: string) => {
    sayId.current += 1;
    setSays((s) => [...s.slice(-3), { id: sayId.current, text }]);
  }, []);

  // ---------- reading the engine ----------
  const refresh = useCallback(async () => {
    const g = gen.current;
    const [page, seatStates] = await Promise.all([engine.reports.list({ status: 'open' }), engine.rooms.seats()]);
    const entries = await Promise.all(engine.seats.map(async (s) => [s.id, await engine.notices.pending(s.id)] as const));
    if (!alive.current || g !== gen.current) return;
    setReports(page.items);
    setSeats(seatStates);
    setPending(Object.fromEntries(entries));
    setSelectedId((cur) => (page.items.some((r) => r.id === cur) ? cur : (page.items[0]?.id ?? null)));
  }, [engine]);

  useEffect(() => {
    if (selectedId === null) {
      setSuggestion(null);
      return;
    }
    let stale = false;
    void engine.suggest(selectedId).then((s) => {
      if (!stale) setSuggestion(s);
    });
    return () => {
      stale = true;
    };
  }, [engine, selectedId, reports]);

  useEffect(() => {
    if (modTab !== 'record') return;
    let stale = false;
    void engine.notices.record(recordSeat).then((r) => {
      if (!stale) setRecord(r);
    });
    return () => {
      stale = true;
    };
  }, [engine, modTab, recordSeat, pending, reports]);

  // ---------- the room ----------
  /** Runs one line through the engine and shows it if the visitor would see it. Returns what the engine said. */
  const play = useCallback(
    async (line: ScriptLine, g: number) => {
      const res = await engine.chat.accept(line.seat, line.text);
      if (!alive.current || g !== gen.current) return;
      if ('deliver' in res) {
        const name = engine.seats.find((s) => s.id === line.seat)?.name ?? line.seat;
        const item: FeedItem = { id: res.deliver.lineId, seat: line.seat, name, text: res.deliver.text, you: false, rude: line.rude };
        setFeed((f) => [...f.slice(-(FEED_MAX - 1)), item]);
      }
    },
    [engine],
  );

  const boot = useCallback(async () => {
    const g = ++gen.current;
    setReady(false);
    await engine.reset();
    if (!alive.current || g !== gen.current) return;
    setFeed([]);
    setReports([]);
    setSeats([]);
    setPending({});
    setRecord([]);
    setSelectedId(null);
    loopAt.current = 0;
    for (const line of SEED) {
      if (!alive.current || g !== gen.current) return;
      await play(line, g);
    }
    if (!alive.current || g !== gen.current) return;
    await refresh();
    if (alive.current && g === gen.current) setReady(true);
  }, [engine, play, refresh]);

  useEffect(() => {
    alive.current = true;
    void boot();
    return () => {
      alive.current = false;
      gen.current += 1;
    };
  }, [boot]);

  // The scripted players: one line about every 4 to 6 seconds. They wait while the tab is hidden, while you type, while a
  // dialog is open and while paused.
  useEffect(() => {
    if (!scripted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop = false;
    const schedule = () => {
      timer = setTimeout(() => void tick(), 4000 + Math.random() * 2000);
    };
    const tick = async () => {
      if (stop) return;
      const typing = document.activeElement === inputRef.current && (inputRef.current?.value ?? '') !== '';
      const { paused: p, ready: r, dialog: d } = live.current;
      if (!p && r && !d && !typing && !document.hidden) {
        const line = LOOP[loopAt.current % LOOP.length];
        loopAt.current += 1;
        if (line !== undefined) {
          const g = gen.current;
          await play(line, g);
          const states = await engine.rooms.seats();
          if (!stop && alive.current && g === gen.current) setSeats(states);
        }
      }
      if (!stop) schedule();
    };
    schedule();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [scripted, engine, play]);

  // keep the newest line in view (inside the chat box only, never the page)
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [feed]);

  // ---------- the tour ----------
  const tourEvent = useCallback((index: number) => {
    setTour((t) => (t.on && t.step <= index ? { ...t, step: index + 1, hint: null } : t));
  }, []);

  const tourLineId = (() => {
    if (!tour.on || tour.step !== 1) return null;
    const others = feed.filter((f) => !f.you);
    return ([...others].reverse().find((f) => f.seat === 'bo' && f.rude) ?? [...others].reverse().find((f) => f.seat === 'bo') ?? others[others.length - 1])?.id ?? null;
  })();

  const prevStep = useRef(0);
  useEffect(() => {
    if (!tour.on) return;
    if (prevStep.current === tour.step) return;
    prevStep.current = tour.step;
    const title = tour.step >= TOTAL ? 'Done' : (TOUR_STEPS[tour.step]?.title ?? '');
    const where = stacked && tour.step === 2 ? ' Showing the moderator view.' : '';
    announce(tour.step >= TOTAL ? 'Tour done.' : `Tour step ${tour.step + 1} of ${TOTAL}: ${title}.${where}`);
    setCodeStep(null);
    if (stacked) setPaneTab(tour.step === 2 ? 'mod' : 'game');
  }, [tour.on, tour.step, stacked, announce]);

  // Put a ring on the control the step is about, and the tooltip next to it.
  useLayoutEffect(() => {
    const host = root.current;
    if (host === null) return;
    const marked = host.querySelectorAll('[data-tour-target]');
    const target = tour.on ? findTarget(host, tour.step, { game: stacked && paneTab !== 'game', mod: stacked && paneTab !== 'mod' }) : null;
    for (const el of marked) if (el !== target) el.removeAttribute('data-tour-target');
    if (target === null) {
      setPos((p) => (p === null ? p : null));
      return;
    }
    target.setAttribute('data-tour-target', 'true');
    const card = tourEl.current;
    if (card === null) return;
    const c = host.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const gap = 14;
    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const cx = t.left + t.width / 2 - c.left;
    const cy = t.top + t.height / 2 - c.top;
    // Side by side, sit next to the control, over the other pane's spare room. Otherwise above or below it.
    let side: TourPos['placement'] | null = null;
    if (!stacked && tour.step < TOTAL) {
      const inGame = target.closest('[data-pane="game"]') !== null;
      if (inGame && t.right - c.left + gap + w <= c.width - 8) side = 'right';
      else if (!inGame && t.left - c.left - gap - w >= 8 && target.closest('[data-pane="mod"]') !== null) side = 'left';
    }
    let left: number;
    let top: number;
    let placement: TourPos['placement'];
    const paneRect = target.closest('.pane')?.getBoundingClientRect();
    const floor = paneRect ? Math.min(c.height, paneRect.bottom - c.top) : c.height;
    if (side === 'right') {
      placement = 'right';
      left = t.right - c.left + gap;
      top = clamp(cy - 28, 8, floor - h - 8);
    } else if (side === 'left') {
      placement = 'left';
      left = t.left - c.left - gap - w;
      top = clamp(cy - 28, 8, floor - h - 8);
    } else {
      // Under a chat line's report button, sit below the whole line so its text stays readable.
      const anchor = target.closest('.msg, .pframe');
      const a = anchor?.getBoundingClientRect() ?? t;
      const below = !anchor?.classList.contains('pframe') && (c.bottom - a.bottom >= h + gap + 8 || c.bottom - a.bottom >= a.top - c.top);
      placement = below ? 'below' : 'above';
      top = clamp(below ? a.bottom - c.top + gap : a.top - c.top - h - gap, 8, c.height - h - 8);
      left = clamp(cx - w / 2, 8, c.width - w - 8);
    }
    left = Math.round(left);
    top = Math.round(top);
    const arrowX = Math.round(clamp(cx - left, 20, w - 20));
    const arrowY = Math.round(clamp(cy - top, 20, h - 20));
    const next: TourPos = { left, top, arrowX, arrowY, placement };
    setPos((p) => (p && p.left === next.left && p.top === next.top && p.arrowX === next.arrowX && p.arrowY === next.arrowY && p.placement === next.placement ? p : next));
  });

  useEffect(() => {
    const host = root.current;
    if (host === null) return;
    const again = () => setPos((p) => (p === null ? p : { ...p }));
    window.addEventListener('resize', again);
    host.addEventListener('scroll', again, true); // the chat and the console scroll inside their panes
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    ro?.observe(host);
    return () => {
      window.removeEventListener('resize', again);
      host.removeEventListener('scroll', again, true);
      ro?.disconnect();
    };
  }, []);

  // ---------- actions ----------
  async function send(text: string) {
    const line = text.trim();
    if (line === '') return;
    setComposerNote(null);
    const res = await engine.chat.accept('you', line);
    if (!alive.current) return;
    if ('deliver' in res) {
      setFeed((f) => [...f.slice(-(FEED_MAX - 1)), { id: res.deliver.lineId, seat: 'you', name: 'You', text: res.deliver.text, you: true }]);
      setDraft('');
      inputRef.current?.focus();
      return;
    }
    const why = res.refuse;
    if (why.reason === 'blocked') {
      const rule = why.rule ?? 1;
      setFeed((f) => [...f.slice(-(FEED_MAX - 1)), { id: `refused-${Date.now()}-${f.length}`, seat: 'you', name: 'You', text: line, you: true, refused: { reason: 'blocked', rule } }]);
      setDraft('');
      announce(`Blocked: ${engine.rules.label(rule).split(':')[0]}. Only you see this.`);
      tourEvent(0);
      inputRef.current?.focus();
    } else if (why.reason === 'rate') {
      setComposerNote('Too fast. Wait a moment, then send again.');
      announce('Too fast. Wait a moment, then send again.');
    } else if (why.reason === 'restricted') {
      setComposerNote('You are on a timeout.');
      announce('You are on a timeout.');
    } else if (why.reason === 'length') {
      setComposerNote('That line is too long.');
    }
  }

  function openReport(item: FeedItem, opener: HTMLElement) {
    setDialog({ item, opener });
  }

  async function submitReport(input: { category: StaffReport['category']; note: string }): Promise<string | null> {
    const d = dialog;
    if (d === null) return null;
    const res = await engine.reports.submit({
      reporterSeat: 'you',
      targetSeat: d.item.seat,
      lineId: d.item.id,
      category: input.category,
      note: input.note,
    });
    if (!alive.current) return null;
    if (!res.ok) {
      return {
        duplicate: 'You already reported that line.',
        rate: 'You are out of reports for today.',
        self: 'You cannot report yourself.',
        not_player: 'That line cannot be reported.',
        off: 'Reports are off.',
      }[res.refused];
    }
    setDialog(null);
    await refresh();
    setSelectedId(res.reportId);
    setModTab('reports');
    announce(`Report filed against ${d.item.name}.`);
    tourEvent(1);
    return null;
  }

  async function decide(kind: DecideKind, quoteId: string | null, reason: string) {
    const report = reports.find((r) => r.id === selectedId);
    if (report === undefined || busy) return;
    setBusy(true);
    const rule = suggestion?.rule ?? 2;
    const base = { subject: report.targetPerson, rule, ...(rule === 'uncovered' ? { gapNote: 'Behaviour the rules do not cover yet.' } : {}) };
    const lineIds = quoteId === null ? [] : [quoteId];
    const input =
      kind === 'warning'
        ? { verdict: 'upheld' as const, actions: [{ ...base, kind: 'warning' as const, durationMs: null, lineIds }] }
        : kind === 'timeout'
          ? { verdict: 'upheld' as const, actions: [{ ...base, kind: 'chat' as const, durationMs: 600_000, lineIds }] }
          : kind === 'note'
            ? { verdict: 'noted' as const, actions: [{ ...base, kind: 'note' as const, durationMs: null }] }
            : { verdict: 'no_action' as const, actions: [] };
    const res = await engine.decide({ reportId: report.id, reason: reason.trim() || `Report: ${report.category}`, ...input });
    if (!alive.current) return;
    setBusy(false);
    if (!res.ok) {
      announce('That decision could not be applied.');
      await refresh();
      return;
    }
    const who = report.targetHandle;
    const noticed = res.groups.some((g) => g.noticeId !== null);
    const what = { warning: 'warning', timeout: 'timeout, 10 minutes', note: 'note recorded', none: 'no action' }[kind];
    announce(
      kind === 'none'
        ? 'Decision made: no action. The report is closed.'
        : `Decision made: ${what} for ${who}. ${noticed ? `Notice shown on ${who}'s screen.` : 'The player is told nothing.'}`,
    );
    await refresh();
    if (noticed) {
      tourEvent(2);
    } else {
      const left = reports.filter((r) => r.id !== report.id).length;
      setTour((t) => (t.on && t.step === 2 && left === 0 ? { ...t, step: 1, hint: NO_NOTICE_HINT } : t));
    }
  }

  async function ack(seat: string, notice: PlayerNotice) {
    const name = engine.seats.find((s) => s.id === seat)?.name ?? seat;
    await engine.notices.ack(seat, notice.id);
    if (!alive.current) return;
    announce(`${name} acknowledged the notice.`);
    await refresh();
    tourEvent(3);
  }

  async function reset() {
    setPaused(false);
    setTour({ on: true, step: 0, hint: null });
    prevStep.current = 0;
    setCodeOpen(false);
    setCodeStep(null);
    setDialog(null);
    setDraft('');
    setComposerNote(null);
    setModTab('reports');
    setPaneTab('game');
    setBusy(false);
    setSays([]);
    await boot();
    if (alive.current) announce('Demo reset. The lobby is back to the start.');
  }

  function toggleCode() {
    setCodeOpen((o) => !o);
  }

  // ---------- render ----------
  const stepIndex = Math.min(tour.step, TOTAL - 1);
  const noReports = reports.length === 0;
  const cardTitle = tour.step >= TOTAL ? 'That’s the whole loop' : (TOUR_STEPS[tour.step]?.title ?? '');
  const cardBody =
    tour.step >= TOTAL
      ? 'Chat, refuse, report, decide, notify. Play again from the top, or read the code behind each step.'
      : tour.step === 2 && noReports
        ? NO_REPORT_HINT
        : (TOUR_STEPS[tour.step]?.body ?? '');
  const gameHidden = stacked && paneTab !== 'game';
  const modHidden = stacked && paneTab !== 'mod';

  return (
    <div
      ref={root}
      className={`demo ${stacked ? 'is-stacked' : ''}`}
      role="group"
      aria-label="Chatwarden interactive demo"
    >
      <div className="demo-toolbar" inert={dialog !== null}>
        <div className="demo-tools">
          <button type="button" className="tool" data-tour="reset" onClick={() => void reset()}>
            <ReplayIcon />
            <span>Reset demo</span>
          </button>
          <button type="button" className="tool" onClick={() => setPaused((p) => !p)}>
            {paused ? <PlayIcon /> : <PauseIcon />}
            <span>{paused ? 'Resume chat' : 'Pause chat'}</span>
          </button>
        </div>
        <div className="demo-tools">
          {!tour.on && (
            <>
              <button type="button" className="tool" aria-expanded={codeOpen} aria-controls="demo-code" onClick={toggleCode}>
                <CodeIcon />
                <span>Show me the code</span>
              </button>
              <button
                type="button"
                className="tool"
                onClick={() => {
                  prevStep.current = 0;
                  setTour({ on: true, step: 0, hint: null });
                }}
              >
                Restart tour
              </button>
            </>
          )}
        </div>
      </div>

      {tour.on && (
        <TourCard
          ref={tourEl}
          step={tour.step}
          total={TOTAL}
          title={cardTitle}
          body={cardBody}
          hint={tour.hint}
          codeOpen={codeOpen}
          pos={pos}
          onNext={() => setTour((t) => ({ ...t, step: Math.min(t.step + 1, TOTAL), hint: null }))}
          onSkip={() => setTour((t) => ({ ...t, on: false }))}
          onToggleCode={toggleCode}
          onPlayAgain={() => void reset()}
        />
      )}

      {stacked && (
        <div className="pane-tabs" role="tablist" aria-label="Switch pane">
          <button type="button" role="tab" aria-selected={paneTab === 'game'} data-tour="tab-game" onClick={() => setPaneTab('game')}>
            Game
          </button>
          <button type="button" role="tab" aria-selected={paneTab === 'mod'} data-tour="tab-mod" onClick={() => setPaneTab('mod')}>
            Moderator
            {reports.length > 0 && (
              <span className="badge" aria-label={`${reports.length} open`}>
                {reports.length}
              </span>
            )}
          </button>
        </div>
      )}

      <div className="demo-panes" inert={dialog !== null}>
        <GamePane
          hidden={gameHidden}
          feed={feed}
          seats={seats}
          allSeats={engine.seats}
          pending={pending}
          draft={draft}
          setDraft={setDraft}
          note={composerNote}
          tourLineId={tourLineId}
          onSend={(t) => void send(t)}
          onBlockedWord={() => {
            setDraft('you zorbak');
            inputRef.current?.focus();
          }}
          onReport={openReport}
          onAck={(seat, n) => void ack(seat, n)}
          inputRef={inputRef}
          logRef={logRef}
        />
        <ModPane
          hidden={modHidden}
          tab={modTab}
          setTab={setModTab}
          reports={reports}
          selectedId={selectedId}
          onSelect={setSelectedId}
          suggestion={suggestion}
          busy={busy}
          onDecide={(k, q, r) => void decide(k, q, r)}
          seats={engine.seats}
          recordSeat={recordSeat}
          setRecordSeat={setRecordSeat}
          record={record}
        />
      </div>

      {codeOpen && <CodeDrawer step={codeStep ?? Math.min(tour.on ? stepIndex : 0, CODE_STEPS.length - 1)} onPick={setCodeStep} />}

      <p className="demo-note">{engine.note}</p>

      <div className="sr-only" role="status" aria-live="polite" aria-relevant="additions text" data-testid="demo-live">
        {says.map((s) => (
          <p key={s.id}>{s.text}</p>
        ))}
      </div>

      {dialog && (
        <ReportDialog
          handle={dialog.item.name}
          text={dialog.item.text}
          returnFocus={dialog.opener}
          onClose={() => setDialog(null)}
          onSubmit={submitReport}
        />
      )}
    </div>
  );
}
