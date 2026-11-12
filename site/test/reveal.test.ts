// revealInOwnScrollBoxes: the tour brings its target into view by scrolling the hub's own scroll boxes, never the page.
// jsdom has no layout, so the rectangles and scroll sizes are faked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealInOwnScrollBoxes } from '../src/demo/reveal';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON() {} }) as DOMRect;

function scene(opts: { target: [number, number]; box?: [number, number]; scrollable?: boolean; bar?: number }) {
  document.body.innerHTML = `<div id="pane"><div id="box" style="overflow-y:auto"><button id="t">Restrict chat</button></div></div>${opts.bar === undefined ? '' : '<section class="tour" data-compact="true"></section>'}`;
  const pane = document.getElementById('pane') as HTMLElement;
  const box = document.getElementById('box') as HTMLElement;
  const target = document.getElementById('t') as HTMLElement;
  const [boxTop, boxHeight] = opts.box ?? [150, 600];
  box.getBoundingClientRect = () => rect(boxTop - box.scrollTop, boxHeight);
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => (opts.scrollable === false ? boxHeight : 1500) });
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => boxHeight });
  box.getBoundingClientRect = () => rect(boxTop, boxHeight);
  // the target sits at a fixed place in the box's content, so scrolling the box moves it
  target.getBoundingClientRect = () => rect(opts.target[0] - box.scrollTop, opts.target[1]);
  if (opts.bar !== undefined) (document.querySelector('.tour') as HTMLElement).getBoundingClientRect = () => rect(opts.bar as number, 90);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  return { pane, box, target };
}

describe('revealInOwnScrollBoxes', () => {
  it('scrolls the box so a target below its fold comes into view, near the top', () => {
    const { pane, box, target } = scene({ target: [900, 40] });
    revealInOwnScrollBoxes(target, pane);
    expect(box.scrollTop).toBeGreaterThan(0);
    const t = target.getBoundingClientRect();
    expect(t.top).toBeGreaterThanOrEqual(150);
    expect(t.bottom).toBeLessThanOrEqual(750);
  });
  it('leaves a target that is already visible alone (a visitor who scrolled the hub themselves is not fought)', () => {
    const { pane, box, target } = scene({ target: [300, 40] });
    revealInOwnScrollBoxes(target, pane);
    expect(box.scrollTop).toBe(0);
  });
  it('keeps the target clear of the phone’s tour bar at the bottom of the window', () => {
    const { pane, box, target } = scene({ target: [700, 40], bar: 740 });
    revealInOwnScrollBoxes(target, pane);
    expect(box.scrollTop).toBeGreaterThan(0);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(740);
  });
  it('does nothing when the box does not scroll', () => {
    const { pane, box, target } = scene({ target: [900, 40], scrollable: false });
    revealInOwnScrollBoxes(target, pane);
    expect(box.scrollTop).toBe(0);
  });
  it('never scrolls the page', () => {
    const { pane, target } = scene({ target: [900, 40] });
    const page = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const by = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const into = vi.fn();
    target.scrollIntoView = into;
    revealInOwnScrollBoxes(target, pane);
    expect(page).not.toHaveBeenCalled();
    expect(by).not.toHaveBeenCalled();
    expect(into).not.toHaveBeenCalled();
  });
  it('only walks the boxes inside the pane', () => {
    document.body.innerHTML = '<div id="outer" style="overflow-y:auto"><div id="pane"><button id="t">x</button></div></div>';
    const outer = document.getElementById('outer') as HTMLElement;
    Object.defineProperty(outer, 'scrollHeight', { configurable: true, value: 3000 });
    Object.defineProperty(outer, 'clientHeight', { configurable: true, value: 500 });
    const target = document.getElementById('t') as HTMLElement;
    target.getBoundingClientRect = () => rect(2000, 40);
    revealInOwnScrollBoxes(target, document.getElementById('pane') as HTMLElement);
    expect(outer.scrollTop).toBe(0);
  });
});
