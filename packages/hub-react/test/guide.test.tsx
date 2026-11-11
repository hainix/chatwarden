import { LADDER_TABLE } from '@chatwarden/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The Guide: the generated moderator guide (GET /policy?format=markdown) through the safe renderer, the Community Rules and the
// escalation ladder drawn from the policy data itself (never parsed back out of the markdown). Against the real routes.

const audits = (w: HubWorld, action: string): unknown[] => w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action);
const policyReads = (w: HubWorld) => w.sent.filter((r) => r.method === 'GET' && r.path === '/policy');
const SERVER_500 = { status: 500, body: { error: 'internal', message: 'x' } };

async function openGuide(options: WorldOptions = {}) {
  const w = await hubWorld(options);
  const r = renderHub(w, { path: '/guide' });
  await screen.findByRole('heading', { level: 2, name: 'Guide' });
  await screen.findByRole('region', { name: 'Community Rules' });
  return { w, ...r };
}

/** A hub whose `/policy` answers with the real policy but a chosen guide text. */
async function openWithGuide(markdown: string) {
  const w = await hubWorld();
  const real = await w.direct.policy({ format: 'markdown' });
  w.intercept.fn = (req) => (req.path === '/policy' ? { status: 200, body: { ...real, documents: { ...real.documents, moderatorGuide: markdown } } } : undefined);
  const r = renderHub(w, { path: '/guide' });
  await screen.findByRole('region', { name: 'The full moderator guide' });
  return { w, ...r };
}

describe('the rules and the ladder', () => {
  it('lists every Community Rule in force with its number, title and text', async () => {
    const { w } = await openGuide();
    const panel = screen.getByRole('region', { name: 'Community Rules' });
    const rules = w.cw.rules.all();
    expect(rules.length).toBeGreaterThan(3);
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(rules.length);
    for (const [i, rule] of rules.entries()) {
      expect(rows[i]).toHaveTextContent(`Rule ${rule.number}`);
      expect(rows[i]).toHaveTextContent(rule.title);
      expect(rows[i]).toHaveTextContent(rule.text);
    }
  });

  it('marks a retired rule as retired and no other', async () => {
    await openGuide({ retire: [3] });
    const rows = within(screen.getByRole('region', { name: 'Community Rules' })).getAllByRole('listitem');
    expect(rows[2]).toHaveTextContent('Retired');
    expect(within(rows[0]!).queryByText('Retired')).toBeNull();
    expect(screen.getAllByText('Retired')).toHaveLength(1);
  });

  it('draws the ladder table from LADDER_TABLE: a row a step, each cell the action in the hub\'s own words', async () => {
    await openGuide();
    const table = within(screen.getByRole('region', { name: 'Escalation ladder' })).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Step', 'Low or medium', 'High']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(LADDER_TABLE.length);
    const words: Record<string, string> = { warning: 'Warning', chat: 'Chat restriction', ban: 'Ban' };
    for (const [i, row] of LADDER_TABLE.entries()) {
      const cells = within(rows[i]!).getAllByRole('cell');
      expect(within(rows[i]!).getByRole('rowheader')).toHaveTextContent(`Step ${row.step}`);
      for (const [c, cell] of [row.lowMedium, row.high].entries()) {
        expect(cells[c]).toHaveTextContent(words[cell.kind]!);
        if (cell.durationMs === null && cell.kind === 'ban') expect(cells[c]).toHaveTextContent('permanent');
      }
    }
    expect(rows[0]).toHaveTextContent('Chat restriction, 7 days');
    expect(rows[4]).toHaveTextContent('Ban, permanent');
  });

  it('shows the adopter\'s own ladder when the profile has one, not the default', async () => {
    const ladder = LADDER_TABLE.map((r) => ({ ...r }));
    ladder[0] = { ...ladder[0]!, lowMedium: { kind: 'chat', durationMs: 60 * 60 * 1000, label: 'Restrict chat 1 hour' } };
    await openGuide({ ladder });
    const table = within(screen.getByRole('region', { name: 'Escalation ladder' })).getByRole('table');
    expect(within(within(table).getAllByRole('row')[1]!).getAllByRole('cell')[0]).toHaveTextContent('Chat restriction, 1 hour');
  });

  it('the referee card beside each cell follows its kind and is decoration only', async () => {
    const { container } = await openGuide();
    const table = container.querySelector('.cw-ladder') as HTMLElement;
    expect(table.querySelectorAll('.cw-card--warning').length).toBeGreaterThan(0);
    expect(table.querySelectorAll('.cw-card--restriction').length).toBeGreaterThan(0);
    expect(table.querySelectorAll('.cw-card--ban').length).toBeGreaterThan(0);
    for (const card of table.querySelectorAll('.cw-card')) expect(card).toHaveAttribute('aria-hidden', 'true');
  });

  it('explains the two columns in a sentence', async () => {
    await openGuide();
    expect(screen.getByText(/A person’s step is the heaviest action on their record in the last 90 days/)).toBeInTheDocument();
  });
});

