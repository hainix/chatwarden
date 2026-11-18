// The one table of flags and the parser over it. `chatwarden --help` is generated from OPTIONS, so a flag, its values and its help text
// have exactly one home; a test fails when the parser and the table disagree.
import { parseArgs } from 'node:util';
import type { ChatChoice, ChatTransportChoice, Framework, HubChoice, Lang, OnConflict, ProfileChoice, Store } from './types.js';

export interface OptionSpec {
  /** The long flag, without the dashes: `chat-transport` for `--chat-transport`. */
  name: string;
  /** The field of `Parsed` it fills. */
  key: string;
  /** One letter, for `-y`. */
  short?: string;
  type: 'string' | 'boolean';
  /** The values a string flag accepts (exact, case-sensitive). */
  values?: readonly string[];
  /** The value used when the flag is absent and nothing is detected. */
  default?: string;
  /** For a flag whose default comes from the project: a few words for the help ("detected, else express"). */
  defaultNote?: string;
  /** `--no-<name>` is the opposite (only `discord`). */
  negatable?: boolean;
  /** One line, under about 55 characters; names no other flag. */
  help: string;
  /** The question the interactive run asks for this flag, if it has one (design 5.1). */
  question?: string;
}

export const OPTIONS: readonly OptionSpec[] = [
  { name: 'framework', key: 'framework', type: 'string', values: ['express', 'fastify', 'next', 'fetch', 'none'], defaultNote: 'detected, else express', help: 'Server framework to wire up', question: 'Which server framework?' },
  { name: 'store', key: 'store', type: 'string', values: ['sqlite', 'memory'], default: 'sqlite', help: 'Where moderation data is kept', question: 'Where should it keep moderation data?' },
  { name: 'chat', key: 'chat', type: 'string', values: ['none', 'box'], default: 'none', help: 'Add the kit chat box, or keep your own chat', question: 'Do you already have chat?' },
  { name: 'chat-transport', key: 'chatTransport', type: 'string', values: ['sse', 'socketio'], defaultNote: 'socketio if installed', help: 'How the chat box reaches the server', question: 'Reach the chat box over?' },
  { name: 'hub', key: 'hub', type: 'string', values: ['element', 'react', 'none'], defaultNote: 'react for next', help: 'How moderators open the hub', question: 'How will moderators open the hub?' },
  { name: 'discord', key: 'discord', type: 'boolean', negatable: true, default: 'no', help: 'Post reports to a Discord forum', question: 'Post reports to a Discord forum?' },
  { name: 'profile', key: 'profile', type: 'string', values: ['relaxed', 'standard', 'strict'], default: 'standard', help: 'How strict the standard is', question: 'Which standard?' },
  { name: 'base', key: 'base', type: 'string', default: '/chatwarden', help: 'URL prefix everything lives under' },
  { name: 'dir', key: 'dir', type: 'string', defaultNote: 'detected', help: 'Folder to write into, inside the project' },
  { name: 'lang', key: 'lang', type: 'string', values: ['ts', 'js'], defaultNote: 'from tsconfig.json', help: 'Language of the generated files' },
  { name: 'on-conflict', key: 'onConflict', type: 'string', values: ['skip', 'overwrite', 'new'], default: 'skip', help: 'What to do with a file that exists and differs' },
  { name: 'force', key: 'force', type: 'boolean', help: 'Overwrite every file that exists and differs' },
  { name: 'service', key: 'service', type: 'boolean', help: 'Write a Docker recipe for the service API (no project needed)' },
  { name: 'install', key: 'install', type: 'boolean', help: 'Run the package manager for you' },
  { name: 'dry-run', key: 'dryRun', type: 'boolean', help: 'Print the plan and write nothing' },
  { name: 'json', key: 'json', type: 'boolean', help: 'Print one JSON document; ask nothing' },
  { name: 'yes', key: 'yes', short: 'y', type: 'boolean', help: 'Accept detected answers and defaults; ask nothing' },
  { name: 'check', key: 'check', type: 'boolean', help: 'Report what is still starter code; change nothing' },
  { name: 'help', key: 'help', short: 'h', type: 'boolean', help: 'Show this help' },
  { name: 'version', key: 'version', short: 'v', type: 'boolean', help: 'Show the version' },
];

