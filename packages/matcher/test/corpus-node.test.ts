import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedMessage } from '../src/corpus/index.js';
import { fileCache, installationKey, startCorpus } from '../src/corpus/node/index.js';
import { BASE, FakeSchedule, fakeClock, newTerms, rig, settle } from './corpus-loader-world.js';

// The real disk: a temporary folder per test. The one thing the disk cache must do that the in-memory one cannot show is survive
// a crash between the temporary file and the rename, so `rename` is wrapped here and made to fail on demand.
const hooks = vi.hoisted(() => ({ renameFails: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string): Promise<void> => {
      if (hooks.renameFails > 0) {
        hooks.renameFails -= 1;
        throw new Error('crash before the rename: secret-path');
      }
      return real.rename(from, to);
    },
  };
});

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-corpus-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  hooks.renameFails = 0;
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);
const posix = process.platform !== 'win32';
const leftovers = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).filter((n) => n.includes('.tmp-'));

describe('fileCache', () => {
  it('write then read round-trips (binary, empty, a megabyte, a name in releases/); overwrite replaces; remove of a missing file is not an error', async () => {
    const dir = join(tmp(), 'cache');
    const cache = fileCache(dir);
    expect(await cache.read('state.json')).toBeNull(); // no folder yet
    const odd = new Uint8Array(256).map((_, i) => i);
    await cache.write('index.json', odd);
    expect(await cache.read('index.json')).toEqual(odd);
    await cache.write('index.json', bytes());
    expect(await cache.read('index.json')).toEqual(bytes());
    const big = new Uint8Array(1024 * 1024).map((_, i) => (i * 31) & 255);
    await cache.write('releases/terms-2026.12.0.zip', big);
    expect(await cache.read('releases/terms-2026.12.0.zip')).toEqual(big);
    expect(await cache.read('releases/terms-2026.12.1.zip')).toBeNull();
    await cache.remove('index.json');
    expect(await cache.read('index.json')).toBeNull();
    await expect(cache.remove('index.json')).resolves.toBeUndefined();
    await expect(cache.remove('releases/terms-2000.01.0.zip')).resolves.toBeUndefined();
    await expect(fileCache(join(dir, 'never-made')).remove('state.json')).resolves.toBeUndefined();
    expect(leftovers(dir)).toEqual([]);
    // What it returns is a plain Uint8Array a caller may keep or change.
    const got = (await cache.read('releases/terms-2026.12.0.zip'))!;
    got[0] = 99;
    expect((await cache.read('releases/terms-2026.12.0.zip'))![0]).toBe(big[0]);
  });

  it('a crash between the temporary file and the rename leaves the old file whole, and no temporary file behind', async () => {
    const dir = tmp();
    const cache = fileCache(dir);
    await cache.write('state.json', bytes(1, 2, 3));
    hooks.renameFails = 1;
    await expect(cache.write('state.json', bytes(9, 9, 9, 9))).rejects.toThrow();
    expect(await cache.read('state.json')).toEqual(bytes(1, 2, 3));
    expect(leftovers(dir)).toEqual([]);
    // The same for a file that never existed: it still does not exist.
    hooks.renameFails = 1;
    await expect(cache.write('index.json', bytes(5))).rejects.toThrow();
    expect(await cache.read('index.json')).toBeNull();
    expect(readdirSync(dir).sort()).toEqual(['state.json']);
    // A temporary file a real crash left (the process died before the rename) is never read as a file of the cache.
    writeFileSync(join(dir, 'state.json.tmp-deadbeef'), bytes(7, 7));
    expect(await cache.read('state.json')).toEqual(bytes(1, 2, 3));
    expect(await cache.read('index.json')).toBeNull();
    // And the cache works again afterwards.
    await cache.write('state.json', bytes(4));
    expect(await cache.read('state.json')).toEqual(bytes(4));
  });

  it('names with a separator, .. or NUL, an absolute path or anything but a plain file name are refused, and nothing is touched outside the folder', async () => {
    const root = tmp();
    const dir = join(root, 'cache');
    writeFileSync(join(root, 'outside.txt'), 'keep');
    const cache = fileCache(dir);
    const nul = String.fromCharCode(0);
    const bad = [
      '', '.', '..', '../outside.txt', '..\\outside.txt', 'a/../../outside.txt', 'releases/../../outside.txt', 'releases/..', '/etc/passwd', 'C:\\x', 'C:x',
      'a/b', 'releases/a/b', 'releases//a', 'releases/', '/releases/a', 'sub/state.json', 'a\\b', `a${nul}b`, `state.json${nul}`, 'a..b', '.hidden', 'a b', 'a:b',
      'x'.repeat(200), 'releases/' + 'x'.repeat(200), 'index.json?x', 'index.json#', 'CON.', '~root',
    ];
    for (const name of bad) {
      await expect(cache.write(name, bytes(1)), JSON.stringify(name)).rejects.toThrow();
      await expect(cache.read(name), JSON.stringify(name)).rejects.toThrow();
      await expect(cache.remove(name), JSON.stringify(name)).rejects.toThrow();
    }
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(root).sort()).toEqual(['outside.txt']); // not even the folder was made by a refused name
    // The messages never carry the name.
    await expect(cache.write('../outside.txt', bytes(1))).rejects.toThrow(/^(?!.*outside).*$/s);
  });

  it('files are 0600 and the folders 0700 where the platform has modes', async () => {
    if (!posix) return;
    const dir = join(tmp(), 'cache');
    const cache = fileCache(dir);
    await cache.write('state.json', bytes(1));
    await cache.write('releases/terms-2026.12.0.zip', bytes(1));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'releases')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'releases', 'terms-2026.12.0.zip')).mode & 0o777).toBe(0o600);
  });

  it('a file far larger than any release is a miss, not a memory problem; a folder where a file should be is a miss', async () => {
    const dir = tmp();
    const cache = fileCache(dir);
    writeFileSync(join(dir, 'index.json'), Buffer.alloc(20 * 1024 * 1024, 1));
    expect(await cache.read('index.json')).toBeNull();
    mkdirSync(join(dir, 'state.json'));
    expect(await cache.read('state.json')).toBeNull();
    // A cache folder that is really a file cannot be written, and says so by rejecting; reading it is a miss.
    const asFile = join(tmp(), 'file');
    writeFileSync(asFile, 'x');
    const broken = fileCache(join(asFile, 'cache'));
    expect(await broken.read('state.json')).toBeNull();
    await expect(broken.write('state.json', bytes(1))).rejects.toThrow();
  });

  it('concurrent writes of one name leave one whole file (never a mix) and no temporary file', async () => {
    const dir = tmp();
    const cache = fileCache(dir);
    const payloads = Array.from({ length: 20 }, (_, i) => new Uint8Array(4096).fill(i + 1));
    await Promise.all(payloads.map((p) => cache.write('state.json', p)));
    const got = (await cache.read('state.json'))!;
    expect(payloads.some((p) => p.length === got.length && p.every((b, i) => b === got[i]))).toBe(true);
    expect(leftovers(dir)).toEqual([]);
  });

  it('is a cache the loader can use: a refresh writes it, and a new loader on the same folder starts from it with the network down', async () => {
    const dir = join(tmp(), 'cache');
    const r = await rig({ cache: fileCache(dir) });
    expect((await r.loader.refresh()).status.state).toBe('ready');
    expect(readdirSync(dir, { recursive: true }).map((n) => String(n).replaceAll('\\', '/')).sort()).toEqual([
      'index.json',
      'index.json.sig',
      'releases',
      'releases/terms-2026.12.0.zip',
      'releases/terms-2026.12.0.zip.sig',
      'state.json',
    ]);
    r.w.fault('index.json', { kind: 'throw' });
    const again = r.make({ cache: fileCache(dir) });
    const res = await again.refresh();
    expect(res.status.state).toBe('offline');
    expect(again.pack()?.version).toBe('2026.12.0');
    // Flip one byte of the zip on disk: it is not used any more.
    const zip = join(dir, 'releases', 'terms-2026.12.0.zip');
    const raw = readFileSync(zip);
    raw[raw.length >> 1] = (raw[raw.length >> 1] as number) ^ 1;
    writeFileSync(zip, raw);
    const tampered = r.make({ cache: fileCache(dir) });
    expect((await tampered.refresh()).status.lastError).toMatchObject({ code: 'bad_signature' });
    expect(tampered.pack()).toBeNull();
  });
});

