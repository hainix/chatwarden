import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../headless/env.js';
import type { PolicyLayer, PolicySamples } from '../types.js';
import type { PreviewState } from './Preview.js';

/** How long after the last edit the preview is asked for. */
export const PREVIEW_DELAY_MS = 400;

type Ask = (layer: PolicyLayer, rule?: number) => Promise<ActionResult<PolicySamples>>;

/**
 * The preview of a draft's layer, kept as state: the first one is asked for at once (also when React runs the effect twice in
 * development), later ones 400 ms after the last edit. A `null` layer is a draft with a problem: nothing is asked, and the state says it
 * is blocked. An answer to an older draft, or to a screen that has gone, is dropped, and a pending timer is cancelled when the screen goes.
 * The last samples are kept while a newer draft is blocked or refused.
 */
export function usePreview(layer: PolicyLayer | null, rule: number | null, ask: Ask): PreviewState {
  const [state, setState] = useState<PreviewState>({ samples: null, note: null });
  const askRef = useRef(ask);
  askRef.current = ask;
  // What was last started, and whether any answer has been delivered yet.
  const started = useRef<string | null>(null);
  const answered = useRef(false);
  const key = layer === null ? null : JSON.stringify([layer, rule]);

  useEffect(() => {
    if (layer === null || key === null) {
      setState((p) => ({ ...p, note: 'blocked' }));
      return undefined;
    }
    let live = true;
    const run = (): void => {
      void askRef.current(layer, rule ?? undefined).then((res) => {
        if (!live) return;
        answered.current = true;
        setState(res.ok ? { samples: res.value, note: null } : (p) => ({ ...p, note: 'failed' }));
      });
    };
    // The same draft starting again before any answer is React's second run of the effect, not an edit: it asks at once too.
    const immediate = started.current === null || (started.current === key && !answered.current);
    started.current = key;
    if (immediate) {
      run();
      return () => {
        live = false;
      };
    }
    const timer = setTimeout(run, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The draft's layer and the rule are what the preview is of.
  }, [key]);

  return state;
}
