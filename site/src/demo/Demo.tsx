import { playerReporting } from '@chatwarden/core';
import { NoticeQueue, playerClient, ReportDialog } from '@chatwarden/player-react';
import type { PlayerClient, PlayerReporting, ReportDetail, ReportDraft, ReportResult } from '@chatwarden/player-react';
import '@chatwarden/player-react/styles.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReplayIcon } from '../components/Icons';
import './demo.css';
import { CodeDrawer } from './CodeDrawer';
import { CODE_STEPS } from './codeSteps';
import { LINE_MAX } from './engine';
import type { DemoEngine, DemoSeat, DemoWorld, SeatState } from './engine';
import { KitEngine } from './kitEngine';
import { GamePane, endTime } from './GamePane';
import { detailedSwitch, moreMenu, newCasesPill, queueLink, rulePicker, settingsLink, stepsAndLadder, suggestedStep, undoButton } from './hubTarget';
import { ModeratorPane } from './HubPane';
import type { StaffEvent } from './HubPane';
import { PauseIcon, PlayIcon, CodeIcon } from './icons';
import { quietNote, refusalMessage } from './notice';
import { seatTransport } from './playerTransport';
import { NO_NOTICE_HINT, NO_REPORT_HINT, LOOP, SEED, TOUR_STEPS } from './script';
import type { ScriptLine } from './script';
import { TourCard } from './TourCard';
import type { TourPos } from './TourCard';
import type { FeedItem } from './types';
import { useMediaQuery } from './useMediaQuery';
import { useSiteTheme } from './useSiteTheme';

export interface DemoProps {
  /** The engine behind the demo. Defaults to the real kit, running in the browser. */
  engine?: DemoEngine;
  /** Whether Ada and Bo chat on their own after the opening conversation. */
  scripted?: boolean;
}

/**
 * One pane at a time up to here, side by side from 1152px. The hub is a workbench with a queue beside the case, and wants about
 * 720px: below 1152px the page cannot give it that next to the game, so the visitor switches between the two panes (and the tour
 * switches for them). demo.css has the matching `min-width: 1152px`.
 */
const STACK_QUERY = '(max-width: 1151px)';
const FEED_MAX = 60;
const TOTAL = TOUR_STEPS.length;
/** The scripted players, for the one sentence that says why a timed out player has gone quiet. */
const PRONOUN: Record<string, 'he' | 'she'> = { ada: 'she', bo: 'he' };
const FRIENDLY = 'Something went wrong in the demo. Reset to try again.';

/** The tour steps, by position. A step is "done" when the thing it asks for happens, or when Next is pressed. */
const STEP = { report: 0, queue: 1, open: 2, apply: 3, notice: 4, detailed: 5, ladder: 6 } as const;
/** The steps that are about the hub: on a phone the tour shows the moderator pane for these, and the game pane for the others. */
const HUB_STEPS: readonly number[] = [STEP.queue, STEP.open, STEP.apply, STEP.detailed, STEP.ladder];

/** The hub remembers the moderator's Simple/Detailed choice here (its README documents the key); a Reset puts it back to Simple. */
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

/** Where the tour tooltip for a step points. Falls back to something visible when the target's pane is hidden. */
function findTarget(root: HTMLElement, step: number): HTMLElement | null {
  const visible = (el: HTMLElement | null) => (el !== null && el.closest('[hidden]') === null ? el : null);
  const q = (name: string) => visible(root.querySelector<HTMLElement>(`[data-tour="${name}"]`));
  const hub = root.querySelector<HTMLElement>('[data-pane="mod"] .cw-hub');
  const inHub = (find: (hub: HTMLElement) => HTMLElement | null) => (hub === null ? null : visible(find(hub)));
  switch (step) {
    case STEP.report:
      return q('report') ?? q('composer') ?? q('tab-game');
    case STEP.queue:
    case STEP.open:
      return inHub(newCasesPill) ?? inHub(queueLink) ?? q('tab-mod');
    case STEP.apply:
      return inHub(undoButton) ?? inHub(suggestedStep) ?? inHub(rulePicker) ?? inHub(newCasesPill) ?? inHub(queueLink) ?? q('tab-mod');
    case STEP.notice:
      return q('notice') ?? q('seats') ?? q('tab-game');
    case STEP.detailed:
      return inHub(detailedSwitch) ?? q('tab-mod');
    case STEP.ladder:
      return inHub(stepsAndLadder) ?? inHub(moreMenu) ?? inHub(settingsLink) ?? q('tab-mod');
    default:
      return q('reset');
  }
}

// What hands the page back to the person after an automatic pane switch (see the settle re-scroll).
const SETTLE_CANCEL = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar', 'Home', 'End']);

