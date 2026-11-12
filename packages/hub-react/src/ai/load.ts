import { useEffect, useState } from 'react';

// The code that builds the AI's pre-fill is loaded the first time a case has a recommendation, not with the hub: nobody who runs without
// the AI pays for it. A case that has one waits for it before its decision form is made (a few milliseconds from the second case on).
// A failed fetch means the ladder's own pre-fill, as without the AI: these are optional extras, not screens.

type Offer = typeof import('./offer.js');

/** What a part asks of the page to get the AI's pre-fill code. Exposed so a test can make a fetch fail or wait; nothing else replaces it. */
export const aiLoaders: { offer: () => Promise<Offer> } = {
  offer: () => import('./offer.js'),
};

let loaded: Offer | null = null;
let failed = false;

/**
 * The AI's pre-fill code, once it is here. `wanted` asks for it (a case with a recommendation); without it nothing is fetched, and the
 * code is returned only if some earlier case already brought it. `settled` is true once it is here or could not be fetched.
 */
export function useAiOffer(wanted: boolean): { offer: Offer | null; settled: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!wanted || loaded !== null) return undefined;
    let live = true;
    aiLoaders.offer().then(
      (m) => {
        loaded = m;
        if (live) tick((n) => n + 1);
      },
      () => {
        failed = true;
        if (live) tick((n) => n + 1);
      },
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return { offer: loaded, settled: loaded !== null || failed };
}

/** Forgets what was fetched (tests). */
export function resetAiOffer(): void {
  loaded = null;
  failed = false;
}
