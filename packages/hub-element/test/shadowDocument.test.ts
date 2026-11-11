import { afterEach, describe, expect, it, vi } from 'vitest';
import { cwDocument, registerShadowRoot } from '../src/shadowDocument.js';

// hub-react reads the page: document.activeElement, getElementById, querySelector and page-wide key listeners. Inside a shadow
// root all of those lie (the active element is the host, the key's target is the host, ids are not found). In the element's
// bundle hub-react's `document` is this object, which answers for the shadow roots that were registered and for the page otherwise.

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.body.replaceChildren();
});

function hostWithRoot(html = '<button id="a">a</button><input id="field" type="text"><div id="box"><span id="deep"></span></div>') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = html;
  cleanups.push(registerShadowRoot(root));
  return { host, root };
}

const key = (target: Element, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: 'j', bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

describe('activeElement', () => {
  it('is the element that has focus inside a registered shadow root, not its host', () => {
    const { root } = hostWithRoot();
    const button = root.getElementById('a') as HTMLElement;
    button.focus();
    expect(document.activeElement).not.toBe(button);
    expect(cwDocument.activeElement).toBe(button);
  });

  it('is the host when nothing inside has focus, and the page element when the page has it', () => {
    const { host } = hostWithRoot();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    expect(cwDocument.activeElement).toBe(outside);
    host.tabIndex = -1;
    host.focus();
    expect(cwDocument.activeElement).toBe(host);
  });

  it('does not look inside a shadow root that was never registered (somebody else\'s)', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="x">x</button>';
    (root.getElementById('x') as HTMLElement).focus();
    expect(cwDocument.activeElement).toBe(host);
  });

  it('goes through a nested registered root to the innermost element', () => {
    const outer = hostWithRoot('<div id="slot"></div>');
    const innerHost = document.createElement('div');
    outer.root.getElementById('slot')?.append(innerHost);
    const inner = innerHost.attachShadow({ mode: 'open' });
    inner.innerHTML = '<button id="deepest">d</button>';
    cleanups.push(registerShadowRoot(inner));
    (inner.getElementById('deepest') as HTMLElement).focus();
    expect(cwDocument.activeElement).toBe(inner.getElementById('deepest'));
  });
});

describe('getElementById and querySelector', () => {
  it('find elements inside registered shadow roots, and in the page', () => {
    const { root } = hostWithRoot();
    const pageEl = document.createElement('i');
    pageEl.id = 'page-only';
    document.body.append(pageEl);
    expect(cwDocument.getElementById('deep')).toBe(root.getElementById('deep'));
    expect(cwDocument.getElementById('page-only')).toBe(pageEl);
    expect(cwDocument.getElementById('nope')).toBeNull();
    expect(cwDocument.querySelector('#box > span')).toBe(root.getElementById('deep'));
    expect(cwDocument.querySelector('i#page-only')).toBe(pageEl);
    expect(cwDocument.querySelector('.nothing')).toBeNull();
  });

  it('do not find elements of a root that was never registered', () => {
    const host = document.createElement('div');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<b id="private"></b>';
    expect(cwDocument.getElementById('private')).toBeNull();
    expect(cwDocument.querySelector('#private')).toBeNull();
  });

  it('prefer the root that has focus when two roots hold the same id', () => {
    const one = hostWithRoot('<button id="same">one</button>');
    const two = hostWithRoot('<button id="same">two</button>');
    (two.root.getElementById('same') as HTMLElement).focus();
    expect(cwDocument.getElementById('same')).toBe(two.root.getElementById('same'));
    (one.root.getElementById('same') as HTMLElement).focus();
    expect(cwDocument.getElementById('same')).toBe(one.root.getElementById('same'));
  });

  it('stop looking in a root once it is unregistered', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<b id="gone"></b>';
    const off = registerShadowRoot(root);
    expect(cwDocument.getElementById('gone')).not.toBeNull();
    off();
    expect(cwDocument.getElementById('gone')).toBeNull();
  });
});

