import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { makeNodeRunner, wranglerBinPath, wranglerStore, type MakeScratch, type RunResult, type Runner } from '../src/tools/wrangler.js';

// The wrangler-backed bucket, with a fake runner: the command lines, the "not found" rule and the clean-up. (The real runner starts a process and is
// exercised by the owner's first publish and by `--dry-run`.)

function rig(results: RunResult[] = []) {
  const calls: string[][] = [];
  const disposed: string[] = [];
  const files = new Map<string, Uint8Array>();
  let n = 0;
  const run: Runner = (args) => {
    calls.push([...args]);
    return Promise.resolve(results.shift() ?? { code: 0, output: '' });
  };
  const scratch: MakeScratch = (bytes) => {
    const path = `scratch-${(n += 1)}`;
    if (bytes !== undefined) files.set(path, bytes);
    else files.set(path, new Uint8Array([9, 8, 7]));
    return Promise.resolve({ path, read: () => Promise.resolve(files.get(path) as Uint8Array), dispose: () => Promise.resolve(void disposed.push(path)) });
  };
  return { calls, disposed, store: wranglerStore({ bucket: 'chatwarden-releases', run, scratch }) };
}

describe('wranglerStore', () => {
  it('writes with the file, the headers, --remote and --force, as an argument list', async () => {
    const r = rig();
    await r.store.write('v1/terms/2026.12.0/terms-2026.12.0.zip', new Uint8Array([1]), { contentType: 'application/zip', cacheControl: 'public, max-age=1', contentDisposition: 'attachment; filename="x.zip"' });
    expect(r.calls).toEqual([
      ['r2', 'object', 'put', 'chatwarden-releases/v1/terms/2026.12.0/terms-2026.12.0.zip', '--file', 'scratch-1', '--content-type', 'application/zip', '--cache-control', 'public, max-age=1', '--content-disposition', 'attachment; filename="x.zip"', '--remote', '--force'],
    ]);
    expect(r.disposed).toEqual(['scratch-1']);
  });

  it('leaves the disposition out when there is none', async () => {
    const r = rig();
    await r.store.write('v1/index.json', new Uint8Array([1]), { contentType: 'application/json', cacheControl: 'public, max-age=300' });
    expect(r.calls[0]).not.toContain('--content-disposition');
  });

  it('reads through --file and --remote and returns the bytes', async () => {
    const r = rig();
    expect(Array.from((await r.store.read('v1/index.json')) as Uint8Array)).toEqual([9, 8, 7]);
    expect(r.calls[0]).toEqual(['r2', 'object', 'get', 'chatwarden-releases/v1/index.json', '--file', 'scratch-1', '--remote']);
    expect(r.disposed).toEqual(['scratch-1']);
  });

  it('a missing object is null, and only that: any other failure rejects (a failed read is never "no index")', async () => {
    const missing = rig([{ code: 1, output: 'The specified key does not exist. [code: 10007]' }]);
    expect(await missing.store.read('v1/index.json')).toBeNull();
    const broken = rig([{ code: 1, output: 'Authentication error [code: 10000]' }]);
    await expect(broken.store.read('v1/index.json')).rejects.toThrow('wrangler could not read the object');
    expect(broken.disposed).toHaveLength(1);
  });

  it('a failed write rejects with a fixed message and still cleans up; the output of wrangler is not passed on', async () => {
    const r = rig([{ code: 1, output: 'token abc123 leaked here' }]);
    const err = (await r.store.write('v1/a', new Uint8Array(), { contentType: 'x', cacheControl: 'y' }).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('wrangler could not write the object');
    expect(r.disposed).toHaveLength(1);
  });

  it('refuses a bucket name that is not an R2 bucket name', () => {
    for (const bucket of ['', 'A', 'a b', 'a;b', 'x'.repeat(64), '-ab']) expect(() => wranglerStore({ bucket, run: () => Promise.reject(new Error('x')), scratch: () => Promise.reject(new Error('x')) }), bucket).toThrow(RangeError);
  });
});

describe('the real runner', () => {
  const echo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-echo-'));
    const script = join(dir, 'echo.mjs');
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    return script;
  };

  it('starts node on the script with the arguments as given: spaces, semicolons and quotes stay inside one argument', async () => {
    const script = await echo();
    try {
      const args = ['r2', 'object', 'put', 'b/k', '--cache-control', 'public, max-age=31536000, immutable', '--content-disposition', 'attachment; filename="a b.zip"', '$HOME', '& echo x'];
      const out = await makeNodeRunner(() => script)(args);
      expect(out.code).toBe(0);
      expect(JSON.parse(out.output)).toEqual(args);
    } finally {
      await rm(dirname(script), { recursive: true, force: true });
    }
  });

  it('reports a non-zero exit and what was printed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cw-echo-'));
    const script = join(dir, 'fail.mjs');
    await writeFile(script, 'process.stderr.write("nope"); process.exit(3);');
    try {
      expect(await makeNodeRunner(() => script)([])).toEqual({ code: 3, output: 'nope' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects when the script cannot be found', async () => {
    await expect(makeNodeRunner(() => { throw new Error('x'); })([])).rejects.toThrow('wrangler could not be started');
  });

  it('does not run through a shell', () => {
    expect(readFileSync(new URL('../src/tools/wrangler.ts', import.meta.url), 'utf8')).not.toMatch(/shell\s*:|spawn\(\s*'npx/);
  });
});

describe('wranglerBinPath', () => {
  it('reads the bin script from the package and resolves it beside the package.json', () => {
    const p = wranglerBinPath(() => join('x', 'node_modules', 'wrangler', 'package.json'), () => JSON.stringify({ bin: { wrangler: './bin/wrangler.js', wrangler2: './bin/other.js' } }));
    expect(p).toBe(resolve('x', 'node_modules', 'wrangler', 'bin', 'wrangler.js'));
  });

  it('accepts a string bin and refuses a package without one', () => {
    expect(wranglerBinPath(() => join('w', 'package.json'), () => JSON.stringify({ bin: './cli.js' }))).toBe(resolve('w', 'cli.js'));
    expect(() => wranglerBinPath(() => join('w', 'package.json'), () => JSON.stringify({ bin: { other: 'x' } }))).toThrow('no bin');
    expect(() => wranglerBinPath(() => join('w', 'package.json'), () => JSON.stringify({}))).toThrow('no bin');
  });

  it('finds the installed wrangler and the file exists', () => {
    expect(existsSync(wranglerBinPath())).toBe(true);
  });
});
