import { describe, expect, it } from 'vitest';
import { exitCodeOf } from '../src/cli/apply.js';
import { helpText } from '../src/cli/args.js';
import { runCli } from '../src/cli/index.js';
import { VERSION } from '../src/index.js';
import { createWorld } from './cli-world.js';
import type { PathKind, World, WorldOptions } from './cli-world.js';

const EXPRESS = JSON.stringify({ name: 'zorbak-game', type: 'module', dependencies: { express: '^5.1.0' } });
const project = (extra: WorldOptions = {}): World =>
  createWorld({ files: { 'package.json': EXPRESS, 'tsconfig.json': '{}', 'src/index.ts': 'export {};\n', ...extra.files }, ...extra });
const run = (world: World, ...argv: string[]): Promise<number> => runCli(['init', ...argv], world.env);
const GAME_Q = '1. What kind of game is this? (competitive: trash talk expected; social: casual, mixed ages; kids: kids or teens; creator: creator and streaming communities) [competitive/social/kids/creator] (social) > ';
const CREATOR_LINE = "    overrides: { teamNotes: [{ text: 'Protect the creator and their guests from targeted abuse' }] },";

describe('the interactive first run (design 5.8)', () => {
  it('prints exactly that transcript shape: the intro, the questions with their choices and defaults, then the report', async () => {
    const world = project({ isTTY: true, stdin: '\n\nbox\n\n\n' });
    expect(await run(world)).toBe(0);
    const out = world.out();
    const head = out.slice(0, out.indexOf('Created'));
    expect(head).toBe(
      [
        'Chatwarden init. This writes new files into ./src/chatwarden and touches nothing else.',
        '',
        `${GAME_Q}2. Where should it keep moderation data? [sqlite/memory] (sqlite) > 3. Do you already have chat? [none/box] (none) > 4. How will moderators open the hub? [element/react/none] (element) > 5. Post reports to a Discord forum? [y/n] (n) > `,
        '',
      ].join('\n'),
    );
    expect(out).toContain('Created\n  src/chatwarden/.env.example\n  src/chatwarden/ChatPanel.tsx\n  src/chatwarden/auth.ts\n  src/chatwarden/express.ts\n  src/chatwarden/hub.ts\n  src/chatwarden/kit.ts\n  src/chatwarden/terms.ts\n');
    expect(out).toContain(`  1. Install the packages: npm install @chatwarden/core@^${VERSION} @chatwarden/http@^${VERSION} @chatwarden/store-sqlite@^${VERSION}`);
    expect(out).toContain('react react-dom');
    expect(out).toContain('await mountChatwarden(app) (from src/chatwarden/express)');
    expect(out).toContain('open http://localhost:3000/chatwarden/mod');
    expect(out).toContain('Starter code to replace before you go live');
    expect(world.err()).toBe('');
    // The box was chosen: the ChatPanel file exists, and nothing was written outside src/chatwarden.
    expect(world.files().filter((f) => !f.startsWith('src/chatwarden/'))).toEqual(['package.json', 'src/index.ts', 'tsconfig.json']);
    expect(world.has('src/chatwarden/ChatPanel.tsx')).toBe(true);
  });

  it('a flag given on the command line is not asked again, and what is detected without doubt is not asked', async () => {
    const world = project({ isTTY: true, stdin: '\n' });
    await run(world, '--store', 'memory', '--chat', 'box', '--hub', 'none', '--no-discord');
    const asked = world.out().match(/\d\. [^>]*> /g) ?? [];
    // the kind of game is the one question left, and it stands in for "Which standard?"
    expect(asked).toEqual([GAME_Q]);
    expect(world.out()).not.toContain('Which standard?');
  });

  it('a second run asks the same questions and writes nothing new: every file unchanged, exit 0 (idempotent)', async () => {
    const world = project({ isTTY: true, stdin: '\n\nbox\n\n\n' });
    expect(await run(world)).toBe(0);
    const again = createWorld({ files: Object.fromEntries(world.files().map((f) => [f, world.read(f)!])), isTTY: true, stdin: '\n\nbox\n\n\n' });
    expect(await run(again)).toBe(0);
    expect(again.out()).toContain('Unchanged\n  src/chatwarden/.env.example');
    expect(again.out()).not.toContain('Created');
    expect(again.writes()).toEqual([]);
  });

  it('input that ends in the middle of the questions takes the defaults for the rest, and does not hang', async () => {
    const world = project({ isTTY: true, stdin: '\nmemory\n' });
    expect(await run(world)).toBe(0);
    expect(world.err()).toContain('input ended: using the defaults for the rest');
    expect(world.has('src/chatwarden/kit.ts')).toBe(true);
    expect(world.read('src/chatwarden/kit.ts')).toContain('createMemoryStore');
  });

  it('a terminal whose input is already closed answers every question with its default', async () => {
    const world = project({ isTTY: true, stdin: '' });
    expect(await run(world)).toBe(0);
    expect(world.read('src/chatwarden/kit.ts')).toContain('openStore');
  });

  it('a conflict is asked once per file, on stderr, with the same input; o overwrites and s keeps', async () => {
    const first = project({ isTTY: false });
    await run(first, '--yes');
    const files = Object.fromEntries(first.files().map((f) => [f, first.read(f)!]));
    files['src/chatwarden/auth.ts'] = '// my own auth\n';
    files['src/chatwarden/kit.ts'] = '// my own kit\n';
    const world = createWorld({ files, isTTY: true, stdin: '\n\n\n\no\ns\n' });
    const code = await run(world, '--chat', 'none');
    expect(code).toBe(2);
    expect(world.err()).toContain('src/chatwarden/auth.ts exists and differs');
    expect(world.err()).toContain('src/chatwarden/kit.ts exists and differs');
    expect(world.read('src/chatwarden/auth.ts')).not.toBe('// my own auth\n'); // o: overwritten
    expect(world.read('src/chatwarden/kit.ts')).toBe('// my own kit\n'); // s: kept
    expect(world.out()).toContain('Overwritten\n  src/chatwarden/auth.ts');
    expect(world.out()).toContain('Skipped');
  });
});

