// Shared shapes of the `chatwarden init` CLI. Pure types: this file has no runtime code and imports nothing (the CLI imports nothing from
// @chatwarden/core: a template is text, and the version it writes comes from this package's own VERSION).

/** Where the generated server code is mounted. `fetch` is anything on Web Request/Response; `none` is library-only (no routes). */
export type Framework = 'express' | 'fastify' | 'next' | 'fetch' | 'none';
export type Store = 'sqlite' | 'memory';
export type ChatChoice = 'none' | 'box';
export type ChatTransportChoice = 'sse' | 'socketio';
export type HubChoice = 'element' | 'react' | 'none';
export type ProfileChoice = 'relaxed' | 'standard' | 'strict';
export type Lang = 'ts' | 'js';
export type OnConflict = 'skip' | 'overwrite' | 'new';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** The resolved answers (design 5.1): every field is set, from a flag, a detected value or a default. */
export interface Answers {
  framework: Framework;
  store: Store;
  chat: ChatChoice;
  chatTransport: ChatTransportChoice;
  hub: HubChoice;
  discord: boolean;
  profile: ProfileChoice;
  /** The URL prefix everything lives under, e.g. `/chatwarden`. */
  base: string;
  /** The folder the files are written to, relative to the project root, with `/` separators on every platform. */
  dir: string;
  lang: Lang;
}

/** What `detect` reads from the project root (design 5.1). */
export interface Detected {
  /** The server frameworks found in `dependencies` or `devDependencies`, from `express`, `fastify` and `next`, in that order. */
  frameworks: Array<'express' | 'fastify' | 'next'>;
  react: boolean;
  socketio: boolean;
  manager: PackageManager;
  /** A `tsconfig.json` is present. */
  ts: boolean;
  /** `"type": "module"` in package.json. */
  moduleType: 'module' | 'commonjs';
  /** A `src/` entry is present in the root listing: the default directory moves under it. */
  srcDir: boolean;
  /** A `chatwarden` entry is present in the root listing (a previous run, or the adopter's own folder of that name). */
  hasDir: boolean;
}

/** One file the CLI writes. */
export interface FileSpec {
  /** Relative to the project root, with `/` separators on every platform. */
  path: string;
  /** The full text, `\n` line endings. */
  content: string;
  /** The starter markers this file carries (`TODO(auth)`, `TODO(identity)`, `TODO(terms)`), for `--check` and the plan's `todo`. */
  markers?: string[];
}

/** An environment variable the generated code reads. A name only: init never writes a value. */
export interface EnvName {
  name: string;
  required: boolean;
}

/** A marker left in a generated file for the adopter to resolve. */
export interface TodoItem {
  file: string;
  line: number;
  marker: string;
}

/** What init would do (design 5.2): pure data, built before anything is written. */
export interface Plan {
  answers: Answers;
  /** Sorted by `path`. */
  files: FileSpec[];
  install: { manager: PackageManager; command: string; packages: string[] };
  env: EnvName[];
  nextSteps: string[];
  warnings: string[];
  todo: TodoItem[];
}

/** The versions a template or the install line may name. The kit's packages move together, so one number is right for all of them. */
export interface Versions {
  chatwarden: string;
}

/**
 * What the plan needs to know about the project beyond the answers. `platform` (`process.platform`) only changes how the install command is printed:
 * on `win32` each package is double-quoted, because a bare `^` is cmd.exe's escape character and would turn a range into an exact pin.
 */
export type Project = Pick<Detected, 'manager' | 'react'> & { platform?: string };
