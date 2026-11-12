import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useOptionalController, useStore } from './controllerContext.js';
import { useHub } from './context.js';
import { TOAST_ERROR_MS, TOAST_HELD_MAX, TOAST_MAX, TOAST_MS, UNDO_MS, createToastStore } from './headless/toasts.js';
import type { Hold, HoldInput, ToastInput, ToastRecord, ToastStore, Toasts } from './headless/toasts.js';

// Toasts: short news that does not need an answer ("You took the case"), and the one that does, for a few seconds: Undo.
// The queue of toasts and the Undo hold are the headless controller's (`./headless/toasts.ts`); this draws them.

export { TOAST_ERROR_MS, TOAST_HELD_MAX, TOAST_MAX, TOAST_MS, UNDO_MS };
export type { Hold, HoldInput, ToastInput, Toasts };

const ToastContext = createContext<Toasts | null>(null);

/** The toast functions. Throws outside a `<Hub>`. */
export function useToasts(): Toasts {
  const value = useContext(ToastContext);
  if (value === null) throw new Error('useToasts must be used inside <Hub>');
  return value;
}

/**
 * Draws the toasts. It sits inside the hub's context (it reads the words), around everything that pushes one. The toasts are the
 * hub controller's; with no controller above it (a toast host on its own) it keeps its own.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useHub();
  const controller = useOptionalController();
  const tRef = useRef(t);
  tRef.current = t;
  const alone = controller === null;
  const make = (): ToastStore => createToastStore({ words: () => tRef.current });
  const [own, setOwn] = useState<ToastStore | null>(() => (alone ? make() : null));
  // A store of its own is disposed with the host. StrictMode runs that cleanup once in development and then mounts again, so a
  // disposed store is replaced rather than left dead.
  const disposed = useRef(false);
  useEffect(() => {
    if (!alone) return undefined;
    if (disposed.current) {
      disposed.current = false;
      setOwn(make());
      return undefined;
    }
    return () => {
      disposed.current = true;
      own?.dispose();
    };
    // `make` only reads a ref.
  }, [alone, own]);
  const store = controller?.toasts ?? (own as ToastStore);
  const all = useStore(store);
  // Quick decisions stack several held toasts. The newest shows in full with its Undo; the rest are one line (their timers run on, and
  // each comes back into view as the ones after it end or are undone).
  let newestHeld: ToastRecord | undefined;
  for (let i = all.length - 1; i >= 0 && newestHeld === undefined; i -= 1) if (all[i]?.held === true) newestHeld = all[i];
  const shown = all.filter((s) => !s.held || s === newestHeld);
  const earlier = all.filter((s) => s.held).length - (newestHeld === undefined ? 0 : 1);
  const api = useMemo<Toasts>(() => ({ push: store.push, hold: store.hold, dismiss: store.dismiss }), [store]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="cw-toasts" role="region" aria-label={t('hub.toast.region')}>
        {shown.map((s) => (
          <ToastView key={s.id} toast={s} dismissLabel={t('hub.toast.dismiss')} store={store} />
        ))}
        {earlier > 0 && (
          <div className="cw-toast-waiting" role="status">
            {t('hub.toast.waiting', { count: earlier })}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, dismissLabel, store }: { toast: ToastRecord; dismissLabel: string; store: ToastStore }) {
  const [paused, setPaused] = useState(false);
  // The store owns the clock; hovering or focusing the toast only holds it still.
  useEffect(() => {
    if (paused) store.pause(toast.id);
    else store.resume(toast.id);
  }, [paused, store, toast.id]);
  // A toast that is hidden while the pointer was on it (a newer held toast took its place) must not stay paused: its clock runs on.
  useEffect(() => () => store.resume(toast.id), [store, toast.id]);
  const onDone = store.dismiss;

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
