import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useHub } from './context.js';

// Toasts: short news that does not need an answer ("You took the case"), and the one that does, for a few seconds: Undo.
// A "held" action is the Undo window the design asks for: the action waits, visible, for UNDO_MS; Undo cancels it; and it is
// sent at once if the toast is dismissed early, or if the hub is closing (the page hides, or the tab is hidden). Nothing is sent twice.

/** How long an Undo toast, and the action it holds, waits. The stylesheet's progress bar runs for the same 5 seconds. */
export const UNDO_MS = 5_000;
/** How long a plain toast stays. An error stays longer. */
export const TOAST_MS = 4_000;
export const TOAST_ERROR_MS = 7_000;
/** The most toasts on screen at once. */
export const TOAST_MAX = 3;

export interface ToastInput {
  text: string;
  tone?: 'neutral' | 'bad';
  /** One button on the toast, such as Undo. Choosing it dismisses the toast. */
  action?: { label: string; run: () => void };
  /** Milliseconds on screen. Default: 4 s; 7 s for an error; 5 s with an action. */
  ms?: number;
}

export interface HoldInput {
  text: string;
  /** What runs when the window ends without Undo, or at once on `commit()`, a dismissal, or the hub closing. Runs once. */
  run: () => unknown;
  /** The label of the Undo button. Default: the catalog's "Undo". */
  undoLabel?: string;
  /** Runs when Undo is chosen. */
  onUndo?: () => void;
  ms?: number;
}

export interface Hold {
  /** Cancel the action. A no-op once it has run. */
  undo: () => void;
  /** Run the action now. A no-op once it has run or been undone. */
  commit: () => void;
}

export interface Toasts {
  push: (input: ToastInput) => number;
  hold: (input: HoldInput) => Hold;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<Toasts | null>(null);

/** The toast functions. Throws outside a `<Hub>`. */
export function useToasts(): Toasts {
  const value = useContext(ToastContext);
  if (value === null) throw new Error('useToasts must be used inside <Hub>');
  return value;
}

interface Shown {
  id: number;
  text: string;
  tone: 'neutral' | 'bad';
  action: { label: string; run: () => void } | null;
  ms: number;
  /** A held action: the toast carries the Undo progress bar. */
  held: boolean;
}

/** Keeps at most TOAST_MAX: the oldest news goes first, and a toast with an Undo is only pushed off when every toast has one. */
function capped(list: Shown[]): Shown[] {
  const out = [...list];
  while (out.length > TOAST_MAX) {
    const at = out.findIndex((s) => s.action === null);
    out.splice(at < 0 ? 0 : at, 1);
  }
  return out;
}

/** Owns the toasts and draws them. It sits inside the hub's context (it reads the words), around everything that pushes one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useHub();
  const [shown, setShown] = useState<Shown[]>([]);
  const nextId = useRef(0);
  // What each held toast does when its window ends: id -> the pending action. Gone once run or undone.
  const pending = useRef(new Map<number, { run: () => unknown; settle: (what: 'run' | 'undo') => void }>());

  const remove = useCallback((id: number) => setShown((list) => list.filter((s) => s.id !== id)), []);

  /** Ends a toast: a held action runs unless it was undone. */
  const finish = useCallback(
    (id: number) => {
      const held = pending.current.get(id);
      if (held !== undefined) {
        pending.current.delete(id);
        held.settle('run');
        void Promise.resolve()
          .then(held.run)
          .catch(() => undefined);
      }
      remove(id);
    },
    [remove],
  );

  const push = useCallback((input: ToastInput): number => {
    const id = ++nextId.current;
    const tone = input.tone ?? 'neutral';
    const ms = input.ms ?? (input.action !== undefined ? UNDO_MS : tone === 'bad' ? TOAST_ERROR_MS : TOAST_MS);
    setShown((list) => capped([...list, { id, text: input.text, tone, action: input.action ?? null, ms, held: false }]));
    return id;
  }, []);

  const hold = useCallback(
    (input: HoldInput): Hold => {
      const id = ++nextId.current;
      let settled = false;
      const settle = (): void => {
        settled = true;
      };
      pending.current.set(id, { run: input.run, settle });
      const undo = (): void => {
        if (settled || !pending.current.has(id)) return;
        pending.current.delete(id);
        settled = true;
        input.onUndo?.();
        remove(id);
      };
      const commit = (): void => {
        if (settled || !pending.current.has(id)) return;
        finish(id);
      };
      const label = input.undoLabel ?? t('hub.toast.undo');
      setShown((list) => capped([...list, { id, text: input.text, tone: 'neutral' as const, action: { label, run: undo }, ms: input.ms ?? UNDO_MS, held: true }]));
      return { undo, commit };
    },
    [finish, remove, t],
  );

  // A toast pushed out by the cap must still run its held action: it was never undone.
  useEffect(() => {
    const onScreen = new Set(shown.map((s) => s.id));
    for (const id of [...pending.current.keys()]) if (!onScreen.has(id)) finish(id);
  }, [shown, finish]);

  // The hub is closing (the tab, or this component going away): anything still held is sent now.
  useEffect(() => {
    const flush = (): void => {
      for (const id of [...pending.current.keys()]) finish(id);
    };
    // `pagehide` is the tab closing; a hidden tab is the other way the page can go away without it (a phone switching apps).
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    const held = pending.current;
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const [, entry] of held) void Promise.resolve().then(entry.run).catch(() => undefined);
      held.clear();
    };
  }, [finish]);

  const api = useMemo<Toasts>(() => ({ push, hold, dismiss: finish }), [push, hold, finish]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="cw-toasts" role="region" aria-label={t('hub.toast.region')}>
        {shown.map((s) => (
          <ToastView key={s.id} toast={s} dismissLabel={t('hub.toast.dismiss')} onDone={finish} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, dismissLabel, onDone }: { toast: Shown; dismissLabel: string; onDone: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const left = useRef(toast.ms);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDone(toast.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(0, left.current - (Date.now() - started));
    };
  }, [paused, onDone, toast.id]);

  const act = (): void => {
    toast.action?.run();
    // An Undo button on a held toast has already removed it; a plain action just closes it.
    if (!toast.held) onDone(toast.id);
  };

  return (
    <div
      className="cw-toast"
      data-tone={toast.tone}
      data-held={toast.held ? 'true' : undefined}
      data-paused={paused ? 'true' : undefined}
      role={toast.tone === 'bad' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="cw-toast-text">{toast.text}</span>
      {toast.action !== null && (
        <button type="button" className="cw-toast-btn" onClick={act}>
          {toast.action.label}
        </button>
      )}
      {!toast.held && (
        <button type="button" className="cw-toast-btn cw-toast-close" aria-label={dismissLabel} onClick={() => onDone(toast.id)}>
          <span aria-hidden="true">{'\u00d7'}</span>
        </button>
      )}
      {toast.held && <span className="cw-toast-bar" aria-hidden="true" />}
    </div>
  );
}