describe('installationKey', () => {
  const body = new TextEncoder().encode('{"schema":"chatwarden-corpus-submission/1","term":"zorbak"}');
  const verify = async (publicKey: string, signature: string, message: Uint8Array): Promise<boolean> => {
    const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64url'), 'Ed25519', false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, Buffer.from(signature, 'base64url'), message);
  };

  it('is generated once, reloaded on the next call, and its public key is 32 bytes of base64url', async () => {
    const dir = join(tmp(), 'keys');
    const first = await installationKey(dir);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(32);
    const file = join(dir, 'installation.key');
    expect(existsSync(file)).toBe(true);
    const der = readFileSync(file);
    expect(der.length).toBe(48); // PKCS#8 of an Ed25519 key
    expect(der.includes(Buffer.from(first.publicKey, 'base64url'))).toBe(false); // the file is the private key, not the public one
    if (posix) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    const second = await installationKey(dir);
    expect(second.publicKey).toBe(first.publicKey);
    expect(readFileSync(file).equals(der)).toBe(true);
    const other = await installationKey(join(tmp(), 'keys'));
    expect(other.publicKey).not.toBe(first.publicKey);
    expect(leftovers(dir)).toEqual([]);
  });

  it('sign verifies over signedMessage(submission, body); a changed body, another key or the bare body fails; the signature is 64 bytes', async () => {
    const key = await installationKey(tmp());
    const message = signedMessage('submission', body);
    const sig = await key.sign(message);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verify(key.publicKey, sig, message)).toBe(true);
    expect(await verify(key.publicKey, sig, signedMessage('submission', new TextEncoder().encode('{"term":"tarvo"}')))).toBe(false);
    expect(await verify(key.publicKey, sig, signedMessage('zip', body))).toBe(false); // domain separation
    expect(await verify(key.publicKey, sig, body)).toBe(false);
    expect(await verify((await installationKey(tmp())).publicKey, sig, message)).toBe(false);
    expect(await key.sign(message)).toBe(sig); // Ed25519 is deterministic
    // A reloaded key signs the same.
    const dir = tmp();
    const a = await installationKey(dir);
    const b = await installationKey(dir);
    expect(await b.sign(message)).toBe(await a.sign(message));
  });

  it('concurrent first calls in one folder agree on one key; a damaged key file is replaced once and then kept', async () => {
    const dir = join(tmp(), 'keys');
    const all = await Promise.all(Array.from({ length: 6 }, () => installationKey(dir)));
    expect(new Set(all.map((k) => k.publicKey)).size).toBe(1);
    expect(leftovers(dir)).toEqual([]);
    writeFileSync(join(dir, 'installation.key'), 'not a key at all');
    const fresh = await installationKey(dir);
    expect(fresh.publicKey).not.toBe(all[0]!.publicKey);
    expect((await installationKey(dir)).publicKey).toBe(fresh.publicKey);
    expect(readFileSync(join(dir, 'installation.key'))).toHaveLength(48);
    // A key file of the wrong kind of key (an RSA key, a truncated one) is not used.
    writeFileSync(join(dir, 'installation.key'), readFileSync(join(dir, 'installation.key')).subarray(0, 40));
    expect((await installationKey(dir)).publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('a folder that cannot be written rejects (a share cannot work without a key) and says nothing about the path', async () => {
    const asFile = join(tmp(), 'file');
    writeFileSync(asFile, 'x');
    const err = await installationKey(join(asFile, 'keys')).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err?.message)).not.toContain(asFile);
    if (posix && process.getuid?.() !== 0) {
      const locked = join(tmp(), 'locked');
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      await expect(installationKey(join(locked, 'keys'))).rejects.toThrow();
      chmodSync(locked, 0o700);
    }
  });
});

