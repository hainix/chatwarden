// @vitest-environment jsdom
// A host page's own heading styles must not restyle the hub. A site that sets `h2 { font-family: Bungee; text-transform: uppercase;
// letter-spacing: .2em }` (many do) would otherwise turn every heading in the hub into capitals in the site's display font. The hub
// sets its own heading font, case, spacing and weight under `.cw-hub`, at a specificity above an element selector and below a class
// the adopter writes, so a deliberate override (`.my-hub h2 { ... }` or a token) still works.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rulesCss } from './css.js';

const HOST = 'h1,h2,h3,h4,h5,h6 { font-family: Bungee, fantasy; text-transform: uppercase; letter-spacing: 0.2em; font-weight: 100; }';
const hubCss = readFileSync(join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css'), 'utf8');

const mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

function page(hostFirst: boolean) {
  const host = document.createElement('style');
  host.textContent = HOST;
  const hub = document.createElement('style');
  hub.textContent = hubCss;
  // the host sheet may come before or after the hub's: the hub must hold either way
  for (const s of hostFirst ? [host, hub] : [hub, host]) document.head.append(s);
  const root = document.createElement('div');
  root.className = 'cw-hub';
  root.innerHTML = '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>';
  document.body.append(root);
  mounted.push(host, hub, root);
  return root;
}

describe('the hub keeps its own heading styles under a host page that styles headings', () => {
  it('has one rule for h1 to h6 under .cw-hub that sets the font, the case, the spacing and the weight', () => {
    const rule = /\.cw-hub :is\(h1, h2, h3, h4, h5, h6\)\s*\{([^}]*)\}/.exec(rulesCss())?.[1] ?? '';
    expect(rule).toMatch(/font-family:\s*var\(--cw-font\)/);
    expect(rule).toMatch(/text-transform:\s*none/);
    expect(rule).toMatch(/letter-spacing:\s*normal/);
    expect(rule).toMatch(/font-weight:\s*var\(--cw-weight-strong\)/);
  });

  it('is above an element selector, so it wins whichever sheet comes last', () => {
    // `.cw-hub :is(h1, ...)` is (0,1,1); a host `h2` is (0,0,1). `:where(.cw-hub)` would make it (0,0,1), a tie decided by sheet order.
    expect(rulesCss()).not.toMatch(/:where\(\.cw-hub\) :is\(h1/);
  });

  it.each([true, false])('computed headings ignore the host stylesheet (host sheet first: %s)', (hostFirst) => {
    const root = page(hostFirst);
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const cs = getComputedStyle(root.querySelector(tag) as HTMLElement);
      expect(cs.fontFamily, tag).not.toMatch(/Bungee/);
      expect(cs.textTransform, tag).toBe('none');
      expect(cs.letterSpacing, tag).not.toBe('0.2em');
      expect(cs.fontWeight, tag).not.toBe('100');
    }
  });

  it('control: without the hub stylesheet the host rule does apply (so the test can see a leak)', () => {
    const host = document.createElement('style');
    host.textContent = HOST;
    document.head.append(host);
    const root = document.createElement('div');
    root.innerHTML = '<h2>Two</h2>';
    document.body.append(root);
    mounted.push(host, root);
    expect(getComputedStyle(root.querySelector('h2') as HTMLElement).textTransform).toBe('uppercase');
  });
});
