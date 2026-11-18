// The careful view's own storage (design 7): a personal setting of this browser. Nothing here is sent anywhere or readable by the owner: the choice to hide excerpts until they are opened,
// the choice to count what was opened, the choice of a break, and the day's count, keyed by the browser's local date. Every access to storage is in try/catch; a storage that is blocked,
// full or missing leaves the setting for this visit (the module keeps its own copy) and nothing breaks. Eager and small on purpose: the case reads it on every open.

export interface Care {
  /** Hide the chat, the reporter's note, the AI's read and an appeal statement behind one button until the moderator opens them. Off by default, in every mode and for urgent cases. */
  hideExcerpts: boolean;
  /** Count the excerpts opened today (this browser's local date), shown only in the panel. */
  countOpened: boolean;
  /** Offer a break after this many excerpts opened in a day, and again at each multiple (0: never). */
  breakAfter: number;
}

/** Just enough of `Storage` to be handed one in a test. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = { hide: 'chatwarden.hub.care.hide', count: 'chatwarden.hub.care.count', breakAfter: 'chatwarden.hub.care.break', day: 'chatwarden.hub.care.day' } as const;
const OFF: Care = { hideExcerpts: false, countOpened: false, breakAfter: 0 };
/** The largest break choice read back from storage: a damaged value is off, not a guess. */
const BREAK_MAX = 1000;

/** The browser's storage, or null where there is none or touching it throws. */
function browserStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function get(storage: StorageLike | null, key: string): string | null {
  try {
    return storage === null ? null : storage.getItem(key);
  } catch {
    return null;
  }
}
/** Writes (or removes) one key. False when the browser would not take it: the caller then keeps its own copy for the visit. */
function put(storage: StorageLike | null, key: string, value: string | null): boolean {
  try {
    if (storage === null) return false;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** What is stored, with a value that is not one of ours read as off. */
export function readCare(storage: StorageLike | null = browserStorage()): Care {
  const breakText = get(storage, KEY.breakAfter);
  const n = breakText !== null && /^\d{1,4}$/.test(breakText) ? Number(breakText) : 0;
  return { hideExcerpts: get(storage, KEY.hide) === '1', countOpened: get(storage, KEY.count) === '1', breakAfter: n >= 1 && n <= BREAK_MAX ? n : 0 };
}

/** Writes the fields given: an "on" is stored, a field that went back to off is removed (nothing is left in the browser). Never throws. */
export function writeCare(patch: Partial<Care>, storage: StorageLike | null = browserStorage()): void {
  if (patch.hideExcerpts !== undefined) put(storage, KEY.hide, patch.hideExcerpts ? '1' : null);
  if (patch.countOpened !== undefined) put(storage, KEY.count, patch.countOpened ? '1' : null);
  if (patch.breakAfter !== undefined) put(storage, KEY.breakAfter, patch.breakAfter > 0 ? String(patch.breakAfter) : null);
}

/** The browser's local date of a moment, `2027-01-15`: the day the counter belongs to. */
export function localDay(now: number): string {
  const d = new Date(now);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

interface Opened {
  day: string;
  n: number;
}

/** The stored day and count, or null when absent or damaged. */
function readStoredOpened(storage: StorageLike | null): Opened | null {
  const text = get(storage, KEY.day);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const { day, n } = v as { day?: unknown; n?: unknown };
    return typeof day === 'string' && typeof n === 'number' && Number.isInteger(n) && n >= 0 ? { day, n } : null;
  } catch {
    return null;
  }
}

/**
 * The visit's own copy of the count, used only once the browser has refused a write (a blocked or full storage): then the count still lasts for the visit. While storage works, the
 * stored value is the truth.
 */
let visitOpened: Opened | null = null;
let storageFailed = false;

/** How many excerpts were opened on the local day of `now`; 0 on another day. */
export function readOpened(now: number, storage: StorageLike | null = browserStorage()): number {
  const day = localDay(now);
  if (storageFailed && visitOpened?.day === day) return visitOpened.n;
  const stored = readStoredOpened(storage);
  return stored !== null && stored.day === day ? stored.n : 0;
}

/** One more excerpt opened today: stores `{ day, n }` and answers the new count. The caller asks only when counting is on. */
export function addOpened(now: number, storage: StorageLike | null = browserStorage()): number {
  const day = localDay(now);
  const n = readOpened(now, storage) + 1;
  if (!put(storage, KEY.day, JSON.stringify({ day, n }))) {
    storageFailed = true;
    visitOpened = { day, n };
  }
  return n;
}

// ---- the settings the hub holds ---------------------------------------------------------------------------------------------------------------

let current: Care | null = null;
const listeners = new Set<() => void>();

/** The settings in force: read from the browser once, then kept (so a storage that fails changes nothing until the page is left). The same object until a setting changes. */
export function careSettings(): Care {
  current ??= readCare();
  return current;
}

/** Changes settings: kept for the visit and written to the browser. Tells the parts that listen only when something changed. */
export function setCare(patch: Partial<Care>): void {
  const before = careSettings();
  const next: Care = { ...before, ...patch };
  if (next.hideExcerpts === before.hideExcerpts && next.countOpened === before.countOpened && next.breakAfter === before.breakAfter) return;
  current = next;
  writeCare(patch);
  for (const fn of [...listeners]) fn();
}

/** Flips "hide excerpts until I open them": what the command bar's entry does. */
export function toggleHideExcerpts(): void {
  setCare({ hideExcerpts: !careSettings().hideExcerpts });
}

export function subscribeCare(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Forgets what the module holds, so the next read comes from the browser again (tests, and a hub that is mounted again). */
export function resetCare(): void {
  current = null;
  visitOpened = null;
  storageFailed = false;
  listeners.clear();
}

export { OFF as CARE_OFF };