describe('a run with no questions', () => {
  it('the re-run after an edited auth.ts and --discord is exit 2 with the skipped lines', async () => {
    const first = project();
    expect(await run(first, '--yes')).toBe(0);
    const files = Object.fromEntries(first.files().map((f) => [f, first.read(f)!]));
    files['src/chatwarden/auth.ts'] = `${files['src/chatwarden/auth.ts']}// my change\n`;
    const world = createWorld({ files });
    expect(await run(world, '--yes', '--discord')).toBe(2);
    const out = world.out();
    expect(out).toMatch(/Unchanged\n( {2}[^\n]+\n)* {2}src\/chatwarden\/terms\.ts\n/);
    expect(out).toContain('Skipped (the file exists and differs, so it was left alone)\n  src/chatwarden/.env.example\n  src/chatwarden/auth.ts\n  src/chatwarden/kit.ts\n');
    expect(out).toContain('Re-run with --on-conflict new');
    expect(world.read('src/chatwarden/auth.ts')).toContain('// my change');
    // --on-conflict new writes the new versions beside them, and says where.
    expect(await run(world, '--yes', '--discord', '--on-conflict', 'new')).toBe(0);
    expect(world.has('src/chatwarden/kit.chatwarden-new.ts')).toBe(true);
    expect(world.read('src/chatwarden/kit.chatwarden-new.ts')).toContain('discordFeed');
  });

  it('an agent run with --yes and --json prints only the JSON document on stdout and exits 0', async () => {
    const world = project({ isTTY: true, stdin: 'this must never be read\n' });
    expect(await run(world, '--yes', '--json', '--framework', 'fastify', '--chat', 'none', '--hub', 'element', '--profile', 'strict')).toBe(0);
    const out = world.out();
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(out.endsWith('}\n')).toBe(true);
    expect(out.trim().split('\n').every((line) => line.startsWith(' ') || line === '{' || line === '}')).toBe(true);
    expect(doc).toMatchObject({ version: 1, chatwarden: VERSION, ok: true, dryRun: false, answers: { framework: 'fastify', profile: 'strict', hub: 'element', chat: 'none' } });
    expect((doc.files as Array<{ action: string }>).every((f) => f.action === 'created')).toBe(true);
    expect(world.err()).toBe('');
    expect(world.out()).not.toContain(world.root);
    expect(world.spawned).toEqual([]);
  });

  it('--json is --yes: it never asks, even on a terminal, and its warnings go to stderr, not stdout', async () => {
    const world = project({ isTTY: true, stdin: 'memory\n', files: { 'package.json': EXPRESS } });
    expect(await run(world, '--json', '--chat', 'box')).toBe(0);
    expect(() => JSON.parse(world.out())).not.toThrow();
    expect(world.out()).not.toMatch(/\[sqlite\/memory\]/);
  });

  it('a run whose stdin is not a terminal never waits: one stderr line, and the detected answers', async () => {
    const world = project({ isTTY: false, stdin: 'box\nmemory\n' });
    expect(await run(world)).toBe(0);
    expect(world.err()).toBe('chatwarden: stdin is not a terminal: using detected answers.\n');
    expect(world.out()).not.toContain('Chatwarden init.');
    expect(world.has('src/chatwarden/ChatPanel.tsx')).toBe(false); // the input was not read
    expect(world.read('src/chatwarden/kit.ts')).toContain('openStore');
  });

  it('--yes on a non-terminal says nothing on stderr', async () => {
    const world = project({ isTTY: false });
    expect(await run(world, '--yes')).toBe(0);
    expect(world.err()).toBe('');
  });

  it('--dry-run never prompts (even on a terminal), writes nothing and says so', async () => {
    const world = project({ isTTY: true, stdin: 'box\n' });
    expect(await run(world, '--dry-run')).toBe(0);
    expect(world.writes()).toEqual([]);
    expect(world.out()).toContain('Dry run: nothing was written.');
    expect(world.out()).toContain('Would create');
    expect(world.out()).not.toMatch(/\[sqlite\/memory\]/);
  });

  it('--dry-run --json is the same plan as a document with dryRun true', async () => {
    const world = project();
    expect(await run(world, '--dry-run', '--json')).toBe(0);
    expect(JSON.parse(world.out())).toMatchObject({ dryRun: true, ok: true });
    expect(world.writes()).toEqual([]);
  });

  it('the same answers write the same bytes on every run and on both path flavours', async () => {
    const posix = project();
    const win = createWorld({ kind: 'win32', files: { 'package.json': EXPRESS, 'tsconfig.json': '{}', 'src/index.ts': 'export {};\n' } });
    await run(posix, '--yes', '--chat', 'box');
    await runCli(['init', '--yes', '--chat', 'box'], win.env);
    expect(win.files()).toEqual(posix.files());
    for (const file of posix.files()) expect(win.read(file), file).toBe(posix.read(file));
    expect(win.out()).not.toContain('\\');
    expect(win.out()).toContain('src/chatwarden/kit.ts');
  });
});

