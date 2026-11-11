import { afterEach, describe, expect, it, vi } from 'vitest';

// The page's hubs, as dom.ts keeps them: a registry on `globalThis` under a symbol from the global registry, so that two copies of
// hub-react on one page (the element script plus an adopter's own, or two element scripts) see one list of hubs and install one
// window listener between them. Module state would make each copy think its hub is the only one.

type Dom = typeof import('../src/dom.js');
const copy = (n: number): Promise<Dom> => import(/* @vite-ignore */ `../src/dom.js?copy=${n}`) as Promise<Dom>;

const registered: Array<() => void> = [];
afterEach(() => {
  for (const stop of registered.splice(0)) stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  (document.activeElement as HTMLElement | null)?.blur();
});

const press = (key = 'j', on: EventTarget = document.body): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true });
  on.dispatchEvent(e);
  return e;
};
const hubEl = (): HTMLElement => document.body.appendChild(document.createElement('div'));
const entry = (primary = false) => ({ dispatch: vi.fn(), primary });
const keydownListeners = (spy: { mock: { calls: unknown[][] } }): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;

describe('two copies of the module share one registry and one page listener', () => {
  it('registering from two copies installs exactly one keydown listener on the window', async () => {
    const [a, b] = [await copy(1), await copy(2)];
    expect(a).not.toBe(b);
    const add = vi.spyOn(window, 'addEventListener');
    registered.push(a.registerHub(hubEl(), entry()));
    registered.push(b.registerHub(hubEl(), entry()));
    expect(keydownListeners(add)).toBe(1);
  });

  it('a lone hub from either copy answers a key on the body, once', async () => {
    const [a, b] = [await copy(3), await copy(4)];
    const mine = entry();
    registered.push(a.registerHub(hubEl(), mine));
    press();
    expect(mine.dispatch).toHaveBeenCalledTimes(1);
    registered.push(b.registerHub(hubEl(), entry()));
    // Now two: neither is primary, so nobody answers.
    press();
    expect(mine.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a primary from the second copy is the one that answers; leaving hands the page back', async () => {
    const [a, b] = [await copy(5), await copy(6)];
    const first = entry();
    const second = entry(true);
    registered.push(a.registerHub(hubEl(), first));
    const leave = b.registerHub(hubEl(), second);
    press();
    expect(second.dispatch).toHaveBeenCalledTimes(1);
    expect(first.dispatch).not.toHaveBeenCalled();
    leave();
    press();
    expect(first.dispatch).toHaveBeenCalledTimes(1);
  });

  it('the copy that installed the listener can leave first; the other copy keeps the page working', async () => {
    const [a, b] = [await copy(7), await copy(8)];
    const mineB = entry();
    const leaveA = a.registerHub(hubEl(), entry());
    registered.push(b.registerHub(hubEl(), mineB));
    leaveA();
    press();
    expect(mineB.dispatch).toHaveBeenCalledTimes(1);
  });

  it('the last hub out removes the listener, from whichever copy it was', async () => {
    const [a, b] = [await copy(9), await copy(10)];
    const remove = vi.spyOn(window, 'removeEventListener');
    const leaveA = a.registerHub(hubEl(), entry());
    const leaveB = b.registerHub(hubEl(), entry());
    leaveA();
    expect(keydownListeners(remove)).toBe(0);
    leaveB();
    expect(keydownListeners(remove)).toBe(1);
  });
});

describe('who gets a key pressed with nothing focused', () => {
  it('nobody when there are no hubs, and nothing throws', async () => {
    const a = await copy(11);
    expect(() => press()).not.toThrow();
    expect(a.registerHub).toBeTypeOf('function');
  });

  it('never Escape, never a key already prevented, never a key pressed inside a hub (React hears those)', async () => {
    const a = await copy(12);
    const root = hubEl();
    const only = entry();
    registered.push(a.registerHub(root, only));
    press('Escape');
    const prevented = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
    document.body.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    document.body.dispatchEvent(prevented);
    const inside = root.appendChild(document.createElement('button'));
    press('j', inside);
    expect(only.dispatch).not.toHaveBeenCalled();
  });

  it('not while the page has focus somewhere other than the body', async () => {
    const a = await copy(13);
    const only = entry();
    registered.push(a.registerHub(hubEl(), only));
    const mine = document.body.appendChild(document.createElement('button'));
    mine.focus();
    press('j', mine);
    expect(only.dispatch).not.toHaveBeenCalled();
    mine.blur();
    press();
    expect(only.dispatch).toHaveBeenCalledTimes(1);
  });

  it('registering the same root again replaces its entry, and its first leave cannot remove the second', async () => {
    const a = await copy(14);
    const root = hubEl();
    const old = entry();
    const fresh = entry();
    const leaveOld = a.registerHub(root, old);
    registered.push(a.registerHub(root, fresh));
    leaveOld();
    press();
    expect(fresh.dispatch).toHaveBeenCalledTimes(1);
    expect(old.dispatch).not.toHaveBeenCalled();
  });
});

describe('activeOf', () => {
  it('is the focus of the root the node is in, and null for no node', async () => {
    const a = await copy(15);
    const button = document.body.appendChild(document.createElement('button'));
    button.focus();
    expect(a.activeOf(button)).toBe(button);
    expect(a.activeOf(null)).toBeNull();
    const host = hubEl();
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = shadow.appendChild(document.createElement('button'));
    inner.focus();
    expect(a.activeOf(inner)).toBe(inner);
    expect(a.activeOf(button)).toBe(host);
  });
});
