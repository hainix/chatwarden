// The CLI's whole view of the machine. Every other file in src/cli/ takes a `CliEnv` and never imports `node:fs`, `node:path` or the
// process global, so the tests can run the CLI over an in-memory file system with `path.win32` and a fake terminal. This is the one place
// those modules are imported (the one other Node import in the CLI is `node:child_process`, in install.ts).
import * as nodeFs from 'node:fs/promises';
import * as nodePath from 'node:path';
import nodeProcess from 'node:process';

/** The slice of `fs.Stats` the CLI looks at. */
export interface CliStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The promise subset of `node:fs/promises` the CLI uses. Paths are strings; text is UTF-8. */
export interface CliFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options?: { flag?: 'w' | 'wx'; encoding?: 'utf8' }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  stat(path: string): Promise<CliStats>;
  lstat(path: string): Promise<CliStats>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
}

/** The slice of `node:path` the CLI uses, so a test can hand it `path.posix` or `path.win32` on any host. */
export interface PathLike {
  sep: string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  normalize(path: string): string;
}

/** Standard input: anything `readline` can read lines from. */
export type CliReadable = NodeJS.ReadableStream;

/** Standard output or error: the CLI only ever writes strings. */
export interface CliWritable {
  write(chunk: string): unknown;
}

/** Runs a command and resolves with its exit code. `shell` is only ever set by install.ts, for a fixed argument list. */
export type Spawner = (command: string, args: string[], options: { cwd: string; shell?: boolean }) => Promise<{ code: number }>;

export interface CliEnv {
  /** The project root: where the CLI was run from. It never looks in a parent folder. */
  cwd: string;
  fs: CliFs;
  path: PathLike;
  stdin: CliReadable;
  stdout: CliWritable;
  stderr: CliWritable;
  env: Record<string, string | undefined>;
  /** `process.platform`: `'win32'`, `'darwin'`, `'linux'`. */
  platform: string;
  /** Both stdin and stdout are a terminal: a prompt makes sense. */
  isTTY: boolean;
  spawn: Spawner;
}

const noSpawner: Spawner = () => Promise.reject(new Error('no process spawner is configured (only --install runs one)'));

/**
 * The real environment. `spawn` is the one piece this file does not own (child_process lives in install.ts alone): the bin passes
 * install.ts's spawner in; without one, a spawn rejects.
 */
export function nodeEnv(spawn: Spawner = noSpawner): CliEnv {
  return {
    cwd: nodeProcess.cwd(),
    fs: {
      readFile: (path, encoding) => nodeFs.readFile(path, encoding),
      writeFile: (path, data, options) => nodeFs.writeFile(path, data, options),
      rename: (from, to) => nodeFs.rename(from, to),
      mkdir: (path, options) => nodeFs.mkdir(path, options),
      stat: (path) => nodeFs.stat(path),
      lstat: (path) => nodeFs.lstat(path),
      realpath: (path) => nodeFs.realpath(path),
      readdir: (path) => nodeFs.readdir(path),
      rm: (path, options) => nodeFs.rm(path, options),
    },
    path: nodePath,
    stdin: nodeProcess.stdin,
    stdout: { write: (chunk) => nodeProcess.stdout.write(chunk) },
    stderr: { write: (chunk) => nodeProcess.stderr.write(chunk) },
    env: nodeProcess.env,
    platform: nodeProcess.platform,
    isTTY: Boolean(nodeProcess.stdin.isTTY && nodeProcess.stdout.isTTY),
    spawn,
  };
}
