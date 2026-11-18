// `chatwarden serve`: the process (design 3.4). One `http.createServer` over `toFetch` through the Node bridge, serving `/v1` (service keys), `/admin` (staff), `/mod` and the hub script (when
// staff auth exists and the hub is `element`), and `/healthz` and `/readyz`. Startup validates in a fixed order and refuses with ONE sentence that names the variable and never its value; the
// packages the kit needs are loaded from the project this runs in (they are optional peers of `@chatwarden/http`, so none is a hard dependency).
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Chatwarden, Logger } from '@chatwarden/core';
import type { Authenticate } from '../auth.js';
import type { ServeFlags } from '../cli/args.js';
import type { RunningService, ServeDeps, ServeIo, SignalSource } from './launch.js';
import { SERVE_OPTIONS } from '../cli/args.js';
import { adminRoutes } from '../admin/index.js';
import { toFetch } from '../fetch.js';
import { healthRoutes } from '../health.js';
import { parseKeys } from './auth.js';
import { nodeHandler, peerAddress } from './node.js';
import { projectImporter } from './serveResolve.js';
import { SERVICE_OPENAPI } from './openapi.js';
import { serviceRoutes } from './index.js';
import { hubHandler, hubScriptPath, MIN_TOKEN_LENGTH, tokenStaff } from './serveStaff.js';

/** A startup failure: one sentence for the person running the process. It names a variable or a flag and never repeats a value. */
export class ServeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServeError';
  }
}

export interface ServeConfig {
  port: number;
  host: string;
  db: string;
  profileFile?: string;
  termsFile?: string;
  hub: 'element' | 'none';
  sharedPacing: boolean;
  /** Send the staff cookie without `Secure` (plain-http local use). Default false: the cookie is Secure whatever NODE_ENV says. */
  insecureStaffCookie: boolean;
  processes: number;
  /** The environment, as given: checked by `startService`, in order. */
  secret?: string;
  serviceKeys?: string;
  adminToken?: string;
  authModule?: string;
}

type Env = Record<string, string | undefined>;

const present = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
const envOf = (flag: string | undefined, env: Env, name: string | undefined): { value?: string; from: string } => {
  if (flag !== undefined) return { value: flag, from: `--${SERVE_OPTIONS.find((o) => o.env === name)?.name ?? name}` };
  const value = name === undefined ? undefined : present(env[name]);
  return value === undefined ? { from: name ?? '' } : { value, from: name ?? '' };
};
// eslint-disable-next-line no-control-regex
const printable = (text: string): boolean => !/[\u0000-\u001f\u007f]/.test(text);

