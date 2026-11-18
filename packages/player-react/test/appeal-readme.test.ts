// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The README says how the appeal form counts, and says it the way the code does.

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

describe('the README on the appeal count', () => {
  it('says the client counts code points of the trimmed text, may count slightly more than the server, never less', () => {
    expect(readme).toMatch(/code points of the trimmed text/);
    expect(readme).toMatch(/slightly more than the server[^.]*never less/);
  });
  it('says Send is off while empty or over the limit and the text is refused, never cut', () => {
    expect(readme).toMatch(/refused, never cut/);
  });
});

// The README's "Appeal page" section (appeals landing): what the component is, the props that matter, that the token is a capability, how to read it from the address, what CORS needs,
// and that the served page works without it.
describe('the README on the Appeal page', () => {
  const raw = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const start = raw.indexOf('\n## Appeal page\n');
  const next = raw.indexOf('\n## ', start + 1);
  const part = start === -1 ? '' : raw.slice(start, next === -1 ? undefined : next);
  const text = part.replace(/\s+/g, ' ');

  it('has an "Appeal page" section of its own', () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });
  it('names the subpath, the component and the three props that matter', () => {
    expect(text).toContain('@chatwarden/player-react/appeal');
    expect(text).toContain('`AppealPage`');
    for (const prop of ['`endpoint`', '`token`', '`client`']) expect(text, prop).toContain(prop);
  });
  it('says the token is a capability: whoever holds the link can appeal, so it is not logged or shown', () => {
    expect(text).toMatch(/token is a capability/i);
    expect(text).toMatch(/never (log|put)/i);
  });
  it('shows readAppealToken(location.search) and createAppealPageClient', () => {
    expect(text).toContain('`readAppealToken(location.search)`');
    expect(text).toContain('`createAppealPageClient`');
    expect(part).toContain("from '@chatwarden/player-react/appeal'");
  });
  it('says CORS needs the game\'s origin in appeals.landingOrigins, and that no cookie or sign-in is used', () => {
    expect(text).toContain('`appeals.landingOrigins`');
    expect(text).toMatch(/no cookie/i);
    expect(text).toMatch(/no sign-in|does not identify/i);
  });
  it('says the served /appeal page works without it, and that the main entry and its size are untouched', () => {
    expect(text).toMatch(/served `\/appeal` page/);
    expect(text).toMatch(/main entry and its size are untouched/);
  });
  it('says a custom t must carry the appeal words (noticeWordsFor), and what the optional contact prop is for', () => {
    expect(text).toContain('`noticeWordsFor`');
    expect(text).toContain('`contact`');
  });
});
