import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { Header } from '../src/sections/Header';
import { Hero } from '../src/sections/Hero';
import { DemoSlot } from '../src/sections/DemoSlot';
import { Features } from '../src/sections/Features';
import { Steps } from '../src/sections/Steps';
import { AiLevels } from '../src/sections/AiLevels';
import { WorksWith } from '../src/sections/WorksWith';
import { OpenSource } from '../src/sections/OpenSource';
import { Faq } from '../src/sections/Faq';
import { Footer } from '../src/sections/Footer';

afterEach(cleanup);

const GITHUB = 'https://github.com/hainix/chatwarden';

describe('Header', () => {
  it('has a labelled nav, a GitHub link, the logo and a theme toggle', () => {
    render(<Header />);
    const nav = screen.getByRole('navigation', { name: /main/i });
    expect(within(nav).getByRole('link', { name: /github/i }).getAttribute('href')).toBe(GITHUB);
    expect(screen.getByRole('img', { name: /chatwarden/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /theme|light|dark/i })).toBeTruthy();
  });
  it('links to the page sections that exist', () => {
    render(<Header />);
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    for (const h of ['#demo', '#features', '#add-it', '#levels', '#faq']) expect(hrefs).toContain(h);
  });
});

describe('Hero', () => {
  it('has the one h1, a sub-line and a "Try the demo" link to #demo', () => {
    render(<Hero />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: /try the demo/i }).getAttribute('href')).toBe('#demo');
    expect(screen.getAllByText(/free, open.source/i).length).toBeGreaterThan(0);
  });
  it('shows the same three-package install command as step 1, with a copy button', () => {
    render(<Hero />);
    expect(document.querySelector('.cmd code')?.textContent).toBe('npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher');
    expect(screen.getByRole('button', { name: /copy install command/i })).toBeTruthy();
  });
  it('shows an animated chat snippet in which a synthetic term is refused with a stamp', () => {
    render(<Hero />);
    const chat = screen.getByRole('log', { name: /example chat/i });
    expect(within(chat).getByText(/zorbak/i)).toBeTruthy();
    expect(within(chat).getByText(/refused!/i)).toBeTruthy();
    // a delivered line and a refused line are both present
    expect(chat.querySelectorAll('[data-verdict="delivered"]').length).toBeGreaterThanOrEqual(2);
    expect(chat.querySelectorAll('[data-verdict="refused"]')).toHaveLength(1);
  });
  it('lets the visitor replay the snippet', () => {
    render(<Hero />);
    expect(screen.getByRole('button', { name: /replay/i })).toBeTruthy();
  });
  it('uses no raster image for the snippet', () => {
    const { container } = render(<Hero />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('DemoSlot placeholder', () => {
  it('is a #demo section with a heading and the loading placeholder', () => {
    const { container } = render(<DemoSlot />);
    const section = container.querySelector('section#demo');
    expect(section).toBeTruthy();
    expect(section?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(section as HTMLElement).getByRole('heading', { level: 2 })).toBeTruthy();
    expect(screen.getByText(/loading the demo/i)).toBeTruthy();
    expect(section?.querySelector('[data-demo-slot]')).toBeTruthy();
  });
  it('names the two panes the demo will fill', () => {
    render(<DemoSlot />);
    expect(screen.getByText('The game')).toBeTruthy();
    expect(screen.getByText('Your moderator')).toBeTruthy();
  });
});

describe('Features', () => {
  it('shows exactly six cards, each with a heading and an inline svg icon', () => {
    const { container } = render(<Features />);
    const cards = container.querySelectorAll('[data-card]');
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      expect(card.querySelector('h3')?.textContent?.length).toBeGreaterThan(3);
      expect(card.querySelector('svg')).toBeTruthy();
    }
  });
  it('covers the six capabilities', () => {
    render(<Features />);
    for (const re of [
      /slurs that dodge/i,
      /reports with evidence/i,
      /fair ladder/i,
      /player notices/i,
      /moderator hub/i,
      /discord and webhooks/i,
    ])
      expect(screen.getByRole('heading', { name: re })).toBeTruthy();
  });
  it('is honest that the hub UI is coming while the HTTP APIs exist', () => {
    render(<Features />);
    expect(screen.getAllByText(/hub ui is coming/i).length).toBeGreaterThan(0);
  });
});

describe('Steps', () => {
  it('shows three ordered steps', () => {
    const { container } = render(<Steps />);
    expect(container.querySelectorAll('ol > li')).toHaveLength(3);
  });
  it('uses the real install command from the READMEs, copyable', () => {
    render(<Steps />);
    expect(
      screen.getAllByText((_, el) => el?.tagName === 'PRE' && !!el.textContent?.includes('npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher')).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^copy /i }).length).toBeGreaterThanOrEqual(3);
  });
  it('syntax-highlights code with local spans (no external highlighter)', () => {
    const { container } = render(<Steps />);
    expect(container.querySelectorAll('pre code .tok-keyword').length).toBeGreaterThan(3);
    expect(container.querySelectorAll('pre code .tok-string').length).toBeGreaterThan(3);
  });
  it('keeps the code text intact (spans only wrap, never change it)', () => {
    const { container } = render(<Steps />);
    const text = [...container.querySelectorAll('pre code')].map((c) => c.textContent).join('\n');
    expect(text).toContain("import { createChatwarden, type Platform } from '@chatwarden/core';");
    expect(text).toContain('cw.chat.accept(');
  });
  it('makes the code blocks keyboard reachable (scrollable regions are focusable)', () => {
    const { container } = render(<Steps />);
    for (const pre of container.querySelectorAll('pre')) expect(pre.getAttribute('tabindex')).toBe('0');
  });
  it('names each scrollable code block as a region (aria-label alone is not allowed on a bare pre)', () => {
    const { container } = render(<Steps />);
    const pres = [...container.querySelectorAll('pre')];
    expect(pres).toHaveLength(3);
    for (const pre of pres) {
      expect(pre.getAttribute('role')).toBe('region');
      expect(pre.getAttribute('aria-label')).toBeTruthy();
    }
    expect(screen.getAllByRole('region').length).toBeGreaterThanOrEqual(3);
  });
});

