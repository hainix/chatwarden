import { playerReporting } from '@chatwarden/core';
import { NoticeQueue, createPlayerClient, ReportDialog } from '@chatwarden/player-react';
import type { PlayerClient, PlayerReporting, ReportDraft, ReportResult } from '@chatwarden/player-react';
import '@chatwarden/player-react/styles.css';
import type { HubController } from '@chatwarden/hub-react/headless';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReplayIcon } from '../components/Icons';
import './demo.css';
import { CodeDrawer } from './CodeDrawer';
import { CODE_STEPS } from './codeSteps';
import { LINE_MAX } from './engine';
import type { DemoEngine, DemoSeat, DemoWorld, SeatState } from './engine';
import { appendLine, pickTourLine } from './feed';
import { KitEngine } from './kitEngine';
import { GamePane, endTime } from './GamePane';
import { newCasesPill, queueLink, rulePicker, suggestedStep, undoButton } from './hubTarget';
import { ModeratorPane } from './HubPane';
import type { StaffEvent } from './HubPane';
import { CodeIcon } from './icons';
import { quietNote, refusalMessage } from './notice';
import { revealInOwnScrollBoxes } from './reveal';
import { seatTransport } from './playerTransport';
import { AFTERWARDS, LOOP, NO_NOTICE_HINT, NO_REPORT_HINT, REPLIES, REPLY_DELAY_MS, RULE_PICKER_HINT, SEED, THANKS, THANKS_DELAY_MS, TOUR_STEPS } from './script';
import type { ScriptLine } from './script';
import { TourCard } from './TourCard';
import type { FeedItem } from './types';
import { useMediaQuery } from './useMediaQuery';
import { useSiteTheme } from './useSiteTheme';

export interface DemoProps {
  /** The engine behind the demo. Defaults to the real kit, running in the browser. */
  engine?: DemoEngine;
  /**
   * How Ada and Bo behave after the opening conversation. `true`: they answer only when something happens (a line the visitor sends,
   * a decision), so nothing moves on its own. `'loop'`: the old endless script, one line every 4 to 6 seconds (kept for tests of the
   * chat's scrolling and the Pause button). `false`: they never speak after the opening.
   */
  scripted?: boolean | 'loop';
}

/**
 * One pane at a time up to here, side by side from 1152px. The hub is a workbench with a queue beside the case, and wants about
 * 700px: below 1152px the page cannot give it that next to the game, so the visitor switches between the two panes. demo.css has
 * the matching `min-width: 1152px`.
 */
const STACK_QUERY = '(max-width: 1151px)';
/** A phone: the tour is a compact bar at the bottom of the window instead of a strip above the panes. */
const PHONE_QUERY = '(max-width: 599px)';
const TOTAL = TOUR_STEPS.length;
/** The scripted players, for the one sentence that says why a timed out player has gone quiet. */
const PRONOUN: Record<string, 'he' | 'she'> = { ada: 'she', bo: 'he' };
const FRIENDLY = 'Something went wrong in the demo. Press Start over.';
const SEATS_NOTE = 'Ada and Bo are bots. You can type too.';
/** The reader counts as "at the bottom" of the chat this close to it (px). */
const BOTTOM_SLACK = 24;

/** The tour steps, by position. A step is "done" when the thing it asks for happens, or when Next is pressed. */
const STEP = { report: 0, open: 1, apply: 2, notice: 3 } as const;
/** The steps that are about the hub: on one pane at a time the card says to open the Moderator tab for these, and the Game tab for the others. */
const HUB_STEPS: readonly number[] = [STEP.open, STEP.apply];

/** The hub remembers the moderator's Simple/Detailed choice here (its README documents the key); a Start over puts it back to Simple. */
const HUB_MODE_KEY = 'chatwarden.hub.mode';

interface TourState {
  on: boolean;
  /** 0 to TOTAL - 1 for the steps, TOTAL when finished. */
  step: number;
  hint: string | null;
}

interface Say {
  id: number;
  text: string;
}

