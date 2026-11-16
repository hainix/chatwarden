// `--install` (design 5.4): run the project's package manager for the person. This is the one file in the CLI that imports `node:child_process`, and the
// only command it ever runs is the package manager with a fixed argument list: a verb and packages that match the forms init itself writes. No value the
// user typed (a folder, a prefix) is ever in it, so there is nothing for a shell to misread.
import { spawn } from 'node:child_process';
import type { CliEnv, PathLike, Spawner } from './env.js';
import type { PackageManager } from './types.js';

const VERBS: Record<PackageManager, string> = { npm: 'install', pnpm: 'add', yarn: 'add', bun: 'add' };

/** The script each manager's own bin is when `npm_execpath` names one: the basename must match, so `npx` (npx-cli.js) is never run as an install. */
const SCRIPTS: Partial<Record<PackageManager, RegExp>> = {
  npm: /^npm-cli\.[cm]?js$/,
  pnpm: /^pnpm\.[cm]?js$/,
  yarn: /^yarn(pkg)?\.[cm]?js$/,
};

/** The package forms init puts on an install line: a kit package at a caret range, React, and the Socket.IO client. Nothing else is run. */
const PACKAGE = /^(@chatwarden\/[a-z-]+@\^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|react|react-dom|socket\.io-client)$/;

export interface InstallSpec {
  command: string;
  argv: string[];
  /** True only on Windows, for a manager's `.cmd` shim, and only for the fixed argument list. */
  shell: boolean;
}

/**
 * What to run for these packages. With an `env`: when `npm_execpath` is the manager's own script, node runs it directly (no shell); otherwise the
 * manager is run by name, and on Windows (where it is a `.cmd`) through the shell, with each package double-quoted so cmd.exe keeps the `^` of a range
 * (it is cmd's escape character). Throws for a package that is not one of the fixed forms: a programming error, never a user's input.
 */
export function installCommand(manager: PackageManager, packages: readonly string[], env?: Pick<CliEnv, 'platform' | 'env' | 'execPath' | 'path'>): InstallSpec {
  for (const spec of packages) {
    if (!PACKAGE.test(spec)) throw new Error('not an installable package: the install line holds only the kit packages, react, react-dom and socket.io-client');
  }
  const verb = VERBS[manager];
  const script = env === undefined ? undefined : scriptOf(manager, env.env.npm_execpath, env.path);
  if (env !== undefined && script !== undefined) return { command: env.execPath, argv: [script, verb, ...packages], shell: false };
  if (env?.platform === 'win32') return { command: manager, argv: [verb, ...packages.map((spec) => `"${spec}"`)], shell: true };
  return { command: manager, argv: [verb, ...packages], shell: false };
}

function scriptOf(manager: PackageManager, execpath: string | undefined, path: PathLike): string | undefined {
  const pattern = SCRIPTS[manager];
  if (pattern === undefined || execpath === undefined || execpath === '' || !path.isAbsolute(execpath)) return undefined;
  return pattern.test(path.basename(execpath)) ? execpath : undefined;
}

/** Run it in the project folder. Resolves the exit code; a command that could not start is 1. */
export async function runInstall(env: CliEnv, spec: InstallSpec): Promise<number> {
  try {
    const { code } = await env.spawn(spec.command, spec.argv, { cwd: env.cwd, ...(spec.shell ? { shell: true } : {}) });
    return code;
  } catch {
    return 1;
  }
}

/**
 * The real spawner: the child's output goes to standard error (so the report, or the `--json` document, is all there is on standard output). With `shell` the fixed, pre-quoted words are joined into the one command line a shell reads, which
 * is also the form Node asks for (an argument list with a shell is deprecated).
 */
export const nodeSpawner: Spawner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child =
      options.shell === true
        ? spawn([command, ...args].join(' '), { cwd: options.cwd, stdio: ['ignore', 2, 2], shell: true })
        : spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 2, 2] });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1 }));
  });