/** What a command line asks for. An answer flag that was not given is absent, so detection and the questions can fill it. */
export interface Parsed {
  command: 'init' | 'help' | 'version' | 'serve' | 'serveHelp';
  /** The flags of `chatwarden serve` (present for that command only). */
  serve?: ServeFlags;
  /** `init --service`: write the service recipe folder instead of the wiring. */
  service?: boolean;
  framework?: Framework;
  store?: Store;
  chat?: ChatChoice;
  chatTransport?: ChatTransportChoice;
  hub?: HubChoice;
  /** `--discord` true, `--no-discord` false, neither absent. */
  discord?: boolean;
  profile?: ProfileChoice;
  base?: string;
  dir?: string;
  lang?: Lang;
  /** `--force` is `overwrite`. Default `skip`. */
  onConflict: OnConflict;
  install: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  check: boolean;
}

type Failure = { error: string };

/** One flag of `chatwarden serve`. Every flag has an environment twin (`env`); the secrets have none and are environment only. */
export interface ServeOptionSpec {
  name: string;
  key: keyof ServeFlags;
  type: 'string' | 'boolean';
  values?: readonly string[];
  /** The environment variable that sets the same thing (a flag beats it). */
  env?: string;
  default?: string;
  help: string;
}

export const SERVE_OPTIONS: readonly ServeOptionSpec[] = [
  { name: 'port', key: 'port', type: 'string', env: 'CHATWARDEN_PORT', default: '8787', help: 'Port to listen on (0 picks a free one)' },
  { name: 'host', key: 'host', type: 'string', env: 'CHATWARDEN_HOST', default: '127.0.0.1', help: 'Address to listen on' },
  { name: 'db', key: 'db', type: 'string', env: 'CHATWARDEN_DB', default: './chatwarden.db', help: 'Database file (:memory: keeps nothing)' },
  { name: 'profile-file', key: 'profileFile', type: 'string', env: 'CHATWARDEN_PROFILE_FILE', help: 'The moderation profile, a JSON file' },
  { name: 'terms-file', key: 'termsFile', type: 'string', env: 'CHATWARDEN_TERMS_FILE', help: 'Your term pack, a JSON file (else the test words)' },
  { name: 'hub', key: 'hub', type: 'string', values: ['element', 'none'], env: 'CHATWARDEN_HUB', default: 'element', help: 'Serve the moderator hub page' },
  { name: 'shared-pacing', key: 'sharedPacing', type: 'boolean', env: 'CHATWARDEN_SHARED_PACING', help: 'Keep the pacer state in the database' },
  { name: 'insecure-staff-cookie', key: 'insecureStaffCookie', type: 'boolean', env: 'CHATWARDEN_INSECURE_STAFF_COOKIE', help: 'Staff cookie without Secure (local http only)' },
  { name: 'print-openapi', key: 'printOpenapi', type: 'boolean', help: 'Print the API description as JSON and exit' },
];

/** What a `chatwarden serve` command line asks for. A flag that was not given is absent, so the environment can fill it. */
export interface ServeFlags {
  port?: string;
  host?: string;
  db?: string;
  profileFile?: string;
  termsFile?: string;
  hub?: 'element' | 'none';
  sharedPacing?: boolean;
  insecureStaffCookie?: boolean;
  printOpenapi: boolean;
}

/** A user-supplied value made safe to put in a one-line message: printable ASCII, short. */
export function show(value: string): string {
  const clean = value.replace(/[^\x20-\x7e]/g, '?');
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

function failure(message: string): Failure {
  return { error: message };
}

function parsed(command: Parsed['command']): Parsed {
  return { command, onConflict: 'skip', install: false, dryRun: false, json: false, yes: false, check: false };
}

function firstQuoted(message: string): string | undefined {
  return /'([^']*)'/.exec(message)?.[1];
}

/**
 * Parse the arguments after the program name (`['init', '--framework', 'express']`). Never throws: a mistake is `{ error }`, one sentence that
 * names the flag. `--help` and `--version` win over every other mistake on the line.
 */
