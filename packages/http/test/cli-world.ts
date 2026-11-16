import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { CliEnv, CliFs, CliStats, PathLike, Spawner } from '../src/cli/env.js';

// A test world for the init CLI: an in-memory file system, a fake terminal and a recorder of every file-system call, under either path
// module (posix, or win32 with a C:\ root) so one test can run both. Nothing here touches the real disk or process.
//
// Files are given as relative posix names ('src/chatwarden/kit.ts'); the world joins them to the root with the chosen path module.

export type PathKind = 'posix' | 'win32';

export type OpName = 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'stat' | 'lstat' | 'realpath' | 'readdir' | 'rm';
export interface Op {
  op: OpName;
  path: string;
  /** rename: the destination. */
  to?: string;
  /** writeFile: the flag. */
  flag?: string;
}

export interface WorldOptions {
  kind?: PathKind;
  /** Files by relative posix name. A parent folder exists for each. */
  files?: Record<string, string>;
  /** Empty folders by relative posix name. */
  dirs?: string[];
  /** Symbolic links: relative posix name of the link to its target (absolute, or relative to the root, posix spelling). */
  links?: Record<string, string>;
  /** Text on standard input (then end of input). Default: empty, ended. */
  stdin?: string;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Return an error to make a call fail (the call is still recorded). */
  failOn?: (op: Op) => Error | undefined;
  /** The exit code the fake spawner returns. Default 0. */
  spawnCode?: number;
}

type Entry = { kind: 'file'; content: string } | { kind: 'dir' } | { kind: 'link'; target: string };

export interface World {
  env: CliEnv;
  kind: PathKind;
  root: string;
  path: PathLike;
  /** Every file-system call, in order. */
  ops: Op[];
  /** Only the calls that change something: writeFile, rename, mkdir, rm. */
  writes(): Op[];
  /** The absolute path of a relative posix name under the root. */
  abs(relative: string): string;
  /** The text of a file by relative posix name, or undefined. */
  read(relative: string): string | undefined;
  has(relative: string): boolean;
  /** Relative posix names of every file (not folders, not links), sorted. */
  files(): string[];
  /** Replace or create a file directly (not recorded). */
  put(relative: string, content: string): void;
  out(): string;
  err(): string;
  spawned: Array<{ command: string; args: string[]; cwd: string; shell?: boolean }>;
}

