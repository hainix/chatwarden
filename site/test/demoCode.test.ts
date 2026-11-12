// "Show the code" must show real code: every non-blank line has to be a verbatim line of a README in this repo.
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE_STEPS } from '../src/demo/codeSteps';

const repo = join(__dirname, '..', '..');
const readmeFiles = ['README.md', ...readdirSync(join(repo, 'packages')).map((p) => join('packages', p, 'README.md'))];
const readme = (rel: string) => readFileSync(join(repo, rel), 'utf8').split('\n').map((l) => l.trimEnd());

describe('Show the code', () => {
  it('has one snippet per tour step, each with a title, a one-sentence blurb and a source README', () => {
    expect(CODE_STEPS).toHaveLength(4); // one per tour step
    for (const s of CODE_STEPS) {
      expect(s.title.length).toBeGreaterThan(3);
      expect(s.blurb.length).toBeGreaterThan(20);
      expect(readmeFiles.map((f) => f.split(sep).join('/'))).toContain(s.source);
    }
  });
  it('every non-blank line is copied verbatim from the README it names', () => {
    for (const s of CODE_STEPS) {
      const have = new Set(readme(s.source));
      const lines = s.code.split('\n').filter((l) => l.trim() !== '');
      expect(lines.length, s.title).toBeGreaterThan(0);
      const missing = lines.filter((l) => !have.has(l.trimEnd()));
      expect(missing, s.title).toEqual([]);
    }
  });
  it('each snippet is one contiguous block of its README, in order (not lines stitched together)', () => {
    for (const s of CODE_STEPS) {
      const readmeText = readme(s.source).join('\n');
      const block = s.code.split('\n').map((l) => l.trimEnd()).join('\n');
      expect(readmeText.includes(block), s.title).toBe(true);
    }
  });
  it('a reordered or stitched snippet would fail the contiguity check (control)', () => {
    const lines = (CODE_STEPS[1]?.code ?? '').split('\n');
    const stitched = [lines[0], lines[3], lines[2]].join('\n');
    expect(readme('packages/core/README.md').join('\n').includes(stitched)).toBe(false);
  });
  it('the blurbs are the proposal’s, one sentence each', () => {
    expect(CODE_STEPS.map((c) => c.blurb)).toEqual([
      'Your server files the report with one call. The room and players come from your session, never from the client.',
      'The whole hub is one component on a page of your admin site.',
      "A decision closes the report, applies the action (here a warning) and writes the player's notice in one step.",
      "Your game reads the player's notices from one route and shows them with the notice dialog.",
    ]);
  });
  it('where the demo differs from a game it says so, beside the blurb: notices are read in process here, over HTTP in a game', () => {
    const note = CODE_STEPS[3]?.demoNote ?? '';
    expect(note).toMatch(/HTTP/);
    expect(note).toContain('cw.notices.pending');
    expect(note).toMatch(/in process/);
    expect(note).toMatch(/local transport/);
    expect(note).toMatch(/never carries anyone else’s chat, an IP, or an account or subject id/);
    expect(CODE_STEPS[0]?.demoNote).toContain('cw.reports.submit');
  });
  it('keeps each snippet short (a few lines, not a page)', () => {
    for (const s of CODE_STEPS) expect(s.code.split('\n').length, s.title).toBeLessThanOrEqual(10);
  });
  it('calls the real entry points the steps are about', () => {
    expect(CODE_STEPS[0]?.code).toContain('cw.reports.submit(');
    expect(CODE_STEPS[0]?.source).toBe('packages/player-react/README.md');
    expect(CODE_STEPS[1]?.code).toContain('<Hub client={client} />');
    expect(CODE_STEPS[1]?.source).toBe('packages/hub-react/README.md');
    expect(CODE_STEPS[2]?.code).toContain('await cw.decide(');
    expect(CODE_STEPS[2]?.source).toBe('packages/core/README.md');
    expect(CODE_STEPS[3]?.code).toContain('client.notices()');
    expect(CODE_STEPS[3]?.source).toBe('packages/player-react/README.md');
  });
  it('shows no address a visitor could mistake for something this page loads (the hub-element CDN line is not a step)', () => {
    for (const s of CODE_STEPS) expect(s.code, s.title).not.toMatch(/https?:\/\//);
  });
  it('the titles are the tour steps’, in order', async () => {
    const { TOUR_STEPS } = await import('../src/demo/script');
    expect(CODE_STEPS.map((s) => s.title)).toEqual(TOUR_STEPS.map((s) => s.title));
  });
});