/** Flags beat the environment, which beats the defaults. The secrets are environment only and are not judged here. A bad value is a `ServeError` that names the flag or the variable. */
export function resolveServeConfig(flags: ServeFlags, env: Env): ServeConfig {
  const text = (key: keyof ServeFlags, name: string, fallback: string): { value: string; from: string } => {
    const r = envOf(flags[key] as string | undefined, env, name);
    return { value: r.value ?? fallback, from: r.from };
  };
  const port = text('port', 'CHATWARDEN_PORT', '8787');
  if (!/^\d{1,5}$/.test(port.value) || Number(port.value) > 65_535) throw new ServeError(`${port.from} must be a whole number from 0 to 65535.`);
  const host = text('host', 'CHATWARDEN_HOST', '127.0.0.1');
  if (host.value === '' || /\s/.test(host.value) || !printable(host.value)) throw new ServeError(`${host.from} must be an address or a host name.`);
  const db = text('db', 'CHATWARDEN_DB', './chatwarden.db');
  if (db.value.includes('\u0000')) throw new ServeError(`${db.from} must be a file path.`);
  const hub = text('hub', 'CHATWARDEN_HUB', 'element');
  if (hub.value !== 'element' && hub.value !== 'none') throw new ServeError(`${hub.from} must be element or none.`);
  const pick = (key: 'profileFile' | 'termsFile', name: string): string | undefined => {
    const r = envOf(flags[key], env, name);
    if (r.value !== undefined && r.value.includes('\u0000')) throw new ServeError(`${r.from} must be a file path.`);
    return r.value;
  };
  const profileFile = pick('profileFile', 'CHATWARDEN_PROFILE_FILE');
  const termsFile = pick('termsFile', 'CHATWARDEN_TERMS_FILE');
  let sharedPacing = flags.sharedPacing === true;
  if (flags.sharedPacing === undefined) {
    const raw = present(env.CHATWARDEN_SHARED_PACING);
    if (raw !== undefined && raw !== '1' && raw !== '0') throw new ServeError('CHATWARDEN_SHARED_PACING must be 1 or 0.');
    sharedPacing = raw === '1';
  }
  let insecureStaffCookie = flags.insecureStaffCookie === true;
  if (flags.insecureStaffCookie === undefined) {
    const raw = present(env.CHATWARDEN_INSECURE_STAFF_COOKIE);
    if (raw !== undefined && raw !== '1' && raw !== '0') throw new ServeError('CHATWARDEN_INSECURE_STAFF_COOKIE must be 1 or 0.');
    insecureStaffCookie = raw === '1';
  }
  const rawProcesses = present(env.CHATWARDEN_PROCESSES);
  let processes = 1;
  if (rawProcesses !== undefined) {
    if (!/^\d{1,4}$/.test(rawProcesses) || Number(rawProcesses) < 1 || Number(rawProcesses) > 1000) throw new ServeError('CHATWARDEN_PROCESSES must be a whole number from 1 to 1000.');
    processes = Number(rawProcesses);
  }
  const optional = <K extends keyof ServeConfig>(key: K, value: ServeConfig[K] | undefined): Partial<ServeConfig> => (value === undefined ? {} : { [key]: value });
  return {
    port: Number(port.value),
    host: host.value,
    db: db.value,
    hub: hub.value,
    sharedPacing,
    insecureStaffCookie,
    processes,
    ...optional('profileFile', profileFile),
    ...optional('termsFile', termsFile),
    ...optional('secret', present(env.CHATWARDEN_SECRET)),
    ...optional('serviceKeys', present(env.CHATWARDEN_SERVICE_KEYS)),
    ...optional('adminToken', present(env.CHATWARDEN_ADMIN_TOKEN)),
    ...optional('authModule', present(env.CHATWARDEN_AUTH_MODULE)),
  };
}

const MAKE_ONE = 'openssl rand -base64 32';
const CLOSE_GRACE_MS = 10_000;
const PRESETS = ['relaxed', 'standard', 'strict'] as const;

/** Read a JSON file; a failure is a `ServeError` that names what the file is for (never the path's content or the file's). */
async function readJson(read: (path: string) => Promise<string>, path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await read(path);
  } catch {
    throw new ServeError(`The ${what} file could not be read.`);
  }
  try {
    return JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text) as unknown;
  } catch {
    throw new ServeError(`The ${what} file is not valid JSON.`);
  }
}

/** The profile file: `{ "preset": "strict", ...overrides }` (the preset defaults to standard), plus `phrases` for the phrase books. */
function splitProfile(json: unknown): { preset: (typeof PRESETS)[number]; overrides: Record<string, unknown>; phrases: Record<string, unknown> | undefined } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new ServeError('The profile file must hold a JSON object.');
  const { preset, phrases, ...overrides } = json as Record<string, unknown>;
  if (preset !== undefined && !(PRESETS as readonly unknown[]).includes(preset)) throw new ServeError('The profile file names a preset that is not relaxed, standard or strict.');
  if (phrases !== undefined && (typeof phrases !== 'object' || phrases === null || Array.isArray(phrases))) throw new ServeError('The phrases of the profile file must be an object of books.');
  return { preset: (preset as (typeof PRESETS)[number] | undefined) ?? 'standard', overrides, phrases: phrases as Record<string, unknown> | undefined };
}

/** The adopter's staff auth module: a path or URL whose default export is `{ authorize(req) }`. */
async function loadAuthModule(importer: (name: string) => Promise<unknown>, spec: string): Promise<Authenticate> {
  const target = /^(\.|\/|[A-Za-z]:[\\/])/.test(spec) ? pathToFileURL(resolve(spec)).href : spec;
  let mod: unknown;
  try {
    mod = await importer(target);
  } catch {
    throw new ServeError('CHATWARDEN_AUTH_MODULE could not be loaded.');
  }
  const authorize = ((mod as { default?: { authorize?: unknown } } | null)?.default as { authorize?: unknown } | undefined)?.authorize;
  if (typeof authorize !== 'function') throw new ServeError('CHATWARDEN_AUTH_MODULE must have a default export with an authorize function.');
  const owner = (mod as { default: object }).default;
  return (req) => (authorize as Authenticate).call(owner, req);
}