function errno(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export function createWorld(options: WorldOptions = {}): World {
  const kind = options.kind ?? 'posix';
  const p: path.PlatformPath = kind === 'win32' ? path.win32 : path.posix;
  const root = kind === 'win32' ? 'C:\\proj' : '/proj';
  const ops: Op[] = [];
  const entries = new Map<string, Entry>();
  const key = (value: string): string => p.resolve(root, value);
  const abs = (relative: string): string => p.join(root, ...relative.split('/'));

  const ensureDirs = (dir: string): void => {
    let current = dir;
    for (;;) {
      if (!entries.has(current)) entries.set(current, { kind: 'dir' });
      const parent = p.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };
  const putFile = (relative: string, content: string): void => {
    const full = key(abs(relative));
    ensureDirs(p.dirname(full));
    entries.set(full, { kind: 'file', content });
  };
  ensureDirs(key(root));
  for (const [name, content] of Object.entries(options.files ?? {})) putFile(name, content);
  for (const name of options.dirs ?? []) ensureDirs(key(abs(name)));
  for (const [name, target] of Object.entries(options.links ?? {})) {
    const full = key(abs(name));
    ensureDirs(p.dirname(full));
    const resolvedTarget = p.isAbsolute(target) ? target : abs(target);
    entries.set(full, { kind: 'link', target: resolvedTarget });
  }

  // Follow symbolic links, component by component. Throws ENOENT when the final path does not exist.
  const real = (input: string, depth = 0): string => {
    if (depth > 20) throw errno('ELOOP', input);
    const full = key(input);
    const parsed = p.parse(full);
    const rest = full.slice(parsed.root.length).split(p.sep).filter(Boolean);
    let current = parsed.root;
    for (const segment of rest) {
      const next = p.join(current, segment);
      const entry = entries.get(next);
      if (entry === undefined) throw errno('ENOENT', input);
      current = entry.kind === 'link' ? real(entry.target, depth + 1) : next;
    }
    return current;
  };

  const record = (op: Op): void => {
    ops.push(op);
    const failure = options.failOn?.(op);
    if (failure) throw failure;
  };
  const statOf = (entry: Entry): CliStats => ({
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'dir',
    isSymbolicLink: () => entry.kind === 'link',
  });

  const fs: CliFs = {
    async readFile(file) {
      record({ op: 'readFile', path: file });
      const entry = entries.get(real(file));
      if (entry?.kind !== 'file') throw errno(entry ? 'EISDIR' : 'ENOENT', file);
      return entry.content;
    },
    async writeFile(file, data, opts) {
      const flag = opts?.flag ?? 'w';
      record({ op: 'writeFile', path: file, flag });
      const parent = real(p.dirname(key(file)));
      if (entries.get(parent)?.kind !== 'dir') throw errno('ENOENT', file);
      const target = p.join(parent, p.basename(file));
      if (flag === 'wx' && entries.has(target)) throw errno('EEXIST', file);
      entries.set(target, { kind: 'file', content: data });
    },
    async rename(from, to) {
      record({ op: 'rename', path: from, to });
      const source = entries.get(key(from));
      if (source?.kind !== 'file') throw errno('ENOENT', from);
      const parent = real(p.dirname(key(to)));
      if (entries.get(parent)?.kind !== 'dir') throw errno('ENOENT', to);
      entries.delete(key(from));
      entries.set(p.join(parent, p.basename(to)), source);
    },
    async mkdir(dir) {
      record({ op: 'mkdir', path: dir });
      const full = key(dir);
      const existing = entries.get(full);
      if (existing && existing.kind !== 'dir') throw errno('EEXIST', dir);
      // Through any link in the chain, like a real mkdir -p.
      const root0 = p.parse(full).root;
      const parts = full.slice(root0.length).split(p.sep).filter(Boolean);
      let current = root0;
      for (const segment of parts) {
        const next = p.join(current, segment);
        const entry = entries.get(next);
        if (entry === undefined) entries.set(next, { kind: 'dir' });
        current = entry?.kind === 'link' ? real(entry.target) : next;
      }
      return undefined;
    },
    async stat(file) {
      record({ op: 'stat', path: file });
      const entry = entries.get(real(file));
      if (!entry) throw errno('ENOENT', file);
      return statOf(entry);
    },
    async lstat(file) {
      record({ op: 'lstat', path: file });
      const full = key(file);
      // The parents are followed; the last component is not.
      const parent = real(p.dirname(full));
      const entry = entries.get(p.join(parent, p.basename(full)));
      if (!entry) throw errno('ENOENT', file);
      return statOf(entry);
    },
    async realpath(file) {
      record({ op: 'realpath', path: file });
      return real(file);
    },
    async readdir(dir) {
      record({ op: 'readdir', path: dir });
      const full = real(dir);
      if (entries.get(full)?.kind !== 'dir') throw errno('ENOTDIR', dir);
      const names = new Set<string>();
      for (const k of entries.keys()) {
        if (k !== full && p.dirname(k) === full) names.add(p.basename(k));
      }
      return [...names].sort();
    },
    async rm(file, opts) {
      record({ op: 'rm', path: file });
      const full = key(file);
      if (!entries.has(full)) {
        if (opts?.force) return;
        throw errno('ENOENT', file);
      }
      entries.delete(full);
    },
  };

  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const spawned: World['spawned'] = [];
  const spawn: Spawner = async (command, args, opts) => {
    spawned.push({ command, args, cwd: opts.cwd, ...(opts.shell === undefined ? {} : { shell: opts.shell }) });
    return { code: options.spawnCode ?? 0 };
  };

  const env: CliEnv = {
    cwd: root,
    fs,
    path: p,
    stdin,
    stdout: { write: (chunk) => outChunks.push(chunk) },
    stderr: { write: (chunk) => errChunks.push(chunk) },
    env: options.env ?? {},
    platform: options.platform ?? (kind === 'win32' ? 'win32' : 'linux'),
    isTTY: options.isTTY ?? false,
    spawn,
  };

  return {
    env,
    kind,
    root,
    path: p,
    ops,
    writes: () => ops.filter((o) => o.op === 'writeFile' || o.op === 'rename' || o.op === 'mkdir' || o.op === 'rm'),
    abs,
    read: (relative) => {
      const entry = entries.get(key(abs(relative)));
      return entry?.kind === 'file' ? entry.content : undefined;
    },
    has: (relative) => entries.has(key(abs(relative))),
    files: () =>
      [...entries.entries()]
        .filter(([, e]) => e.kind === 'file')
        .map(([k]) => p.relative(root, k).split(p.sep).join('/'))
        .sort(),
    put: (relative, content) => putFile(relative, content),
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
    spawned,
  };
}
