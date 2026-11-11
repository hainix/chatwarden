// Guards on the demo stylesheet: things a jsdom render cannot see.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'src', 'demo', 'demo.css'), 'utf8').split('\r\n').join('\n');
const demoSrc = readFileSync(join(__dirname, '..', 'src', 'demo', 'Demo.tsx'), 'utf8');

/** The bodies of every rule whose selector list is exactly `selector` (newlines in a comma list are matched as written). */
function bodies(selector: string): string[] {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|[{}]|\\*\\/)\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1] as string);
}

describe('demo.css', () => {
  it('the stacked breakpoint in JS matches the side-by-side breakpoint in CSS (1151px and 1152px)', () => {
    expect(demoSrc).toMatch(/\(max-width: 1151px\)/);
    expect(css).toMatch(/@media \(min-width: 1152px\)/);
  });
  it('side by side the game is the narrow column and the hub gets the rest (about 720px of the 1120px column)', () => {
    expect(css).toMatch(/@media \(min-width: 1152px\)\s*\{\s*\.demo-panes\s*\{\s*grid-template-columns:\s*minmax\(300px, 340px\) minmax\(0, 1fr\)/);
  });
  it('the hub fills the pane under its heading, and in one-pane mode it is as tall as the window allows', () => {
    expect(bodies('.hub-host .cw-hub').join(';')).toMatch(/--cw-hub-height:\s*100%/);
    expect(bodies('.is-stacked .hub-host .cw-hub').join(';')).toMatch(/--cw-hub-height:\s*min\(82vh, 720px\)/);
  });
  it('from 820px the hub host contains fixed children, so the hub’s toasts and pop-ups sit at the hub’s corner, not the window’s', () => {
    expect(css).toMatch(/@media \(min-width: 51\.25rem\)\s*\{\s*\.hub-host\s*\{\s*contain:\s*layout;/);
  });
  it('from a 1200px window the hub would draw three panes; here it stays stacked inside its pane (same rules the hub uses when narrow)', () => {
    const block = /@media \(min-width: 75rem\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/\.demo \.cw-hub \.cw-body\[data-case='true'\] \.cw-work\s*\{[^}]*display:\s*block/);
    expect(block).toMatch(/\.cw-main\s*\{[^}]*display:\s*block/);
    expect(block).toMatch(/\.cw-ctx\s*\{[^}]*border-left:\s*0/);
  });
  it('the two overrides name hub-react classes that still exist, in the rules the site means to undo (hub-react has no prop or token for either)', () => {
    const hub = readFileSync(join(__dirname, '..', '..', 'packages', 'hub-react', 'src', 'styles.css'), 'utf8').split('\r\n').join('\n');
    // the three-pane layout from a 1200px window: these are the rules `demo.css` reverts
    const threePane = /@media \(min-width: 75rem\)\s*\{([\s\S]*?)\n\}/.exec(hub)?.[1] ?? '';
    expect(threePane).toContain(".cw-hub .cw-body[data-case='true'] .cw-work");
    expect(threePane).toContain(".cw-hub .cw-body[data-case='true'] .cw-main");
    expect(threePane).toContain(".cw-hub .cw-body[data-case='true'] .cw-ctx");
    // the toasts are fixed to the window, which is why the host contains them
    expect(hub).toMatch(/\.cw-hub \.cw-toasts\s*\{[^}]*position:\s*fixed/);
    // and no token reaches either: if one is added, use it and delete the override
    expect(hub).not.toMatch(/--cw-(layout|panes|toast-position|contain)/);
  });
  it('under 600px the tour is a bar that sticks to the bottom of the window while the demo is in view', () => {
    expect(demoSrc).toMatch(/\(max-width: 599px\)/);
    const b = bodies(".tour[data-compact]").join(';');
    expect(b).toMatch(/position:\s*sticky/);
    expect(b).toMatch(/bottom:\s*calc\(\d+px \+ env\(safe-area-inset-bottom/);
    expect(b).toMatch(/z-index:\s*(\d+)/);
    expect(Number(/z-index:\s*(\d+)/.exec(b)?.[1])).toBeLessThan(50);
    // the card the wide layouts float is placed by script; the bar must not inherit that offset
    expect(b).toMatch(/left:\s*auto/);
  });
  it('a control the tour points at keeps clear of the sticky site header, the pane switcher and the bar when it is scrolled to', () => {
    const margin = bodies('[data-tour-target]').join(';');
    expect(margin).toMatch(/scroll-margin:\s*(\d+)px 0 (\d+)px/);
    const [, top, bottom] = /scroll-margin:\s*(\d+)px 0 (\d+)px/.exec(margin) ?? [];
    expect(Number(top)).toBeGreaterThanOrEqual(130); // 64px header + the 60px switcher + room
    expect(Number(bottom)).toBeGreaterThanOrEqual(90); // the collapsed bar
  });
  it('a hidden pane really hides (its display rule must not beat the hidden attribute)', () => {
    expect(bodies('.pane[hidden]').join(';')).toMatch(/display:\s*none/);
  });
  it('the control the tour points at has a static ring, so it shows under reduced motion too', () => {
    expect(bodies('[data-tour-target]').join(';')).toMatch(/outline:\s*3px solid/);
  });
  it('the report button is always visible on touch screens (no hover there)', () => {
    expect(css).toMatch(/@media \(hover: none\), \(pointer: coarse\)\s*\{\s*\.report-btn\s*\{[^}]*opacity:\s*1/);
    expect(bodies('.report-btn').join(';')).toMatch(/opacity:\s*0/);
    expect(css).toMatch(/\.msg:focus-within \.report-btn/);
  });
  it('the dark game screen uses the dark theme signature colours in both themes', () => {
    const body = bodies('.pane').join(';');
    expect(body).toMatch(/--warden:\s*#35e3c5/);
    expect(body).toMatch(/--gold:\s*#ffc83d/);
  });
  it('the tour tooltip sits under player-react’s dialogs (z-index 1000), and the pane switcher under the 50-high site header', () => {
    const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(bodies(sel).join(';'))?.[1]);
    const playerCss = readFileSync(join(__dirname, '..', '..', 'packages', 'player-react', 'src', 'styles.css'), 'utf8');
    expect(Number(/--cw-layer:\s*(\d+)/.exec(playerCss)?.[1])).toBeGreaterThan(50);
    expect(z('.tour')).toBeLessThan(50);
    expect(z('.pane-tabs')).toBeLessThan(50);
    expect(z('.tour')).toBeLessThan(z('.pane-tabs')); // the pane switcher stays pressable where the card sits over it
  });
  it('the notice button is a 44px target and has its own ring when the tour points at it', () => {
    expect(bodies('.notice-btn').join(';')).toMatch(/min-height:\s*44px/);
    expect(bodies('.notice-btn[data-tour-target]').join(';')).toMatch(/border-radius/);
  });
  it('the demo carries no style for the hand-built console, dialog or player frame any more', () => {
    expect(css).not.toMatch(/\.(pframe|decide-bar|dialog-backdrop|mod-body|evidence|cat-chip|suggest-hint)(?![\w-])/);
  });
  it('the sticky pane switcher clears the 64px sticky site header', () => {
    expect(Number(/top:\s*(\d+)px/.exec(bodies('.pane-tabs').join(';'))?.[1])).toBeGreaterThanOrEqual(64);
  });
  it('touch targets: tools are 44px tall, tour buttons at least 36px, chips 44px on touch screens', () => {
    expect(bodies('.tool').join(';')).toMatch(/min-height:\s*44px/);
    expect(bodies('.tbtn').join(';')).toMatch(/min-height:\s*(4\d|3[6-9])px/);
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.chip\s*\{\s*min-height:\s*44px/);
  });
  it('shows no third-party URL', () => {
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/@import/);
  });
});
