// The AI's code is loaded when the hub learns the AI is on (a queue that holds a read, a case that has one or expects one), not with the hub:
// an install with the AI off pays for none of it. `ensureAi()` fetches it once and keeps it; a failed fetch leaves the hub as it is without the
// AI (the ladder's pre-fill, the longest-wait order): these are optional extras, not screens. No React here: the headless queue uses it too.

type Core = typeof import('./core.js');

/** What the hub asks of the page to get the AI's code. Exposed so a test can make a fetch fail or wait; nothing else replaces it. */
export const aiLoaders: { core: () => Promise<Core> } = {
  core: () => import('./core.js'),
};

let core: Core | null = null;
let failed = false;
let pending: Promise<Core | null> | null = null;

/** The AI's code if it is here, else null. Never fetches. */
export const aiCore = (): Core | null => core;
/** Whether the fetch was tried and failed. */
export const aiFailed = (): boolean => failed;

/** Fetches the AI's code (once) and resolves with it, or null when it cannot be fetched. */
export function ensureAi(): Promise<Core | null> {
  pending ??= aiLoaders.core().then(
    (m) => (core = m),
    () => {
      failed = true;
      return null;
    },
  );
  return pending;
}

/** Forgets what was fetched (tests). */
export function resetAiCore(): void {
  core = null;
  failed = false;
  pending = null;
}