/**
 * Start the process. Validation order: the packages, `CHATWARDEN_SECRET` (32 or more characters), the service keys, the admin token (not a service key, 24 or more characters), the profile
 * file, the terms file, then the store and the kit, then listen. Any failure before listening is a `ServeError` and nothing is left open.
 */
export async function startService(config: ServeConfig, deps: ServeDeps = {}): Promise<RunningService> {
  const importer = deps.importer ?? projectImporter();
  const read = deps.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const log = deps.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const logger: Logger = { warn: (event, detail) => log(JSON.stringify({ event, ...detail })) };
  const finder = deps.hubScript ?? hubScriptPath;
  const hubPresent = deps.hubPackage ?? (() => finder() !== null);

  // 1. the packages
  const load = async <T>(name: string): Promise<T> => {
    try {
      return (await importer(name)) as T;
    } catch {
      throw new ServeError(`${name} is not installed: run npm install ${name} in the folder you run chatwarden serve from.`);
    }
  };
  const core = await load<typeof import('@chatwarden/core')>('@chatwarden/core');
  const sqlite = await load<typeof import('@chatwarden/store-sqlite')>('@chatwarden/store-sqlite');
  const matcher = await load<typeof import('@chatwarden/matcher')>('@chatwarden/matcher');
  const profanity = await load<typeof import('@chatwarden/profanity')>('@chatwarden/profanity');
  if (config.hub === 'element' && !hubPresent()) throw new ServeError('@chatwarden/hub-element is not installed: run npm install @chatwarden/hub-element in the folder you run chatwarden serve from, or start with --hub none.');

  // 2. the secret, the keys, the admin token
  if (config.secret === undefined || config.secret.length < 32) throw new ServeError(`CHATWARDEN_SECRET must be set to at least 32 characters (make one with: ${MAKE_ONE}).`);
  const secret = config.secret;
  if (config.serviceKeys === undefined) throw new ServeError('CHATWARDEN_SERVICE_KEYS must be set to one to five service keys, comma separated.');
  let keys: string[];
  try {
    keys = parseKeys(config.serviceKeys.split(',').map((k) => k.trim()));
  } catch {
    throw new ServeError('CHATWARDEN_SERVICE_KEYS must hold one to five keys of 32 to 256 characters of A-Z a-z 0-9 _ - . ~ + / =, none repeated.');
  }
  if (config.adminToken !== undefined) {
    if (keys.includes(config.adminToken)) throw new ServeError('CHATWARDEN_ADMIN_TOKEN must not be the same as a service key.');
    if (config.adminToken.length < MIN_TOKEN_LENGTH) throw new ServeError(`CHATWARDEN_ADMIN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }

  // 3. the files
  let profile = { preset: 'standard' as (typeof PRESETS)[number], overrides: {} as Record<string, unknown>, phrases: undefined as Record<string, unknown> | undefined };
  if (config.profileFile !== undefined) profile = splitProfile(await readJson(read, config.profileFile, 'profile'));
  try {
    core.resolveProfile(profile.preset, profile.overrides as never);
  } catch (err) {
    const where = (err as { path?: unknown }).path;
    throw new ServeError(`The profile file is not valid${typeof where === 'string' && /^[A-Za-z0-9_.[\]-]{1,80}$/.test(where) ? ` at ${where}` : ''}.`);
  }
  let pack: unknown;
  if (config.termsFile !== undefined) {
    const json = await readJson(read, config.termsFile, 'terms');
    try {
      pack = matcher.loadTermPack(json);
    } catch (err) {
      throw new ServeError(`The terms file is not a valid term pack: ${err instanceof Error ? err.message.replace(/[^\x20-\x7e]/g, '?').slice(0, 120) : 'unreadable'}.`);
    }
  } else {
    const fixtures = await load<typeof import('@chatwarden/matcher/fixtures')>('@chatwarden/matcher/fixtures');
    pack = fixtures.syntheticTermPack();
    log(JSON.stringify({ event: 'chatwarden.serve_synthetic_terms' }));
  }
  const staffModule = config.authModule === undefined ? undefined : await loadAuthModule(importer, config.authModule);

  // 4. the store and the kit
  const store = sqlite.openStore({ path: config.db });
  let cw: Chatwarden | undefined;
  try {
    const live = new matcher.LiveTerms({ store, pack: pack as never, clock: { now: () => Date.now() } });
    await live.load();
    try {
      cw = await core.createChatwarden({
        store,
        secret,
        matcher: live,
        profile: profile.preset,
        overrides: profile.overrides as never,
        ...(profile.phrases === undefined ? {} : { phrases: profile.phrases as never }),
        profanityPackage: { createProfanityFilter: profanity.createProfanityFilter },
        sharedPacing: config.sharedPacing,
        platform: { identify: () => ({}) },
        logger,
      });
    } catch (err) {
      const where = (err as { path?: unknown }).path;
      throw new ServeError(`The kit could not start with this profile${typeof where === 'string' && /^[A-Za-z0-9_.[\]-]{1,80}$/.test(where) ? ` (see ${where})` : ''}.`);
    }

    // The staff side: a module beats the token; with neither, every staff route is 401 and the hub page is not served.
    const staff = config.adminToken === undefined ? undefined : tokenStaff(config.adminToken, secret, !config.insecureStaffCookie);
    const authorize: Authenticate = staffModule ?? staff?.authorize ?? (() => null);
    const staffOpen = staffModule !== undefined || staff !== undefined;
    const hub = config.hub === 'element' && staffOpen ? hubHandler({ authorize, ...(staff === undefined || staffModule !== undefined ? {} : { staff }), script: finder }) : undefined;

    const warnings = (): string[] => [...(config.termsFile === undefined ? ['synthetic_terms'] : []), ...(config.processes > 1 && !config.sharedPacing ? ['pacing_per_process'] : [])];
    const routes = toFetch(
      {
        '/v1': serviceRoutes(cw, { keys, logger, warnings, processes: config.processes > 1 ? 'multiple' : 'single', capabilities: { sharedPacing: config.sharedPacing } }),
        '/admin': adminRoutes(cw, { authorize, terms: live, logger }),
        '': healthRoutes(cw, { logger }),
      },
      { unmatched: 'pass', remoteAddress: peerAddress, logger },
    );
    const handle = async (request: Request): Promise<Response | null> => (hub === undefined ? null : await hub(request)) ?? (await routes(request));

    const server: Server = createServer(nodeHandler(handle));
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', (err: NodeJS.ErrnoException) => rejectListen(new ServeError(err.code === 'EADDRINUSE' ? `The port ${config.port} is already in use.` : `The server could not listen on port ${config.port}.`)));
      server.listen(config.port, config.host, resolveListen);
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : config.port;
    log(JSON.stringify({ event: 'chatwarden.serve_started', port }));
    const kit = cw;
    let closing: Promise<void> | undefined;
    return {
      port,
      close: () =>
        (closing ??= (async () => {
          const stopped = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
          server.closeIdleConnections();
          const timer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
          await stopped;
          clearTimeout(timer);
          await kit.close();
          store.close();
        })()),
    };
  } catch (err) {
    try {
      await cw?.close();
    } catch {
      /* nothing to do */
    }
    store.close();
    throw err;
  }
}

/**
 * `chatwarden serve`, whole: print the API description, or start, wait for SIGTERM or SIGINT and stop. Resolves the exit code: 0 stopped (or the description printed), 2 it would not start.
 * A second signal while it is stopping resolves at once.
 */
export async function runServeCommand(flags: ServeFlags, io: ServeIo): Promise<number> {
  if (flags.printOpenapi) {
    io.stdout.write(`${JSON.stringify(SERVICE_OPENAPI, null, 2)}\n`);
    return 0;
  }
  let service: RunningService;
  try {
    service = await startService(resolveServeConfig(flags, io.env), { ...io, log: io.log ?? ((line) => void io.stderr.write(`${line}\n`)) });
  } catch (err) {
    if (err instanceof ServeError) {
      io.stderr.write(`chatwarden: ${err.message}\n`);
      return 2;
    }
    io.stderr.write(`chatwarden: the service could not start (${err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(err.constructor.name) ? err.constructor.name : 'Error'}).\n`);
    return 2;
  }
  io.onStarted?.(service);
  const signals = io.signals;
  if (signals === undefined) {
    await service.close();
    return 0;
  }
  await new Promise<void>((resolveStop) => {
    let received = 0;
    const off = signals.on(() => {
      received += 1;
      if (received === 1) {
        void service.close().then(() => {
          off();
          resolveStop();
        });
      } else {
        off();
        resolveStop();
      }
    });
  });
  return 0;
}

export type { RunningService, ServeDeps, ServeIo, SignalSource };
