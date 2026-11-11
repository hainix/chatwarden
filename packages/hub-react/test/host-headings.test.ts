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

  it.each([true, false])('an adopter can still override on purpose: `.my-theme .cw-hub h2` (0,2,1) wins in either sheet order (adopter sheet last: %s)', (adopterLast) => {
    const hub = document.createElement('style');
    hub.textContent = hubCss;
    const mine = document.createElement('style');
    mine.textContent = '.my-theme .cw-hub h2 { text-transform: uppercase; letter-spacing: 0.1em; }';
    for (const s of adopterLast ? [hub, mine] : [mine, hub]) document.head.append(s);
    const wrap = document.createElement('div');
    wrap.className = 'my-theme';
    wrap.innerHTML = '<div class="cw-hub"><h2>Two</h2></div>';
    document.body.append(wrap);
    mounted.push(hub, mine, wrap);
    const cs = getComputedStyle(wrap.querySelector('h2') as HTMLElement);
    expect(cs.textTransform).toBe('uppercase');
    expect(cs.letterSpacing).not.toBe('normal');
  });

  it('a bare `.my-hub h2` ties the hub’s rule at (0,1,1), so sheet order decides: the adopter who wants it last wins, as the README says', () => {
    const hub = document.createElement('style');
    hub.textContent = hubCss;
    const mine = document.createElement('style');
    mine.textContent = '.my-hub h2 { text-transform: uppercase; }';
    document.head.append(hub, mine);
    const root = document.createElement('div');
    root.className = 'cw-hub my-hub';
    root.innerHTML = '<h2>Two</h2>';
    document.body.append(root);
    mounted.push(hub, mine, root);
    expect(getComputedStyle(root.querySelector('h2') as HTMLElement).textTransform).toBe('uppercase');
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
