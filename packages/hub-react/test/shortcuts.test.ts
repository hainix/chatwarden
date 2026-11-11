// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTypingTarget } from '../src/dom.js';
import { SHORTCUTS, shortcutFor } from '../src/shortcuts.js';
import type { KeyLike } from '../src/shortcuts.js';
import { en } from '../src/i18n.js';

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

describe('shortcutFor: what each key means', () => {
  it.each([
    ['j', 'next'],
    ['J', 'next'],
    ['k', 'previous'],
    ['K', 'previous'],
    ['n', 'takeNext'],
    ['N', 'takeNext'],
    ['?', 'help'],
    ['Escape', 'escape'],
  ])('%s is %s', (k, action) => {
    expect(shortcutFor(key(k, { shiftKey: k === '?' || (k.length === 1 && k !== k.toLowerCase()) }))).toBe(action);
  });

  it('Ctrl+K and Cmd+K open the command bar, either case', () => {
    expect(shortcutFor(key('k', { ctrlKey: true }))).toBe('command');
    expect(shortcutFor(key('K', { ctrlKey: true }))).toBe('command');
    expect(shortcutFor(key('k', { metaKey: true }))).toBe('command');
  });

  it('other keys mean nothing', () => {
    for (const k of ['a', 'x', '1', '2', '3', 'Enter', ' ', 'Tab', 'ArrowDown', 'F5', '/', 'm']) expect(shortcutFor(key(k)), k).toBeNull();
  });
});

describe('shortcutFor: combinations the browser owns are left alone', () => {
  it.each(['j', 'k', 'n', '?'])('Ctrl or Cmd or Alt with %s is not a shortcut (except Ctrl/Cmd+K)', (k) => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      const action = shortcutFor(key(k, { [mod]: true }));
      if (k === 'k' && mod !== 'altKey') expect(action).toBe('command');
      else expect(action, `${mod}+${k}`).toBeNull();
    }
  });

  it('Ctrl+Shift+K and Alt+K and Cmd+Shift+K are not the command bar', () => {
    expect(shortcutFor(key('K', { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key('k', { altKey: true }))).toBeNull();
    expect(shortcutFor(key('K', { metaKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFor(key('k', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('Ctrl+N, Cmd+N, Ctrl+J, Ctrl+Escape do nothing here', () => {
    expect(shortcutFor(key('n', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('n', { metaKey: true }))).toBeNull();
    expect(shortcutFor(key('j', { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('Escape', { ctrlKey: true }))).toBeNull();
  });
});

describe('shortcutFor: never while typing', () => {
  const typing = [
    '<input type="text">',
    '<input>',
    '<input type="search">',
    '<input type="checkbox">',
    '<textarea></textarea>',
    '<select><option>a</option></select>',
    '<div contenteditable="true">x</div>',
    '<div contenteditable="">x</div>',
    '<div contenteditable="plaintext-only">x</div>',
    '<div role="textbox" tabindex="0">x</div>',
    '<div role="combobox" tabindex="0">x</div>',
    '<span contenteditable="true"><b id="inner">x</b></span>',
  ];

  it.each(typing)('is silent in %s, for every key', (html) => {
    const host = el(html);
    const target = host.querySelector('#inner') ?? host;
    expect(isTypingTarget({ target })).toBe(true);
    for (const k of ['j', 'k', 'n', '?', 'Escape']) expect(shortcutFor(key(k, { target })), k).toBeNull();
    expect(shortcutFor(key('k', { target, ctrlKey: true }))).toBeNull();
  });

  it('speaks on a button, a link, a list row and the page', () => {
    for (const html of ['<button>x</button>', '<a href="#/">x</a>', '<li tabindex="0">x</li>', '<div contenteditable="false">x</div>']) {
      const target = el(html);
      expect(isTypingTarget({ target }), html).toBe(false);
      expect(shortcutFor(key('j', { target })), html).toBe('next');
    }
    expect(shortcutFor(key('j', { target: document.body }))).toBe('next');
    expect(shortcutFor(key('j', { target: null }))).toBe('next');
  });

  it('is silent while an input method is composing, and when something already handled the key', () => {
    expect(shortcutFor(key('j', { isComposing: true }))).toBeNull();
    expect(shortcutFor(key('j', { defaultPrevented: true }))).toBeNull();
  });
});

describe('shortcutFor: an event that began inside a shadow root', () => {
  // A listener outside the shadow root sees `target` as the host; the path still starts where the key was pressed.
  function inShadow(html: string) {
    const host = el('<div></div>');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = html;
    return { host, origin: shadow.firstElementChild as HTMLElement };
  }

  it('is silent when the key began in a field, whatever target says', () => {
    const { host, origin } = inShadow('<input>');
    for (const k of ['j', 'k', 'n', '?', 'Escape']) expect(shortcutFor(key(k, { target: host, composedPath: () => [origin, host] })), k).toBeNull();
  });

  it('speaks when the key began on a button, even though the host is not one', () => {
    const { host, origin } = inShadow('<button>x</button>');
    expect(shortcutFor(key('j', { target: host, composedPath: () => [origin, host] }))).toBe('next');
  });

  it('falls back to target when there is no path', () => {
    const { origin } = inShadow('<textarea></textarea>');
    expect(shortcutFor(key('j', { target: origin }))).toBeNull();
  });
});

describe('shortcutFor: a held key', () => {
  it('N does not repeat (holding it would take a case after case), but J and K do', () => {
    expect(shortcutFor(key('n', { repeat: true }))).toBeNull();
    expect(shortcutFor(key('j', { repeat: true }))).toBe('next');
    expect(shortcutFor(key('k', { repeat: true }))).toBe('previous');
  });
});

describe('the shortcut sheet table', () => {
  it('lists every action once, with a word from the catalog', () => {
    const actions = SHORTCUTS.map((s) => s.action);
    expect(new Set(actions).size).toBe(actions.length);
    for (const a of ['next', 'previous', 'takeNext', 'command', 'help', 'escape']) expect(actions).toContain(a);
    for (const s of SHORTCUTS) expect(Object.keys(en)).toContain(s.label);
  });

  it('shows Ctrl and K as two keys for the command bar, and one key for the others', () => {
    expect(SHORTCUTS.find((s) => s.action === 'command')?.keys).toEqual(['Ctrl', 'K']);
    expect(SHORTCUTS.find((s) => s.action === 'next')?.keys).toEqual(['J']);
  });
});
