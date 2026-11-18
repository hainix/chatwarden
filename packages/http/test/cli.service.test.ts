import { describe, expect, it } from 'vitest';
import { parseCli } from '../src/cli/args.js';
import { runCli } from '../src/cli/index.js';
import { contentProblems } from '../src/cli/plan.js';
import { VERSION } from '../src/version.js';
import { createWorld } from './cli-world.js';

// S5: `chatwarden init --service`: a self-contained folder (the Dockerfile recipe), written by the same K4b rules as every other init: new files only, conflicts skipped, no secret, no network,
// idempotent. No package.json is needed.

const DIR = 'chatwarden-service';
const FILES = ['.dockerignore', '.env.example', 'Dockerfile', 'README.txt', 'compose.yaml', 'profile.json'].map((f) => `${DIR}/${f}`);

const run = async (argv: string[], files: Record<string, string> = {}) => {
  const world = createWorld({ files });
  const code = await runCli(['init', '--service', ...argv], world.env);
  return { world, code };
};

describe('the plan', () => {
  it('lists the six files under chatwarden-service and writes them, with no package.json in the folder', async () => {
    const { world, code } = await run(['--yes']);
    expect(code).toBe(0);
    expect(world.files()).toEqual([...FILES].sort());
    expect(world.out()).toContain(`${DIR}/Dockerfile`);
    expect(world.has('package.json')).toBe(false);
  });

  it('--dir changes the folder; the default is chatwarden-service, not src/chatwarden even in a project with src', async () => {
    const custom = await run(['--yes', '--dir', 'deploy/svc']);
    expect(custom.world.files()).toEqual(FILES.map((f) => f.replace(DIR, 'deploy/svc')).sort());
    const inProject = await run(['--yes'], { 'package.json': '{}', 'src/index.ts': '' });
    expect(inProject.world.has(`${DIR}/Dockerfile`)).toBe(true);
    expect(inProject.world.has('src/chatwarden/Dockerfile')).toBe(false);
  });

  it('a bad --dir is the usual usage error (outside the folder, absolute, with ..)', async () => {
    for (const dir of ['../out', '/abs', 'a/../../b', 'C:\\x']) {
      const { world, code } = await run(['--yes', '--dir', dir]);
      expect(code, dir).toBe(1);
      expect(world.writes()).toEqual([]);
    }
  });

  it('--dry-run and --json print the plan and write nothing; the JSON document is versioned and names the service', async () => {
    const dry = await run(['--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.world.writes()).toEqual([]);
    expect(dry.world.out()).toMatch(/Would create/);
    for (const f of FILES) expect(dry.world.out()).toContain(f);
    const json = await run(['--json']);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.world.out()) as { version: number; chatwarden: string; ok: boolean; answers: Record<string, unknown>; files: Array<{ path: string; action: string }>; env: Array<{ name: string; required: boolean }>; todo: unknown[] };
    expect(doc).toMatchObject({ version: 1, chatwarden: VERSION, ok: true });
    expect(doc.files.map((f) => f.path).sort()).toEqual([...FILES].sort());
    expect(doc.answers).toEqual({ service: true, store: 'sqlite', profile: 'standard', dir: DIR });
    expect(doc.env.map((e) => e.name)).toEqual(['CHATWARDEN_SECRET', 'CHATWARDEN_SERVICE_KEYS', 'CHATWARDEN_ADMIN_TOKEN']);
    expect(doc.env.map((e) => e.required)).toEqual([true, true, false]);
    expect(doc.todo).toEqual([]);
  });

  it('the human report names the next steps (the env file, the build, the first call) and no chat hook, no install line', async () => {
    const { world } = await run(['--yes']);
    expect(world.out()).toMatch(/Next steps/);
    expect(world.out()).toMatch(/docker compose .*up/);
    expect(world.out()).toMatch(/\.env/);
    expect(world.out()).not.toMatch(/npm install|To moderate your own chat/);
  });
});

describe('what is written', () => {
  it('no secret, no machine path, no timestamp, no carriage return, in any file', async () => {
    const { world } = await run(['--yes']);
    for (const f of FILES) expect(contentProblems(world.read(f) ?? ''), f).toEqual([]);
  });

  it('.env.example holds placeholders only: the three names, nothing after the =', async () => {
    const { world } = await run(['--yes']);
    const text = world.read(`${DIR}/.env.example`) as string;
    const assignments = text.split('\n').filter((l) => /^[A-Z_]+=/.test(l));
    expect(assignments).toEqual(['CHATWARDEN_SECRET=', 'CHATWARDEN_SERVICE_KEYS=', 'CHATWARDEN_ADMIN_TOKEN=']);
    expect(text).toContain('openssl rand -base64 32');
  });

  it('profile.json is the chosen preset as editable JSON with contexts and names.reserved shown empty', async () => {
    for (const profile of ['relaxed', 'standard', 'strict']) {
      const { world } = await run(['--yes', '--profile', profile]);
      expect(JSON.parse(world.read(`${DIR}/profile.json`) as string)).toEqual({ preset: profile, contexts: {}, names: { reserved: [] } });
    }
  });

  it('--store memory writes CHATWARDEN_DB=:memory: with a comment that it is lost on restart, and no volume', async () => {
    const { world } = await run(['--yes', '--store', 'memory']);
    const docker = world.read(`${DIR}/Dockerfile`) as string;
    expect(docker).toMatch(/^ENV .*CHATWARDEN_DB=:memory:/m);
    expect(docker).toMatch(/lost on restart/i);
    expect(docker).not.toMatch(/^VOLUME/m);
    expect(world.read(`${DIR}/compose.yaml`)).not.toMatch(/volumes:/);
  });

  it('the sqlite default keeps its data in /data on a volume', async () => {
    const { world } = await run(['--yes']);
    expect(world.read(`${DIR}/Dockerfile`)).toMatch(/^VOLUME \/data$/m);
    expect(world.read(`${DIR}/Dockerfile`)).toMatch(/CHATWARDEN_DB=\/data\/chatwarden\.db/);
    expect(world.read(`${DIR}/compose.yaml`)).toMatch(/volumes:/);
  });
});

describe('the K4b rules', () => {
  it('a second run is unchanged; a differing file is skipped (exit 2) and --force overwrites', async () => {
    const first = createWorld({});
    expect(await runCli(['init', '--service', '--yes'], first.env)).toBe(0);
    const again = createWorld({ files: Object.fromEntries(first.files().map((f) => [f, first.read(f) as string])) });
    expect(await runCli(['init', '--service', '--yes'], again.env)).toBe(0);
    expect(again.writes()).toEqual([]);
    expect(again.out()).toMatch(/Unchanged/);
    again.put(`${DIR}/profile.json`, '{ "edited": true }\n');
    expect(await runCli(['init', '--service', '--yes'], again.env)).toBe(2);
    expect(again.read(`${DIR}/profile.json`)).toBe('{ "edited": true }\n');
    expect(await runCli(['init', '--service', '--yes', '--force'], again.env)).toBe(0);
    expect(JSON.parse(again.read(`${DIR}/profile.json`) as string).preset).toBe('standard');
  });

  it('--on-conflict new writes the new version beside the edited one', async () => {
    const first = createWorld({});
    await runCli(['init', '--service', '--yes'], first.env);
    first.put(`${DIR}/Dockerfile`, 'FROM scratch\n');
    expect(await runCli(['init', '--service', '--yes', '--on-conflict', 'new'], first.env)).toBe(0);
    expect(first.has(`${DIR}/Dockerfile.chatwarden-new`)).toBe(true);
    expect(first.read(`${DIR}/Dockerfile`)).toBe('FROM scratch\n');
  });

  it('makes no network call and touches nothing outside the folder', async () => {
    const saved = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      throw new Error('the CLI must not touch the network');
    }) as typeof fetch;
    try {
      const { world, code } = await run(['--yes']);
      expect(code).toBe(0);
      for (const op of world.writes()) expect(op.path.replaceAll('\\', '/')).toContain(`/${DIR}`);
    } finally {
      globalThis.fetch = saved;
    }
    expect(calls).toEqual([]);
  });
});