describe('key listeners', () => {
  it('hear keys pressed inside a registered root, with the real element as the target', () => {
    const { root } = hostWithRoot();
    const seen: Array<{ target: unknown; key: string }> = [];
    const listener = (e: Event) => seen.push({ target: e.target, key: (e as KeyboardEvent).key });
    cwDocument.addEventListener('keydown', listener);
    cleanups.push(() => cwDocument.removeEventListener('keydown', listener));
    const field = root.getElementById('field') as HTMLElement;
    key(field);
    expect(seen).toEqual([{ target: field, key: 'j' }]);
  });

  it('a listener can still stop the key: preventDefault reaches the real event', () => {
    const { root } = hostWithRoot();
    const listener = (e: Event) => e.preventDefault();
    cwDocument.addEventListener('keydown', listener);
    cleanups.push(() => cwDocument.removeEventListener('keydown', listener));
    expect(key(root.getElementById('a') as HTMLElement).defaultPrevented).toBe(true);
  });

  it('never hear keys pressed in the page outside (the hub must not take the page\'s keys)', () => {
    hostWithRoot();
    const outside = document.createElement('input');
    document.body.append(outside);
    const listener = vi.fn();
    cwDocument.addEventListener('keydown', listener);
    cleanups.push(() => cwDocument.removeEventListener('keydown', listener));
    key(outside);
    key(document.body);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keyup and keypress are held to the same rule', () => {
    const { root } = hostWithRoot();
    const outside = document.createElement('input');
    document.body.append(outside);
    const up = vi.fn();
    cwDocument.addEventListener('keyup', up);
    cleanups.push(() => cwDocument.removeEventListener('keyup', up));
    outside.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', bubbles: true, composed: true }));
    expect(up).not.toHaveBeenCalled();
    (root.getElementById('a') as HTMLElement).dispatchEvent(new KeyboardEvent('keyup', { key: 'j', bubbles: true, composed: true }));
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('removeEventListener stops a listener, and adding the same listener twice is one listener', () => {
    const { root } = hostWithRoot();
    const listener = vi.fn();
    cwDocument.addEventListener('keydown', listener);
    cwDocument.addEventListener('keydown', listener);
    key(root.getElementById('a') as HTMLElement);
    expect(listener).toHaveBeenCalledTimes(1);
    cwDocument.removeEventListener('keydown', listener);
    key(root.getElementById('a') as HTMLElement);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('take a listener object with handleEvent', () => {
    const { root } = hostWithRoot();
    const handleEvent = vi.fn();
    const object = { handleEvent };
    cwDocument.addEventListener('keydown', object);
    cleanups.push(() => cwDocument.removeEventListener('keydown', object));
    key(root.getElementById('a') as HTMLElement);
    expect(handleEvent).toHaveBeenCalledTimes(1);
  });
});

describe('other events and properties', () => {
  it('pointer events from inside arrive with the real target (so "was the click inside this menu?" works)', () => {
    const { root } = hostWithRoot();
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push(e.target);
    cwDocument.addEventListener('pointerdown', listener);
    cleanups.push(() => cwDocument.removeEventListener('pointerdown', listener));
    const span = root.getElementById('deep') as HTMLElement;
    span.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(seen).toEqual([span]);
  });

  it('pointer events from the page outside still arrive (a click away closes a menu)', () => {
    hostWithRoot();
    const outside = document.createElement('p');
    document.body.append(outside);
    const listener = vi.fn();
    cwDocument.addEventListener('pointerdown', listener);
    cleanups.push(() => cwDocument.removeEventListener('pointerdown', listener));
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('events with no path through a root (visibilitychange) go straight to the page', () => {
    const listener = vi.fn();
    cwDocument.addEventListener('visibilitychange', listener);
    cleanups.push(() => cwDocument.removeEventListener('visibilitychange', listener));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('everything else is the real document: visibilityState, body, createElement', () => {
    expect(cwDocument.visibilityState).toBe(document.visibilityState);
    expect(cwDocument.body).toBe(document.body);
    expect(cwDocument.createElement('div').tagName).toBe('DIV');
  });
});
