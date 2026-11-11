// The site's code snippets and install commands must be real: every import line and install command has to appear in a
// README of this repo. Copy that drifts from the READMEs fails here.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CEILINGS_INTRO, CEILINGS_TITLE, FAQ, FEATURES, HERO_CHAT, HUB_STEP, INSTALL_KIT, LEVELS, NPM_PACKAGES, STEPS, WORKS_WITH } from '../src/content';

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
  it('the AI limits are worded as a commitment, not as shipped code (the levels are not built yet)', () => {
    const copy = CEILINGS_TITLE + ' ' + CEILINGS_INTRO;
    expect(copy).toMatch(/building in/i);
    expect(copy).toMatch(/won.t be settings/i);
    expect(copy).not.toMatch(/written into the code|are not settings/i);
  });
  it('snippets use only synthetic terms (when they use any)', () => {
    const all = JSON.stringify([STEPS, HERO_CHAT, FEATURES, FAQ, LEVELS, WORKS_WITH]);
    const words = all.match(/z[o0]rbak|vlemmo|quissel|drakkuun|fenrisk|tarvo|snerp|glarn/gi) ?? [];
    expect(words.length).toBeGreaterThan(0);
  });
  it('has the hero refusal on a synthetic term, with a delivered trash-talk line', () => {
    const refused = HERO_CHAT.filter((m) => m.verdict === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.text).toMatch(/zorbak/i);
    expect(HERO_CHAT.filter((m) => m.verdict === 'delivered').length).toBeGreaterThanOrEqual(2);
  });
  it('has six features, three steps, five levels', () => {
    expect(FEATURES).toHaveLength(6);
    expect(STEPS).toHaveLength(3);
    expect(LEVELS.map((l) => l.level)).toEqual([0, 1, 2, 3, 4]);
  });
  it('only level 0 is marked available; the AI read is not built yet', () => {
    expect(LEVELS.filter((l) => l.status === 'available').map((l) => l.level)).toEqual([0]);
  });
  it('the FAQ states the no-SLA line plainly', () => {
    expect(JSON.stringify(FAQ)).toMatch(/free and open source under Apache-2\.0, with no paid tier/i);
    expect(JSON.stringify(FAQ)).not.toMatch(/forever/i);
    expect(JSON.stringify(FAQ)).toMatch(/no SLA/);
  });
});

describe('the hub and player packages on the page', () => {
  const normal = (t: string) => t.split('\n').map((l) => l.trimEnd()).join('\n');
  const readmeOf = (pkg: string) => normal(readFileSync(join(repo, 'packages', pkg, 'README.md'), 'utf8').replace(/\r\n/g, '\n'));

  it('the hub card no longer says the UI is coming, and says what ships', () => {
    const hub = FEATURES.find((f) => f.id === 'hub');
    expect(hub).toBeDefined();
    expect(hub?.tag).toBeUndefined();
    expect(JSON.stringify(FEATURES)).not.toMatch(/hub ui is coming/i);
    const body = `${hub?.title} ${hub?.body}`;
    for (const re of [/team workbench/i, /simple mode/i, /editable steps/i, /reporting/i, /drop-in/i, /pieces/i, /hooks/i, /headless/i, /<chatwarden-hub>/]) {
      expect(body, String(re)).toMatch(re);
    }
    expect(hub?.link?.href).toBe('https://www.npmjs.com/package/@chatwarden/hub-react');
  });

  it('counts the ways to adopt the way hub-react’s README does: three (drop-in, pieces, hooks and headless)', () => {
    const body = FEATURES.find((f) => f.id === 'hub')?.body ?? '';
    expect(body).toContain('as a drop-in, as pieces, or as hooks and headless');
    expect(body).not.toMatch(/four ways/i);
    expect(readmeOf('hub-react')).toContain('## Three ways to adopt');
  });

  it('the hub step starts with the README’s install line, a contiguous block of the hub-react README', () => {
    expect(HUB_STEP.install.code).toBe('npm install @chatwarden/hub-react @chatwarden/core @chatwarden/http react react-dom');
    expect(readmeOf('hub-react')).toContain(normal(HUB_STEP.install.code));
  });

  it('the hub step shows the drop-in <Hub> and, as the alternative, the one-script-tag element, each a contiguous README block', () => {
    expect(HUB_STEP.dropIn.code).toContain('<Hub client={client} />');
    expect(HUB_STEP.element.code).toContain('<chatwarden-hub base-url="/admin"></chatwarden-hub>');
    expect(readmeOf('hub-react')).toContain(normal(HUB_STEP.dropIn.code));
    expect(readmeOf('hub-element')).toContain(normal(HUB_STEP.element.code));
  });

  it('every non-blank line of the hub step is a verbatim README line (and the check can fail: a changed line is caught)', () => {
    const all = new Set([readmeOf('hub-react'), readmeOf('hub-element')].flatMap((t) => t.split('\n')));
    const lines = [HUB_STEP.install.code, HUB_STEP.dropIn.code, HUB_STEP.element.code].flatMap((c) => c.split('\n')).filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.filter((l) => !all.has(l.trimEnd()))).toEqual([]);
    expect(all.has('export const ModeratorPage = () => <Hub client={client} />; // changed')).toBe(false);
  });

  it('names the three packages with their npm links, all real non-private packages of this repo', () => {
    expect(NPM_PACKAGES.map((p) => p.name)).toEqual(['@chatwarden/hub-react', '@chatwarden/player-react', '@chatwarden/hub-element']);
    for (const p of NPM_PACKAGES) {
      expect(p.href).toBe(`https://www.npmjs.com/package/${p.name}`);
      const pkg = JSON.parse(readFileSync(join(repo, 'packages', p.name.split('/')[1] as string, 'package.json'), 'utf8')) as { name: string; private?: boolean };
      expect(pkg.name).toBe(p.name);
      expect(pkg.private).not.toBe(true);
    }
  });
});