describe('usage errors', () => {
  it('--service with --framework, --chat, --chat-transport, --hub, --discord, --no-discord, --base, --lang, --install or --check is a usage error that names both flags, and writes nothing', async () => {
    const bad: string[][] = [['--framework', 'express'], ['--chat', 'box'], ['--chat-transport', 'sse'], ['--hub', 'element'], ['--discord'], ['--no-discord'], ['--base', '/x'], ['--lang', 'ts'], ['--install'], ['--check']];
    for (const flags of bad) {
      const { world, code } = await run(['--yes', ...flags]);
      expect(code, flags.join(' ')).toBe(1);
      expect(world.err(), flags.join(' ')).toMatch(/^chatwarden: /);
      expect(world.err()).toContain('--service');
      expect(world.err()).toContain(flags[0] as string);
      expect(world.writes()).toEqual([]);
    }
  });

  it('--store and --profile still apply, and the flags that are not about the service are parsed as ever', () => {
    const ok = parseCli(['init', '--service', '--store', 'memory', '--profile', 'strict', '--dir', 'x', '--dry-run']);
    expect(ok).toMatchObject({ command: 'init', service: true, store: 'memory', profile: 'strict', dir: 'x', dryRun: true });
    expect(parseCli(['init'])).not.toHaveProperty('service');
  });

  it('a detected project is not read: a broken package.json does not stop --service', async () => {
    const { code, world } = await run(['--yes'], { 'package.json': '{not json' });
    expect(code).toBe(0);
    expect(world.has(`${DIR}/Dockerfile`)).toBe(true);
  });

  it('the usual init is untouched: without --service the project is still required', async () => {
    const world = createWorld({});
    expect(await runCli(['init', '--yes'], world.env)).toBe(1);
    expect(world.err()).toMatch(/package\.json/);
  });
});

