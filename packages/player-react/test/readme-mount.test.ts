import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as player from '../src/index.js';

// The README's way in: install, the easy path, mounting on a server, signing players in, the CSP, then the reference. Its snippets are
// compiled by scripts/readme.test.ts; this holds what the prose promises and that the reference lists every public component.

const root = process.cwd();
const readme = readFileSync(join(root, 'packages', 'player-react', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const flat = (text: string): string => text.replace(/\s+/g, ' ');
/** The text of a `##` heading's section, up to the next `##`. */
const section = (heading: string): string => {
  const start = readme.indexOf(`\n## ${heading}\n`);
  expect(start, `section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
};

describe('the order: the easy path first', () => {
  it('goes Install, Quick start, Put it on your server, Signing players in, Content Security Policy, Options, Theming', () => {
    const headings = [...readme.matchAll(/^## (.*)$/gm)].map((m) => m[1] as string);
    const wanted = ['Install', 'Quick start', 'Put it on your server', 'Signing players in', 'Content Security Policy', 'Options', 'Theming'];
    expect(headings.filter((h) => wanted.includes(h))).toEqual(wanted);
  });
});

describe('mounting on a server', () => {
  const mount = flat(section('Put it on your server'));
  it('says to serve the built game page and the player routes under one origin, and why', () => {
    expect(mount).toContain('serve the built game page and the player routes under one origin');
    expect(mount).toMatch(/no CORS to set up/);
  });
  it('shows Express with the adapter and the static page, and says any server works the same', () => {
    expect(mount).toContain("toExpress( playerRoutes(cw, {");
    expect(mount).toContain("express.static('dist/game')");
    expect(mount).toMatch(/Any other server works the same way/);
    expect(mount).toContain('createRouter(playerRoutes(...))');
    expect(mount).toContain("credentials: 'include'");
  });
});

describe('signing players in', () => {
  const auth = flat(section('Signing players in'));
  it('puts the decision on the server: identify, from the session, never the page', () => {
    expect(auth).toContain('`identify`');
    expect(auth).toContain('`clientKey` or `accountId`');
    expect(auth).toMatch(/from your session, never from the page/);
  });
  it('covers cookies and headers, a rotating token, and keeping the key out of URLs and logs', () => {
    expect(auth).toContain('req.headers.cookie');
    expect(auth).toContain('fetchTransport({ baseUrl, headers })');
    expect(auth).toMatch(/fixed when the transport is made/);
    expect(section('Signing players in')).toContain('const rotating: Transport');
    expect(auth).toMatch(/keep it out of URLs and logs/);
  });
});

describe('the Content Security Policy', () => {
  it('needs no unsafe-inline and no unsafe-eval, and names the three directives to allow', () => {
    const csp = flat(section('Content Security Policy'));
    expect(csp).toContain("no `'unsafe-inline'` and no `'unsafe-eval'`");
    for (const directive of ['script-src', 'style-src', 'connect-src']) expect(csp, directive).toContain(`\`${directive}\``);
  });
});

describe('theming', () => {
  it('says where the tokens go: the component root, not an ancestor, because the defaults sit on .cw-player', () => {
    expect(flat(section('Theming'))).toMatch(/Put the tokens on the component's own root .* not on an ancestor/);
  });
});

describe('the reference lists everything public', () => {
  it('every component is exported and is a row of the components table', () => {
    for (const name of ['NoticeQueue', 'MyRecord', 'RulesPage', 'ReportDialog', 'RestrictedChatLine']) {
      expect(Object.keys(player), `${name} is exported`).toContain(name);
      expect(readme, name).toContain(`| \`${name}\` |`);
    }
  });
  it('the client methods, the transports and the words are documented', () => {
    for (const method of ['notices()', 'ack(id)', 'record()', 'rules()']) expect(readme, method).toContain(`| \`${method}\` |`);
    expect(readme).toContain('`fetchTransport({ baseUrl, headers?, credentials?, fetch? })`');
    expect(readme).toContain('### Words and languages');
    expect(readme).toContain('<NoticeQueue t={t} locale="de" ... />');
  });
});
