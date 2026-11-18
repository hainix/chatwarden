import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The recipe pages in docs/recipes embed the golden files, byte for byte (design 9.6, ruling 8). A page holds no code of its own: a code block is
// either the text of a golden file, introduced by a marker line `<!-- golden: <case>/<file> -->`, or a short shell line. `UPDATE_RECIPES=1`
// rewrites the embedded blocks from the goldens after a template change, in the same commit.

const root = fileURLToPath(new URL('..', import.meta.url));
const cases = join(root, 'examples', 'recipes', 'cases');
const recipes = join(root, 'docs', 'recipes');
const PAGES = ['express', 'fastify', 'nextjs', 'socketio', 'colyseus'];
// Three guides for the person who runs the moderation (0.2.0): prose with at most a short snippet, not a framework recipe, so the golden-file rules above do not apply to them.
const GUIDES = ['urgent-and-welfare', 'raids', 'digest'];
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
  it('has the five pages and the three guides, and nothing else', () => {
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

describe('docs/recipes: the three guides say what the kit does not do', () => {
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