describe('startCorpus', () => {
  it('opens the cache, refreshes once, starts the periodic refresh and hands back a loader that is ready', async () => {
    const dir = join(tmp(), 'cache');
    const r = await rig({}, true);
    const terms = newTerms();
    const started = await startCorpus({ dir, select: { languages: ['en'] }, keys: r.w.keys(), baseUrl: BASE, fetch: r.w.fetch, follow: 'stable', kit: '0.1.11', apply: 'auto', terms: terms.live, schedule: r.schedule });
    expect(started.status()).toMatchObject({ state: 'ready', applied: '2026.12.0', lastError: null });
    expect(terms.live.match('you zorbak')).not.toBeNull();
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
    // The periodic refresh is armed (24 hours, plus or minus 10 percent) and stops on stop().
    expect(r.schedule.delays).toHaveLength(1);
    expect(r.schedule.delays[0]).toBeGreaterThanOrEqual(0.9 * 86_400_000);
    expect(r.schedule.delays[0]).toBeLessThanOrEqual(1.1 * 86_400_000);
    started.stop();
    expect(r.schedule.timers).toHaveLength(0);
    started.stop();
  });

  it('never rejects: a folder that cannot be made, a network that is down, a cache full of garbage, a server that answers garbage', async () => {
    const r = await rig({}, true);
    const base = { select: { languages: ['en'] }, keys: r.w.keys(), baseUrl: BASE, follow: 'stable' as const, kit: '0.1.11', schedule: new FakeSchedule() };
    const asFile = join(tmp(), 'file');
    writeFileSync(asFile, 'x');
    const noDir = await startCorpus({ ...base, dir: join(asFile, 'cache'), fetch: r.w.fetch });
    expect(noDir.status().state).toBe('failed'); // verified, but it could not be cached: nothing is adopted
    expect(noDir.status().lastError).toMatchObject({ code: 'cache_failed', stage: 'cache' });
    noDir.stop();

    const down = await startCorpus({ ...base, dir: tmp(), fetch: async () => { throw new TypeError('network down: secret-host'); } });
    expect(down.status()).toMatchObject({ state: 'none', lastError: { code: 'offline' } });
    down.stop();

    const garbage = tmp();
    for (const name of ['state.json', 'index.json', 'index.json.sig']) writeFileSync(join(garbage, name), Buffer.from([0, 1, 103, 97, 114, 98, 97, 103, 101]));
    mkdirSync(join(garbage, 'releases'));
    writeFileSync(join(garbage, 'releases', 'terms-2026.12.0.zip'), 'PK garbage');
    const junk = await startCorpus({ ...base, dir: garbage, fetch: r.w.fetch });
    expect(junk.status().state).toBe('ready'); // the garbage was a miss and the real release was downloaded
    junk.stop();

    const lies = await startCorpus({ ...base, dir: tmp(), fetch: async () => new Response('<html>captive portal</html>', { status: 200 }) });
    expect(['failed', 'none']).toContain(lies.status().state);
    lies.stop();

    // A throwing logger changes nothing either.
    const loud = await startCorpus({ ...base, dir: tmp(), fetch: r.w.fetch, logger: { warn: () => { throw new Error('logger down'); } } });
    expect(loud.status().state).toBe('ready');
    loud.stop();
  });

  it('returns within the bound (10 s) even while the network is still working; the refresh carries on after', async () => {
    const r = await rig({}, true);
    const schedule = new FakeSchedule();
    r.w.fault('terms/2026.12.0/terms-2026.12.0.zip', { kind: 'hang' });
    let returned = false;
    const pending = startCorpus({ dir: tmp(), select: { languages: ['en'] }, keys: r.w.keys(), baseUrl: BASE, fetch: r.w.fetch, follow: 'stable', kit: '0.1.11', schedule }).then((l) => {
      returned = true;
      return l;
    });
    await vi.waitFor(() => expect(schedule.delays).toContain(60_000)); // the zip request is waiting
    await settle();
    expect(returned).toBe(false);
    schedule.advance(10_000); // the startup bound, not the zip timeout
    const started = await pending;
    expect(started.status().state).not.toBe('ready');
    expect(started.pack()).toBeNull();
    schedule.advance(60_000); // the zip request times out later, and the loader records it
    await vi.waitFor(() => expect(started.status().lastError).toMatchObject({ code: 'timeout', stage: 'download' }));
    started.stop();
  });

  it('with the default timer, every timer it sets is unref (it never holds a process open) and stop() clears the periodic one', async () => {
    const r = await rig({}, true);
    const seen: { delay: number; timer: NodeJS.Timeout }[] = [];
    const real = globalThis.setTimeout;
    const cleared: unknown[] = [];
    const realClear = globalThis.clearTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const timer = (real as (...a: unknown[]) => NodeJS.Timeout)(fn, ms, ...rest);
      if (ms === 10_000 || ms === 60_000 || (ms !== undefined && ms > 80_000_000)) seen.push({ delay: ms, timer });
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((t: NodeJS.Timeout) => {
      cleared.push(t);
      return realClear(t);
    }) as typeof clearTimeout);
    const started = await startCorpus({ dir: tmp(), select: { languages: ['en'] }, keys: r.w.keys(), baseUrl: BASE, fetch: r.w.fetch, follow: 'stable', kit: '0.1.11' });
    expect(started.status().state).toBe('ready');
    const periodic = seen.filter((s) => s.delay > 80_000_000);
    expect(periodic).toHaveLength(1);
    expect(seen.length).toBeGreaterThan(1);
    for (const s of seen) expect(s.timer.hasRef(), `${s.delay}`).toBe(false);
    started.stop();
    expect(cleared).toContain(periodic[0]!.timer);
    // The seed and the clock defaults: a second call with a clock of its own uses it.
    const clock = fakeClock();
    const second = await startCorpus({ dir: tmp(), select: { languages: ['en'] }, keys: r.w.keys(), baseUrl: BASE, fetch: r.w.fetch, follow: 'stable', kit: '0.1.11', clock });
    expect(second.status().lastCheckedAt).toBe(clock.t);
    second.stop();
  });

  it('refuses a configuration that cannot work (a RangeError, the one thing that is the caller\'s to fix)', async () => {
    await expect(startCorpus({ dir: tmp(), select: { languages: ['en'] } } as never)).rejects.toThrow(RangeError);
    await expect(startCorpus({ select: { languages: ['en'] }, follow: 'stable' } as never)).rejects.toThrow(RangeError);
    await expect(startCorpus({ dir: 5, select: { languages: ['en'] }, follow: 'stable' } as never)).rejects.toThrow(RangeError);
    await expect(startCorpus({ dir: '', select: { languages: ['en'] }, follow: 'stable' } as never)).rejects.toThrow(RangeError);
  });

});