describe('usage errors', () => {
  const cases: Array<[string, string[], WorldOptions?]> = [
    ['an unknown flag', ['--frobnicate']],
    ['a value outside the set', ['--framework', 'flask']],
    ['a bad combination', ['--framework', 'none', '--hub', 'react']],
    ['next with the element hub', ['--framework', 'next', '--hub', 'element']],
    ['an unsafe dir', ['--dir', '../elsewhere']],
    ['an absolute dir', ['--dir', '/etc']],
    ['a bad base', ['--base', 'chatwarden/']],
    ['a repeated flag', ['--store', 'sqlite', '--store', 'memory']],
    ['a flag with a missing value', ['--framework']],
    ['no package.json', ['--yes'], { files: {} }],
  ];
  it.each(cases)('%s is exit 1 with one sentence and no stack', async (_name, flags, extra) => {
    const world = extra === undefined ? project() : createWorld({ files: {}, ...extra });
    expect(await run(world, ...flags)).toBe(1);
    expect(world.out()).toBe('');
    const lines = world.err().trimEnd().split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^chatwarden: \S/);
    expect(world.err()).not.toMatch(/\bat\s.*:\d+|node:internal|Error:/);
    expect(world.err()).not.toContain(world.root);
    expect(world.writes()).toEqual([]);
  });

  it('a command that is not init, and no command at all', async () => {
    const bad = project();
    expect(await runCli(['frobnicate'], bad.env)).toBe(1);
    expect(bad.err()).toMatch(/^chatwarden: Unknown command/);
    const none = project();
    expect(await runCli([], none.env)).toBe(0);
    expect(none.out()).toBe(helpText());
  });

  it('an unsafe path found while applying is exit 1 and nothing is written', async () => {
    const world = project({ absDirs: ['/elsewhere'], links: { 'src/chatwarden': '/elsewhere' } });
    expect(await run(world, '--yes')).toBe(1);
    expect(world.writes()).toEqual([]);
    expect(world.out()).toContain('Error');
  });
});

