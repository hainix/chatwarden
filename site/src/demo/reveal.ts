/**
 * Brings the control the tour is about into view by scrolling the hub's OWN scroll boxes, never the page. (`scrollIntoView` can move
 * the page under the visitor; this only sets `scrollTop` on the scrollable ancestors between the control and its pane.) A control
 * that is already visible, clear of the sticky header and of whatever covers the bottom of the window (the phone's tour bar), is left
 * alone, so a visitor who scrolled the hub themselves is not fought.
 */
export function revealInOwnScrollBoxes(target: HTMLElement, pane: HTMLElement): void {
  const sticky = (selector: string): number => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el === null) return 0;
    const r = el.getBoundingClientRect();
    return r.top <= 70 && r.bottom > 0 ? r.bottom : 0; // only while it is stuck to the top of the window
  };
  const topEdge = Math.max(sticky('.site-header'), sticky('.pane-tabs')) + 12;
  const bar = document.querySelector<HTMLElement>('.tour[data-compact]');
  const barTop = bar === null ? Infinity : bar.getBoundingClientRect().top;
  const bottomEdge = Math.min(window.innerHeight, barTop) - 12;
  for (let el = target.parentElement; el !== null && pane.contains(el); el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
    const box = el.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const top = Math.max(box.top, topEdge);
    const bottom = Math.min(box.bottom, bottomEdge);
    if (t.top >= top && t.bottom <= bottom) continue;
    el.scrollTop += t.top - top - 16; // near the top of what the visitor can see
  }
}