export default function Demo({ engine: given, scripted = true }: DemoProps) {
  const [engine] = useState<DemoEngine>(() => given ?? new KitEngine());
  const stacked = useMediaQuery(STACK_QUERY);
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
  // How long each scripted player was timed out for (the real length of the decision), so the seats can say why one went quiet.
  const [quiet, setQuiet] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [focusPane, setFocusPane] = useState<'game' | 'mod' | null>(null);
  const [ready, setReady] = useState(false);
  const [pos, setPos] = useState<TourPos | null>(null);
  /** The tour is pointing at the hub's rule picker: say that the case needs a rule first. */
  const [needsRule, setNeedsRule] = useState(false);
  /** The visitor has worked in the demo (and not elsewhere on the page since): then the hub's keys answer with nothing focused. */
  const [active, setActive] = useState(false);
  /** Bumped when the hub's markup changes, so the tour looks for its target again. */
  const [hubTick, setHubTick] = useState(0);

  const root = useRef<HTMLDivElement>(null);
  const tourEl = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const restartRef = useRef<HTMLButtonElement>(null);
  const paneNow = useRef<'game' | 'mod'>('game');
  const prevOn = useRef(true);
  const gen = useRef(0);
  const sayId = useRef(0);
  const settle = useRef<number | undefined>(undefined);
  const stopSettle = useRef<() => void>(() => {});
  const loopAt = useRef(0);
  const live = useRef({ paused, ready, dialog: false });
  const modalOpen = report !== null || (viewing !== null && (waiting[viewing] ?? 0) > 0);
  live.current = { paused, ready, dialog: modalOpen };
  paneNow.current = paneTab;

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
    () => Object.fromEntries(engine.seats.map((s) => [s.id, playerClient({ transport: seatTransport(engine, s.id) })])),
    [engine],
  );

  // ---------- the room ----------
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
        const item: FeedItem = { id: res.deliver.lineId, seat: line.seat, name, text: res.deliver.text, you: false, rude: line.rude };
        setFeed((f) => [...f.slice(-(FEED_MAX - 1)), item]);
      }
    },
    [engine],
  );

  const boot = useCallback(async () => {
    const g = ++gen.current;
    setReady(false);
    setError(null);
    try {
      await engine.reset();
      if (!alive.current || g !== gen.current) return;
      const next = await engine.world();
      if (!alive.current || g !== gen.current) return;
      setFeed([]);
      setSeats([]);
      setOpenReports(0);
      setFiled(false);
      setWaiting({});
      setViewing(null);
      setReport(null);
      setKitNo((n) => n + 1);
      setWorld(next);
      loopAt.current = 0;
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
  }, [engine, play, refresh]);

  useEffect(() => {
    alive.current = true;
    void boot();
    return () => {
      alive.current = false;
      gen.current += 1;
      stopSettle.current();
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

  // keep the newest line in view (inside the chat box only, never the page)
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [feed]);

  // The hub's keys answer with nothing focused only while the visitor is working in the demo: a press inside it turns that on, a
  // press anywhere else on the page turns it off. (With focus inside the hub its keys always work; with focus in the chat box or a
  // dialog they never do.)
  useEffect(() => {
    const on = (e: Event) => {
      const t = e.target;
      setActive(t instanceof Node && root.current?.contains(t) === true);
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

  const tourLineId = (() => {
    if (!tour.on || tour.step !== STEP.report) return null;
    const others = feed.filter((f) => !f.you);
    return ([...others].reverse().find((f) => f.seat === 'bo' && f.rude) ?? [...others].reverse().find((f) => f.seat === 'bo') ?? others[others.length - 1])?.id ?? null;
  })();

  // Step 2 is done when the case is in the hub's list: a case that arrives waits behind the "1 new case" pill, and pressing it is
  // what puts the case's link in the queue. (The hub has no event for that, so the tour looks at the queue as it changes.)
  useEffect(() => {
    if (!tour.on || tour.step !== STEP.queue) return;
    const hub = root.current?.querySelector<HTMLElement>('[data-pane="mod"] .cw-hub');
    if (hub && queueLink(hub) !== null) tourEvent(STEP.queue);
  }, [tour.on, tour.step, hubTick, tourEvent]);

  const prevStep = useRef(0);
  useEffect(() => {
    if (!tour.on) return;
    if (prevStep.current === tour.step) return;
    prevStep.current = tour.step;
    const title = tour.step >= TOTAL ? 'Done' : (TOUR_STEPS[tour.step]?.title ?? '');
    announce(tour.step >= TOTAL ? 'Tour done.' : `Tour step ${tour.step + 1} of ${TOTAL}: ${title}.`);
    setCodeStep(null);
    if (stacked) {
      // One pane at a time on a phone: the tour moves you to the pane the step is about, and says so.
      const want = HUB_STEPS.includes(tour.step) ? 'mod' : 'game';
      if (paneNow.current !== want) {
        setPaneTab(want);
        setFocusPane(want);
        announce(`Showing the ${want === 'mod' ? 'moderator' : 'game'} view.`);
      }
    }
  }, [tour.on, tour.step, stacked, announce]);

  // After an automatic pane switch, keep keyboard focus: if the control that had it is now hidden (or gone), land on the new
  // pane's heading. Focus that is still somewhere visible (the tour card's Next button) is left alone.
  useEffect(() => {
    if (focusPane === null || paneTab !== focusPane) return;
    const a = document.activeElement;
    if (a === null || a === document.body || !a.isConnected || a.closest('[hidden]') !== null) {
      const heading = document.getElementById(focusPane === 'mod' ? 'pane-mod-title' : 'pane-game-title');
      if (heading) {
        // preventScroll first: the layout swap can leave the heading above the viewport, so bring it back ourselves. The jump
        // is instant: a smooth scroll gets cut short when the swapped pane changes the page height, and it is the
        // reduced-motion-safe choice too.
        heading.focus({ preventScroll: true });
        const bring = () => heading.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
        bring();
        // The swapped pane and the closing dialog keep moving the page for a moment (entrance animations, the scroll lock
        // lifting), so once more when they have settled, if focus is still on the heading.
        stopSettle.current();
        const stop = () => {
          window.clearTimeout(settle.current);
          for (const type of SETTLE_CANCEL) window.removeEventListener(type, onInput);
          stopSettle.current = () => {};
        };
        // The first thing the person does (wheel, touch, click, a scroll key) means the page is theirs again: no re-scroll.
        const onInput = (e: Event) => {
          if (e.type === 'keydown' && !SCROLL_KEYS.has((e as KeyboardEvent).key)) return;
          stop();
        };
        for (const type of SETTLE_CANCEL) window.addEventListener(type, onInput, { passive: true });
        stopSettle.current = stop;
        settle.current = window.setTimeout(() => {
          if (document.activeElement === heading) bring();
          stop();
        }, 650);
      }
    }
    setFocusPane(null);
  }, [focusPane, paneTab]);

  // A dialog that closes hands focus back to the button that opened it. On a phone that button may now be in the hidden pane (the
  // tour moved on while the dialog was open): then focus lands on the pane that is showing.
  const hadModal = useRef(false);
  useEffect(() => {
    if (hadModal.current && !modalOpen && stacked) setFocusPane(paneNow.current);
    hadModal.current = modalOpen;
  }, [modalOpen, stacked]);

  // When the tour card goes away (Skip, Escape, Close) its button had focus: hand focus to a stable control instead of the body.
  useEffect(() => {
    const a = document.activeElement;
    const lost = a === null || a === document.body;
    if (prevOn.current && !tour.on && lost) restartRef.current?.focus();
    // Restart tour removes the button that was pressed: carry on from the card that just appeared.
    if (!prevOn.current && tour.on && lost) tourEl.current?.querySelector<HTMLElement>('.tbtn-next')?.focus();
    prevOn.current = tour.on;
  }, [tour.on]);

  // Put a ring on the control the step is about, and the tooltip next to it. It runs after every render, and the hub's markup changing
  // (hubTick) renders again, so a control that appears later (the Undo bar, an opened menu) gets its ring.
  useLayoutEffect(() => {
    const host = root.current;
    if (host === null) return;
    const marked = host.querySelectorAll('[data-tour-target]');
    const target = tour.on ? findTarget(host, tour.step) : null;
    for (const el of marked) if (el !== target) el.removeAttribute('data-tour-target');
    const wantRule = tour.on && tour.step === STEP.apply && target !== null && target.tagName === 'SELECT';
    setNeedsRule((v) => (v === wantRule ? v : wantRule));
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
      const anchor = target.closest('.msg, .notice-bar');
      const a = anchor?.getBoundingClientRect() ?? t;
      const below = !anchor?.classList.contains('notice-bar') && (c.bottom - a.bottom >= h + gap + 8 || c.bottom - a.bottom >= a.top - c.top);
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
    host.addEventListener('scroll', again, true); // the chat and the hub scroll inside their panes
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    ro?.observe(host);
    return () => {
      window.removeEventListener('resize', again);
      host.removeEventListener('scroll', again, true);
      ro?.disconnect();
    };
  }, []);

  // ---------- actions ----------
  // Every engine call below can reject. Each action takes the generation it started in and drops its result if a Reset happened
  // meanwhile, so nothing stale survives a Reset.
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
      // The hub asks the kit what changed every five seconds. Its poll also runs the moment the page becomes visible again, which
      // is the browser's own event, so the case is on its way to the queue now rather than in a few seconds.
      document.dispatchEvent(new Event('visibilitychange'));
      await refresh();
      if (!alive.current || g !== gen.current) return res;
      announce(`Report filed against ${d.item.name}.`);
      tourEvent(STEP.report);
    }
    return res;
  }

  async function addDetail(reportId: string, detail: ReportDetail) {
    const res = await engine.reports.addDetail(reportId, 'you', detail);
    if (res.ok) document.dispatchEvent(new Event('visibilitychange')); // the hub reads the reason now, not in a few seconds
    return res;
  }

  /** What the hub tells the page: a case was opened, a decision was taken. */
  async function onStaffEvent(event: StaffEvent) {
    const g = gen.current;
    if (event.kind === 'case-opened') {
      tourEvent(STEP.open);
      return;
    }
    const counts = await refresh();
    if (counts === null || !alive.current || g !== gen.current) return;
    const who = engine.seats.filter((s) => (counts[s.id] ?? 0) > 0);
    // A timeout leaves a scripted player silent: say why, and how to replay, in the announcement and under the seats.
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
    if (alive.current) announce('Demo reset. The lobby is back to the start.');
  }

  function toggleCode() {
    setCodeOpen((o) => !o);
  }

  // ---------- render ----------
  const stepIndex = Math.min(tour.step, TOTAL - 1);
  const noCase = !filed && (HUB_STEPS.includes(tour.step) && tour.step !== STEP.detailed && tour.step !== STEP.ladder);
  const cardTitle = tour.step >= TOTAL ? 'That’s the whole loop' : (TOUR_STEPS[tour.step]?.title ?? '');
  const cardBody =
    tour.step >= TOTAL
      ? 'Chat, report, decide, notify. Play again from the top, or read the code behind each step.'
      : noCase
        ? NO_REPORT_HINT
        : (TOUR_STEPS[tour.step]?.body ?? '');
  const cardHint = tour.hint ?? (needsRule ? 'This report named no reason, so pick which rule it breaks first.' : null);
  // While a scripted player is still timed out for a long time, the line under the seats says why they are quiet.
  const seatsNote =
    engine.seats
      .map((s) => (quiet[s.id] !== undefined && seats.find((x) => x.id === s.id)?.restrictedUntil != null ? quietNote(s.name, quiet[s.id] as number, PRONOUN[s.id] ?? 'he') : null))
      .find((n) => n !== null) ?? null;
  const gameHidden = stacked && paneTab !== 'game';
  const modHidden = stacked && paneTab !== 'mod';
  const backToGame = () => document.getElementById('pane-game-title');

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
              <button type="button" className="tool" aria-expanded={codeOpen} aria-controls={codeOpen ? 'demo-code' : undefined} onClick={toggleCode}>
                <CodeIcon />
                <span>Show me the code</span>
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
                Restart tour
              </button>
            </>
          )}
        </div>
      </div>

      <p className="demo-badge">{engine.note}</p>
      {engine.noteDetails !== undefined && (
        <details className="demo-details">
          <summary>What is different here</summary>
          <p>{engine.noteDetails}</p>
        </details>
      )}
      {error !== null && (
        <p className="demo-error" role="alert">
          {error}
        </p>
      )}

      {tour.on && (
        <TourCard
          ref={tourEl}
          step={tour.step}
          total={TOTAL}
          optional={TOUR_STEPS[tour.step]?.optional === true}
          title={cardTitle}
          body={cardBody}
          hint={cardHint}
          codeOpen={codeOpen}
          inert={modalOpen}
          pos={pos}
          onNext={() => setTour((t) => ({ ...t, step: Math.min(t.step + 1, TOTAL), hint: null }))}
          onSkip={() => setTour((t) => ({ ...t, on: false }))}
          onToggleCode={toggleCode}
          onPlayAgain={() => void reset()}
        />
      )}

      {stacked && (
        <div className="pane-tabs" role="group" aria-label="Switch pane" inert={modalOpen}>
          <button type="button" aria-pressed={paneTab === 'game'} data-tour="tab-game" onClick={() => setPaneTab('game')}>
            Game
          </button>
          <button type="button" aria-pressed={paneTab === 'mod'} data-tour="tab-mod" onClick={() => setPaneTab('mod')}>
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
          seatsNote={seatsNote}
          tourLineId={tourLineId}
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
        <ModeratorPane world={world} hidden={modHidden} theme={theme} active={active} onEvent={(e) => void onStaffEvent(e)} />
      </div>

      {codeOpen && <CodeDrawer step={codeStep ?? Math.min(tour.on ? stepIndex : 0, CODE_STEPS.length - 1)} onPick={setCodeStep} />}

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
          onAddDetail={addDetail}
        />
      )}
    </div>
  );
}
