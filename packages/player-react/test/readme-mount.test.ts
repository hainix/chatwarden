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
  it('says where the tokens go: on any element above the components, because the defaults are private and sit at zero specificity', () => {
    const theming = flat(section('Theming'));
    expect(theming).toMatch(/Set a token on any element above the components .* on `\.cw-player`, or on the `className` you pass/);
    expect(theming).toContain('private `--cwd-*` names');
    expect(theming).not.toMatch(/not on an ancestor|shadowed/);
  });

  it('says a dialog drawn into another container does not see a wrapper\'s tokens', () => {
    expect(flat(section('Theming'))).toMatch(/drawn into another `container` has its own root there/);
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

describe('reporting in the README is one step', () => {
  const quick = flat(section('Quick start'));
  it('describes the one dialog: the question, the optional Why? select, Add a note, and Report sent', () => {
    expect(quick).toContain('Reporting is one step');
    expect(quick).toContain('"Report this message?"');
    expect(quick).toContain('"Why?"');
    expect(quick).toContain('"Add a note"');
    expect(quick).toContain('"Report sent"');
  });
  it('says onAddDetail is deprecated and never called, and has no follow-up step', () => {
    expect(quick).toMatch(/`onAddDetail` is deprecated/);
    expect(quick).not.toContain('"Add a reason"');
    expect(quick).not.toContain('Skip and report');
  });
  it('its server snippet sends the draft (reason, note) to cw.reports.submit and no longer wires addDetail', () => {
    expect(quick).toContain('...draft');
    expect(quick).not.toContain('POST /report/:id/detail');
    expect(quick).not.toMatch(/onAddDetail=\{/);
  });
  it('the components table lists ReportDialog as a one-step dialog', () => {
    const row = readme.split('\n').find((l) => l.startsWith('| `ReportDialog` |')) ?? '';
    expect(row).toContain('one-step');
    expect(row).not.toContain('"Add a reason"');
  });
  it('documents the experimental extra prop with a small example, and the Tab order', () => {
    expect(quick).toContain('`extra`, experimental');
    expect(quick).toContain('Also mute this player');
    expect(quick).toContain('reason, note, yours, Report, Cancel');
    expect(readme.split(String.fromCharCode(10)).find((l) => l.startsWith('| `ReportDialog` |'))).toContain('`extra`');
  });
});