describe('--game with --service (0.2.2)', () => {
  const profileOf = (world: Awaited<ReturnType<typeof run>>['world']) => JSON.parse(world.read(`${DIR}/profile.json`) as string) as Record<string, unknown>;

  it('--game is allowed, and picks the preset: competitive relaxed, social standard, kids strict, creator standard', async () => {
    for (const [game, preset] of [['competitive', 'relaxed'], ['social', 'standard'], ['kids', 'strict'], ['creator', 'standard']] as const) {
      const { world, code } = await run(['--yes', '--game', game]);
      expect(code, game).toBe(0);
      expect(profileOf(world).preset, game).toBe(preset);
    }
  });

  it('--game creator adds the team note to profile.json, in the order preset, teamNotes, contexts, names; the others add none', async () => {
    const creator = await run(['--yes', '--game', 'creator']);
    expect(profileOf(creator.world)).toEqual({ preset: 'standard', teamNotes: [{ text: 'Protect the creator and their guests from targeted abuse' }], contexts: {}, names: { reserved: [] } });
    expect(Object.keys(profileOf(creator.world))).toEqual(['preset', 'teamNotes', 'contexts', 'names']);
    for (const game of ['competitive', 'social', 'kids'] as const) {
      const { world } = await run(['--yes', '--game', game]);
      expect(Object.keys(profileOf(world)), game).toEqual(['preset', 'contexts', 'names']);
    }
  });

  it('--profile beats the game for the preset, and the creator note stays', async () => {
    const { world } = await run(['--yes', '--game', 'creator', '--profile', 'relaxed']);
    expect(profileOf(world)).toMatchObject({ preset: 'relaxed', teamNotes: [{ text: expect.any(String) }] });
  });

  it('the JSON answers carry the game only when one was given', async () => {
    const withGame = JSON.parse((await run(['--json', '--game', 'kids'])).world.out()) as { answers: Record<string, unknown> };
    expect(withGame.answers).toEqual({ service: true, store: 'sqlite', profile: 'strict', dir: DIR, game: 'kids' });
    const without = JSON.parse((await run(['--json'])).world.out()) as { answers: Record<string, unknown> };
    expect(Object.hasOwn(without.answers, 'game')).toBe(false);
  });

  it('the files other than profile.json are the same with and without a game', async () => {
    const plain = await run(['--yes']);
    const creator = await run(['--yes', '--game', 'creator']);
    for (const f of FILES.filter((x) => !x.endsWith('profile.json'))) expect(creator.world.read(f), f).toBe(plain.world.read(f));
  });
});
