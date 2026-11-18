import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../packages/core/src/index.js';
import { adminRoutes, createRouter } from '../packages/http/src/admin-entry.js';
import { createMemoryStore } from '../packages/store-memory/src/index.js';
import { compileSnippets } from './snippetCompile.js';

// The recipe pages in docs/recipes embed the golden files, byte for byte (design 9.6, ruling 8). A page holds no code of its own: a code block is
// either the text of a golden file, introduced by a marker line `<!-- golden: <case>/<file> -->`, or a short shell line. `UPDATE_RECIPES=1`
// rewrites the embedded blocks from the goldens after a template change, in the same commit.

const root = fileURLToPath(new URL('..', import.meta.url));
const cases = join(root, 'examples', 'recipes', 'cases');
const recipes = join(root, 'docs', 'recipes');
const PAGES = ['express', 'fastify', 'nextjs', 'socketio', 'colyseus'];
// Guides for the person who runs the moderation (0.2.0): prose with at most a short snippet, not a framework recipe, so the golden-file rules above do not apply to them.
const GUIDES = ['urgent-and-welfare', 'raids', 'digest', 'kids-rooms', 'creator-channels', 'service-mode', 'translations', 'appeal-emails'];
const MARKER = /^<!-- golden: (\S+) -->$/;
const FENCE = /^```(\w*)$/;

const lf = (text: string): string => text.replaceAll('\r\n', '\n');
const pageOf = (name: string): string => join(recipes, `${name}.md`);

interface Block {
  /** The golden path named by the marker before the block, if any. */
  golden?: string;
  language: string;
  text: string;
  /** Line numbers (0-based) of the opening fence and of the closing fence. */
  open: number;
  close: number;
}

/** The fenced blocks of a page, each with the marker line right before it (a blank line between is allowed). */
function blocksOf(text: string): Block[] {
  const lines = lf(text).split('\n');
  const blocks: Block[] = [];
  let marker: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const m = MARKER.exec(line);
    if (m) {
      marker = m[1];
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      let end = i + 1;
      while (end < lines.length && lines[end] !== '```') end += 1;
      const block: Block = { language: fence[1] as string, text: lines.slice(i + 1, end).map((l) => `${l}\n`).join(''), open: i, close: end };
      if (marker !== undefined) block.golden = marker;
      blocks.push(block);
      marker = undefined;
      i = end;
      continue;
    }
    if (line.trim() !== '') marker = undefined;
  }
  return blocks;
}

/** The page with each golden block replaced by the file it names. */
function expand(text: string): string {
  const lines = lf(text).split('\n');
  const blocks = blocksOf(text).filter((b) => b.golden !== undefined).reverse();
  for (const block of blocks) {
    const body = lf(readFileSync(join(cases, block.golden as string), 'utf8'));
    const inner = body.endsWith('\n') ? body.slice(0, -1).split('\n') : body.split('\n');
    lines.splice(block.open + 1, block.close - block.open - 1, ...inner);
  }
  return lines.join('\n');
}

if (process.env.UPDATE_RECIPES === '1') {
  for (const name of PAGES) {
    if (existsSync(pageOf(name))) writeFileSync(pageOf(name), expand(readFileSync(pageOf(name), 'utf8')));
  }
}

const page = (name: string): string => lf(readFileSync(pageOf(name), 'utf8'));
const prose = (name: string): string => page(name).replace(/```[\s\S]*?```/g, '');

