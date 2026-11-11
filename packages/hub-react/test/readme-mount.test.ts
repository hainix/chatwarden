import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as hub from '../src/index.js';

// The README's way in: install, the easy path, mounting on a server, signing moderators in, the CSP, then the four ways to adopt and the
// full reference. Its snippets are compiled by scripts/readme.test.ts and, for the four ways, by readme-adopt.test.tsx; this holds what the
// prose promises and that the reference lists every public piece, hook and prop.

const root = process.cwd();
const readme = readFileSync(join(root, 'packages', 'hub-react', 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const flat = (text: string): string => text.replace(/\s+/g, ' ');
/** The text of a heading's section, up to the next heading of the same or a higher level. */
const section = (heading: string, level = '##'): string => {
  const start = readme.indexOf(`\n${level} ${heading}\n`);
  expect(start, `section ${heading}`).toBeGreaterThanOrEqual(0);
  const rest = readme.slice(start + 1);
  const next = rest.slice(1).search(new RegExp(`\\n#{1,${level.length}} `));
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('the order: the easy path first', () => {
  it('goes Install, Quick start, Put it on your server, Signing moderators in, Content Security Policy, Four ways to adopt, Options, Theming', () => {
    const headings = [...readme.matchAll(/^## (.*)$/gm)].map((m) => m[1] as string);
    const wanted = ['Install', 'Quick start', 'Put it on your server', 'Signing moderators in', 'Content Security Policy', 'Four ways to adopt', 'Options', 'Theming'];
    expect(headings.filter((h) => wanted.includes(h))).toEqual(wanted);
  });
  it('the quick start is a client and one <Hub>, with nothing about pieces or hooks in it', () => {
    const quick = section('Quick start');
    expect(quick).toContain('<Hub client={client} />');
    expect(quick).not.toMatch(/HubProvider|useCases/);
  });
});

describe('mounting on a server', () => {
  const mount = flat(section('Put it on your server'));
  it('says to serve the built page and the staff API under one origin, and why', () => {
    expect(mount).toContain('serve the built page and the staff API under one origin');
    expect(mount).toMatch(/no CORS to set up/);
  });
  it('shows Express (the adapter before any body parser, the page as static files) and says any server works the same', () => {
    expect(mount).toContain('toExpress(adminRoutes(cw, { authorize: yourModeratorLogin }), { fallthrough: false })');
    expect(mount).toContain('mount them before any body parser');
    expect(mount).toContain("express.static('dist/mod')");
    expect(mount).toMatch(/Any other server works the same way/);
    expect(mount).toContain('createRouter(adminRoutes(...))');
  });
  it('says what another origin needs, and points at the element for a page with no React build', () => {
    expect(mount).toMatch(/Another origin\*\* needs three more things/);
    expect(mount).toContain("credentials: 'include'");
    expect(mount).toContain('@chatwarden/hub-element');
  });
});

describe('signing moderators in', () => {
  const auth = flat(section('Signing moderators in'));
  it('puts the decision on the server: authorize answers { actor, role } or null, and the kit checks the permissions', () => {
    expect(auth).toContain('`authorize`');
    expect(auth).toContain('{ actor, role }');
    expect(auth).toMatch(/`null` for nobody \(a 401\)/);
    expect(auth).toMatch(/\(a 403\)/);
    expect(auth).toContain('GET /me');
  });
  it('covers cookies and headers: fetchTransport({ baseUrl, headers }), with a rotating token', () => {
    expect(auth).toContain('req.headers.cookie');
    expect(auth).toContain('fetchTransport({ baseUrl, headers })');
    expect(auth).toMatch(/fixed when the transport is made/);
    expect(section('Signing moderators in')).toContain('const rotating: Transport');
  });
  it('warns about cookie-authenticated APIs: SameSite or a CSRF header, no shared caches', () => {
    expect(auth).toMatch(/SameSite=Strict/);
    expect(auth).toMatch(/CSRF header/);
    expect(auth).toContain('no-store');
  });
});

describe('the Content Security Policy', () => {
  const csp = flat(section('Content Security Policy'));
  it('needs no unsafe-inline and no unsafe-eval, and names the three directives to allow', () => {
    expect(csp).toContain("no `'unsafe-inline'` and no `'unsafe-eval'`");
    for (const directive of ['script-src', 'style-src', 'connect-src']) expect(csp, directive).toContain(`\`${directive}\``);
    expect(csp).toContain("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'");
  });
});

describe('theming and words', () => {
  it('says the tokens can be set on any ancestor, and keeps the t and locale story', () => {
    expect(flat(section('Theming'))).toMatch(/Set a token on any element above the hub/);
    expect(flat(readme)).toContain('<Hub t={t} locale="de" />');
  });
});

describe('the reference lists everything public', () => {
  it('every piece is exported and is a row of the pieces table', () => {
    const pieces = ['CaseList', 'CaseCard', 'CaseWorkbench', 'PersonRecord', 'TermsManager', 'BlockedList', 'AuditLog', 'RuleGaps', 'Guide', 'RecentActions', 'LadderSettings', 'ReportingSettings'];
    const exported = Object.keys(hub);
    for (const name of pieces) {
      expect(exported, `${name} is exported`).toContain(name);
      expect(readme, name).toContain(`| \`${name}\` |`);
    }
  });
  it('every embedding hook is exported and is in the hooks table', () => {
    const exported = Object.keys(hub);
    for (const name of ['useMe', 'useCases', 'useCase', 'useDecide', 'useClaim', 'usePolicy', 'useTerms', 'useBlocked', 'usePerson', 'useHubController']) {
      expect(exported, `${name} is exported`).toContain(name);
      expect(section('Four ways to adopt'), name).toContain(`\`${name}(`);
    }
  });
  it('every <Hub> prop, read from the source, has a row in the props table', () => {
    const source = readFileSync(join(root, 'packages', 'hub-react', 'src', 'Hub.tsx'), 'utf8').replace(/\r\n/g, '\n');
    const body = /export interface HubProps \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const props = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    expect(props).toContain('primary');
    expect(props.length).toBeGreaterThanOrEqual(10);
    const table = section('`<Hub>` props', '###');
    for (const prop of props) expect(table, prop).toContain(`| \`${prop}\` |`);
  });
  it('the headless entry, the HubClient methods and the transports are documented', () => {
    for (const heading of ['`HubClient`', 'Transports', 'Routing', 'Words and languages']) section(heading, '###');
    expect(readme).toContain('## Headless (any framework)');
    expect(readme).toContain('`fetchTransport({ baseUrl, headers?, credentials?, fetch? })`');
  });
});
