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
  it('the stacked breakpoint in JS matches the side-by-side breakpoint in CSS (899px and 900px)', () => {
    expect(demoSrc).toMatch(/\(max-width: 899px\)/);
    expect(css).toMatch(/@media \(min-width: 900px\)/);
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
  it('the decide buttons stay in reach: the bar is sticky', () => {
    expect(bodies('.decide-bar').join(';')).toMatch(/position:\s*sticky/);
  });
  it('the dark screens use the dark theme signature colours in both themes', () => {
    const body = bodies('.pane,\n.dialog').join(';');
    expect(body).toMatch(/--warden:\s*#35e3c5/);
    expect(body).toMatch(/--gold:\s*#ffc83d/);
  });
  it('the tour tooltip sits under the dialog, and both are in a sane order against the 50-high site header', () => {
    const z = (sel: string) => Number(/z-index:\s*(\d+)/.exec(bodies(sel).join(';'))?.[1]);
    expect(z('.dialog-backdrop')).toBeGreaterThan(50);
    expect(z('.tour')).toBeLessThan(z('.dialog-backdrop'));
    expect(z('.pane-tabs')).toBeLessThan(50);
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