export function parseCli(argv: readonly string[]): Parsed | Failure {
  const args = [...argv];
  const beforeTerminator = args.indexOf('--') === -1 ? args : args.slice(0, args.indexOf('--'));
  if ((beforeTerminator.includes('--help') || beforeTerminator.includes('-h')) && args[0] !== 'serve') return parsed('help');
  if (beforeTerminator.includes('--version') || beforeTerminator.includes('-v')) return parsed('version');
  const first = args[0];
  if (first === undefined) return parsed('help');
  if (first === 'serve') return parseServe(args.slice(1), beforeTerminator.includes('--help') || beforeTerminator.includes('-h'));
  if (first !== 'init') {
    return failure(
      first.startsWith('-')
        ? 'The command comes first: run chatwarden init or chatwarden serve (see chatwarden --help).'
        : `Unknown command ${show(first)}: the commands are init and serve (see chatwarden --help).`,
    );
  }

  const spec: Record<string, { type: 'string' | 'boolean'; short?: string }> = {};
  for (const option of OPTIONS) spec[option.name] = option.short ? { type: option.type, short: option.short } : { type: option.type };

  let result;
  try {
    result = parseArgs({ args: args.slice(1), options: spec, strict: true, allowPositionals: false, allowNegative: true, tokens: true });
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    const message = cause instanceof Error ? cause.message : '';
    const quoted = firstQuoted(message) ?? '';
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return failure(`Unknown option ${show(quoted)} (see chatwarden --help).`);
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const flag = /^(--?[A-Za-z0-9-]+)/.exec(quoted)?.[1] ?? show(quoted);
      return failure(message.includes('does not take') ? `${flag} takes no value.` : `${flag} needs a value.`);
    }
    if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return failure(`Unexpected argument ${show(quoted)}: init takes only flags (see chatwarden --help).`);
    return failure('Could not read the arguments (see chatwarden --help).');
  }

  const seen = new Map<string, number>();
  for (const token of result.tokens ?? []) {
    if (token.kind === 'option') seen.set(token.name, (seen.get(token.name) ?? 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) return failure(`--${name} was given more than once.`);
  }

  const values = result.values as Record<string, string | boolean | undefined>;
  for (const option of OPTIONS) {
    const value = values[option.name];
    if (typeof value === 'string' && option.values && !option.values.includes(value)) {
      return failure(`--${option.name} must be one of ${option.values.join(', ')} (got ${show(value)}).`);
    }
  }

  // Both short and long forms of these were handled up front; this catches a grouped short flag such as -yh.
  if (values.help === true) return parsed('help');
  if (values.version === true) return parsed('version');

  const out: Record<string, unknown> = { ...parsed('init') };
  for (const option of OPTIONS) {
    const value = values[option.name];
    if (value === undefined || option.name === 'force' || option.name === 'help' || option.name === 'version') continue;
    out[option.key] = value;
  }
  if (values.force === true) {
    const given = values['on-conflict'];
    if (given !== undefined && given !== 'overwrite') return failure(`--force means --on-conflict overwrite, but --on-conflict ${show(String(given))} was given.`);
    out.onConflict = 'overwrite';
  }
  return out as unknown as Parsed;
}

const COLUMN = 32;

/** The `--help` text, generated from OPTIONS. */
export function helpText(): string {
  const lines = [
    'chatwarden init [options]       write the wiring for a Chatwarden-moderated server',
    'chatwarden serve [options]      run the service API as a process (chatwarden serve --help)',
    'chatwarden --help | -h          show this help',
    'chatwarden --version | -v       show the version',
    '',
    'Run it from the project root (the folder with package.json). It never edits an existing file.',
    '',
    'Options:',
  ];
  for (const option of OPTIONS) {
    const flag = `${option.short ? `-${option.short}, ` : '    '}--${option.name}${option.type === 'string' ? ' <value>' : ''}`;
    const fallback = option.default ?? option.defaultNote;
    const suffix = fallback === undefined ? '' : ` (default: ${fallback})`;
    lines.push(`  ${flag.padEnd(COLUMN)}${option.help}${suffix}`);
    if (option.values) lines.push(`  ${' '.repeat(COLUMN)}one of: ${option.values.join(', ')}`);
    if (option.negatable) lines.push(`  ${' '.repeat(COLUMN)}also: no-${option.name} to switch it off`);
  }
  lines.push(
    '',
    'Exit codes:',
    '  0  done, or nothing to do, or nothing wrong (dry run, check)',
    '  1  a usage error: a bad flag, value or combination, or an unsafe path; or --check found something left',
    '  2  applied, but some files were skipped because they differ',
    '  3  could not write or install',
    '',
  );
  return lines.join('\n');
}