describe('docs/recipes', () => {
  it('has the five pages and the five guides, and nothing else', () => {
    expect(readdirSync(recipes).filter((f) => f.endsWith('.md')).sort()).toEqual([...PAGES, ...GUIDES].map((p) => `${p}.md`).sort());
  });

  it('every golden marker resolves to a committed file and the page contains its exact text', () => {
    let seen = 0;
    for (const name of PAGES) {
      for (const block of blocksOf(page(name)).filter((b) => b.golden !== undefined)) {
        const golden = block.golden as string;
        expect(golden.includes('..') && !golden.includes('[...'), `${name}: ${golden} stays under cases/`).toBe(false);
        const file = join(cases, golden);
        expect(existsSync(file), `${name}: ${golden} is a committed file`).toBe(true);
        expect(block.text, `${name}: the block for ${golden} is the file, byte for byte`).toBe(lf(readFileSync(file, 'utf8')));
        expect(['ts', 'tsx', 'js'].includes(block.language), `${name}: ${golden} is fenced as code`).toBe(true);
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });

  it('a page that differs from its goldens is found (control)', () => {
    const text = page('express');
    const changed = text.replace('mountChatwarden', 'mountSomethingElse');
    expect(changed).not.toBe(text);
    const golden = blocksOf(changed).find((b) => b.golden !== undefined);
    expect(golden?.text).not.toBe(lf(readFileSync(join(cases, golden?.golden as string), 'utf8')));
    expect(expand(changed)).toBe(text);
  });

  it('no recipe page contains a code block that is not a marker or a short shell line', () => {
    for (const name of PAGES) {
      for (const block of blocksOf(page(name))) {
        if (block.golden !== undefined) continue;
        expect(['sh', 'bash', 'shell'].includes(block.language), `${name}: an unmarked block must be shell, not ${JSON.stringify(block.language)}`).toBe(true);
        expect(block.text.split('\n').filter((l) => l !== '').length, `${name}: a shell block is at most three lines`).toBeLessThanOrEqual(3);
      }
      // No indented code and no inline snippet longer than a short call: prose names things, the goldens show them.
      expect((page(name).match(/^```/gm) ?? []).length % 2, `${name} has an unclosed fence`).toBe(0);
      for (const inline of prose(name).matchAll(/`([^`\n]+)`/g)) expect((inline[1] as string).length, `${name}: \`${inline[1]}\``).toBeLessThanOrEqual(90);
    }
  });

  it('says in its first lines which files init writes and which parts you write', () => {
    for (const name of PAGES.filter((p) => p !== 'colyseus')) {
      const head = page(name).split('\n').slice(0, 14).join('\n');
      expect(head, name).toMatch(/Init writes/);
      expect(head, name).toMatch(/You write/);
    }
    const colyseus = page('colyseus').split('\n').slice(0, 14).join('\n');
    expect(colyseus).toMatch(/not written by init|init does not write/i);
    expect(colyseus).toMatch(/You write/);
  });

  it('the Colyseus page names the version it follows and says it was checked against fakes', () => {
    const text = prose('colyseus');
    expect(text).toMatch(/Colyseus 0\.16/);
    expect(text).toMatch(/fakes/);
    expect(text).toMatch(/not (been )?run in a real Colyseus/);
    expect(text).toMatch(/0\.15/);
  });

  it('the Next.js page says Node process, not serverless', () => {
    const text = prose('nextjs');
    expect(text).toMatch(/Node process/);
    expect(text).toMatch(/not serverless/i);
    expect(text).toMatch(/\bnext start\b/);
  });

  it('the Express and Fastify pages say the generated hub needs an ESM project, and what to do otherwise', () => {
    for (const name of ['express', 'fastify']) {
      const text = prose(name);
      expect(text, name).toMatch(/ESM/);
      expect(text, name).toContain('import.meta.url');
      expect(text, name).toContain('--hub none');
    }
  });

  it('the Fastify page uses mountChatwarden(app) (the plugin is exported too)', () => {
    const text = prose('fastify');
    expect(text).toContain('mountChatwarden(app)');
    expect(text).not.toContain('app.register(chatwarden)');
  });

  it('every page names the check command, the environment variables, and that .env is not loaded for you', () => {
    for (const name of PAGES.filter((p) => p !== 'colyseus')) {
      const text = prose(name);
      expect(text, name).toContain('chatwarden init --check');
      expect(text, name).toContain('CHATWARDEN_ADMIN_TOKEN');
      expect(text, name).toContain('CHATWARDEN_SECRET');
      expect(text, name).toContain('--env-file');
    }
  });

  it('the pages name only cases and files that exist', () => {
    for (const name of PAGES) {
      for (const m of page(name).matchAll(/examples\/recipes\/cases\/([\w-]+)/g)) {
        expect(existsSync(join(cases, m[1] as string)), `${name}: ${m[0]}`).toBe(true);
      }
    }
  });

  it('no page promises a speed ("in 15 minutes", "five minutes", "in seconds")', () => {
    const SPEED = /\b(in|within|under|takes?|just)\s+(about\s+|only\s+|a\s+few\s+)?(\d+|a|one|two|three|four|five|ten|fifteen|twenty|thirty)\s+(minutes?|mins?|seconds?|hours?)\b|\b(instantly|in no time|in a flash|lightning)\b/i;
    const docs = [
      ...PAGES.map((p) => [`docs/recipes/${p}.md`, page(p)] as const),
      ['README.md', lf(readFileSync(join(root, 'README.md'), 'utf8'))] as const,
      ['packages/http/README.md', lf(readFileSync(join(root, 'packages/http/README.md'), 'utf8'))] as const,
      ['packages/store-memory/README.md', lf(readFileSync(join(root, 'packages/store-memory/README.md'), 'utf8'))] as const,
    ];
    for (const [name, text] of docs) {
      for (const line of text.split('\n')) {
        // The Discord and retry windows in the existing READMEs are durations of the product, not a promise about setup time: only lines about setup are scanned.
        if (/\b(set up|setup|install|init\b|adopt|wire|add it|get started|start)\b/i.test(line)) expect(line, `${name}: ${line}`).not.toMatch(SPEED);
      }
    }
    // The control: the scan does catch a promise.
    expect('Set up Chatwarden in 15 minutes.').toMatch(SPEED);
    expect('Set it up in five minutes').toMatch(SPEED);
  });

  it('uses no marketing words and no real term, and no absolute path', () => {
    for (const name of PAGES) {
      expect(prose(name), name).not.toMatch(/\b(blazing|seamless|powerful|robust|world-class|cutting-edge|revolutionary|effortless)\b/i);
      expect(page(name), name).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    }
  });
});

describe('docs/recipes: the guides say what the kit does not do', () => {
  const guide = (name: string): string => lf(readFileSync(join(recipes, `${name}.md`), 'utf8')).replace(/\s+/g, ' ');
  const all = GUIDES.map(guide).join(' ');

  // Each limit of the kit's safety statement (design 3): it is said in the adopter guide, in words an adopter can quote.
  const LIMITS: Array<[string, RegExp]> = [
    ['it does not decide whether anyone is at risk or a threat is real', /does not decide whether anyone is at risk, or whether a threat is real/],
    ['it does not message anyone', /does not message the person reported/],
    ['it does not ring, email or post by itself', /does not ring, email or post anywhere by itself/],
    ['it does not report to any authority', /does not report to any authority/],
    ['it does not store, copy, fetch or forward images or link targets', /does not store, copy, fetch or forward images, link targets or media/],
    ['it does not promise a response time and is not a pager', /does not promise a response time, and it is not a pager/],
    ['the child line: stop, do not copy, follow your legal procedure', /stop\. Do not save, copy, screenshot or forward it\. Follow your studio's legal procedure/],
    ['not legal advice', /not legal advice/i],
  ];

  it.each(LIMITS)('the urgent guide says: %s', (_name, pattern) => {
    expect(guide('urgent-and-welfare')).toMatch(pattern);
  });

  it('every guide says it is not legal advice, and none promises a response time', () => {
    for (const name of GUIDES) {
      expect(guide(name), name).toMatch(/not legal advice/i);
      expect(guide(name), name).not.toMatch(/within \d+ (minutes|hours)|guarantee/i);
    }
    expect(all).toMatch(/promise a response time/);
  });

  it('the raids guide says a mode always expires, is per process, and is not a sanction; the digest guide says the kit has no scheduler', () => {
    expect(guide('raids')).toMatch(/every mode ends by itself/);
    expect(guide('raids')).toMatch(/There is no "until I turn it off"/);
    expect(guide('raids')).toMatch(/memory of the process that serves the room/);
    expect(guide('raids')).toMatch(/None of them is a sanction/);
    expect(guide('digest')).toMatch(/The kit has no scheduler/);
    expect(guide('digest')).toMatch(/cw\.insights\.emitDigest/);
  });

  it('a guide holds no more code than a short snippet, in a fenced block', () => {
    for (const name of GUIDES) {
      const text = lf(readFileSync(join(recipes, `${name}.md`), 'utf8'));
      expect((text.match(/^```/gm) ?? []).length % 2, `${name}: unclosed fence`).toBe(0);
      for (const block of text.matchAll(/```(\w*)\n([\s\S]*?)```/g)) expect((block[2] as string).split('\n').length, `${name}: a snippet is a few lines`).toBeLessThanOrEqual(8);
    }
  });

  it('no guide names a real slur, key or token', () => {
    expect(all).not.toMatch(/sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|https:\/\/discord\.com\/api\/webhooks\/\d+/);
  });
});

describe("docs/recipes: kids-rooms and creator-channels say what the kit does and what stays the game's", () => {
  const guide = (name: string): string => lf(readFileSync(join(recipes, `${name}.md`), 'utf8')).replace(/\s+/g, ' ');

  it("kids-rooms: a context with phrase-only chat and a strict pace, the refusals, and what is the game's (age, which rooms)", () => {
    const text = guide('kids-rooms');
    for (const needle of ['`profile.contexts`', '`chat.phrases`', '`cw.chat.acceptPhrase(room, seat, id)`', '`phrases_only`', '`phrase_unknown`', '`slowModeMs`', '`chat.minAccountAgeDays`', '`account_too_new`', '`gate`', '`phrase.<id>`']) {
      expect(text, needle).toContain(needle);
    }
    expect(text).toMatch(/The kit never learns how old a player is/);
    expect(text).toMatch(/Which rooms are kids' rooms is your decision/);
    expect(text).toMatch(/The kit ships no phrase text/);
    expect(text).toMatch(/a typo in the context name fails shut/i);
    expect(text).toMatch(/account age is not a person's age/i);
    expect(text).toMatch(/not legal advice/i);
  });

  it('creator-channels: a scope per creator, scoped moderators, what a scoped moderator cannot do and the sanction limits', () => {
    const text = guide('creator-channels');
    for (const needle of ['`scope`', '`creator:alice`', '`cw.rooms.seat`', '`authorize`', '`scopedLimits`', '`reportId`', '`GET /me`', '`guard()`', '404 `not_found`', '403 `forbidden`']) {
      expect(text, needle).toContain(needle);
    }
    expect(text).toMatch(/A report from a room with no scope is invisible to a scoped moderator/);
    expect(text).toMatch(/The owner role cannot be scoped/);
    expect(text).toMatch(/only a warning or a chat restriction, for at most 7 days, never permanent/);
    expect(text).toMatch(/settings, terms, the audit trail, appeals/);
    expect(text).toMatch(/Which creator a moderator works for is your decision/);
    expect(text).toMatch(/not legal advice/i);
  });
});

describe('docs/recipes: the code of kids-rooms and creator-channels', () => {
  // The ts blocks of a page, in order, are one program: the imports first, then the steps. Names the page leaves to the game are declared here and passed in when it runs.
  const STUBS = `
declare function isKidsRoom(roomId: string): boolean;
declare function yourLogin(req: import('@chatwarden/http').KitRequest): Promise<{ email: string; creator: string } | null>;
`;
  const tsBlocks = (name: string): string =>
    blocksOf(page(name))
      .filter((b) => b.language === 'ts')
      .map((b) => b.text)
      .join('\n');

  type Run = (...values: unknown[]) => Promise<Record<string, unknown>>;
  /** Run a page's program: its imports are replaced by the real modules, its game-owned names by `given`, and `after` is appended to it. */
  async function run(name: string, given: Record<string, unknown>, after = ''): Promise<Record<string, unknown>> {
    const source = `${tsBlocks(name).replace(/^import .*;$/gm, '')}\n${after}`;
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const all: Record<string, unknown> = { createChatwarden, createMemoryStore, adminRoutes, createRouter, ...given };
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => Run;
    return new AsyncFunction(...Object.keys(all), js)(...Object.values(all));
  }

  it('both pages hold ts blocks, and all of them compile in one program each; a deliberate error is caught (control)', { timeout: 120_000 }, () => {
    const files = ['kids-rooms', 'creator-channels'].map((n) => ({ file: `${n}.ts`, code: tsBlocks(n) }));
    for (const f of files) expect(f.code.length, f.file).toBeGreaterThan(200);
    const diagnostics = compileSnippets([...files, { file: 'control.ts', code: "const n: number = 'not a number';" }], STUBS);
    expect(diagnostics.get('control.ts')?.length, 'the control must fail to compile').toBe(1);
    diagnostics.delete('control.ts');
    expect(Object.fromEntries(diagnostics)).toEqual({});
  });

  it('kids-rooms runs against a memory kit: a phrase room refuses text and accepts a phrase; a room that is not a kids room takes text', async () => {
    const kids = await run('kids-rooms', { isKidsRoom: () => true }, 'return { typed, picked };');
    expect(kids.typed).toMatchObject({ refuse: { reason: 'phrases_only' } });
    expect(kids.picked).toMatchObject({ deliver: { text: 'Good game!', phrase: 'gg' } });
    const open = await run('kids-rooms', { isKidsRoom: () => false }, 'return { typed, picked };');
    expect(open.typed).toMatchObject({ deliver: { text: 'hello there' } });
    expect((open.typed as { deliver: object }).deliver).not.toHaveProperty('phrase');
    // A phrase is not a way around the room: outside a kids room the phrase id names a book the room does not use, and is refused.
    expect(open.picked).toHaveProperty('refuse');
  });

  it("creator-channels runs against a memory kit: a creator's scoped moderator sees only that creator's reports, and cannot reach the settings or a ban", async () => {
    const after = `
for (const [id, scope] of [['alice-lobby', 'creator:alice'], ['bob-lobby', 'creator:bob']] as const) {
  cw.rooms.seat(id, 'p1', { clientKey: id + '-reporter-key' }, 'Reporter', { scope });
  cw.rooms.seat(id, 'p2', { clientKey: id + '-target-key' }, 'Target', { scope });
  cw.chat.accept(id, 'p2', 'hello there');
  const filed = await cw.reports.submit({ roomId: id, reporterSeat: 'p1', targetSeat: 'p2' });
  if (!filed.ok) throw new Error('refused: ' + filed.refused);
}
const ask = (method: string, path: string, body?: unknown) =>
  handle({ method, path, query: {}, headers: {}, body: undefined, ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }) } as never);
const queue = await ask('GET', '/reports');
const policy = await ask('GET', '/policy');
const me = await ask('GET', '/me');
const first = (queue.body as { items: Array<{ id: string; person: string }> }).items[0];
const ban = first === undefined ? undefined : await ask('POST', '/sanctions', { subject: first.person, kind: 'ban', durationMs: 86400000, rule: 1, reason: 'no', reportId: first.id });
return { queue, policy, me, ban };
`;
    const out = await run('creator-channels', { yourLogin: async () => ({ email: 'alice-mod@example.test', creator: 'alice' }) }, after);
    const queue = out.queue as { status: number; body: { items: unknown[] } };
    expect(queue.status).toBe(200);
    expect(queue.body.items).toHaveLength(1);
    expect((out.policy as { status: number }).status).toBe(403);
    expect((out.me as { body: { scope: string[] } }).body.scope).toEqual(['creator:alice']);
    expect((out.ban as { status: number }).status).toBe(400);
  });
});

describe('docs/recipes: appeal-emails (0.2.1)', () => {
  const guide = lf(readFileSync(join(recipes, 'appeal-emails.md'), 'utf8')).replace(/\s+/g, ' ');
  const tsBlocks = (): string =>
    blocksOf(page('appeal-emails'))
      .filter((b) => b.language === 'ts')
      .map((b) => b.text)
      .join('\n');

  it('says the kit never sends email and never stores an email address, in those words', () => {
    expect(guide).toContain('The kit never sends email and never stores an email address.');
  });

  it('says what the link is and how to keep it: a capability, query strings out of access logs, never in a public channel, and when it stops working', () => {
    for (const needle of ['capability', 'query string', 'access log', 'referrer', 'public channel', '`appeals.linkTtlMs`', 'not a login']) expect(guide, needle).toContain(needle);
    expect(guide).toMatch(/keep (the )?query strings out of (your )?access logs/i);
  });

  it('says appeals must be enabled in the profile for /appeal to show, and that switching them off breaks the mailed links', () => {
    expect(guide).toMatch(/Appeals must be enabled in the profile/);
    expect(guide).toContain('`appeals.enabled`');
    expect(guide).toMatch(/switching appeals off/i);
  });

  it('names the hook, the settings and the page options', () => {
    for (const needle of ['`notices.deliver`', '`notices.localeOf`', '`d.to.accountId`', '`d.sanction.automated`', '`d.sanction.until`', '`appeals.landingUrl`', '`landingOrigins`', '`appeals.contact`', '`appeals.emailsOutcome`', '`appeals.words`', '`appealUrl`', 'sendMail']) {
      expect(guide, needle).toContain(needle);
    }
  });

  it('says what a good email says, and what it must not do', () => {
    for (const needle of ['What a good appeal email says', 'what happened', 'until when', 'the rule', 'the link', 'a way to reach a person', 'does not promise an outcome', 'private reason', 'no excerpt']) {
      expect(guide.toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });

  it('service mode: the delivery variables, the signature header and scheme, dedupe on x-chatwarden-delivery, the retry schedule, a separate endpoint, and how to ask again', () => {
    for (const needle of ['`CHATWARDEN_DELIVERY_URL`', '`CHATWARDEN_DELIVERY_SECRET`', '`CHATWARDEN_PUBLIC_URL`', 'X-Chatwarden-Signature', '`sha256=`', 'x-chatwarden-delivery', '1, 3 and 6 minutes', '/v1/appeals/link', '`CHATWARDEN_TRUST_PROXY`']) {
      expect(guide, needle).toContain(needle);
    }
    expect(guide).toMatch(/[Dd]eduplicate on `?x-chatwarden-delivery`?/);
    expect(guide).toMatch(/separate endpoint/);
    expect(guide).toMatch(/lost on a restart|lost when the service restarts/);
  });

  it('says what feedback an appeal gives, and that strike forgiveness is per process until a restart', () => {
    expect(guide).toMatch(/no longer counts toward the next restriction/);
    expect(guide).toMatch(/never changes a term by itself/);
    expect(guide).toMatch(/per process/);
    expect(guide).toMatch(/until it restarts/);
  });

  it('the hook example never skips the outcome email: only a short automatic restriction (kind sanction) is skipped, and the page says an outcome is always sent (R3 minor 2)', () => {
    const code = tsBlocks();
    const skip = code.split('\n').find((l) => l.includes('d.sanction.automated'));
    expect(skip).toBeDefined();
    expect(skip).toContain("d.kind === 'sanction'");
    expect(skip).toMatch(/return;/);
    expect(guide).toMatch(/an outcome (email )?is always sent/i);
    expect(guide).toContain('`appeal_outcome`');
  });

  it('says the link stops working when the appeal is moot, not "closed", and that a decided appeal shows the outcome until the link expires (R3 minor 3)', () => {
    expect(guide).not.toMatch(/when the appeal is closed/);
    expect(guide).toMatch(/when the appeal is moot/);
    expect(guide).toMatch(/the link of a decided appeal still shows the outcome until it expires/);
  });

  it('says the Spanish and Portuguese words are machine drafts that a person has not read', () => {
    expect(guide).toMatch(/Spanish and Portuguese are machine-drafted/);
    expect(guide).toMatch(/not been reviewed by a person/);
    expect(guide).toContain('`appeals.words`');
  });

  it('holds two short typed snippets that compile: the hook, and the signature check; a deliberate error is caught (control)', { timeout: 120_000 }, () => {
    const code = tsBlocks();
    expect(code).toContain('sendMail(');
    expect(code).toContain('d.to.accountId');
    expect(code).toContain('d.sanction.automated');
    expect(code).toContain('d.sanction.until');
    expect(code).toContain('timingSafeEqual');
    expect(code).toContain('sha256=');
    expect(code).not.toMatch(/console\.(log|info|warn|error)/);
    const stubs = `
declare function sendMail(mail: { to: string; subject: string; text: string; html: string }): Promise<void>;
declare function emailOf(accountId: string): Promise<string | null>;
`;
    const diagnostics = compileSnippets([{ file: 'appeal-emails.ts', code }, { file: 'control.ts', code: "const n: number = 'not a number';" }], stubs);
    expect(diagnostics.get('control.ts')?.length, 'the control must fail to compile').toBe(1);
    diagnostics.delete('control.ts');
    expect(Object.fromEntries(diagnostics)).toEqual({});
  });
});
