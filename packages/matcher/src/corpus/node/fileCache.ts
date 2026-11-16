import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isBytes } from '../sign.js';
import type { CorpusCache } from '../loader.js';

// A disk cache for the loader (design 8.2). The folder is untrusted, and the loader verifies whatever it reads, so this only has to be
// honest about three things: a write is all or nothing (a temporary file in the same folder, flushed, then renamed over the name), a
// name can never leave the folder, and what is on disk is never read without a bound. Files are 0600 and folders 0700 where the
// platform has modes. Nothing it throws carries a path or a name.

/** A release and its signature are at most 8 MiB and a kilobyte; nothing in the cache is bigger than this. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** `state.json`, `index.json`, ... or one file inside `releases/`: plain characters, starting and ending with a letter or digit. */
const NAME_RE = /^(?:releases\/)?[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const refused = (): TypeError => new TypeError('corpus cache: not a file name this cache keeps');
const failed = (what: 'write' | 'read' | 'remove'): Error => new Error(`corpus cache: could not ${what} a file`);

function pathFor(dir: string, name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) throw refused();
  return join(dir, ...name.split('/'));
}

const codeOf = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Rename over the target. Windows can refuse for a moment while another writer or a scanner holds the file; a few short retries. */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = codeOf(e);
      if (attempt >= 5 || code === undefined || !RETRY_CODES.has(code)) throw e;
      await sleep(10 * (attempt + 1));
    }
  }
}

/**
 * A {@link CorpusCache} on a folder, made on the first write. Names are `state.json`-style plain file names, or one file inside
 * `releases/` (the loader's layout); anything else (a separator elsewhere, `..`, NUL, an absolute path) is refused with a
 * `TypeError` that does not repeat it. `write` is atomic. `read` is null for a file that is not there, is not a file, or is larger than
 * any release can be.
 * @experimental
 */
export function fileCache(dir: string): CorpusCache {
  if (typeof dir !== 'string' || dir === '' || dir.includes(String.fromCharCode(0))) throw new TypeError('corpus cache: dir must be a folder path');
  return {
    async read(name) {
      const path = pathFor(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
        const handle = await open(path, 'r');
        try {
          const buffer = new Uint8Array(info.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          // It grew while it was being read: not the file that was checked.
          return bytesRead > info.size ? null : buffer.slice(0, bytesRead);
        } finally {
          await handle.close();
        }
      } catch (e) {
        const code = codeOf(e);
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw failed('read');
      }
    },

    async write(name, bytes) {
      const path = pathFor(dir, name);
      if (!isBytes(bytes)) throw new TypeError('corpus cache: bytes must be a Uint8Array');
      const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await renameOver(temporary, path);
      } catch {
        try {
          await handle?.close();
        } catch {
          // already closed
        }
        await rm(temporary, { force: true }).catch(() => undefined);
        throw failed('write');
      }
    },

    async remove(name) {
      const path = pathFor(dir, name);
      try {
        await rm(path, { force: true });
      } catch {
        throw failed('remove');
      }
    },
  };
}
