// The way the command line reaches the server. `chatwarden init` must run in a project that has not installed the kit yet, so the command line (src/cli) never loads `@chatwarden/core` at start-up:
// it calls this file, which holds only types and loads `./serve.js` (and with it the kit) with a dynamic import, only when `chatwarden serve` is the command.
import type { ServeFlags } from '../cli/args.js';

/** What a test (or an embedding) can replace. */
export interface ServeDeps {
  /** Loads a package by name. Default `import()`. A missing one is a `ServeError` with the install command. */
  importer?: (name: string) => Promise<unknown>;
  /** Reads a file as UTF-8. Default `fs.readFile`. */
  readFile?: (path: string) => Promise<string>;
  /** Where a JSON log line goes. Default: standard error. */
  log?: (line: string) => void;
  /** Where the hub element's script is, or null. Default: the installed package. */
  hubScript?: () => string | null;
  /** Is the hub element package installed? Default: its script can be found. */
  hubPackage?: () => boolean;
}

export interface RunningService {
  port: number;
  /** Stop accepting, let open requests finish (at most 10 seconds), close the kit and the store. */
  close(): Promise<void>;
}

/** Where a signal comes from: the process, or a test. `on` returns what takes the handler off again. */
export interface SignalSource {
  on(handler: (signal: string) => void): () => void;
}

/** What the command needs from the machine. */
export interface ServeIo extends ServeDeps {
  env: Record<string, string | undefined>;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  signals?: SignalSource;
  /** Called once the process is listening (for a test). */
  onStarted?: (service: RunningService) => void;
}

/** `chatwarden serve`: the exit code. */
export async function launchServe(flags: ServeFlags, io: ServeIo): Promise<number> {
  const { runServeCommand } = await import('./serve.js');
  return runServeCommand(flags, io);
}