/** The command line after `serve`. Never throws; a mistake is `{ error }`. `--help` wins over every other mistake. */
function parseServe(rest: readonly string[], wantsHelp: boolean): Parsed | Failure {
  if (wantsHelp) return parsed('serveHelp');
  const spec: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const option of SERVE_OPTIONS) spec[option.name] = { type: option.type };
  let result;
  try {
    result = parseArgs({ args: [...rest], options: spec, strict: true, allowPositionals: false, tokens: true });
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    const message = cause instanceof Error ? cause.message : '';
    const quoted = firstQuoted(message) ?? '';
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return failure(`Unknown option ${show(quoted)} (see chatwarden serve --help).`);
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const flag = /^(--?[A-Za-z0-9-]+)/.exec(quoted)?.[1] ?? show(quoted);
      return failure(message.includes('does not take') ? `${flag} takes no value.` : `${flag} needs a value.`);
    }
    if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return failure(`Unexpected argument ${show(quoted)}: serve takes only flags (see chatwarden serve --help).`);
    return failure('Could not read the arguments (see chatwarden serve --help).');
  }
  const seen = new Map<string, number>();
  for (const token of result.tokens ?? []) if (token.kind === 'option') seen.set(token.name, (seen.get(token.name) ?? 0) + 1);
  for (const [name, count] of seen) if (count > 1) return failure(`--${name} was given more than once.`);
  const values = result.values as Record<string, string | boolean | undefined>;
  const flags: Record<string, unknown> = { printOpenapi: false };
  for (const option of SERVE_OPTIONS) {
    const value = values[option.name];
    if (value === undefined) continue;
    if (typeof value === 'string' && option.values && !option.values.includes(value)) return failure(`--${option.name} must be one of ${option.values.join(', ')} (got ${show(value)}).`);
    flags[option.key] = value;
  }
  return { ...parsed('serve'), serve: flags as unknown as ServeFlags };
}

/** The help of `chatwarden serve`, generated from SERVE_OPTIONS. */
export function serveHelpText(): string {
  const lines = ['chatwarden serve [options]   run the service API, the staff API and the hub in one process', '', 'Options (each has an environment twin; a flag beats the variable):'];
  for (const option of SERVE_OPTIONS) {
    const flag = `--${option.name}${option.type === 'string' ? ' <value>' : ''}`;
    const twin = option.env === undefined ? '' : ` [${option.env}]`;
    const fallback = option.default === undefined ? '' : ` (default: ${option.default})`;
    lines.push(`  ${flag.padEnd(24)}${option.help}${fallback}${twin}`);
    if (option.values) lines.push(`  ${' '.repeat(24)}one of: ${option.values.join(', ')}`);
  }
  lines.push(
    '',
    'Environment only (a secret is never a flag):',
    '  CHATWARDEN_SECRET        The hashing secret, 32 or more characters. Required: there is no default.',
    '  CHATWARDEN_SERVICE_KEYS  One to five service keys of 32 to 256 characters, comma separated. Required.',
    '  CHATWARDEN_ADMIN_TOKEN   The staff sign-in token, 24 or more characters. Without it staff routes are 401.',
    '  CHATWARDEN_AUTH_MODULE   A path to a module whose default export is { authorize(req) }; beats the token',
    '  CHATWARDEN_PROCESSES     How many service processes you run (default 1); above 1 the handshake warns.',
    '',
    'Exit codes:',
    '  0  stopped by a signal, or after printing the API description',
    '  1  a usage error: a bad flag or value',
    '  2  it would not start: a missing secret or key, an unreadable file, a port in use',
    '',
  );
  return lines.join('\n');
}
