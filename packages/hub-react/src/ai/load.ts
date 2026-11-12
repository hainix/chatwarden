// The AI's code is loaded when the hub learns the AI is on (a queue that holds a read, a case that has one or expects one), not with the hub:
// an install with the AI off pays for none of it. `ensureAi()` fetches it and keeps it; a failed fetch leaves the hub as it is without the
// AI (the ladder's pre-fill, the longest-wait order) and is not remembered, so the next look (a refresh of the queue) tries again. These are
// optional extras, not screens. No React here: the headless queue uses it too.

type Core = typeof import('./core.js');

/** What the hub asks of the page to get the AI's code. Exposed so a test can make a fetch fail or wait; nothing else replaces it. */
export const aiLoaders: { core: () => Promise<Core> } = {
  core: () => import('./core.js'),
};

let core: Core | null = null;
let pending: Promise<Core | null> | null = null;

/** Fetches the AI's code (once it has arrived, never again) and resolves with it, or null when it cannot be fetched (the next call tries again). */
export function ensureAi(): Promise<Core | null> {
  if (core !== null) return Promise.resolve(core);
  pending ??= aiLoaders.core().then(
    (m) => (core = m),
    () => {
      pending = null;
      return null;
    },
  );
  return pending;
}