/** The control a tour step is about. Falls back to something visible (the tab that opens the pane) when its pane is hidden. */
function findTarget(root: HTMLElement, step: number): HTMLElement | null {
  const visible = (el: HTMLElement | null) => (el !== null && el.closest('[hidden]') === null ? el : null);
  const q = (name: string) => visible(root.querySelector<HTMLElement>(`[data-tour="${name}"]`));
  const hub = root.querySelector<HTMLElement>('[data-pane="mod"] .cw-hub');
  const inHub = (find: (hub: HTMLElement) => HTMLElement | null) => (hub === null ? null : visible(find(hub)));
  switch (step) {
    case STEP.report:
      return q('report') ?? q('composer') ?? q('tab-game');
    case STEP.open:
      return inHub(newCasesPill) ?? inHub(queueLink) ?? q('tab-mod');
    case STEP.apply:
      return inHub(undoButton) ?? inHub(suggestedStep) ?? inHub(rulePicker) ?? inHub(newCasesPill) ?? inHub(queueLink) ?? q('tab-mod');
    case STEP.notice:
      return q('notice') ?? q('seats') ?? q('tab-game');
    default:
      return q('reset');
  }
}

export default function Demo({ engine: given, scripted = true }: DemoProps) {
  const [engine] = useState<DemoEngine>(() => given ?? new KitEngine());
  const stacked = useMediaQuery(STACK_QUERY);
  const compact = useMediaQuery(PHONE_QUERY);
  const theme = useSiteTheme();

  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [seats, setSeats] = useState<SeatState[]>([]);
  const [world, setWorld] = useState<DemoWorld | null>(null);
  /** Changes with every kit: the hub and the player's notice lists are made again for it. */
  const [kitNo, setKitNo] = useState(0);
  const [openReports, setOpenReports] = useState(0);
  const [filed, setFiled] = useState(false);
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  /** Asks the players' notice lists to read again. */
  const [noticeKey, setNoticeKey] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);
  const [paneTab, setPaneTab] = useState<'game' | 'mod'>('game');
  const [says, setSays] = useState<Say[]>([]);
  const [paused, setPaused] = useState(false);
  const [tour, setTour] = useState<TourState>({ on: true, step: 0, hint: null });
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeStep, setCodeStep] = useState<number | null>(null);
  const [report, setReport] = useState<{ item: FeedItem; opener: HTMLElement; reporting: PlayerReporting } | null>(null);
  const [draft, setDraft] = useState('');
  const [composerNote, setComposerNote] = useState<string | null>(null);
  // How long each scripted player was timed out for (the real length of the decision), so the notice bar can say why one went quiet.
  const [quiet, setQuiet] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  /** The tour is pointing at the hub's rule picker: say that the report needs a rule first. */
  const [needsRule, setNeedsRule] = useState(false);
  /** The visitor has worked in the demo (and not elsewhere on the page since): then the hub's keys answer with nothing focused. */
  const [active, setActive] = useState(false);
  /** Bumped when the hub's markup changes, so the tour looks for its target again. */
  const [, setHubTick] = useState(0);
  /** Lines that arrived while the reader was scrolled up (or had the pointer in the chat): the "new messages" pill. */
  const [unseen, setUnseen] = useState(0);
  /** The lines the visitor has reported: the tour does not point at them again. */
  const [reported, setReported] = useState<ReadonlySet<string>>(() => new Set());
  /** The line the tour points at: picked when step 1 starts and kept until it is reported or leaves the chat. */
  const [tourLine, setTourLine] = useState<string | null>(null);

  const root = useRef<HTMLDivElement>(null);
  const tourEl = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  /**
   * The hub's own controller, handed over by `<Hub onController>` (a Start over makes a new hub, and hands over its new one). The page
   * asks the hub to read its queue now through it: the hub polls the kit every five seconds, and `refresh()` makes a report show
   * without the wait. It only reads, so it is as safe on a hidden tab as on a visible one.
   */
  const hub = useRef<HubController | null>(null);
  const keepHub = (controller: HubController): void => {
    hub.current = controller;
  };
  const nudgeHub = (): void => hub.current?.refresh();
  const restartRef = useRef<HTMLButtonElement>(null);
  const prevOn = useRef(true);
  const gen = useRef(0);
  const sayId = useRef(0);
  const lineNo = useRef(0);
  const loopAt = useRef(0);
  const replyNo = useRef(0);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const afterTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  /** Is the reader at the bottom of the chat? Only then does a new line scroll it. */
  const atBottom = useRef(true);
  /** The pointer is in the chat, or focus is: nothing under it may move. */
  const hold = useRef({ pointer: false, focus: false });
  /** The control the tour last brought into view inside the hub, so it is done once per control. */
  const revealed = useRef<HTMLElement | null>(null);
  /** A line arrived that should be scrolled to: the layout effect does it once the line is drawn. */
  const stickNext = useRef(false);
  const live = useRef({ paused, ready, dialog: false });
  const modalOpen = report !== null || (viewing !== null && (waiting[viewing] ?? 0) > 0);
  live.current = { paused, ready, dialog: modalOpen };

  const announce = useCallback((text: string) => {
    // Take the id before the updater runs: React may run it later, and two announcements in one tick must not share a key.
    const id = ++sayId.current;
    setSays((s) => [...s.slice(-3), { id, text }]);
  }, []);

  // ---------- reading the engine ----------
  /** Reads the seats, how many reports are open and which players have a notice waiting. Returns the waiting counts. */
  const refresh = useCallback(async (): Promise<Record<string, number> | null> => {
    const g = gen.current;
    try {
      const [{ cw }, seatStates] = await Promise.all([engine.world(), engine.rooms.seats()]);
      const entries = await Promise.all(engine.seats.map(async (s) => [s.id, (await engine.notices.pending(s.id)).length] as const));
      if (!alive.current || g !== gen.current) return null;
      const counts = Object.fromEntries(entries);
      setSeats(seatStates);
      setOpenReports(cw.reports.list({ status: 'open' }).items.length);
      setWaiting(counts);
      setNoticeKey((k) => k + 1);
      return counts;
    } catch {
      if (alive.current && g === gen.current) setError(FRIENDLY);
      return null;
    }
  }, [engine]);

  // The player's side: one client per seat, over the small local transport that asks the kit directly.
  const clients = useMemo<Record<string, PlayerClient>>(
    () => Object.fromEntries(engine.seats.map((s) => [s.id, createPlayerClient({ transport: seatTransport(engine, s.id) })])),
    [engine],
  );

  // ---------- the room ----------
  /**
   * Adds a line to the chat. The chat scrolls to it only when the reader is at the bottom and nothing is under their pointer or
   * focus (or when `force` is set: the visitor's own line). Otherwise the line waits below, and the "new messages" pill counts it.
   */
  const pushLine = useCallback((item: FeedItem, force = false) => {
    const bottom = atBottom.current;
    const stick = force || (bottom && !hold.current.pointer && !hold.current.focus);
    if (stick) {
      stickNext.current = true;
      atBottom.current = true;
      setUnseen(0);
    } else {
      setUnseen((n) => n + 1);
    }
    setFeed((f) => appendLine(f, item, bottom || force));
  }, []);

  /** Runs one line through the engine and shows it if the visitor would see it. Returns what the engine said. */
  const play = useCallback(
    async (line: ScriptLine, g: number) => {
      let res: Awaited<ReturnType<DemoEngine['chat']['accept']>>;
      try {
        res = await engine.chat.accept(line.seat, line.text);
      } catch {
        if (alive.current && g === gen.current) setError(FRIENDLY);
        return;
      }
      if (!alive.current || g !== gen.current) return;
      if ('deliver' in res) {
        const name = engine.seats.find((s) => s.id === line.seat)?.name ?? line.seat;
        pushLine({ id: res.deliver.lineId, seat: line.seat, name, text: res.deliver.text, you: false, rude: line.rude });
      }
    },
    [engine, pushLine],
  );

  const clearScheduled = useCallback(() => {
    clearTimeout(replyTimer.current);
    for (const t of afterTimers.current) clearTimeout(t);
    afterTimers.current.clear();
  }, []);

  const boot = useCallback(async () => {
    const g = ++gen.current;
    clearScheduled();
    setReady(false);
    setError(null);
    try {
      await engine.reset();
      if (!alive.current || g !== gen.current) return;
      const next = await engine.world();
      if (!alive.current || g !== gen.current) return;
      setFeed([]);
      setUnseen(0);
      setReported(new Set());
      atBottom.current = true;
      setSeats([]);
      setOpenReports(0);
      setFiled(false);
      setWaiting({});
      setViewing(null);
      setReport(null);
      setKitNo((n) => n + 1);
      setWorld(next);
      loopAt.current = 0;
      replyNo.current = 0;
      for (const line of SEED) {
        if (!alive.current || g !== gen.current) return;
        await play(line, g);
      }
      if (!alive.current || g !== gen.current) return;
      await refresh();
    } catch {
      if (alive.current && g === gen.current) setError(FRIENDLY);
    } finally {
      // Whatever happened, the scripted players must not wait forever on a lobby that failed to open.
      if (alive.current && g === gen.current) setReady(true);
    }
  }, [engine, play, refresh, clearScheduled]);

  useEffect(() => {
    alive.current = true;
    void boot();
    return () => {
      alive.current = false;
      gen.current += 1;
      clearScheduled();
    };
  }, [boot, clearScheduled]);

  // The old endless script (scripted="loop"): one line about every 4 to 6 seconds. They wait while the tab is hidden, while you type,
  // while a dialog is open and while paused. The default room is quiet until something happens; see `scheduleReply`.
  useEffect(() => {
    if (scripted !== 'loop') return;
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
          try {
            const states = await engine.rooms.seats();
            if (!stop && alive.current && g === gen.current) setSeats(states);
          } catch {
            if (!stop && alive.current && g === gen.current) setError(FRIENDLY);
          }
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

  /** A scripted player says a line later, unless the demo is paused or the tab is hidden by then. A timed out player is refused by the kit, so says nothing. */
  const speakLater = useCallback(
    (line: ScriptLine, delay: number): ReturnType<typeof setTimeout> => {
      const g = gen.current;
      const timer = setTimeout(() => {
        afterTimers.current.delete(timer);
        if (!alive.current || g !== gen.current) return;
        if (live.current.paused || document.hidden) return;
        void play(line, g);
      }, delay);
      afterTimers.current.add(timer);
      return timer;
    },
    [play],
  );

  /** One answer, two seconds after the visitor's line (a burst of lines gets one). */
  function scheduleReply() {
    if (scripted !== true) return;
    clearTimeout(replyTimer.current);
    const g = gen.current;
    replyTimer.current = setTimeout(() => {
      void (async () => {
        if (!alive.current || g !== gen.current) return;
        if (live.current.paused || document.hidden) return;
        // The next player in the round who can chat: a timed out player cannot answer.
        let states: SeatState[];
        try {
          states = await engine.rooms.seats();
        } catch {
          return;
        }
        if (!alive.current || g !== gen.current) return;
        for (let i = 0; i < REPLIES.length; i++) {
          const line = REPLIES[(replyNo.current + i) % REPLIES.length];
          if (line === undefined) continue;
          if (states.find((s) => s.id === line.seat)?.restrictedUntil != null) continue;
          replyNo.current += i + 1;
          await play(line, g);
          return;
        }
      })();
    }, REPLY_DELAY_MS);
  }

  // The chat scrolls to the newest line only when the line asked for it (see `pushLine`).
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el !== null && stickNext.current) {
      stickNext.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [feed]);

  function onChatScroll() {
    const el = logRef.current;
    if (el === null) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    atBottom.current = bottom;
    if (bottom) setUnseen((n) => (n === 0 ? n : 0));
  }

  function onChatHold(source: 'pointer' | 'focus', holding: boolean) {
    hold.current[source] = holding;
  }

  function jumpToNewest() {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(0);
  }

  // The hub's keys answer with nothing focused only while the visitor is working in the demo: a press inside it turns that on, a
  // press in the chat box or anywhere else on the page turns it off (leaving the box with nothing focused does not turn it back on). (With focus inside the hub its keys always work; with focus in the chat box or a
  // dialog they never do.)
  useEffect(() => {
    const on = (e: Event) => {
      const t = e.target;
      // On while the visitor works in the demo, off once they are in the chat box (or its quick lines) or anywhere else on the page.
      setActive(t instanceof Element && root.current?.contains(t) === true && t.closest('.composer') === null);
    };
    document.addEventListener('pointerdown', on, true);
    document.addEventListener('focusin', on, true);
    return () => {
      document.removeEventListener('pointerdown', on, true);
      document.removeEventListener('focusin', on, true);
    };
  }, []);

  // The hub draws and redraws on its own (a toast, a menu, a card): when its markup changes, the tour looks for its target again.
  useEffect(() => {
    const pane = root.current?.querySelector('[data-pane="mod"]');
    if (!pane || typeof MutationObserver !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setHubTick((n) => n + 1), 40);
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, []);

  // ---------- the tour ----------
  const tourEvent = useCallback((index: number) => {
    setTour((t) => (t.on && t.step <= index ? { ...t, step: index + 1, hint: null } : t));
  }, []);

  // Step 1 points at one of Bo's rude lines. It is picked once and kept: a newer rude line never moves the ring.
  useEffect(() => {
    if (!tour.on || tour.step !== STEP.report) {
      setTourLine((cur) => (cur === null ? cur : null));
      return;
    }
    setTourLine((cur) => {
      const next = pickTourLine(feed, reported, cur);
      return next === cur ? cur : next;
    });
  }, [tour.on, tour.step, feed, reported]);

  const prevStep = useRef(0);
  useEffect(() => {
    if (!tour.on) return;
    if (prevStep.current === tour.step) return;
    prevStep.current = tour.step;
    const title = tour.step >= TOTAL ? 'Done' : (TOUR_STEPS[tour.step]?.title ?? '');
    announce(tour.step >= TOTAL ? 'Tour done.' : `Tour step ${tour.step + 1} of ${TOTAL}: ${title}.`);
    setCodeStep(null);
  }, [tour.on, tour.step, announce]);

  // When the tour card goes away (Skip tour, Escape, Close) its button had focus: hand focus to a stable control instead of the body.
  useEffect(() => {
    const a = document.activeElement;
    const lost = a === null || a === document.body;
    if (prevOn.current && !tour.on && lost) restartRef.current?.focus();
    // Restart the tour removes the button that was pressed: carry on from the card that just appeared.
    if (!prevOn.current && tour.on && lost) tourEl.current?.querySelector<HTMLElement>('.tbtn-next')?.focus();
    prevOn.current = tour.on;
  }, [tour.on]);

  // Put a ring on the control the step is about. It runs after every render, and the hub's markup changing (hubTick) renders again,
  // so a control that appears later (the Undo bar, an opened menu) gets its ring. Nothing moves: the card is docked, and the page
  // is never scrolled for the visitor.
  useLayoutEffect(() => {
    const host = root.current;
    if (host === null) return;
    const marked = host.querySelectorAll('[data-tour-target]');
    const target = tour.on ? findTarget(host, tour.step) : null;
    for (const el of marked) if (el !== target) el.removeAttribute('data-tour-target');
    const wantRule = tour.on && tour.step === STEP.apply && target !== null && target.tagName === 'SELECT';
    setNeedsRule((v) => (v === wantRule ? v : wantRule));
    target?.setAttribute('data-tour-target', 'true');
    // A hub control below the hub's own fold (the suggested action sits under the case's history) is scrolled into view inside the hub,
    // once. The page itself is never scrolled.
    const hubPane = host.querySelector<HTMLElement>('[data-pane="mod"]');
    if (target !== null && hubPane !== null && hubPane.contains(target)) {
      if (revealed.current !== target) {
        revealed.current = target;
        revealInOwnScrollBoxes(target, hubPane);
      }
    } else {
      revealed.current = null;
    }
  });

  // ---------- actions ----------
  // Every engine call below can reject. Each action takes the generation it started in and drops its result if a Start over happened
  // meanwhile, so nothing stale survives it.
  async function send(text: string) {
    const line = text.trim();
    if (line === '') return;
    const g = gen.current;
    setComposerNote(null);
    setError(null);
    let res: Awaited<ReturnType<DemoEngine['chat']['accept']>>;
    try {
      res = await engine.chat.accept('you', line);
    } catch {
      if (alive.current && g === gen.current) setError(FRIENDLY);
      return;
    }
    if (!alive.current || g !== gen.current) return;
    if ('deliver' in res) {
      pushLine({ id: res.deliver.lineId, seat: 'you', name: 'You', text: res.deliver.text, you: true }, true);
      setDraft('');
      inputRef.current?.focus();
      scheduleReply();
      return;
    }
    const why = res.refuse;
    if (why.reason === 'blocked') {
      const rule = why.rule ?? 1;
      pushLine({ id: `refused-${++lineNo.current}`, seat: 'you', name: 'You', text: line, you: true, refused: { reason: 'blocked', rule } }, true);
      setDraft('');
      announce(`Blocked (rule ${rule}). Only you can see this.`);
      inputRef.current?.focus();
      // A blocked line is a strike, and the third inside an hour earns the real automatic timeout: read the seats and the
      // notices back so the visitor sees it (and its end time) as soon as it happens.
      await refresh();
      return;
    }
    // Every other refusal says so, in the kit's own terms (rate, length, a timeout with its end, gate, profanity), and keeps
    // the line so it can be edited.
    const message = refusalMessage(why, LINE_MAX, endTime, (n) => engine.rules.label(n).split(':')[0] ?? '');
    setComposerNote(message);
    announce(message);
    if (why.reason === 'restricted') await refresh();
  }

  /** The report dialog opens on the kit's reporting settings as they are now (one tap unless the owner changed them in the hub). */
  async function openReport(item: FeedItem, opener: HTMLElement) {
    const g = gen.current;
    let reporting: PlayerReporting;
    try {
      reporting = playerReporting((await engine.world()).cw.profile.reporting);
    } catch {
      if (alive.current && g === gen.current) setError(FRIENDLY);
      return;
    }
    if (!alive.current || g !== gen.current) return;
    setReport({ item, opener, reporting });
  }

  async function submitReport(draftReport: ReportDraft): Promise<ReportResult> {
    const d = report;
    if (d === null) return { ok: false, refused: 'off' };
    const g = gen.current;
    setError(null);
    // A rejection (the kit could not be reached) goes to the dialog, which keeps what was typed and offers to send again.
    const res = await engine.reports.submit({ reporterSeat: 'you', targetSeat: d.item.seat, lineId: d.item.id, ...draftReport });
    if (res.ok && alive.current && g === gen.current) {
      setFiled(true);
      setReported((s) => new Set(s).add(d.item.id));
      nudgeHub();
      await refresh();
      if (!alive.current || g !== gen.current) return res;
      announce(`Report filed against ${d.item.name}.`);
      tourEvent(STEP.report);
    }
    return res;
  }

  /** What the hub tells the page: a report was opened, a decision was taken. */
  async function onStaffEvent(event: StaffEvent) {
    const g = gen.current;
    if (event.kind === 'case-opened') {
      tourEvent(STEP.open);
      return;
    }
    const counts = await refresh();
    if (counts === null || !alive.current || g !== gen.current) return;
    const who = engine.seats.filter((s) => (counts[s.id] ?? 0) > 0);
    // A timeout leaves a scripted player silent: say why, and how to replay, in the announcement and in the notice bar.
    const timed = await engine.rooms.seats();
    if (!alive.current || g !== gen.current) return;
    for (const s of timed) {
      const until = s.restrictedUntil;
      if (until !== null && !s.you) setQuiet((q) => (q[s.id] === undefined ? { ...q, [s.id]: until - Date.now() } : q));
    }
    const quietLines = timed.flatMap((s) => (s.restrictedUntil !== null && !s.you ? [quietNote(s.name, s.restrictedUntil - Date.now(), PRONOUN[s.id] ?? 'he')] : [])).filter((n) => n !== null);
    announce(
      who.length > 0
        ? `Decision taken. ${who.map((s) => `${s.you ? 'You have' : `${s.name} has`} a notice waiting.`).join(' ')}${quietLines.length > 0 ? ` ${quietLines[0]}` : ''}`
        : 'Decision taken. The player is told nothing.',
    );
    // After a decision Ada says thanks. Bo adds a line only if he got a notice and can still chat: the kit refuses a timed out player,
    // so a timed out Bo stays silent.
    if (scripted === true) {
      speakLater(THANKS, THANKS_DELAY_MS);
      if ((counts['bo'] ?? 0) > 0 && timed.find((s) => s.id === 'bo')?.restrictedUntil == null) speakLater(AFTERWARDS, THANKS_DELAY_MS + 1000);
    }
    if (who.length > 0) {
      tourEvent(STEP.apply);
    } else {
      setTour((t) => (t.on && t.step === STEP.apply ? { ...t, step: STEP.report, hint: NO_NOTICE_HINT } : t));
    }
  }

  function showNotices(seat: DemoSeat) {
    setViewing(seat.id);
  }

  function acknowledged(seat: DemoSeat) {
    const g = gen.current;
    announce(`${seat.name === 'You' ? 'You' : seat.name} acknowledged the notice.`);
    void refresh().then(() => {
      if (alive.current && g === gen.current) tourEvent(STEP.notice);
    });
  }

  async function reset() {
    setPaused(false);
    setTour({ on: true, step: 0, hint: null });
    prevStep.current = 0;
    prevOn.current = true;
    setCodeOpen(false);
    setCodeStep(null);
    setReport(null);
    setViewing(null);
    setDraft('');
    setComposerNote(null);
    setError(null);
    setPaneTab('game');
    setQuiet({});
    setSays([]);
    setWorld(null);
    try {
      localStorage.removeItem(HUB_MODE_KEY); // the new hub opens in Simple again, whatever the visitor chose last
    } catch {
      // storage blocked: the hub keeps no choice then either
    }
    await boot();
    if (alive.current) announce('Started over. The lobby is back to the start.');
  }

  function toggleCode() {
    setCodeOpen((o) => !o);
  }

  // ---------- render ----------
  const stepIndex = Math.min(tour.step, TOTAL - 1);
  const noCase = !filed && HUB_STEPS.includes(tour.step);
  const cardTitle = tour.step >= TOTAL ? "That's the whole loop" : (TOUR_STEPS[tour.step]?.title ?? '');
  const cardBody =
    tour.step >= TOTAL
      ? "A player reported, you decided in one click, and Bo was told why. That's what you add to your game."
      : noCase
        ? NO_REPORT_HINT
        : (TOUR_STEPS[tour.step]?.body ?? '');
  const cardHint = tour.hint ?? (needsRule ? RULE_PICKER_HINT : null);
  // One pane at a time: the card says which tab to open instead of the page switching panes (or scrolling) for the visitor.
  const wantsPane: 'game' | 'mod' | null = !tour.on || tour.step >= TOTAL ? null : HUB_STEPS.includes(tour.step) ? 'mod' : 'game';
  const wrongPane = stacked && wantsPane !== null && paneTab !== wantsPane;
  const tabHint = wrongPane ? (wantsPane === 'mod' ? 'Open the Moderator tab.' : 'Open the Game tab.') : null;
  // While a scripted player is still timed out for a long time, the notice bar says why they are quiet.
  const quietLine =
    engine.seats
      .map((s) => (quiet[s.id] !== undefined && seats.find((x) => x.id === s.id)?.restrictedUntil != null ? quietNote(s.name, quiet[s.id] as number, PRONOUN[s.id] ?? 'he') : null))
      .find((n) => n !== null) ?? null;
  const gameHidden = stacked && paneTab !== 'game';
  const modHidden = stacked && paneTab !== 'mod';
  const backToGame = () => document.getElementById('pane-game-title');

  const card = tour.on ? (
    <TourCard
      ref={tourEl}
      step={tour.step}
      total={TOTAL}
      title={cardTitle}
      body={cardBody}
      hint={cardHint}
      tabHint={tabHint}
      codeOpen={codeOpen}
      inert={modalOpen}
      compact={compact}
      onNext={() => setTour((t) => ({ ...t, step: Math.min(t.step + 1, TOTAL), hint: null }))}
      onSkip={() => setTour((t) => ({ ...t, on: false }))}
      onToggleCode={toggleCode}
      onPlayAgain={() => void reset()}
    />
  ) : null;

  return (
    <div
      ref={root}
      className={`demo ${stacked ? 'is-stacked' : ''}`}
      role="group"
      aria-label="Chatwarden interactive demo"
    >
      <div className="demo-toolbar" inert={modalOpen}>
        <div className="demo-tools">
          <button type="button" className="tool" data-tour="reset" onClick={() => void reset()}>
            <ReplayIcon />
            <span>Start over</span>
          </button>
        </div>
        <div className="demo-tools">
          {!tour.on && (
            <>
              <button type="button" className="tool" aria-expanded={codeOpen} aria-controls={codeOpen ? 'demo-code' : undefined} onClick={toggleCode}>
                <CodeIcon />
                <span>Show the code</span>
              </button>
              <button
                type="button"
                className="tool"
                ref={restartRef}
                onClick={() => {
                  prevStep.current = 0;
                  setTour({ on: true, step: 0, hint: null });
                }}
              >
                Restart the tour
              </button>
            </>
          )}
        </div>
      </div>

      {error !== null && (
        <p className="demo-error" role="alert">
          {error}
        </p>
      )}

      {/* Docked above the panes: it never follows the control it is about, so it cannot cover the chat or the hub's toasts. */}
      {!compact && card}

      {stacked && (
        <div className="pane-tabs" role="group" aria-label="Switch pane" inert={modalOpen}>
          <button
            type="button"
            aria-pressed={paneTab === 'game'}
            data-tour="tab-game"
            data-pulse={wrongPane && wantsPane === 'game' ? 'true' : undefined}
            onClick={() => setPaneTab('game')}
          >
            Game
          </button>
          <button
            type="button"
            aria-pressed={paneTab === 'mod'}
            data-tour="tab-mod"
            data-pulse={wrongPane && wantsPane === 'mod' ? 'true' : undefined}
            onClick={() => setPaneTab('mod')}
          >
            Moderator
            {openReports > 0 && (
              <span className="badge" aria-label={`${openReports} open`}>
                {openReports}
              </span>
            )}
          </button>
        </div>
      )}

      <div className="demo-panes" inert={modalOpen}>
        <GamePane
          hidden={gameHidden}
          feed={feed}
          seats={seats}
          allSeats={engine.seats}
          waiting={waiting}
          draft={draft}
          setDraft={(v) => {
            setDraft(v);
            setComposerNote(null);
          }}
          note={composerNote}
          seatsNote={SEATS_NOTE}
          quietNote={quietLine}
          tourLineId={tourLine}
          paused={paused}
          onTogglePause={() => setPaused((p) => !p)}
          unseen={unseen}
          onJumpToNewest={jumpToNewest}
          onChatScroll={onChatScroll}
          onChatHold={onChatHold}
          onSend={(t) => void send(t)}
          onBlockedWord={() => {
            setDraft('you zorbak');
            inputRef.current?.focus();
          }}
          onReport={(item, opener) => void openReport(item, opener)}
          onShowNotices={showNotices}
          inputRef={inputRef}
          logRef={logRef}
        />
        <ModeratorPane world={world} hidden={modHidden} theme={theme} active={active} onEvent={(e) => void onStaffEvent(e)} onController={keepHub} />
      </div>

      {/* After the panes: on a phone the card is a bar that sticks to the bottom of the window while the demo is in view. */}
      {compact && card}

      {codeOpen && <CodeDrawer step={codeStep ?? Math.min(tour.on ? stepIndex : 0, CODE_STEPS.length - 1)} onPick={setCodeStep} />}

      <p className="demo-badge">{engine.note}</p>
      {engine.noteDetails !== undefined && (
        <details className="demo-details">
          <summary>Demo settings</summary>
          <p>{engine.noteDetails}</p>
        </details>
      )}

      <div className="sr-only" role="status" aria-live="polite" aria-relevant="additions text" data-testid="demo-live">
        {says.map((s) => (
          <p key={s.id}>{s.text}</p>
        ))}
      </div>

      {/* The players' notices: one list per seat, held until the visitor asks to see it (canShow), then player-react's own dialog. */}
      {engine.seats.map((s) => (
        <NoticeQueue
          key={`${kitNo}-${s.id}`}
          client={clients[s.id] as PlayerClient}
          canShow={viewing === s.id}
          refreshKey={noticeKey}
          theme={theme}
          container={typeof document === 'undefined' ? null : document.body}
          returnFocusTo={backToGame}
          onAcknowledged={() => acknowledged(s)}
          onPendingChange={(n) => {
            if (n === 0) setViewing((v) => (v === s.id ? null : v));
          }}
        />
      ))}

      {report && (
        <ReportDialog
          line={report.item.text}
          targetName={report.item.name}
          reporting={report.reporting}
          theme={theme}
          container={document.body}
          returnFocusTo={backToGame}
          onClose={() => setReport(null)}
          onSubmit={submitReport}
        />
      )}
    </div>
  );
}
