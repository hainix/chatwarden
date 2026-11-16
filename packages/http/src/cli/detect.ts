// What the project already is. Reads package.json, and the names in the root folder (to see lockfiles, tsconfig.json, src and a previous
// chatwarden folder); nothing else, and nothing outside the root. Never throws: a problem is `{ error }`, one sentence.
import type { CliEnv } from './env.js';
import type { Detected, PackageManager } from './types.js';

type Failure = { error: string };

const FRAMEWORKS = ['express', 'fastify', 'next'] as const;

function reason(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,20}$/.test(code) ? ` (${code})` : '';
}

function dependencyNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const table of ['dependencies', 'devDependencies']) {
    const value = manifest[table];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) for (const name of Object.keys(value)) names.add(name);
  }
  return names;
}

function managerOf(names: readonly string[]): PackageManager {
  if (names.includes('pnpm-lock.yaml')) return 'pnpm';
  if (names.includes('yarn.lock')) return 'yarn';
  if (names.includes('bun.lock') || names.includes('bun.lockb')) return 'bun';
  return 'npm';
}

export async function detect(env: CliEnv): Promise<Detected | Failure> {
  let names: string[];
  try {
    names = await env.fs.readdir(env.cwd);
  } catch (cause) {
    return { error: `Could not read this folder to look for package.json${reason(cause)}: run chatwarden init from the root of your project.` };
  }
  if (!names.includes('package.json')) {
    return { error: 'There is no package.json in this folder: run chatwarden init from the root of your project.' };
  }

  let text: string;
  try {
    text = await env.fs.readFile(env.path.join(env.cwd, 'package.json'), 'utf8');
  } catch (cause) {
    return { error: `Could not read package.json${reason(cause)}: run chatwarden init from the root of your project.` };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { error: 'package.json is empty or is not valid JSON: fix it, then run chatwarden init again.' };
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { error: 'package.json must hold a JSON object: fix it, then run chatwarden init again.' };
  }

  const record = manifest as Record<string, unknown>;
  const dependencies = dependencyNames(record);
  return {
    frameworks: FRAMEWORKS.filter((name) => dependencies.has(name)),
    react: dependencies.has('react'),
    socketio: dependencies.has('socket.io'),
    manager: managerOf(names),
    ts: names.includes('tsconfig.json'),
    moduleType: record.type === 'module' ? 'module' : 'commonjs',
    srcDir: names.includes('src'),
    hasDir: names.includes('chatwarden'),
  };
}
