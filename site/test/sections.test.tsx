import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { Header } from '../src/sections/Header';
import { Hero } from '../src/sections/Hero';
import { DemoSlot } from '../src/sections/DemoSlot';
import { HowItWorks } from '../src/sections/HowItWorks';
import { Steps } from '../src/sections/Steps';
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
  it('links Demo, How it works, Add it and FAQ, in that order, to sections that exist', () => {
    render(<Header />);
    const nav = screen.getByRole('navigation', { name: /main/i });
    const links = within(nav).getAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('#'));
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Demo', '#demo'],
      ['How it works', '#how'],
      ['Add it', '#add-it'],
      ['FAQ', '#faq'],
    ]);
  });
});

describe('Hero', () => {
  it('has the one h1, a sub-line and a "Try the live demo" link to #demo', () => {
    render(<Hero />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(h1.textContent).toBe('Chat moderation for your game. Moderator hub included.');
    expect(screen.getByRole('link', { name: 'Try the live demo' }).getAttribute('href')).toBe('#demo');
  });
  it('says what you get, including the hub, in the sub-line', () => {
    const { container } = render(<Hero />);
    expect(container.querySelector('.lead')?.textContent).toBe(
      "Chatwarden blocks slurs from your word list before they're posted, lets players report a message right from the chat, and gives your team a moderator hub: each player with open reports is a case, with every report about them and one click to act. Add it to the chat you already have with a short setup on your Node server.",
    );
  });
  it('has a ghost button to the setup steps and a proof line, and no install command (it moved into step 1)', () => {
    const { container } = render(<Hero />);
    const ghost = screen.getByRole('link', { name: 'Add it to your game' });
    expect(ghost.getAttribute('href')).toBe('#add-it');
    expect(ghost.className).toMatch(/btn-ghost/);
    expect(container.querySelector('.hero-note')?.textContent).toBe('Free · Open source (Apache-2.0) · Runs on your server, no account');
    expect(container.querySelector('.cmd')).toBeNull();
    expect(screen.queryByRole('button', { name: /copy install command/i })).toBeNull();
  });
  it('shows an animated chat snippet in which a synthetic term is blocked with a stamp', () => {
    const { container } = render(<Hero />);
    const chat = screen.getByRole('log', { name: /example chat/i });
    expect(within(chat).getByText(/zorbak/i)).toBeTruthy();
    expect(container.querySelector('.stamp')?.textContent).toBe('Blocked');
    expect(within(chat).getByText('Blocked. Only Bo sees this.')).toBeTruthy();
    expect(container.querySelector('.hud-tag')?.textContent).toBe('standard rules');
    expect(container.textContent).not.toMatch(/refused|preset/i);
    // a delivered line and a blocked line are both present
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
  it('is a #demo section with its heading and lead, and the loading placeholder', () => {
    const { container } = render(<DemoSlot />);
    const section = container.querySelector('section#demo');
    expect(section).toBeTruthy();
    expect(section?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(section as HTMLElement).getByRole('heading', { level: 2 }).textContent).toBe("Try it: you're the player and the moderator");
    expect(section?.querySelector('.section-lead')?.textContent).toBe(
      'On the left, a game lobby. On the right, the moderator hub your team would use. Report a message, then deal with it. It takes a few clicks, and it all runs in your browser.',
    );
    expect(screen.getByText(/loading the demo/i)).toBeTruthy();
    expect(section?.querySelector('[data-demo-slot]')).toBeTruthy();
  });
  it('names the two panes the demo will fill', () => {
    render(<DemoSlot />);
    expect(screen.getByText('Your game')).toBeTruthy();
    expect(screen.getByText('Moderator hub')).toBeTruthy();
  });
});

describe('HowItWorks', () => {
  it('is #how with a lead and three panels, each with a heading and an inline svg icon', () => {
    const { container } = render(<HowItWorks />);
    expect(container.querySelector('section#how')?.getAttribute('aria-labelledby')).toBe('how-title');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('How it works');
    expect(container.querySelector('.section-lead')?.textContent).toBe(
      'Your game keeps its own chat. Chatwarden checks each message, collects reports, and gives your team one place to act on them.',
    );
    const cards = container.querySelectorAll('[data-card]');
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.querySelector('h3')?.textContent?.length).toBeGreaterThan(3);
      expect(card.querySelector('svg')).toBeTruthy();
    }
    expect([...cards].map((c) => c.querySelector('h3')?.textContent)).toEqual(['In the chat', 'In your game', 'In your moderator hub']);
  });
  it('explains the three halves in plain words', () => {
    const { container } = render(<HowItWorks />);
    const text = container.textContent ?? '';
    expect(text).toContain("Every message goes through one check before your server sends it.");
    expect(text).toContain('Players report a message right from the chat.');
    expect(text).toContain('The moderator hub is a web page where your team handles reports.');
    expect(text).toContain('One click to act, five seconds to undo.');
    expect(text).toContain("Bigger team? The hub's Detailed view adds a full queue with filters");
    expect(text).not.toMatch(/one tap|one card per report|a few lines/i);
  });
  it('has the "Your rules" strip', () => {
    const { container } = render(<HowItWorks />);
    const strip = container.querySelector('[data-rules]') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(within(strip).getByRole('heading', { level: 3 }).textContent).toBe('Your rules');
    expect(strip.textContent).toContain('Start with relaxed, standard or strict rules.');
  });
});

describe('Steps', () => {
  it('shows five ordered steps; the fifth is optional', () => {
    const { container } = render(<Steps />);
    const items = container.querySelectorAll('ol > li');
    expect(items).toHaveLength(5);
    expect([...items].map((li) => li.querySelector('h3')?.textContent?.replace(/\s*\(optional\)$/, ''))).toEqual([
      'Install',
      'Set it up once',
      'Check every message',
      'Add the moderator hub',
      'Show players what happened',
    ]);
    expect(items[4]?.textContent).toMatch(/optional/i);
    expect(items[3]?.hasAttribute('data-hub-step')).toBe(true);
  });
  it('has the proposal’s heading and lead', () => {
    const { container } = render(<Steps />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Add it to your game');
    expect(container.querySelector('.section-lead')?.textContent).toBe(
      "Chatwarden needs three things from your server: who's talking, each message before it's sent, and a page for your moderators. It runs on Node 22.13 or newer, with any framework.",
    );
  });
  it('uses the real install command from the READMEs, copyable', () => {
    render(<Steps />);
    expect(
      screen.getAllByText((_, el) => el?.tagName === 'PRE' && !!el.textContent?.includes('npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher')).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^copy /i }).length).toBeGreaterThanOrEqual(3);
  });
  it('step 4 can be done from the page alone: the server first (install, imports, mount), then the page: React (install, the client, the drop-in <Hub>) or Any page (one script tag)', async () => {
    const user = userEvent.setup();
    const { container } = render(<Steps />);
    const more = container.querySelector('[data-hub-step]') as HTMLElement;
    const server = more.querySelector('.hub-server') as HTMLElement;
    expect(server).toBeTruthy();
    expect(server.textContent).toContain('npm install @chatwarden/http express @types/express');
    expect(server.textContent).toContain("import { adminRoutes } from '@chatwarden/http';");
    expect(server.textContent).toContain("import { toExpress } from '@chatwarden/http/express';");
    expect(server.textContent).toContain("app.use('/admin', toExpress(adminRoutes(cw, { authorize: yourModeratorLogin }), { fallthrough: false }));");
    // the server block comes before the tabs
    expect(server.compareDocumentPosition(more.querySelector('[role="tablist"]') as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const tabs = within(more).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['React', 'Any page']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    const panel = () => within(more).getByRole('tabpanel');
    expect(panel().textContent).toContain('npm install @chatwarden/hub-react');
    expect(panel().textContent).toContain("export const client = createHubClient(fetchTransport({ baseUrl: '/admin', credentials: 'same-origin' }));");
    expect(panel().textContent).toContain('<Hub client={client} />');
    await user.click(tabs[1] as HTMLElement);
    expect(panel().textContent).toContain('<chatwarden-hub base-url="/admin"></chatwarden-hub>');
    expect(panel().textContent).not.toContain('<Hub client');
    expect(within(more).getAllByRole('button', { name: /^copy /i }).length).toBe(3); // the server's two blocks and the script tag
  });
  it('the tabs work by keyboard: arrows move and select (and wrap), Home and End jump; only the selected tab is in the tab order', async () => {
    const { container } = render(<Steps />);
    const more = container.querySelector('[data-hub-step]') as HTMLElement;
    const tabs = () => within(more).getAllByRole('tab');
    expect(tabs().map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1']);
    tabs()[0]?.focus();
    fireEvent.keyDown(tabs()[0] as HTMLElement, { key: 'ArrowRight' });
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs()[1]);
    fireEvent.keyDown(tabs()[1] as HTMLElement, { key: 'ArrowRight' });
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs()[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs()[1] as HTMLElement, { key: 'Home' });
    expect(tabs()[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs()[0] as HTMLElement, { key: 'End' });
    expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
    // each tab names its panel, and the panel names the tab
    const panel = within(more).getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[1]?.id);
    expect(tabs()[1]?.getAttribute('aria-controls')).toBe(panel.id);
  });
  it('step 2 points a real word list at the matcher README, which has the term pack format', () => {
    const { container } = render(<Steps />);
    const step = container.querySelectorAll('ol > li')[1] as HTMLElement;
    expect(step.textContent).toContain('The code uses made-up test words; see the matcher README for the term pack format.');
    const link = within(step).getByRole('link', { name: /matcher readme/i });
    expect(link.getAttribute('href')).toBe('https://github.com/hainix/chatwarden/tree/main/packages/matcher#readme');
  });
  it('step 2 shows the first lines and a "Show the full file" button that opens the whole file (all of it is in the page either way)', async () => {
    const user = userEvent.setup();
    const { container } = render(<Steps />);
    const step = container.querySelectorAll('ol > li')[1] as HTMLElement;
    const pre = step.querySelector('pre') as HTMLElement;
    expect(pre.textContent).toContain('profile: ');
    const toggle = within(step).getByRole('button', { name: /show the full file/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(pre.hasAttribute('data-collapsed')).toBe(true);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(pre.hasAttribute('data-collapsed')).toBe(false);
    expect(toggle.textContent).toMatch(/show fewer lines/i);
    // the other code steps have no toggle
    expect(within(container.querySelectorAll('ol > li')[0] as HTMLElement).queryByRole('button', { name: /full file/i })).toBeNull();
  });
  it('step 5 is a link to player-react and has no code', () => {
    const { container } = render(<Steps />);
    const step = container.querySelectorAll('ol > li')[4] as HTMLElement;
    expect(step.querySelector('pre')).toBeNull();
    const link = within(step).getByRole('link', { name: /player-react/i });
    expect(link.getAttribute('href')).toBe('https://github.com/hainix/chatwarden/tree/main/packages/player-react');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });
  it('ends with the README pointer and the tiny-chat example, and no longer with the old http footnote', () => {
    const { container } = render(<Steps />);
    const text = container.textContent ?? '';
    expect(text).toContain('Every package has a README with the full setup, options and security notes.');
    expect(text).toContain('examples/tiny-chat');
    expect(text).not.toMatch(/Want routes for moderators and players/);
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
    expect(pres).toHaveLength(8); // steps 1 to 3, the server's install and mount, then the React tab's install line, client and drop-in
    for (const pre of pres) {
      expect(pre.getAttribute('role')).toBe('region');
      expect(pre.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

describe('OpenSource', () => {
  it('has the proposal’s heading and says it plainly', () => {
    const { container } = render(<OpenSource />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Free and open source');
    const text = container.textContent ?? '';
    expect(text).toContain('Apache-2.0, with no paid tier and nothing hosted.');
    expect(text).toContain('Chatwarden is pre-release (version 0.1): ready to try, with no support promise yet.');
    expect(text).toContain('Published to npm with provenance.');
    expect(text).not.toMatch(/no strings|forever|0\.1\.0|0\.1\.x/i);
  });
  it('links to GitHub and npm and nothing else: no package chips, no badges, no customers', () => {
    const { container } = render(<OpenSource />);
    const gh = screen.getByRole('link', { name: /view on github/i });
    expect(gh.getAttribute('href')).toBe(GITHUB);
    expect(gh.getAttribute('rel')).toMatch(/noopener/);
    const npm = screen.getByRole('link', { name: /packages on npm/i }).getAttribute('href') ?? '';
    expect(new URL(npm).hostname).toBe('www.npmjs.com');
    expect(npm).toContain('@chatwarden');
    expect(container.querySelectorAll('a')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/moxgate|trusted by|used by/i);
  });
  it('invents no customers, counts or stats', () => {
    const { container } = render(<OpenSource />);
    expect(container.textContent).not.toMatch(/\b\d[\d,.]*\s?[kKmM]?\+?\s+(users|customers|studios|games|downloads|stars|developers)\b/);
  });
});

describe('Faq', () => {
  it('answers the nine questions, including privacy, cost and the word list', () => {
    render(<Faq />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Questions');
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(9);
    expect(screen.getAllByText("Nothing. It's open source under Apache-2.0, with no paid tier.").length).toBeGreaterThan(0);
    expect(screen.queryByText(/forever/i)).toBeNull();
    expect(screen.getAllByText(/There's no shared list yet/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Where is player data stored?' })).toBeTruthy();
  });
  it('uses native disclosure elements so it works without JS and by keyboard', () => {
    const { container } = render(<Faq />);
    const items = container.querySelectorAll('details');
    expect(items).toHaveLength(9);
    for (const d of items) expect(d.querySelector('summary')).toBeTruthy();
  });
  it('says plainly that it is not a child-safety tool, and where to go instead', () => {
    const { container } = render(<Faq />);
    const item = [...container.querySelectorAll('details')].find((d) => /child-safety/i.test(d.textContent ?? '')) as HTMLElement;
    expect(item.querySelector('p')?.textContent).toMatch(/^No\. For detecting and reporting child sexual abuse material, use Coop and HMA\./);
    expect(within(item).getByRole('link', { name: 'Coop' }).getAttribute('href')).toBe('https://github.com/roostorg/coop');
    expect(within(item).getByRole('link', { name: 'HMA' }).getAttribute('href')).toMatch(/hasher-matcher-actioner$/);
  });
});

describe('Footer', () => {
  it('is a contentinfo landmark with the licence and repo links', () => {
    render(<Footer />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: /github/i }).getAttribute('href')).toBe(GITHUB);
    expect(within(footer).getByText(/apache-2\.0/i)).toBeTruthy();
  });
  it('has the proposal’s brand line and fine print', () => {
    const { container } = render(<Footer />);
    expect(container.querySelector('.footer-brand p')?.textContent).toBe('Chat moderation for games. Free and open source.');
    expect(container.querySelector('.footer-fine')?.textContent).toBe('Apache-2.0. Pre-release, provided as is. Not a child-safety tool.');
    expect([...container.querySelectorAll('.footer-links a')].map((a) => a.textContent)).toEqual(['GitHub', 'npm', 'Report an issue', 'Licence']);
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
  it('orders the sections: hero, demo, how it works, add it, open source, faq (no AI levels, no works-with)', () => {
    const { container } = render(<App />);
    const ids = [...container.querySelectorAll('main > section')].map((s) => s.id || s.getAttribute('data-section'));
    expect(ids).toEqual(['hero', 'demo', 'how', 'add-it', 'open', 'faq']);
  });
  it('every header link lands on a section', () => {
    const { container } = render(<App />);
    for (const a of container.querySelectorAll('.nav-links a')) expect(container.querySelector(a.getAttribute('href') as string), a.textContent ?? '').toBeTruthy();
    for (const a of container.querySelectorAll('.hero-actions a[href^="#"]')) expect(container.querySelector(a.getAttribute('href') as string), a.textContent ?? '').toBeTruthy();
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
  it('says "block", never "refuse", and keeps the retired jargon off the page outside code', () => {
    const { container } = render(<App />);
    const clone = container.cloneNode(true) as HTMLElement;
    for (const pre of clone.querySelectorAll('pre')) pre.remove();
    const text = clone.textContent ?? '';
    expect(text).not.toMatch(/\brefus(e|ed|es|al)\b|\bladder\b|\bseats?\b|staff routes|headless|ceilings?|\bpreset\b|\bAI levels?\b|moxgate/i);
    expect(text).not.toMatch(/Give it a warden|Made for indie developers|Use it, change it, ship it/);
  });
});