describe('--help and --version', () => {
  it('--help prints the table generated from the parser, exit 0, nothing on stderr', async () => {
    for (const argv of [['--help'], ['init', '--help'], ['-h'], ['init', '--bogus', '--help']]) {
      const world = project();
      expect(await runCli(argv, world.env)).toBe(0);
      expect(world.out()).toBe(helpText());
      expect(world.err()).toBe('');
    }
  });

  it('--version prints the http VERSION and nothing else', async () => {
    for (const argv of [['--version'], ['-v'], ['init', '--version']]) {
      const world = project();
      expect(await runCli(argv, world.env)).toBe(0);
      expect(world.out()).toBe(`${VERSION}\n`);
    }
  });
});

describe('--install', () => {
  it('is off by default: no process is ever spawned', async () => {
    const world = project();
    await run(world, '--yes');
    expect(world.spawned).toEqual([]);
  });

  it('runs after a successful apply, prints that it did and leaves out the install step from the next steps', async () => {
    const world = project({ env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' } });
    expect(await run(world, '--yes', '--install')).toBe(0);
    expect(world.spawned.length).toBe(1);
    expect(world.spawned[0]).toMatchObject({ command: '/usr/bin/node', cwd: world.root });
    expect(world.spawned[0]!.args.slice(0, 2)).toEqual(['/usr/lib/node_modules/npm/bin/npm-cli.js', 'install']);
    expect(world.out()).toContain('Installed with npm.');
    expect(world.out()).not.toContain('Install the packages');
  });

  it('a failing install is exit 3 and the command is printed anyway', async () => {
    const world = project({ spawnCode: 1 });
    expect(await run(world, '--yes', '--install')).toBe(3);
    expect(world.out()).toContain('The install did not finish. Run it yourself:');
    expect(world.out()).toContain(`  npm install @chatwarden/core@^${VERSION}`);
    expect(world.has('src/chatwarden/kit.ts')).toBe(true); // the files were written
  });

  it('a spawner that cannot start the command is the same: exit 3', async () => {
    const world = project();
    world.env.spawn = () => Promise.reject(new Error('spawn npm ENOENT'));
    expect(await run(world, '--yes', '--install')).toBe(3);
  });

  it('is not run for a dry run, nor when a file could not be written', async () => {
    const dry = project();
    await run(dry, '--yes', '--install', '--dry-run');
    expect(dry.spawned).toEqual([]);
    const broken = project({ failOn: (op) => (op.op === 'writeFile' ? Object.assign(new Error('EACCES'), { code: 'EACCES' }) : undefined) });
    expect(await run(broken, '--yes', '--install')).toBe(3);
    expect(broken.spawned).toEqual([]);
  });

  it('on win32 without npm_execpath the shell form carries only the quoted fixed names', async () => {
    const world = createWorld({ kind: 'win32', files: { 'package.json': EXPRESS, 'tsconfig.json': '{}' } });
    expect(await runCli(['init', '--yes', '--install', '--dir', 'zork\\drakkuun'], world.env)).toBe(0);
    const [call] = world.spawned;
    expect(call).toMatchObject({ command: 'npm', shell: true });
    expect(call!.args[0]).toBe('install');
    for (const arg of call!.args.slice(1)) expect(arg).toMatch(/^"(@chatwarden\/[a-z-]+@\^\d+\.\d+\.\d+|react|react-dom)"$/);
    expect(JSON.stringify(call)).not.toMatch(/zork|drakkuun/);
    // Without --install the printed command is quoted the same way.
    const printed = createWorld({ kind: 'win32', files: { 'package.json': EXPRESS, 'tsconfig.json': '{}' } });
    await runCli(['init', '--yes'], printed.env);
    expect(printed.out()).toContain(`"@chatwarden/core@^${VERSION}"`);
  });

  it('exit code 3 beats skipped files (2): a failed install is the louder result', () => {
    expect(exitCodeOf({ dryRun: false, files: [{ path: 'a', action: 'skipped', reason: 'differs' }], install: { ran: false, failed: true } })).toBe(3);
    expect(exitCodeOf({ dryRun: false, files: [{ path: 'a', action: 'skipped', reason: 'differs' }], install: { ran: true } })).toBe(2);
  });
});

describe('--check', () => {
  it('exit 1 on a fresh run, 0 after the markers are removed and the variables are set', async () => {
    const world = project({ env: { CHATWARDEN_SECRET: 'x'.repeat(40), CHATWARDEN_ADMIN_TOKEN: 'y'.repeat(30) } });
    await run(world, '--yes', '--chat', 'box');
    expect(await run(world, '--check')).toBe(1);
    expect(world.out()).toContain('src/chatwarden/auth.ts:');
    expect(world.out()).toContain('TODO(terms)');
    for (const name of ['auth.ts', 'terms.ts']) world.put(`src/chatwarden/${name}`, world.read(`src/chatwarden/${name}`)!.replaceAll('TODO(', 'DONE('));
    const clean = createWorld({ files: Object.fromEntries(world.files().map((f) => [f, world.read(f)!])), env: world.env.env });
    expect(await runCli(['init', '--check'], clean.env)).toBe(0);
    expect(clean.out()).toContain('Nothing left to replace');
    expect(clean.writes()).toEqual([]);
  });

  it('a missing variable is exit 1 and its value is never printed; --json prints only the check document', async () => {
    const world = project({ env: { CHATWARDEN_SECRET: 'zorbak-must-not-print-0123456789-0123456789' } });
    await run(world, '--yes');
    for (const name of ['auth.ts', 'terms.ts']) world.put(`src/chatwarden/${name}`, world.read(`src/chatwarden/${name}`)!.replaceAll('TODO(', 'DONE('));
    const before = world.out().length;
    expect(await run(world, '--check', '--json')).toBe(1);
    const doc = JSON.parse(world.out().slice(before)) as { ok: boolean; check: { missingEnv: string[] } };
    expect(doc).toMatchObject({ ok: false, check: { missingEnv: ['CHATWARDEN_ADMIN_TOKEN'] } });
    expect(world.out()).not.toContain('must-not-print');
    expect(world.err()).toBe('');
  });

  it('never asks and never writes, on a terminal too', async () => {
    const world = project({ isTTY: true, stdin: 'box\n' });
    await run(world, '--yes');
    const writes = world.writes().length;
    await run(world, '--check');
    expect(world.writes().length).toBe(writes);
  });
});

describe('an unexpected failure', () => {
  it('an uncaught error inside a template is exit 3 with "chatwarden: something went wrong" and the error class only', async () => {
    const world = project();
    const code = await runCli(['init', '--yes'], world.env, {
      render: () => {
        throw new TypeError('secret detail with C:\\Users\\someone\\path and a token');
      },
    });
    expect(code).toBe(3);
    expect(world.err()).toBe('chatwarden: something went wrong (TypeError).\n');
    expect(world.out()).toBe('');
    expect(world.writes()).toEqual([]);
  });

  it('a thrown non-error is reported without its text', async () => {
    const world = project();
    const code = await runCli(['init', '--yes'], world.env, {
      render: () => {
        throw 'a string with a secret';
      },
    });
    expect(code).toBe(3);
    expect(world.err()).toMatch(/^chatwarden: something went wrong \(\w+\)\.\n$/);
    expect(world.err()).not.toContain('secret');
  });
});

describe.each(['posix', 'win32'] as const)('the whole flow on %s paths', (kind: PathKind) => {
  it('an interactive run, then a check, end to end', async () => {
    const world = createWorld({ kind, files: { 'package.json': EXPRESS, 'tsconfig.json': '{}', 'src/index.ts': '' }, isTTY: true, stdin: 'kids\nmemory\nnone\nelement\nn\n' });
    expect(await runCli(['init'], world.env)).toBe(0);
    expect(world.read('src/chatwarden/kit.ts')).toContain("profile: 'strict'");
    expect(world.read('src/chatwarden/kit.ts')).toContain('createMemoryStore');
    expect(world.out()).not.toContain('\\');
  });
});

describe('Next.js: the route goes where the project\'s app directory is', () => {
  const NEXT = JSON.stringify({ name: 'zorbak-game', type: 'module', dependencies: { next: '^15.0.0', react: '^19.0.0' } });
  const nextProject = (files: Record<string, string>): World => createWorld({ files: { 'package.json': NEXT, 'tsconfig.json': '{}', ...files } });
  const routes = (world: World): string[] => world.files().filter((f) => f.endsWith('route.ts'));

  it('--dir chatwarden in a project with src/app puts the route under src/app, and the next step says so', async () => {
    const world = nextProject({ 'src/app/page.tsx': 'export default function Page() { return null; }\n' });
    expect(await run(world, '--yes', '--dir', 'chatwarden', '--store', 'memory')).toBe(0);
    expect(routes(world)).toEqual(['src/app/chatwarden/[...path]/route.ts']);
    expect(world.out()).toContain('under src/app/chatwarden/');
  });
  it('the default directory in a project with src/app keeps the route under src/app', async () => {
    const world = nextProject({ 'src/app/page.tsx': '' });
    expect(await run(world, '--yes', '--store', 'memory')).toBe(0);
    expect(routes(world)).toEqual(['src/app/chatwarden/[...path]/route.ts']);
  });
  it('a project with an app folder at the root keeps the route under app, even with --dir src/chatwarden', async () => {
    const world = nextProject({ 'app/page.tsx': '', 'src/util.ts': 'export {};\n' });
    expect(await run(world, '--yes', '--dir', 'src/chatwarden', '--store', 'memory')).toBe(0);
    expect(routes(world)).toEqual(['app/chatwarden/[...path]/route.ts']);
  });
});

describe('init --game (0.2.2)', () => {
  const KIT = 'src/chatwarden/kit.ts';

  it("--yes --json --game kids has answers.game 'kids' and profile 'strict'", async () => {
    const world = project();
    expect(await run(world, '--yes', '--json', '--game', 'kids')).toBe(0);
    const doc = JSON.parse(world.out()) as { answers: Record<string, unknown> };
    expect(doc.answers).toMatchObject({ game: 'kids', profile: 'strict' });
    expect(world.read(KIT)).toContain("profile: 'strict'");
  });

  it('the JSON answers carry no game key when none was given', async () => {
    const world = project();
    expect(await run(world, '--yes', '--json')).toBe(0);
    const doc = JSON.parse(world.out()) as { answers: Record<string, unknown> };
    expect(Object.hasOwn(doc.answers, 'game')).toBe(false);
    expect(doc.answers.profile).toBe('standard');
  });

  it('each game writes its standard into kit.ts', async () => {
    for (const [game, profile] of [['competitive', 'relaxed'], ['social', 'standard'], ['kids', 'strict'], ['creator', 'standard']] as const) {
      const world = project();
      expect(await run(world, '--yes', '--game', game), game).toBe(0);
      expect(world.read(KIT), game).toContain(`profile: '${profile}',`);
    }
  });

  it('--game creator writes kit.ts with the team-note overrides line right after the profile line', async () => {
    const world = project();
    expect(await run(world, '--yes', '--game', 'creator')).toBe(0);
    const kit = world.read(KIT) as string;
    expect(kit).toContain(`    profile: 'standard',\n${CREATOR_LINE}\n`);
    expect(kit.split('\n').filter((l) => l === CREATOR_LINE)).toHaveLength(1);
  });

  it('--game creator in a JavaScript project writes the same line', async () => {
    const world = createWorld({ files: { 'package.json': EXPRESS } });
    expect(await run(world, '--yes', '--game', 'creator', '--lang', 'js')).toBe(0);
    const kit = world.files().find((f) => /kit\.m?js$/.test(f));
    expect(kit).toBeDefined();
    expect(world.read(kit as string)).toContain(CREATOR_LINE);
  });

  it('--game social, kids, competitive and no game write no overrides line, and social and no game give a byte-identical kit.ts (control)', async () => {
    const none = project();
    await run(none, '--yes');
    const social = project();
    await run(social, '--yes', '--game', 'social');
    expect(social.read(KIT)).toBe(none.read(KIT));
    for (const game of ['social', 'kids', 'competitive'] as const) {
      const world = project();
      await run(world, '--yes', '--game', game);
      expect(world.read(KIT), game).not.toContain('overrides:');
      expect(world.read(KIT), game).not.toContain('teamNotes');
    }
    expect(none.read(KIT)).not.toContain('overrides:');
    // a game and the profile it maps to write the same file
    const kids = project();
    await run(kids, '--yes', '--game', 'kids');
    const strict = project();
    await run(strict, '--yes', '--profile', 'strict');
    expect(kids.read(KIT)).toBe(strict.read(KIT));
  });

  it('the creator project is the standard one plus the note: only kit.ts differs', async () => {
    const creator = project();
    await run(creator, '--yes', '--game', 'creator');
    const standard = project();
    await run(standard, '--yes');
    expect(creator.files()).toEqual(standard.files());
    for (const f of creator.files()) {
      if (f === KIT) expect(creator.read(f)).not.toBe(standard.read(f));
      else expect(creator.read(f), f).toBe(standard.read(f));
    }
  });

  it('the interactive flow asks "What kind of game is this?" first; Enter takes social and writes profile standard, and "Which standard?" is not asked', async () => {
    const world = project({ isTTY: true, stdin: '\n\n\n\n\n' });
    expect(await run(world)).toBe(0);
    const asked = world.out().match(/\d\. [^>]*> /g) ?? [];
    expect(asked[0]).toBe(GAME_Q);
    expect(asked).toHaveLength(5);
    expect(world.out()).not.toContain('Which standard?');
    expect(world.read(KIT)).toContain("profile: 'standard',");
    expect(world.read(KIT)).not.toContain('overrides:');
  });

  it('typing kids writes profile strict and "Which standard?" is not asked', async () => {
    const world = project({ isTTY: true, stdin: 'kids\n\n\n\n\n' });
    expect(await run(world)).toBe(0);
    expect(world.out()).not.toContain('Which standard?');
    expect(world.read(KIT)).toContain("profile: 'strict',");
  });

  it('typing creator writes the creator note; a game typed in any case is taken', async () => {
    const world = project({ isTTY: true, stdin: ' Creator \n\n\n\n\n' });
    expect(await run(world)).toBe(0);
    expect(world.read(KIT)).toContain(CREATOR_LINE);
  });

  it('with --profile relaxed on the command line AND a creator reply the kit has profile relaxed and still has the creator note', async () => {
    const world = project({ isTTY: true, stdin: 'creator\n\n\n\n\n' });
    expect(await run(world, '--profile', 'relaxed')).toBe(0);
    expect(world.read(KIT)).toContain("profile: 'relaxed',");
    expect(world.read(KIT)).toContain(CREATOR_LINE);
    expect(world.out()).not.toContain('Which standard?');
  });

  it('a game on the command line is not asked, and --game with --dry-run writes nothing', async () => {
    const world = project({ isTTY: true, stdin: '\n\n\n\n\n' });
    await run(world, '--game', 'kids');
    expect(world.out()).not.toContain('What kind of game');
    const dry = project();
    expect(await run(dry, '--dry-run', '--game', 'creator')).toBe(0);
    expect(dry.writes()).toEqual([]);
  });
});
