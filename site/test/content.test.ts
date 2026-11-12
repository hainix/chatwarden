// The site's code snippets and install commands must be real: every import line and install command has to appear in a
// README of this repo. Copy that drifts from the READMEs fails here. The words are the ones in
// docs/design/2026-11-11-site-copy-rewrite.md (section 3); the glossary rule there is tested too.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_FAQ_PREPARED,
  AI_LEVELS_AVAILABLE,
  AI_SECTION_PREPARED,
  buildFaq,
  FAQ,
  HERO,
  HERO_CHAT,
  HOW_PANELS,
  HUB_STEP,
  INSTALL_KIT,
  OPEN_SOURCE,
  PLAYER_STEP,
  RULES_STRIP,
  STEPS,
} from '../src/content';

const repo = join(__dirname, '..', '..');
const readmes = [
  join(repo, 'README.md'),
  ...readdirSync(join(repo, 'packages')).map((p) => join(repo, 'packages', p, 'README.md')),
].map((p) => readFileSync(p, 'utf8'));
const allReadme = readmes.join('\n');

describe('content is grounded in the READMEs', () => {
  it('the install commands appear in the README as written', () => {
    expect(allReadme).toContain('npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher');
    expect(INSTALL_KIT).toBe('npm install @chatwarden/core @chatwarden/store-sqlite @chatwarden/matcher');
    expect(STEPS[0]?.code).toBe(INSTALL_KIT);
  });
  it('every import line in the step snippets is a real line from a README', () => {
    const lines = STEPS.flatMap((s) => s.code.split('\n')).filter((l) => /^import /.test(l));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      const normal = (s: string) => s.replace(/\s+/g, ' ').trim();
      expect(normal(allReadme), line).toContain(normal(line));
    }
  });
  it('every non-blank line of every code snippet is a verbatim line of a README', () => {
    const readmeLines = new Set(allReadme.split('\n').map((l) => l.trimEnd()));
    const lines = STEPS.flatMap((s) => s.code.split('\n')).filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(25);
    const missing = lines.filter((l) => !readmeLines.has(l.trimEnd()));
    expect(missing).toEqual([]);
  });
  it('the snippets still call the real entry points (so the verbatim check is not vacuous)', () => {
    const code = STEPS.map((s) => s.code).join('\n');
    for (const call of ['createChatwarden(', 'openStore(', 'cw.chat.accept(', 'cw.rooms.seatConnection(', 'new LiveTerms(']) {
      expect(code, call).toContain(call);
    }
  });
  it('snippets use only synthetic terms (when they use any)', () => {
    const all = JSON.stringify([STEPS, HERO_CHAT, HOW_PANELS, FAQ]);
    const words = all.match(/z[o0]rbak|vlemmo|quissel|drakkuun|fenrisk|tarvo|snerp|glarn/gi) ?? [];
    expect(words.length).toBeGreaterThan(0);
  });
  it('has the hero block on a synthetic term, with a delivered trash-talk line', () => {
    const blocked = HERO_CHAT.filter((m) => m.verdict === 'refused');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.text).toMatch(/zorbak/i);
    expect(HERO_CHAT.filter((m) => m.verdict === 'delivered').length).toBeGreaterThanOrEqual(2);
  });
  it('step 2 shows its code collapsed (the full file stays in the page), and says what it does', () => {
    const engine = STEPS[1];
    expect(engine?.title).toBe('Set it up once');
    // the preview runs down to the matcher, so it shows the platform hook and the store, not only the imports
    expect(engine?.collapsedLines).toBeGreaterThanOrEqual(20);
    expect(engine?.collapsedLines).toBeLessThanOrEqual(24);
    expect(engine?.code.split('\n').length).toBeGreaterThan((engine?.collapsedLines ?? 0) + 6);
    expect(engine?.code.split('\n').slice(0, engine.collapsedLines).join('\n')).toContain('const platform: Platform');
  });
});

