import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Clock } from '../deps.js';

// What the maintainers' tools need from the machine they run on, as an interface so a test can run them on a temporary folder with a fixed clock
// and read what they printed. The tools never read the clock, the environment or the console any other way.

export interface ToolIo {
  clock: Clock;
  /** The environment (the one place a secret may come from, by a variable's name the caller was given). */
  env: Readonly<Record<string, string | undefined>>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array | string, mode?: number): Promise<void>;
  ensureDir(path: string): Promise<void>;
  out(line: string): void;
  err(line: string): void;
}

export function nodeIo(): ToolIo {
  return {
    clock: { now: () => Date.now() },
    env: process.env,
    read: async (path) => new Uint8Array(await readFile(path)),
    write: async (path, data, mode) => writeFile(path, data, mode === undefined ? undefined : { mode }),
    ensureDir: async (path) => void (await mkdir(path, { recursive: true })),
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
  };
}
