import { describe, expect, it } from 'vitest';
import { installCommand, runInstall } from '../src/cli/install.js';
import { buildPlan } from '../src/cli/plan.js';
import type { PackageManager } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';
import { PROJECT, VERSIONS, answersOf, stubTemplates } from './cli-stubs.js';

const MANAGERS: PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];
const VERBS: Record<PackageManager, string> = { npm: 'install', pnpm: 'add', yarn: 'add', bun: 'add' };
const PACKAGES = ['@chatwarden/core@^1.2.3', '@chatwarden/http@^1.2.3', 'react', 'react-dom', 'socket.io-client'];
const FIXED = /^"?(@chatwarden\/[a-z-]+@\^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|react|react-dom|socket\.io-client)"?$/;

describe('installCommand', () => {
  it('the command per manager: the manager itself with its verb and the packages, no shell', () => {
    for (const manager of MANAGERS) {
      expect(installCommand(manager, PACKAGES)).toEqual({ command: manager, argv: [VERBS[manager], ...PACKAGES], shell: false });
    }
  });

  it('with npm_execpath the spawner gets process.execPath and the script, never a shell', () => {
    const cases: Array<[PackageManager, string]> = [
      ['npm', '/usr/lib/node_modules/npm/bin/npm-cli.js'],
      ['pnpm', '/home/u/.local/share/pnpm/pnpm.cjs'],
      ['yarn', '/usr/lib/node_modules/yarn/bin/yarn.js'],
    ];
    for (const [manager, script] of cases) {
      const world = createWorld({ env: { npm_execpath: script } });
      const spec = installCommand(manager, PACKAGES, world.env);
      expect(spec, manager).toEqual({ command: world.env.execPath, argv: [script, VERBS[manager], ...PACKAGES], shell: false });
    }
    // The same on win32: the script is run with node, so there is no shell and no .cmd to quote for.
    const win = createWorld({ kind: 'win32', env: { npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' } });
    expect(installCommand('npm', PACKAGES, win.env)).toMatchObject({ command: 'C:\\node\\node.exe', shell: false });
  });

  it('an npm_execpath that is not the chosen manager (npx runs npx-cli.js), is relative or is not a script is not used', () => {
    const odd = ['/usr/lib/node_modules/npm/bin/npx-cli.js', 'npm-cli.js', '/usr/bin/npm-cli.sh', '/x/pnpm.cjs; rm -rf /', '', undefined];
    for (const npm_execpath of odd) {
      const world = createWorld({ env: { npm_execpath } });
      expect(installCommand('npm', PACKAGES, world.env), String(npm_execpath)).toEqual({ command: 'npm', argv: ['install', ...PACKAGES], shell: false });
    }
    // A pnpm script is not used for an npm project.
    const world = createWorld({ env: { npm_execpath: '/x/pnpm.cjs' } });
    expect(installCommand('npm', PACKAGES, world.env).command).toBe('npm');
  });

  it('on win32 without npm_execpath the spawner gets shell true and an argv made only of the fixed package names, each double-quoted so cmd.exe keeps the caret', () => {
    const world = createWorld({ kind: 'win32' });
    for (const manager of MANAGERS) {
      const spec = installCommand(manager, PACKAGES, world.env);
      expect(spec.shell, manager).toBe(true);
      expect(spec.command).toBe(manager);
      expect(spec.argv[0]).toBe(VERBS[manager]);
      expect(spec.argv.slice(1)).toEqual(PACKAGES.map((p) => `"${p}"`));
      for (const arg of spec.argv.slice(1)) expect(arg).toMatch(FIXED);
    }
  });

  it('on a platform that is not win32 there is never a shell', () => {
    for (const platform of ['linux', 'darwin']) {
      const world = createWorld({ platform });
      for (const manager of MANAGERS) expect(installCommand(manager, PACKAGES, world.env).shell).toBe(false);
    }
  });

  it('no user-typed value (dir, base) is ever in argv', () => {
    const answers = answersOf({ dir: 'zork/drakkuun', base: '/vlemmo-fenrisk', chat: 'box' });
    const plan = buildPlan(answers, VERSIONS, stubTemplates, PROJECT);
    for (const platform of ['win32', 'linux']) {
      const world = createWorld({ platform, kind: platform === 'win32' ? 'win32' : 'posix' });
      const spec = installCommand(plan.install.manager, plan.install.packages, world.env);
      const text = JSON.stringify(spec);
      for (const typed of ['zork', 'drakkuun', 'vlemmo', 'fenrisk', plan.files[0]!.path]) expect(text, typed).not.toContain(typed);
    }
  });

  it('a package that is not one of the fixed forms is refused, whatever the platform (a metacharacter never reaches a shell)', () => {
    const world = createWorld({ kind: 'win32' });
    for (const bad of ['react & calc', '@chatwarden/core@^1.2.3;x', '$(id)', 'a b', '"react"', '@chatwarden/core@latest', '..\\x', 'react\nreact', '', '--registry=x', '-g']) {
      expect(() => installCommand('npm', [bad], world.env), bad).toThrow(/not an installable package/);
      expect(() => installCommand('npm', ['react', bad]), bad).toThrow();
    }
  });
});

describe('runInstall', () => {
  it('spawns the command in the project folder and resolves its exit code', async () => {
    const world = createWorld({ env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' } });
    const code = await runInstall(world.env, installCommand('npm', PACKAGES, world.env));
    expect(code).toBe(0);
    expect(world.spawned).toEqual([{ command: '/usr/bin/node', args: ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'install', ...PACKAGES], cwd: world.root }]);
  });

  it('passes shell true only for the win32 form', async () => {
    const world = createWorld({ kind: 'win32' });
    await runInstall(world.env, installCommand('npm', PACKAGES, world.env));
    expect(world.spawned[0]).toMatchObject({ command: 'npm', shell: true });
  });

  it('a failing spawner is a non-zero code (the caller prints the command and exits 3), a rejecting one too', async () => {
    const failing = createWorld({ spawnCode: 1 });
    expect(await runInstall(failing.env, installCommand('npm', PACKAGES, failing.env))).toBe(1);
    const rejecting = createWorld();
    rejecting.env.spawn = () => Promise.reject(new Error('spawn npm ENOENT'));
    expect(await runInstall(rejecting.env, installCommand('npm', PACKAGES, rejecting.env))).not.toBe(0);
  });
});
