import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Clock } from '../deps.js';

// What the maintainers' tools need from the machine they run on, as an interface so a test can run them on a temporary folder with a fixed clock,
// a scripted passphrase and a fake network, and read what they printed. The tools never read the clock, the environment, the console, the keyboard
// or the network any other way.

export interface WriteOptions {
  /** File mode (0o600 for a key). */
  mode?: number;
  /** Fail if the file exists (never overwrite a key). */
  exclusive?: boolean;
}

export interface ToolIo {
  clock: Clock;
  /** The environment (the one place a secret may come from, by a variable's name the caller was given). */
  env: Readonly<Record<string, string | undefined>>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array | string, options?: WriteOptions): Promise<void>;
  exists(path: string): boolean;
  ensureDir(path: string): Promise<void>;
  /** Asks for a secret on the terminal without echoing it. Rejects when there is no terminal. */
  secret(prompt: string): Promise<string>;
  fetch: typeof fetch;
  out(line: string): void;
  err(line: string): void;
}

/** Reads a line from the terminal with the typed characters not echoed. */
function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new Error('no terminal to ask on'));
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput.bind(rl);
    let asked = false;
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (!asked) write(text);
    };
    process.stdout.write(prompt);
    asked = true;
    rl.question('', (answer) => {
      asked = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => reject(new Error('no answer')));
  });
}

export function nodeIo(): ToolIo {
  return {
    clock: { now: () => Date.now() },
    env: process.env,
    read: async (path) => new Uint8Array(await readFile(path)),
    write: async (path, data, options) => writeFile(path, data, { ...(options?.mode === undefined ? {} : { mode: options.mode }), ...(options?.exclusive === true ? { flag: 'wx' } : {}) }),
    exists: (path) => existsSync(path),
    ensureDir: async (path) => void (await mkdir(path, { recursive: true })),
    secret: readHidden,
    fetch: (input, init) => fetch(input, init),
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
  };
}
