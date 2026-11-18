import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { projectImporter, resolveFromProject } from '../src/service/projectResolve.js';
import { hubScriptPath } from '../src/service/serveStaff.js';

// Review m14: `chatwarden serve` loads the kit's optional packages from the project it runs in (the current directory) before its own location, so `npx -p @chatwarden/http chatwarden serve` and a strict
// pnpm layout find what the project installed. Fake packages in a temp folder only.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project folder with fake installed packages: name -> the text its entry file holds. */
function project(packages: Record<string, string>, extra: Record<string, Record<string, unknown>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-proj-'));
  dirs.push(dir);
  for (const [name, code] of Object.entries(packages)) {
    const root = join(dir, 'node_modules', ...name.split('/'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '0.0.1', type: 'module', exports: { '.': { default: './index.js' }, ...(extra[name] ?? {}) } }));
    writeFileSync(join(root, 'index.js'), code);
  }
  return dir;
}

describe('resolveFromProject', () => {
  it('finds a package the project installed, as a file URL of its entry', () => {
    const dir = project({ '@chatwarden/fakepkg': 'export const where = "project";\n' });
    const url = resolveFromProject('@chatwarden/fakepkg', dir);
    expect(url).toBe(pathToFileURL(join(dir, 'node_modules', '@chatwarden', 'fakepkg', 'index.js')).href);
  });

  it('finds it from a subfolder of the project, as Node would', () => {
    const dir = project({ '@chatwarden/fakepkg': 'export const x = 1;\n' });
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(resolveFromProject('@chatwarden/fakepkg', sub)).toContain('fakepkg');
  });

  it('is undefined for a package the project does not have, a name that is not a package, and a folder that is not there', () => {
    const dir = project({});
    expect(resolveFromProject('@chatwarden/fakepkg', dir)).toBeUndefined();
    expect(resolveFromProject('', dir)).toBeUndefined();
    expect(resolveFromProject('./relative', dir)).toBeUndefined();
    expect(resolveFromProject('@chatwarden/fakepkg', join(dir, 'missing', 'folder'))).toBeUndefined();
  });

  it('never throws, whatever the name', () => {
    const dir = project({});
    for (const name of ['\u0000', '..', '/abs', 'node:fs', 'x'.repeat(3000), '@', '@/x']) expect(() => resolveFromProject(name, dir)).not.toThrow();
  });
});

describe('projectImporter', () => {
  it('imports the project copy when there is one', async () => {
    const dir = project({ '@chatwarden/fakepkg': 'export const where = "project";\n' });
    const mod = (await projectImporter(dir)('@chatwarden/fakepkg')) as { where: string };
    expect(mod.where).toBe('project');
  });

  it('falls back to a plain import of the name when the project has none (the package next to this one)', async () => {
    const dir = project({});
    const mod = (await projectImporter(dir)('@chatwarden/core')) as { errorClass?: unknown };
    expect(typeof mod.errorClass).toBe('function');
  });

  it('a package neither place has is a rejection (the caller turns it into the install message)', async () => {
    const dir = project({});
    await expect(projectImporter(dir)('@chatwarden/not-a-real-package-zzz')).rejects.toBeDefined();
  });
});

describe('the hub script is looked for in the project first', () => {
  it('finds the standalone script the project installed, and otherwise the one next to this package or none', () => {
    const dir = project({ '@chatwarden/hub-element': 'export {};\n' }, { '@chatwarden/hub-element': { './standalone': { default: './hub-element.js' } } });
    writeFileSync(join(dir, 'node_modules', '@chatwarden', 'hub-element', 'hub-element.js'), 'console.log(1);\n');
    expect(hubScriptPath(dir)).toBe(join(dir, 'node_modules', '@chatwarden', 'hub-element', 'hub-element.js'));
    const empty = project({});
    const fallback = hubScriptPath(empty);
    expect(fallback === null || typeof fallback === 'string').toBe(true);
  });
});

describe('the install message says where to install', () => {
  it('names the folder the command runs from', async () => {
    const { startService, resolveServeConfig } = await import('../src/service/serve.js');
    const config = resolveServeConfig({ printOpenapi: false, port: '0', db: ':memory:', hub: 'none' }, {});
    let message = '';
    try {
      await startService(config, {
        importer: () => Promise.reject(new Error('nope')),
        log: () => undefined,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/is not installed: run npm install @chatwarden\/core/);
    expect(message).toMatch(/folder you run chatwarden serve from/);
  });
});