describe('AiLevels', () => {
  it('lists levels 0 to 4', () => {
    const { container } = render(<AiLevels />);
    const levels = container.querySelectorAll('[data-level]');
    expect([...levels].map((l) => l.getAttribute('data-level'))).toEqual(['0', '1', '2', '3', '4']);
  });
  it('marks level 0 available and levels 2 to 4 coming soon', () => {
    const { container } = render(<AiLevels />);
    const status = (n: number) => container.querySelector(`[data-level="${n}"]`)?.getAttribute('data-status');
    expect(status(0)).toBe('available');
    for (const n of [2, 3, 4]) expect(status(n)).toBe('coming');
  });
  it('does not claim any AI read ships today (it is not built yet)', () => {
    const { container } = render(<AiLevels />);
    expect(container.querySelector('[data-level="1"]')?.getAttribute('data-status')).toBe('coming');
    expect(screen.getAllByText(/coming soon/i).length).toBeGreaterThanOrEqual(4);
  });
  it('words the limits as a design commitment, not as shipped behaviour', () => {
    render(<AiLevels />);
    expect(screen.getByRole('heading', { name: /hard limits we.re building in/i })).toBeTruthy();
    expect(screen.queryByText(/written into the code/i)).toBeNull();
    expect(screen.queryByText(/are not settings/i)).toBeNull();
    expect(screen.getAllByText(/won.t be settings/i).length).toBeGreaterThan(0);
  });
  it('states the hard ceilings', () => {
    render(<AiLevels />);
    expect(screen.getAllByText(/never ban/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/24 hours/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/do not automate/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/opt.in/i).length).toBeGreaterThan(0);
  });
});

describe('WorksWith', () => {
  it('names Express, any Node game server, Discord and webhooks', () => {
    render(<WorksWith />);
    for (const re of [/express/i, /any node game server/i, /^discord$/i, /webhooks/i])
      expect(screen.getByRole('heading', { name: re })).toBeTruthy();
  });
});