describe('the generated guide', () => {
  it('draws the kit\'s own moderator guide: its title as a heading below the panel title, its lists and tables', async () => {
    const { w } = await openGuide();
    const panel = screen.getByRole('region', { name: 'The full moderator guide' });
    const md = w.cw.documents.moderatorGuide({ format: 'markdown' });
    expect(md).toContain('## Conduct levels');
    expect(within(panel).getByRole('heading', { level: 3, name: /^Moderator guide:/ })).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { level: 4, name: 'Conduct levels' })).toBeInTheDocument();
    expect(within(panel).getAllByRole('region', { name: /^Table \d+$/ }).length).toBeGreaterThanOrEqual(2);
    expect(panel.textContent).not.toMatch(/\\[.*_`#|]|\*\*/);
    expect(panel.querySelector('script, img, iframe')).toBeNull();
  });

  it('asks for the markdown format and reads the policy once, audited once', async () => {
    const { w } = await openGuide();
    expect(policyReads(w)).toHaveLength(1);
    expect(policyReads(w)[0]?.query).toEqual({ format: 'markdown', omit: 'rules,ladder' });
    expect(audits(w, 'policy.view')).toHaveLength(1);
  });

  it('opening it again in the same hub does not read the policy again', async () => {
    const { w, user } = await openGuide();
    await user.click(screen.getByRole('link', { name: 'Reports' }));
    await screen.findByRole('heading', { level: 2, name: 'Reports' });
    await user.click(screen.getByRole('link', { name: 'Guide' }));
    await screen.findByRole('region', { name: 'Community Rules' });
    expect(policyReads(w)).toHaveLength(1);
    expect(audits(w, 'policy.view')).toHaveLength(1);
  });

  it('is the generated document for the profile: the game profile name is in the title', async () => {
    const { w } = await openGuide();
    const name = w.cw.profile.name;
    expect(screen.getByRole('heading', { level: 3, name: new RegExp(`Moderator guide: ${name}`) })).toBeInTheDocument();
  });
});

describe('nothing is shown twice', () => {
  it('each rule title and rule text appears exactly once on the Guide', async () => {
    const { w } = await openGuide();
    const main = screen.getByRole('main');
    for (const rule of w.cw.rules.all()) {
      expect(within(main).queryAllByText(rule.title), `title of rule ${rule.number}`).toHaveLength(1);
      expect(main.textContent?.split(rule.text).length, `text of rule ${rule.number}`).toBe(2);
    }
  });

  it('the ladder is one table, with one heading, and the generated guide has no ladder or rules section', async () => {
    const { w } = await openGuide();
    const main = screen.getByRole('main');
    expect(within(main).getAllByRole('columnheader', { name: 'Step' })).toHaveLength(1);
    expect(within(main).getAllByRole('heading', { name: 'Escalation ladder' })).toHaveLength(1);
    expect(within(main).getAllByRole('heading', { name: 'Community Rules' })).toHaveLength(1);
    expect(within(main).queryByRole('columnheader', { name: /^Low \/ medium/ })).toBeNull();
    const guide = screen.getByRole('region', { name: 'The full moderator guide' });
    expect(guide.textContent).not.toContain('Low / medium');
    for (const rule of w.cw.rules.all()) expect(guide.textContent, `rule ${rule.number}`).not.toContain(rule.title);
  });

  it('keeps the rest of the guide in the kit order, and the rules and ladder panels come before it', async () => {
    const { w } = await openGuide();
    const panel = screen.getByRole('region', { name: 'The full moderator guide' });
    const md = w.cw.documents.moderatorGuide({ format: 'markdown', omitSections: ['rules', 'ladder'] });
    const expected = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(within(panel).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(expected);
    const order = [...screen.getByRole('main').querySelectorAll('section > .cw-panel-head h2')].map((h) => h.textContent);
    expect(order).toEqual(['Community Rules', 'Escalation ladder', 'The full moderator guide']);
  });

  it('says which rules turn a restriction into a ban and which always read the High column, from the data, once', async () => {
    const { w } = await openGuide();
    const main = screen.getByRole('main');
    const area = w.cw.rules.all().filter((r) => [5, 6].includes(r.number) && r.retired !== true);
    const severe = w.cw.rules.all().filter((r) => r.number === 1);
    expect(within(main).getAllByText(/^Rules that turn a chat restriction into a ban/)).toHaveLength(1);
    expect(within(main).getAllByText(/^Rules that always read the High column/)).toHaveLength(1);
    const areaText = within(main).getByText(/^Rules that turn a chat restriction into a ban/).textContent ?? '';
    for (const r of area) expect(areaText).toContain(`Rule ${r.number}: ${r.title}`);
    expect(within(main).getByText(/^Rules that always read the High column/).textContent).toContain(`Rule ${severe[0]!.number}: ${severe[0]!.title}`);
  });

  it('follows the profile own area and severe rules, and drops a note whose rules are all retired or absent', async () => {
    const w = await hubWorld({ retire: [5, 6] });
    const real = await w.direct.policy({ format: 'markdown', omit: ['rules', 'ladder'] });
    w.intercept.fn = (req) => (req.path === '/policy' ? { status: 200, body: { ...real, profile: { ...real.profile, areaRules: [2, 3], severeRules: [] } } } : undefined);
    renderHub(w, { path: '/guide' });
    await screen.findByRole('region', { name: 'The full moderator guide' });
    const main = screen.getByRole('main');
    expect(within(main).getByText(/^Rules that turn a chat restriction into a ban/).textContent).toMatch(/Rule 2: .*Rule 3: /);
    expect(within(main).queryByText(/^Rules that always read the High column/)).toBeNull();
  });
});

describe('hostile markdown', () => {
  const HOSTILE = [
    '# Guide <script>window.pwned = 1</script>',
    '',
    '<img src=x onerror="window.pwned = 2">',
    '',
    '[click](javascript:window.pwned=3) and [data](data:text/html;base64,PHNjcmlwdD4=) and [ok](https://example.test/ok) and [rel](/rules)',
    '',
    '![pixel](https://example.test/p.png)',
    '',
    '<iframe src="https://evil.test"></iframe>',
    '',
    '| a | b |',
    '| --- | --- |',
    '| <b>x</b> | [bad](JaVaScRiPt:alert(1)) |',
  ].join('\n');

  it('escapes raw HTML and refuses every link that is not https or relative', async () => {
    const { container } = await openWithGuide(HOSTILE);
    const panel = screen.getByRole('region', { name: 'The full moderator guide' });
    expect(panel.querySelector('script, img, iframe, b, svg, object, embed, style')).toBeNull();
    expect(container.querySelector('[onerror], [onclick], [onload]')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    const hrefs = [...panel.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.test/ok', '/rules']);
    for (const a of panel.querySelectorAll('a')) expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    expect(panel.textContent).toContain('<script>window.pwned = 1</script>');
    expect(panel.textContent).toContain('<img src=x onerror="window.pwned = 2">');
    expect(panel.innerHTML).not.toMatch(/javascript:/i);
  });

  it('a malicious rule title or text from the server is text too', async () => {
    const w = await hubWorld();
    const real = await w.direct.policy({ format: 'markdown' });
    const rules = real.rules.map((r, i) => (i === 0 ? { ...r, title: '<img src=x onerror=alert(1)>', text: '<script>alert(2)</script>' } : r));
    w.intercept.fn = (req) => (req.path === '/policy' ? { status: 200, body: { ...real, rules } } : undefined);
    const { container } = renderHub(w, { path: '/guide' });
    await screen.findByRole('region', { name: 'Community Rules' });
    expect(container.querySelector('.cw-hub img[src="x"], script')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Community Rules' })).getAllByRole('listitem')[0]).toHaveTextContent('<script>alert(2)</script>');
  });

  it('an empty guide draws an empty panel and the rules and ladder still show', async () => {
    await openWithGuide('');
    expect(screen.getByRole('region', { name: 'Community Rules' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Escalation ladder' })).toBeInTheDocument();
  });
});

describe('when it cannot be shown', () => {
  it('a 403 says so plainly with Try again, which reads once more', async () => {
    const w = await hubWorld();
    let n = 0;
    w.intercept.fn = (req) => (req.path === '/policy' && ++n === 1 ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/guide' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the guide. Your role cannot do this.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Community Rules' })).toBeInTheDocument();
    await waitFor(() => expect(policyReads(w)).toHaveLength(2));
  });

  it('a 500 says the server had a problem', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/policy' ? SERVER_500 : undefined);
    renderHub(w, { path: '/guide' });
    expect(await screen.findByText(/The server had a problem/)).toBeInTheDocument();
  });

  it('a role that cannot read the policy gets the "not available" page, reads nothing, and the tab is gone', async () => {
    const w = await hubWorld({ permissions: { 'policy.read': 'owner' } });
    renderHub(w, { path: '/guide' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available for your role' })).toBeInTheDocument();
    expect(policyReads(w)).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Guide' })).toBeNull();
  });
});