describe('the steps, panels and questions', () => {
  it('has three panels, three code steps, a hub step and an optional player step (five steps in all)', () => {
    expect(HOW_PANELS.map((p) => p.title)).toEqual(['In the chat', 'In your game', 'In your moderator hub']);
    expect(STEPS).toHaveLength(3);
    expect([...STEPS.map((s) => s.title), HUB_STEP.title, PLAYER_STEP.title]).toEqual([
      'Install',
      'Set it up once',
      'Check every message',
      'Add the moderator hub',
      'Show players what happened',
    ]);
    expect(PLAYER_STEP.optional).toBe(true);
  });
  it('the step texts are the proposal’s', () => {
    expect(STEPS.map((s) => s.body)).toEqual([
      'The engine, its storage (one SQLite file, using the SQLite built into Node) and the word filter.',
      'Tell it how to recognise a player: your login token and their IP address, both hashed before anything is stored. Load your word list and pick relaxed, standard or strict. The code uses made-up test words; see the matcher README for the term pack format.',
      'Call it before you broadcast a message. It answers deliver, or block with a reason you show only to the sender.',
    ]);
  });
  it('the cost answer and the open-source band say it plainly: Apache-2.0, no paid tier, pre-release, no support promise yet, never "forever"', () => {
    expect(FAQ.find((f) => f.id === 'cost')?.a).toBe("Nothing. It's open source under Apache-2.0, with no paid tier.");
    expect(JSON.stringify([FAQ, OPEN_SOURCE])).not.toMatch(/forever|no strings/i);
    expect(OPEN_SOURCE.body).toBe(
      'Apache-2.0, with no paid tier and nothing hosted. It runs on your server and keeps its data in your database file. Chatwarden is pre-release (version 0.1): ready to try, with no support promise yet. Issues and pull requests are welcome.',
    );
  });
  it('the FAQ is the nine questions developers ask, in order', () => {
    expect(FAQ.map((f) => f.q)).toEqual([
      'Does Chatwarden give my game a chat?',
      'Will it work with my game server?',
      'Which words does it block?',
      'How do my moderators sign in?',
      'Where is player data stored?',
      'What does it cost?',
      'Does it use AI?',
      'Can reports go to Discord?',
      'Is it a child-safety tool?',
    ]);
  });
  it('the FAQ is honest about the limits: no chat, Node only, bring your own word list, spaced letters, AI not built', () => {
    const a = (id: string) => FAQ.find((f) => f.id === id)?.a ?? '';
    expect(a('chat')).toMatch(/^No\. It moderates the chat you already have\./);
    expect(a('server')).toMatch(/Node 22\.13 or newer/);
    expect(a('server')).toMatch(/no ready-made bridge yet/);
    expect(a('words')).toMatch(/There's no shared list yet, so you bring your own/);
    expect(a('words')).toMatch(/Words with spaces between the letters are not caught, on purpose/);
    expect(a('ai')).toMatch(/It isn't built yet\.$/);
    expect(a('data')).toMatch(/Chatwarden runs no servers and collects nothing, and this site has no analytics\./);
  });
  it('the page prose avoids the jargon the proposal retired (outside code samples)', () => {
    const prose = JSON.stringify([
      HOW_PANELS,
      RULES_STRIP,
      FAQ,
      OPEN_SOURCE,
      STEPS.map((s) => [s.title, s.body]),
      [HUB_STEP.title, HUB_STEP.body],
      [PLAYER_STEP.title, PLAYER_STEP.body],
    ]);
    expect(prose).not.toMatch(/\bladder\b|\brefus(e|ed|es|al)\b|\bseats?\b|staff routes|headless|ceilings?|\bpreset\b|simple mode|\bidentify\b|\bAI levels?\b/i);
  });
  it('the page promises only what is true: two presses to report, one card per player (a case), blocks from your list, a short setup', () => {
    const prose = JSON.stringify([HERO, HOW_PANELS, FAQ, STEPS.map((x) => x.body)]);
    expect(prose).not.toMatch(/one tap|one card per report|a few lines|always deciding|\bone-tap\b/i);
    expect(HERO.lead).toBe("Chatwarden blocks slurs from your word list before they're posted, lets players report a message right from the chat, and gives your team a moderator hub: each player with open reports is a case, with every report about them and one click to act. Add it to the chat you already have with a short setup on your Node server.");
    expect(HERO.lead).toContain('slurs from your word list');
    expect(HOW_PANELS[1]?.body).toMatch(/^Players report a message right from the chat\./);
    expect(HOW_PANELS[2]?.body).toMatch(/^The moderator hub is a web page where your team handles reports\. Each case is one card:/);
  });
  it('"case" is defined once, where the hub is first described (the hero), and the tour uses it the same way', () => {
    expect(HERO.lead).toContain('each player with open reports is a case');
  });
  it('the AI answer promises nothing about who decides (levels 3 and 4 are planned to act on clear cases)', () => {
    expect(FAQ.find((f) => f.id === 'ai')?.a).toBe("No. Optional AI help that reads reports and suggests a decision is planned. It isn't built yet.");
  });
  it('invents no customers, counts or stats', () => {
    const text = JSON.stringify([HOW_PANELS, FAQ, OPEN_SOURCE]);
    expect(text).not.toMatch(/\b\d[\d,.]*\s?[kKmM]?\+?\s+(users|customers|studios|games|downloads|stars|developers)\b/);
    expect(text).not.toMatch(/trusted by|moxgate/i);
  });
});

describe('the hub and player packages on the page', () => {
  const normal = (t: string) => t.split('\n').map((l) => l.trimEnd()).join('\n');
  const readmeOf = (pkg: string) => normal(readFileSync(join(repo, 'packages', pkg, 'README.md'), 'utf8').replace(/\r\n/g, '\n'));
  const rootReadme = () => normal(readFileSync(join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n'));

  it('the hub step is the server first, then two ways to put the hub on a page (React, any page)', () => {
    expect(HUB_STEP.server.map((x) => x.file)).toEqual(['terminal', 'server.ts']);
    expect(HUB_STEP.tabs.map((t) => t.label)).toEqual(['React', 'Any page']);
    expect(HUB_STEP.body).toBe(
      "Mount the moderator routes on your server, behind your own login: you write one function that says who's a moderator. Then put the hub on a page. In React it's one component; anywhere else it's one script tag.",
    );
  });

  it('the server block installs the routes and Express, imports what it uses, and mounts the routes: contiguous blocks of a README', () => {
    const [install, mount] = HUB_STEP.server;
    expect(install?.code).toBe('npm install @chatwarden/http express @types/express');
    expect(readmeOf('hub-react')).toContain(normal(install?.code ?? ''));
    expect(mount?.code).toContain("import { adminRoutes } from '@chatwarden/http';");
    expect(mount?.code).toContain("import { toExpress } from '@chatwarden/http/express';");
    expect(mount?.code).toContain("app.use('/admin', toExpress(adminRoutes(cw, { authorize: yourModeratorLogin }), { fallthrough: false }));");
    expect(readmeOf('hub-react')).toContain(normal(mount?.code ?? ''));
  });

  it('the React tab has the install line, the client the drop-in imports from ./client, and the drop-in <Hub>: contiguous README blocks', () => {
    const react = HUB_STEP.tabs.find((t) => t.id === 'react');
    const [install, client, dropIn] = react?.snippets ?? [];
    expect(install?.code).toBe('npm install @chatwarden/hub-react @chatwarden/core @chatwarden/http react react-dom');
    expect(client?.file).toBe('client.ts');
    expect(client?.code).toContain("export const client = createHubClient(fetchTransport({ baseUrl: '/admin', credentials: 'same-origin' }));");
    expect(dropIn?.code).toContain("import { client } from './client';");
    expect(dropIn?.code).toContain('<Hub client={client} />');
    for (const snippet of [install, client, dropIn]) expect(readmeOf('hub-react')).toContain(normal(snippet?.code ?? ''));
  });

  it('the Any page tab is the one-script-tag element, a contiguous block of the hub-element README', () => {
    const page = HUB_STEP.tabs.find((t) => t.id === 'page');
    expect(page?.snippets[0]?.code).toContain('<chatwarden-hub base-url="/admin"></chatwarden-hub>');
    expect(readmeOf('hub-element')).toContain(normal(page?.snippets[0]?.code ?? ''));
  });

  it('every non-blank line of the hub step is a verbatim README line (and the check can fail: a changed line is caught)', () => {
    const all = new Set([readmeOf('hub-react'), readmeOf('hub-element'), rootReadme()].flatMap((t) => t.split('\n')));
    const snippets = [...HUB_STEP.server, ...HUB_STEP.tabs.flatMap((t) => t.snippets)];
    const lines = snippets.flatMap((x) => x.code.split('\n')).filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(20);
    expect(lines.filter((l) => !all.has(l.trimEnd()))).toEqual([]);
    expect(all.has('export const ModeratorPage = () => <Hub client={client} />; // changed')).toBe(false);
  });

  it('the player step links player-react (a real, published package of this repo) and carries no code', () => {
    expect(PLAYER_STEP.link.href).toBe('https://github.com/hainix/chatwarden/tree/main/packages/player-react');
    expect(PLAYER_STEP.body).toBe("Add the report dialog, notices and the player's record from @chatwarden/player-react.");
    const pkg = JSON.parse(readFileSync(join(repo, 'packages', 'player-react', 'package.json'), 'utf8')) as { name: string; private?: boolean };
    expect(pkg.name).toBe('@chatwarden/player-react');
    expect(pkg.private).not.toBe(true);
  });
});

describe('the words of the proposal (docs/design/2026-11-11-site-copy-rewrite.md section 3)', () => {
  it('the hero chat blocks one invented word and says only Bo sees the notice', () => {
    const blocked = HERO_CHAT.find((m) => m.verdict === 'refused');
    expect(blocked?.notice).toBe('Blocked. Only Bo sees this.');
  });
  it('the third panel points bigger teams at the Detailed view and Discord users at the forum feed', () => {
    expect(HOW_PANELS[2]?.aside).toMatch(/^Bigger team\? The hub's Detailed view adds a full queue/);
    expect(HOW_PANELS[2]?.aside).toMatch(/Prefer Discord\?/);
  });
  it('the rules strip', () => {
    expect(RULES_STRIP.title).toBe('Your rules');
    expect(RULES_STRIP.body).toBe(
      'Start with relaxed, standard or strict rules. They set what counts as over the line, what the hub suggests, and the code of conduct your players read. Change any of it later in the hub.',
    );
  });
});

// AI levels 1 and 2 (0.1.7): the wording that says they are available is written and tested, but not shown. The page still says "planned" (the tests
// above) until the release is on npm and Moxgate has run it (design question 10); then AI_LEVELS_AVAILABLE becomes true, the "unflipped" tests below
// are replaced by the flipped ones, and the site is deployed by hand. Until then nothing in the built page changes.
describe('the wording for AI levels 1 and 2 is prepared and not shown (unflipped)', () => {
  it('the switch is off, and the page shows the "planned" answer and no AI section', () => {
    expect(AI_LEVELS_AVAILABLE).toBe(false);
    expect(FAQ.find((f) => f.id === 'ai')?.q).toBe('Does it use AI?');
    expect(FAQ).toEqual(buildFaq(false));
    const shown = JSON.stringify([HERO, HERO_CHAT, HOW_PANELS, RULES_STRIP, FAQ, OPEN_SOURCE, STEPS, HUB_STEP, PLAYER_STEP]);
    for (const line of [AI_FAQ_PREPARED.q, AI_FAQ_PREPARED.a, AI_SECTION_PREPARED.title, AI_SECTION_PREPARED.ceilingsIntro]) expect(shown).not.toContain(line);
  });

  it('the prepared FAQ answer is the agreed one, word for word', () => {
    expect(AI_FAQ_PREPARED.id).toBe('ai');
    expect(AI_FAQ_PREPARED.q).toBe("Does an AI read my players' chat?");
    expect(AI_FAQ_PREPARED.a).toBe(
      'Only if you turn it on. Levels are per game and off by default. Only the chat lines of a report, with names replaced, go to the AI provider you choose.',
    );
  });

  it('flipped, it replaces the planned answer in place: same position, same ids, still nine questions', () => {
    const before = buildFaq(false);
    const after = buildFaq(true);
    expect(after).toHaveLength(9);
    expect(after.map((f) => f.id)).toEqual(before.map((f) => f.id));
    expect(after.find((f) => f.id === 'ai')).toEqual(AI_FAQ_PREPARED);
    for (const f of before) if (f.id !== 'ai') expect(after.find((g) => g.id === f.id)).toEqual(f);
    expect(JSON.stringify(after)).not.toMatch(/isn't built yet|is planned/);
  });

  it('the prepared copy tells the truth about this release: advice only, a person decides, off by default, the ceilings in code', () => {
    const s = AI_SECTION_PREPARED;
    expect(s.title).toBe('Optional AI help, with a person in charge');
    expect(s.levels.map((l) => l.name)).toEqual(['Read', 'Recommend']);
    expect(s.lead).toMatch(/A moderator makes every decision\.$/);
    expect(s.ceilingsIntro).toBe('The AI can advise; it cannot act. These limits are in the code, not in a setting:');
    expect(s.ceilings).toEqual([
      'The one-key accept never fills in a ban or anything longer than 24 hours.',
      'A suggestion to act needs a line the reported player wrote.',
      'Flags, mutes and report counts never reach the model.',
      'Names, handles, IP addresses and ids are replaced or left out before anything leaves your server.',
      'It stops at the daily spending limit you set in code.',
    ]);
  });

  it('the prepared copy promises nothing it cannot keep: no accuracy, no replacing moderators, no acting alone, no default-on', () => {
    const text = JSON.stringify([AI_FAQ_PREPARED, AI_SECTION_PREPARED]);
    expect(text).not.toMatch(/accura|always right|replace(s)? your moderators|on its own|automatic|acts alone|free|no cost|private|never leaves|nothing leaves/i);
    // Words the page does not use for the reader (the glossary rule), outside the section title that names the feature.
    expect(JSON.stringify([AI_FAQ_PREPARED.a, AI_SECTION_PREPARED.lead, AI_SECTION_PREPARED.levels, AI_SECTION_PREPARED.ceilings])).not.toMatch(/\bladder\b|\bseats?\b|\bheadless\b|\bpreset\b/i);
  });

  it('each ceiling the copy states is stated in the READMEs too (the copy cannot drift from what the code does)', () => {
    const hub = readFileSync(join(repo, 'packages', 'hub-react', 'README.md'), 'utf8');
    const core = readFileSync(join(repo, 'packages', 'core', 'README.md'), 'utf8');
    expect(hub).toMatch(/24 hours or less/);
    expect(core).toMatch(/never writes a sanction/i);
    expect(core + hub).toMatch(/flags, mutes|Flags, mutes/);
    expect(core).toMatch(/dailyBudgetMicros/);
  });
});
