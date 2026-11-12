// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n.js';
import { SHORTCUT_GROUPS, arrowsMoveCases, shortcutFor } from '../src/shortcuts.js';
import type { KeyLike } from '../src/shortcuts.js';

// The keys the keyboard queue mode adds: U to undo, the arrow keys where they cannot scroll anything, and the table that holds the
// rest (modifiers, held keys, typing targets) in one place.

const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  target: document.body,
  ...over,
});
const el = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild as Element;
};
const row = (): Element => el('<section class="cw-queue"><a class="cw-case-link" href="#/">Alpha</a></section>').querySelector('a') as Element;
const title = (): Element => el('<h2 class="cw-screen-title" tabindex="-1">Alpha</h2>');

describe('shortcutFor: U undoes', () => {
  it('u and U are undo, and it does not repeat (a held key would undo case after case)', () => {
    expect(shortcutFor(key('u'))).toBe('undo');
    expect(shortcutFor(key('U', { shiftKey: true }))).toBe('undo');
    expect(shortcutFor(key('u', { repeat: true }))).toBeNull();
    expect(shortcutFor(key('U', { repeat: true, shiftKey: true }))).toBeNull();
  });

  it('Ctrl+U, Cmd+U and Alt+U belong to the browser or the system', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) expect(shortcutFor(key('u', { [mod]: true })), mod).toBeNull();
  });

  it('is silent while typing, while composing, and when the key was handled', () => {
    expect(shortcutFor(key('u', { isComposing: true }))).toBeNull();
    expect(shortcutFor(key('u', { defaultPrevented: true }))).toBeNull();
    for (const html of ['<input>', '<textarea></textarea>', '<select><option>a</option></select>', '<div contenteditable="true">x</div>', '<div role="searchbox" tabindex="0">x</div>', '<div role="combobox" tabindex="0">x</div>']) {
      expect(shortcutFor(key('u', { target: el(html) })), html).toBeNull();
    }
  });
});

describe('shortcutFor: the arrow keys', () => {
  it('Down and Up move between cases when focus is on a queue row or on the case title', () => {
    for (const target of [row(), title()]) {
      expect(shortcutFor(key('ArrowDown', { target })), target.className).toBe('next');
      expect(shortcutFor(key('ArrowUp', { target })), target.className).toBe('previous');
    }
  });

  it('they scroll as usual everywhere else: the page, a button, the bar, the transcript, a select, a window', () => {
    const transcript = el('<div class="cw-transcript"><a class="cw-case-link" href="#/">x</a></div>').querySelector('a') as Element;
    const dialog = el('<div role="dialog" aria-modal="true"><h2 class="cw-screen-title" tabindex="-1">x</h2></div>').querySelector('h2') as Element;
    const select = el('<select><option>a</option></select>');
    const bar = el('<section class="cw-dock"><button>Decide</button></section>').querySelector('button') as Element;
    for (const target of [document.body, transcript, dialog, select, bar, el('<button>x</button>')]) {
      expect(shortcutFor(key('ArrowDown', { target })), target.tagName).toBeNull();
      expect(shortcutFor(key('ArrowUp', { target })), target.tagName).toBeNull();
    }
  });

  it('they may repeat (they only move), and a modifier with an arrow is not ours', () => {
    expect(shortcutFor(key('ArrowDown', { target: row(), repeat: true }))).toBe('next');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) expect(shortcutFor(key('ArrowDown', { target: row(), [mod]: true })), mod).toBeNull();
  });

  it('arrowsMoveCases: true on a row and the title; false in the transcript, a field, the page and with no target', () => {
    expect(arrowsMoveCases(key('ArrowDown', { target: row() }))).toBe(true);
    expect(arrowsMoveCases(key('ArrowDown', { target: title() }))).toBe(true);
    expect(arrowsMoveCases(key('ArrowDown', { target: el('<textarea></textarea>') }))).toBe(false);
    expect(arrowsMoveCases(key('ArrowDown', { target: el('<div class="cw-transcript"><h2 class="cw-screen-title">x</h2></div>').firstElementChild as Element }))).toBe(false);
    expect(arrowsMoveCases(key('ArrowDown', { target: document.body }))).toBe(false);
    expect(arrowsMoveCases(key('ArrowDown', { target: null }))).toBe(false);
  });

  it('inside a shadow root the origin of the event counts, not the host', () => {
    const host = el('<div></div>');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section class="cw-queue"><a class="cw-case-link" href="#/">x</a></section>';
    const origin = shadow.querySelector('a') as HTMLElement;
    expect(shortcutFor(key('ArrowDown', { target: host, composedPath: () => [origin, host] }))).toBe('next');
    expect(shortcutFor(key('ArrowDown', { target: host }))).toBeNull();
  });
});

