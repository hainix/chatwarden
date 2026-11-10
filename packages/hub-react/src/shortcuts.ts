import type { HubT, HubText } from './i18n.js';

// The keyboard shortcuts, as a pure decision: given a key event, which action (if any) it asks for. The hub's one listener
// calls this; nothing here touches the page.

export type ShortcutAction = 'next' | 'previous' | 'takeNext' | 'command' | 'help' | 'escape';

/** The parts of a `KeyboardEvent` the decision reads, so a test can hand in a plain object. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: EventTarget | null;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

// Anything a person types into, or edits in place.
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"]';

/** Whether a key pressed on this element is text, not a command: a field, a menu, an editable region, or inside one. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && target.closest(TYPING) !== null;
}

/**
 * What a key press asks for, or null. Never while typing, while an input method is composing, or when something has already
 * handled the key. Ctrl or Cmd with K opens the command bar; every other combination with Ctrl, Cmd or Alt belongs to the
 * browser or the system and is left alone. `N` does not repeat, so holding it cannot take case after case.
 */
export function shortcutFor(e: KeyLike): ShortcutAction | null {
  if (e.defaultPrevented === true || e.isComposing === true || isTypingTarget(e.target)) return null;
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
  return key === 'Ctrl' ? t('hub.key.ctrl') : key === 'Esc' ? t('hub.key.esc') : key;
}

/** What the shortcut sheet lists, in order: the keys to press and the catalog line saying what they do. */
export const SHORTCUTS: ReadonlyArray<{ action: ShortcutAction; keys: string[]; label: HubText }> = [
  { action: 'next', keys: ['J'], label: 'hub.shortcuts.next' },
  { action: 'previous', keys: ['K'], label: 'hub.shortcuts.previous' },
  { action: 'takeNext', keys: ['N'], label: 'hub.shortcuts.takeNext' },
  { action: 'command', keys: ['Ctrl', 'K'], label: 'hub.shortcuts.command' },
  { action: 'help', keys: ['?'], label: 'hub.shortcuts.help' },
  { action: 'escape', keys: ['Esc'], label: 'hub.shortcuts.escape' },
];
