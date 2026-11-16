import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PutMeta, ReleaseStore } from './publishing.js';

// The release bucket through `wrangler` (the maintainer is logged in with `npx wrangler login`; nothing here holds a credential). The command line is
// built from an argument list, never a shell string. `read` answers null only when R2 says the object does not exist; every other failure rejects,
// so a failed read can never be taken for "there is no index".

export interface RunResult {
  code: number;
  /** Everything wrangler printed, stdout and stderr together (only searched, never shown). */
  output: string;
}
export type Runner = (args: readonly string[]) => Promise<RunResult>;

/** A scratch file for one transfer. */
export interface Scratch {
  path: string;
  read(): Promise<Uint8Array>;
  dispose(): Promise<void>;
}
export type MakeScratch = (bytes?: Uint8Array) => Promise<Scratch>;

const MISSING = /specified key does not exist|NoSuchKey|10007/i;

export const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export function wranglerStore(options: { bucket: string; run: Runner; scratch: MakeScratch }): ReleaseStore {
  const { bucket, run, scratch } = options;
  if (!BUCKET_RE.test(bucket)) throw new RangeError('wranglerStore: the bucket name is not a valid R2 bucket name');
  return {
    read: async (key) => {
      const file = await scratch();
      try {
        const out = await run(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file.path, '--remote']);
        if (out.code === 0) return await file.read();
        if (MISSING.test(out.output)) return null;
        throw new Error('wrangler could not read the object');
      } finally {
        await file.dispose();
      }
    },
    write: async (key, bytes, meta: PutMeta) => {
      const file = await scratch(bytes);
      try {
        const args = ['r2', 'object', 'put', `${bucket}/${key}`, '--file', file.path, '--content-type', meta.contentType, '--cache-control', meta.cacheControl];
        if (meta.contentDisposition !== undefined) args.push('--content-disposition', meta.contentDisposition);
        args.push('--remote', '--force');
        const out = await run(args);
        if (out.code !== 0) throw new Error('wrangler could not write the object');
      } finally {
        await file.dispose();
      }
    },
  };
}

/** Runs `npx wrangler <args>` and collects what it printed. The one place the tools start a process. */
export const nodeRunner: Runner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => void (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => void (output += d.toString()));
    child.on('error', () => reject(new Error('wrangler could not be started')));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });

/** A scratch file in a private temporary folder, removed after the transfer. */
export const nodeScratch: MakeScratch = async (bytes) => {
  const dir = await mkdtemp(join(tmpdir(), 'chatwarden-corpus-'));
  const path = join(dir, 'object');
  if (bytes !== undefined) await writeFile(path, bytes);
  return { path, read: async () => new Uint8Array(await readFile(path)), dispose: () => rm(dir, { recursive: true, force: true }) };
};