describe('shortcutFor: keys, modifiers and targets', () => {
  const plain = ['j', 'J', 'k', 'K', 'n', 'N', 'u', 'U', '?', 'Escape'];
  it.each(plain)('%s acts on a plain target, and on nothing with Ctrl, Cmd or Alt (except Ctrl or Cmd+K)', (k) => {
    expect(shortcutFor(key(k, { shiftKey: k.length === 1 && k !== k.toLowerCase() }))).not.toBeNull();
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      const action = shortcutFor(key(k, { [mod]: true }));
      if (k.toLowerCase() === 'k' && mod !== 'altKey') expect(action).toBe('command');
      else expect(action, `${mod}+${k}`).toBeNull();
    }
  });

  it('K alone is previous and Ctrl or Cmd+K is the command bar, with Caps Lock or Shift too', () => {
    expect(shortcutFor(key('k'))).toBe('previous');
    expect(shortcutFor(key('K'))).toBe('previous');
    expect(shortcutFor(key('K', { shiftKey: true }))).toBe('previous');
    expect(shortcutFor(key('k', { ctrlKey: true }))).toBe('command');
    expect(shortcutFor(key('K', { metaKey: true }))).toBe('command');
    expect(shortcutFor(key('K', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('J, K and the arrows repeat; N and U do not', () => {
    expect(shortcutFor(key('j', { repeat: true }))).toBe('next');
    expect(shortcutFor(key('k', { repeat: true }))).toBe('previous');
    expect(shortcutFor(key('ArrowUp', { repeat: true, target: row() }))).toBe('previous');
    expect(shortcutFor(key('n', { repeat: true }))).toBeNull();
    expect(shortcutFor(key('u', { repeat: true }))).toBeNull();
  });
});

describe('the shortcut groups', () => {
  const chord = (keys: readonly string[]): string => keys.join('+');
  it('are Move, Act on a case and Anywhere, each row with its keys and a catalog line', () => {
    expect(SHORTCUT_GROUPS.map((g) => g.group)).toEqual(['move', 'act', 'general']);
    for (const g of SHORTCUT_GROUPS) for (const r of g.rows) expect(Object.keys(en), r.label).toContain(r.label);
    expect(SHORTCUT_GROUPS[0]?.rows.map((r) => chord(r.keys))).toEqual(['J', 'K', 'N']);
    expect(SHORTCUT_GROUPS[0]?.rows.map((r) => (r.alt === undefined ? null : chord(r.alt)))).toEqual(['Down', 'Up', null]);
    expect(SHORTCUT_GROUPS[1]?.rows.map((r) => chord(r.keys))).toEqual(['1', '2', '3', 'Ctrl+Enter', 'U']);
    expect(SHORTCUT_GROUPS[2]?.rows.map((r) => chord(r.keys))).toEqual(['Ctrl+K', '?', 'Esc']);
  });

  it('rows that only apply with Quick keys on say so', () => {
    const rows = SHORTCUT_GROUPS.flatMap((g) => g.rows);
    const quickOnly = rows.filter((r) => r.quickOnly === true).map((r) => chord(r.keys));
    expect(quickOnly).toEqual(expect.arrayContaining(['1', '2', '3']));
    for (const k of ['Ctrl+K', 'N', 'U', '?', 'Esc', 'Ctrl+Enter']) expect(quickOnly).not.toContain(k);
  });
});