describe('OpenSource', () => {
  it('states the licence and links to GitHub and npm', () => {
    render(<OpenSource />);
    expect(screen.getAllByText(/apache-2\.0/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /github/i }).getAttribute('href')).toBe(GITHUB);
    const npm = screen.getByRole('link', { name: /npm/i }).getAttribute('href') ?? '';
    expect(new URL(npm).hostname).toBe('www.npmjs.com');
    expect(npm).toContain('@chatwarden');
  });
  it('shows the provenance badge and the one true customer line', () => {
    render(<OpenSource />);
    expect(screen.getAllByText(/npm provenance/i).length).toBeGreaterThan(0);
    // Moxgate has not shipped on the kit yet: the badge says what is true. Flip it to "Used by Moxgate" only after it has.
    expect(screen.getAllByText('Built for Moxgate, now being adopted').length).toBeGreaterThan(0);
    expect(screen.queryByText(/used by moxgate/i)).toBeNull();
  });
  it('words the licence and the version truthfully: keep the notice, 0.1.x, nothing "no strings"', () => {
    const { container } = render(<OpenSource />);
    const text = container.textContent ?? '';
    expect(text).toContain('Use it, change it, ship it. Keep the licence notice.');
    expect(text).not.toMatch(/no strings/i);
    expect(text).toContain('The kit is pre-release (0.1.x) and provided as-is.');
    expect(text).not.toMatch(/0\.1\.0/);
  });
  it('invents no customers, counts or stats', () => {
    const { container } = render(<OpenSource />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\b\d[\d,.]*\s?[kKmM]?\+?\s+(users|customers|studios|games|downloads|stars|developers)\b/);
    expect(text).not.toMatch(/trusted by/i);
  });
});

describe('Faq', () => {
  it('answers privacy, the no-SLA line and the community term list', () => {
    render(<Faq />);
    expect(screen.getAllByText(/free and open source under apache-2\.0, with no paid tier/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/forever/i)).toBeNull();
    expect(screen.getAllByText(/no sla/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/community.*term list/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /player data|privacy/i })).toBeTruthy();
  });
  it('uses native disclosure elements so it works without JS and by keyboard', () => {
    const { container } = render(<Faq />);
    const items = container.querySelectorAll('details');
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const d of items) expect(d.querySelector('summary')).toBeTruthy();
  });
  it('says plainly that it is not a child-safety tool', () => {
    render(<Faq />);
    expect(screen.getAllByText(/not a child-safety tool/i).length).toBeGreaterThan(0);
  });
});

describe('Footer', () => {
  it('is a contentinfo landmark with the licence and repo links', () => {
    render(<Footer />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: /github/i }).getAttribute('href')).toBe(GITHUB);
    expect(within(footer).getByText(/apache-2\.0/i)).toBeTruthy();
  });
});

describe('App', () => {
  it('has the page landmarks, a skip link and exactly one h1', () => {
    render(<App />);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const skip = screen.getByRole('link', { name: /skip to content/i });
    expect(skip.getAttribute('href')).toBe('#main');
  });
  it('orders the sections: hero, demo, features, steps, levels, works with, open, faq', () => {
    const { container } = render(<App />);
    const ids = [...container.querySelectorAll('main > section')].map((s) => s.id || s.getAttribute('data-section'));
    expect(ids).toEqual(['hero', 'demo', 'features', 'add-it', 'levels', 'works-with', 'open', 'faq']);
  });
  it('gives every section an accessible name', () => {
    const { container } = render(<App />);
    for (const s of container.querySelectorAll('main > section')) {
      expect(s.getAttribute('aria-labelledby') ?? s.getAttribute('aria-label')).toBeTruthy();
    }
  });
  it('has unique ids', () => {
    const { container } = render(<App />);
    const ids = [...container.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('has no lorem ipsum anywhere', () => {
    const { container } = render(<App />);
    expect((container.textContent ?? '').toLowerCase()).not.toMatch(/lorem|ipsum|dolor sit/);
  });
  it('has no empty links or buttons', () => {
    const { container } = render(<App />);
    for (const el of container.querySelectorAll('a, button')) {
      const name = (el.textContent ?? '').trim() || el.getAttribute('aria-label') || el.getAttribute('title');
      expect(name, el.outerHTML.slice(0, 80)).toBeTruthy();
    }
  });
  it('every external link is to github.com, npmjs.com or chatwarden.dev and opens safely', () => {
    const { container } = render(<App />);
    for (const a of container.querySelectorAll('a[href^="http"]')) {
      const host = new URL(a.getAttribute('href') as string).hostname;
      expect(['github.com', 'www.npmjs.com', 'npmjs.com', 'chatwarden.dev']).toContain(host);
      if (a.getAttribute('target') === '_blank') expect(a.getAttribute('rel')).toMatch(/noopener/);
    }
  });
  it('uses only synthetic demo terms', () => {
    const { container } = render(<App />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/zorbak/i);
  });
});
