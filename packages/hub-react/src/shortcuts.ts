import { isTypingTarget } from './dom.js';
import type { HubT, HubText } from './i18n.js';

// The keyboard shortcuts, as a pure decision: given a key event, which action (if any) it asks for. The hub's one listener
// calls this; nothing here touches the page.

export type ShortcutAction = 'next' | 'previous' | 'takeNext' | 'command' | 'help' | 'escape' | 'undo';

/** The parts of a `KeyboardEvent` the decision reads, so a test can hand in a plain object. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: EventTarget | null;
  /** Where the event began; read before `target`, which a listener outside a shadow root sees as the host. */
  composedPath?: () => EventTarget[];
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/**
 * The keys of the AI's suggestion (level 2), answered by the case that is open, where Quick keys act: A accepts it into the Undo hold, E opens
 * the editor. Neither is one the hub's own listener answers ({@link shortcutFor} leaves them alone).
 */
export const AI_KEYS = { accept: 'a', edit: 'e' } as const;

/**
 * How long after a move (with Quick keys on) the case under the cursor is opened. Every further move starts it again, so a held key
 * opens only the row it stops on.
 * @experimental
 */
export const QUEUE_OPEN_DELAY_MS = 200;

// Where an arrow key may move between cases: a row of the queue, or the case's own title (where the hub puts focus on arrival).
const ARROW_ORIGIN = '.cw-queue .cw-case-link, .cw-screen-title';
// Where it may not: the transcript (its own scroller), and any window.
const ARROW_NEVER = '.cw-transcript, [role="dialog"]';

/**
 * Whether an arrow key pressed here moves between cases. Only on a queue row or the case title, never inside the transcript (a
 * scroller), a field, a select, a menu or a window: everywhere else the arrow keys scroll or move as the page expects. It reads where
 * the event began, as {@link isTypingTarget} does, so it holds inside a shadow root.
 */
export function arrowsMoveCases(e: Pick<KeyLike, 'target' | 'composedPath'>): boolean {
  if (isTypingTarget(e)) return false;
  const origin = e.composedPath?.()[0] ?? e.target;
  if (typeof Element === 'undefined' || !(origin instanceof Element)) return false;
  return origin.closest(ARROW_ORIGIN) !== null && origin.closest(ARROW_NEVER) === null;
}

/**
 * What a key press asks for, or null. Never while typing, while an input method is composing, or when something has already
 * handled the key. Ctrl or Cmd with K opens the command bar; every other combination with Ctrl, Cmd or Alt belongs to the
 * browser or the system and is left alone. `N` and `U` do not repeat, so holding them cannot take case after case or undo decision after
 * decision; `J`, `K` and the arrow keys only move, so they do. The arrow keys move between cases only where {@link arrowsMoveCases} says so.
 * @experimental
 */
export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.defaultPrevented === true || e.isComposing === true || isTypingTarget(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) {
    const onlyCtrlOrCmd = (e.ctrlKey !== e.metaKey) && !e.altKey && !e.shiftKey;
    return e.key.toLowerCase() === 'k' && onlyCtrlOrCmd ? 'command' : null;
  }
  switch (e.key) {
    case 'j':
    case 'J':
      return 'next';
    case 'k':
    case 'K':
      return 'previous';
    case 'n':
    case 'N':
      return e.repeat ? null : 'takeNext';
    case 'u':
    case 'U':
      return e.repeat ? null : 'undo';
    case 'ArrowDown':
      return !e.shiftKey && arrowsMoveCases(e) ? 'next' : null;
    case 'ArrowUp':
      return !e.shiftKey && arrowsMoveCases(e) ? 'previous' : null;
    case '?':
      return 'help';
    case 'Escape':
      return 'escape';
    default:
      return null;
  }
}

/** A key as it is written on a key cap: letters and symbols as they are, `Ctrl` and `Esc` from the catalog. */
export function keyLabel(t: HubT, key: string): string {
  switch (key) {
    case 'Ctrl':
      return t('hub.key.ctrl');
    case 'Cmd':
      return t('hub.key.cmd');
    case 'Esc':
      return t('hub.key.esc');
    case 'Enter':
      return t('hub.key.enter');
    case 'Down':
      return t('hub.key.down');
    case 'Up':
      return t('hub.key.up');
    default:
      return key;
  }
}

/** One line of the shortcut sheet: the keys to press, another way to press it, and the catalog line saying what it does. */
export interface ShortcutRow {
  /** The key caps, pressed together (`Ctrl` stands for Cmd on a Mac). */
  keys: readonly string[];
  /** Another key that does the same (the arrow beside J and K). */
  alt?: readonly string[];
  label: HubText;
  /** It only applies with Quick keys on: the sheet says so while they are off. */
  quickOnly?: boolean;
}

/** What the shortcut sheet lists, in three groups. */
export const SHORTCUT_GROUPS: ReadonlyArray<{ group: 'move' | 'act' | 'general'; title: HubText; rows: readonly ShortcutRow[] }> = [
  {
    group: 'move',
    title: 'hub.shortcuts.group.move',
    rows: [
      { keys: ['J'], alt: ['Down'], label: 'hub.shortcuts.next' },
      { keys: ['K'], alt: ['Up'], label: 'hub.shortcuts.previous' },
      { keys: ['N'], label: 'hub.shortcuts.takeNext' },
    ],
  },
  {
    group: 'act',
    title: 'hub.shortcuts.group.act',
    rows: [
      { keys: ['1'], label: 'hub.shortcuts.primary', quickOnly: true },
      { keys: ['2'], label: 'hub.shortcuts.dismiss', quickOnly: true },
      { keys: ['3'], label: 'hub.shortcuts.warning', quickOnly: true },
      { keys: ['Ctrl', 'Enter'], label: 'hub.shortcuts.decide' },
      { keys: ['U'], label: 'hub.shortcuts.undo' },
    ],
  },
  {
    group: 'general',
    title: 'hub.shortcuts.group.general',
    rows: [
      { keys: ['Ctrl', 'K'], label: 'hub.shortcuts.command' },
      { keys: ['?'], label: 'hub.shortcuts.help' },
      { keys: ['Esc'], label: 'hub.shortcuts.escape' },
    ],
  },
];

/** The key that goes with K: Cmd on a Mac, Ctrl elsewhere. */
export function modKey(): 'Ctrl' | 'Cmd' {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'Cmd' : 'Ctrl';
}
