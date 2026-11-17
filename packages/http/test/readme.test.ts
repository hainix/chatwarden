import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { adminRoutes, healthRoutes, playerRoutes, BACKOFF_BASE_MS, DELIVERY_HEADER, MAX_RETRIES, PERMISSIONS, PERMISSION_KEYS, RETRY_AFTER_CAP_MS, RETRY_AFTER_FLOOR_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/index.js';
import { OPTIONS, helpText, parseCli } from '../src/cli/args.js';
import type { OptionSpec } from '../src/cli/args.js';
import { buildPlan } from '../src/cli/plan.js';
import { renderJson } from '../src/cli/report.js';
import { toFetch } from '../src/fetch.js';
import { PROJECT, VERSIONS, answersOf, stubTemplates } from './cli-stubs.js';

// The READMEs are part of the product: an adopter (or a coding agent) copies from them. These checks keep them true to the
// code: every permission, every error code and every header the code defines must be written down, and every ```ts block
// must compile against the real types.

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, rel), 'utf8').replace(/\r\n/g, '\n');
const http = read('../README.md');
const discord = read('../../discord/README.md');
const root = read('../../../README.md');

/** The text of a `## Heading` section, up to the next `## ` heading. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, next === -1 ? undefined : next);
}

/** The cells of a markdown table row, trimmed and with the outer pipes dropped. */
const cells = (row: string): string[] => row.split('|').slice(1, -1).map((c) => c.trim());
const rows = (text: string): string[][] => text.split('\n').filter((l) => l.startsWith('|') && !/^\|[ |-]+\|$/.test(l)).map(cells);

/** The error codes and statuses the code defines, read from the table in errors.ts. */
const errorTable = [...read('../src/errors.ts').matchAll(/^ {2}(\w+): \{ status: (\d+),/gm)].map((m) => [m[1] as string, Number(m[2])] as const);

/** Whitespace collapsed to single spaces, so a sentence that wraps still matches. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const MARKETING = /\b(blazing|seamless|powerful|robust|world-class|cutting-edge|revolutionary)\b/i;

describe('packages/http/README.md', () => {
  it('says GET /sanctions is an audited read (history.view, no target), not that it writes no row', () => {
    const line = (start: string): string => http.split('\n').find((l) => l.startsWith(start)) ?? '';
    const row = line('| `GET /sanctions');
    expect(row).not.toMatch(/writes no audit row/);
    expect(row).toMatch(/audits `history.view` with no target, once per successful read/);
    expect(row).toMatch(/cannot be written, the read fails/);
    expect(line('| `history.read`')).toMatch(/GET \/sanctions/);
  });

  it('has the sections an adopter needs, setup first', () => {
    for (const heading of ['## Install', '## Set up', '## Auth', '## Permissions', '## Errors', '## Webhooks', '## Health probes', '## Security notes']) {
      expect(http, heading).toContain(heading);
    }
    expect(http.indexOf('## Set up')).toBeLessThan(http.indexOf('## Permissions'));
    expect(http.indexOf('## Set up')).toBeLessThan(http.indexOf('## Security notes'));
  });

  it('shows the browser-safe subpath with an import snippet, and says its matcher is matchRoute', () => {
    const setup = section(http, 'Set up');
    const at = setup.indexOf('### In a browser');
    expect(at, 'an "In a browser" subsection').toBeGreaterThanOrEqual(0);
    const part = setup.slice(at);
    expect(part).toContain("import { adminRoutes, createRouter } from '@chatwarden/http/admin';");
    expect(part).toContain('matchRoute');
    expect(part).toContain('no-store');
    expect(part).toContain('GET /me');
  });

  it('the setup shows the builders and the Express adapter', () => {
    const setup = section(http, 'Set up');
    for (const name of ['adminRoutes', 'playerRoutes', 'healthRoutes', 'toExpress', 'webhooksOut', 'webhookIn', 'createRouter']) {
      expect(setup, name).toContain(name);
    }
    expect(setup).toContain("from '@chatwarden/http/express'");
  });

  it('in the setup snippet nothing is mounted after the probes, which carry a comment saying why', () => {
    const snippet = /```ts\n([\s\S]*?)```/.exec(section(http, 'Set up'))?.[1] ?? '';
    const lines = snippet.split('\n');
    const at = lines.findIndex((l) => l.includes('toExpress(healthRoutes('));
    expect(at, 'the probes are mounted in the snippet').toBeGreaterThan(-1);
    // Every other mount and parser comes before the root-mounted probes.
    expect(lines.slice(at + 1).filter((l) => /^\s*app\.(use|get|post|put|delete|patch)\(/.test(l))).toEqual([]);
    const before = lines.slice(Math.max(0, at - 3), at).join('\n');
    expect(before).toMatch(/last/i);
    expect(before).toMatch(/fallthrough/);
  });

  it('explains authorize and identify: returning null, the actor shape, and that remoteAddress is the socket peer', () => {
    const auth = section(http, 'Auth');
    expect(auth).toContain('### `authorize` (staff)');
    expect(auth).toContain('### `identify` (players)');
    expect(auth).toMatch(/Return `null` for nobody: the answer is 401 `unauthorized`/);
    expect(auth).toMatch(/1 to 128 characters of `A-Z a-z 0-9 _ \. : @ \+ -`/);
    expect(auth).toMatch(/`req\.remoteAddress` is the socket peer/);
    expect(auth).toMatch(/Behind a reverse proxy or load balancer it is the proxy's address/);
    expect(auth).toMatch(/Whether to trust `X-Forwarded-For`[^.]*is your call/);
  });

  it('says to mount toExpress before any body parser, and documents fallthrough', () => {
    const setup = section(http, 'Set up');
    const mounting = setup.slice(setup.indexOf('### Mounting'));
    expect(mounting).toMatch(/Mount `toExpress` before any body parser/i);
    expect(mounting).toContain('express.json()');
    expect(mounting).toContain('fallthrough');
    expect(mounting).toContain('fallthrough: false');
    expect(mounting).toMatch(/calls `next\(\)`/);
  });

  it('lists every permission with its default role in the Default role column, and says there are no floors', () => {
    expect(PERMISSION_KEYS.length).toBeGreaterThan(5);
    const permissions = section(http, 'Permissions');
    const table = rows(permissions);
    expect(table.map((r) => r[0])).toEqual(['Permission', ...PERMISSION_KEYS.map((k) => `\`${k}\``)]);
    for (const key of PERMISSION_KEYS) {
      const row = table.find((r) => r[0] === `\`${key}\``);
      expect(row?.[1], key).toBe(PERMISSIONS[key]);
    }
    expect(permissions).toMatch(/There are no floors: the kit does not stop you from letting a `moderator` ban permanently/);
    expect(permissions).toMatch(/That is\s+your decision/);
  });

  it('the error table has exactly the code table of errors.ts, with the same statuses, plus internal', () => {
    expect(errorTable.length).toBeGreaterThan(15);
    expect(errorTable).toContainEqual(['in_progress', 409]);
    const table = rows(section(http, 'Errors')).slice(1); // without the header row
    const documented = table.map((r) => [r[0]?.replaceAll('`', ''), Number(r[1])]);
    expect(documented).toEqual([...errorTable, ['internal', 500]]);
    for (const r of table) expect(r[2]?.length, r[0]).toBeGreaterThan(5);
  });

  it('documents the webhook headers, the signing recipe, verify, delivery ids, retries and the staff-only warning', () => {
    const hooks = section(http, 'Webhooks');
    for (const header of [TIMESTAMP_HEADER, SIGNATURE_HEADER, DELIVERY_HEADER]) {
      expect(rows(hooks).some((r) => r[0] === `\`${header}\``), header).toBe(true);
    }
    expect(hooks).toContain('HMAC-SHA256');
    expect(hooks).toContain('`${timestamp}.${body}`');
    expect(hooks).toContain('v1=');
    expect(hooks).toContain('ReplayCache');
    expect(hooks).toMatch(/Deduplicate on the delivery id/);
    expect(hooks).toMatch(new RegExp(`retried ${MAX_RETRIES} times \\(${MAX_RETRIES + 1} attempts in all\\)`));
    const waits = Array.from({ length: MAX_RETRIES }, (_, i) => (BACKOFF_BASE_MS * 2 ** i) / 1000);
    expect(hooks).toContain(`${waits.slice(0, -1).join(', ')} and ${waits.at(-1)} seconds`);
    expect(hooks).toMatch(/Events carry subject ids/);
    expect(hooks).toMatch(/send events to staff endpoints only/);
    expect(hooks).toContain('includeExcerpts');
  });

  it('the receiver snippet deduplicates on the delivery header', () => {
    const hooks = section(http, 'Webhooks');
    const receiver = /```ts\n(import express[\s\S]*?)```/.exec(hooks)?.[1] ?? '';
    expect(receiver).toContain('verify(');
    expect(receiver).toContain(DELIVERY_HEADER);
    expect(receiver).toMatch(/handled\.has\(/);
    expect(receiver).toMatch(/handled\.add\(/);
  });

  it('documents idempotency keys and 409s, and edge rate limiting for the incoming webhook', () => {
    const hooks = section(http, 'Webhooks');
    expect(hooks).toContain('idempotencyKey');
    expect(hooks).toContain('409 `idempotency_mismatch`');
    expect(hooks).toContain('409 `in_progress`');
    expect(hooks).toMatch(/Rate-limit this route at the edge/);
    expect(hooks).toMatch(/express-rate-limit/);
  });

  it('documents the health probes and their statuses', () => {
    const health = section(http, 'Health probes');
    expect(health).toContain('`GET /healthz`: 200');
    expect(health).toContain('`GET /readyz`: 200');
    expect(health).toContain('503');
  });

  it('the route table gives the request body of every route that takes one', () => {
    const routes = http.slice(http.indexOf('### The routes'), http.indexOf('### Mounting'));
    const find = (needle: string): string => rows(routes).find((r) => r[0]?.includes(needle))?.[1] ?? '';
    expect(find('POST /sanctions`')).toMatch(/\{ subject, kind, durationMs, rule, reason\?, gapNote\?, includeIp\? \}/);
    expect(find('/revoke')).toMatch(/\{ reason \}/);
    expect(find('/revoke')).toMatch(/non-empty/);
    expect(find('/decide')).toMatch(/\{ verdict, actions, reason\?, evidence\?(, rename\?)? \}/);
    expect(find('/suggest')).toMatch(/\{ level, rule\?, person\? \}/);
    expect(find('/gaps/:groupId/close')).toMatch(/\{ status, ref \}/);
    expect(find('POST /terms`')).toMatch(/\{ term, language, note\? \}/);
    expect(find('POST /exceptions`')).toMatch(/\{ phrase, language, note\? \}/);
  });

  it('says how a CommonJS app consumes it, and that CORS middleware mounts before toExpress', () => {
    const install = section(http, 'Install');
    expect(install).toContain('### CommonJS');
    expect(install).toMatch(/Node 22\.13 or newer/);
    expect(install).toMatch(/no top-level `await`/);
    expect(install).toContain('moduleResolution: node');
    expect(install).toContain('typesVersions');
    const mounting = section(http, 'Set up').slice(section(http, 'Set up').indexOf('### Mounting'));
    expect(mounting).toMatch(/\*\*CORS\.\*\*/);
    expect(mounting).toMatch(/mount your CORS middleware\s+BEFORE `toExpress`/);
    expect(mounting).toContain('OPTIONS');
  });

  it('the queue row lists the summary fields and the evidence stays on the single-report row', () => {
    const routes = http.slice(http.indexOf('### The routes'), http.indexOf('### Mounting'));
    const list = rows(routes).find((r) => r[0]?.startsWith('`GET /reports?'))?.[1] ?? '';
    for (const field of ['id', 'createdAt', 'roomId', 'tags', 'category', 'status', 'badFaith', 'targetPerson', 'reporterPerson', 'actionedAt', 'actionedBy']) {
      expect(list, field).toContain(`\`${field}\``);
    }
    expect(list).not.toContain('`excerpt`');
    expect(list).toMatch(/No chat text/);
    const one = rows(routes).find((r) => r[0]?.startsWith('`GET /reports/:id'))?.[1] ?? '';
    expect(one).toMatch(/excerpt/);
    expect(one).toMatch(/audited with the report id/);
  });

  it('uses no marketing words', () => {
    expect(http).not.toMatch(MARKETING);
    expect(discord).not.toMatch(MARKETING);
    expect(root).not.toMatch(MARKETING);
  });
});

describe('packages/discord/README.md', () => {
  it('has copy-paste setup first, then options and notes', () => {
    for (const heading of ['## Install', '## Set up', '## Options', '## Known limits']) expect(discord, heading).toContain(heading);
    expect(discord.indexOf('## Set up')).toBeLessThan(discord.indexOf('## Options'));
  });

  it('explains the forum-channel webhook setup', () => {
    const setup = section(discord, 'Set up');
    expect(setup).toMatch(/\*\*forum channel\*\*/);
    expect(setup).toMatch(/\*\*Integrations\*\*/);
    expect(setup).toContain('discord.com/api/webhooks/');
    expect(setup).toMatch(/The URL is a credential/);
  });

  it('documents hubLink, mentionRoleId and severeOnly as rows of the options table', () => {
    const table = rows(section(discord, 'Options'));
    for (const option of ['webhookUrl', 'hubLink', 'mentionRoleId', 'severeOnly']) {
      expect(table.some((r) => r[0] === `\`${option}\``), option).toBe(true);
    }
    expect(discord).toContain('feed.dispose()');
  });

  it('states the duplicate-thread limit and that kit_discord_threads is not purged', () => {
    const limits = section(discord, 'Known limits');
    expect(limits).toMatch(/A duplicate thread is possible/);
    expect(limits).toMatch(/the person ends up with two threads/);
    expect(limits).toMatch(/`kit_discord_threads` is not purged/);
    expect(limits).toMatch(/not removed by `purge\(\)`/);
  });

  it('says what the posts hold and do not hold', () => {
    const notes = section(discord, 'Security notes');
    expect(notes).toMatch(/No chat text, ever/);
    expect(notes).toMatch(/Subject ids appear only inside the hub links/);
  });
});

describe('the root README', () => {
  it('lists @chatwarden/http and @chatwarden/discord in the package table', () => {
    expect(rows(root).some((r) => r[0] === '[`@chatwarden/http`](packages/http)')).toBe(true);
    expect(rows(root).some((r) => r[0] === '[`@chatwarden/discord`](packages/discord)')).toBe(true);
  });

  it('has a quick start for the HTTP routes and the Discord feed, with the probes last', () => {
    const quick = section(root, 'Quick start');
    for (const name of ['adminRoutes', 'playerRoutes', 'toExpress', 'discordFeed']) expect(quick, name).toContain(name);
    expect(quick).toContain('packages/http/README.md');
    expect(quick).toContain('packages/discord/README.md');
    const lines = quick.split('\n');
    const at = lines.findIndex((l) => l.includes('toExpress(healthRoutes('));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1).filter((l) => /^\s*app\.use\(/.test(l))).toEqual([]);
  });

  it('keeps the preset section and the development notes', () => {
    expect(root).toContain('## Pick a preset');
    expect(root).toContain('## Development');
  });
});

describe('packages/http/README.md: gap notes, matchRoute and the retry-after floor', () => {
  it('warns that GET /gaps returns the moderators gap notes in bulk, so no chat goes into a note', () => {
    const routes = http.slice(http.indexOf('### The routes'), http.indexOf('### Mounting'));
    const gaps = rows(routes).find((r) => r[0] === '`GET /gaps`')?.[1] ?? '';
    expect(gaps).toMatch(/moderator-written gap notes/);
    expect(gaps).toMatch(/in bulk/);
    expect(gaps).toMatch(/never paste chat/i);
    const notes = section(http, 'Security notes');
    expect(notes).toMatch(/gap note/i);
    expect(notes).toMatch(/never paste chat/i);
    expect(notes).toMatch(/GET \/gaps/);
  });

  it('documents matchRoute for adapter authors: run, matches, falling through, and createRouter', () => {
    const adapters = section(http, 'Writing another adapter');
    for (const needle of ['matchRoute', 'CompiledRoutes', 'run(req)', 'matches(path', 'next()', 'RangeError', 'createRouter']) {
      expect(adapters, needle).toContain(needle);
    }
    expect(adapters).toMatch(/before you read the\s+body/);
    expect(adapters).toMatch(/handler that answers 404 is a match/);
    expect(adapters).toMatch(/OPTIONS/);
    expect(adapters).toMatch(/HEAD/);
  });

  it('documents RETRY_AFTER_FLOOR_MS with its value, beside the cap', () => {
    const hooks = section(http, 'Webhooks');
    expect(hooks).toContain('`RETRY_AFTER_FLOOR_MS`');
    expect(hooks).toContain('`RETRY_AFTER_CAP_MS`');
    expect(hooks).toContain(`${RETRY_AFTER_FLOOR_MS / 1000} second`);
    expect(hooks).toContain(`${RETRY_AFTER_CAP_MS / 1000} seconds`);
  });
});

describe('packages/http/README.md, Chat', () => {
  const chat = section(http, 'Chat').replace(/\s+/g, ' ');

  it('shows the whole setup: the broadcaster, the routes, identify, join and noticePending', () => {
    expect(chat).toContain('createRoomBroadcaster(cw)');
    expect(chat).toContain('chatRoutes(cw, chat,');
    expect(chat).toContain('identify');
    expect(chat).toContain('join');
    expect(chat).toContain('chat.noticePending(subject)');
    expect(chat).toContain('chat.close()');
  });

  it('lists the four routes with their answers, and the JSON-only and silent-mute rules', () => {
    for (const route of ['GET /rooms/:room/stream', 'POST /rooms/:room/lines', 'POST /rooms/:room/mute', 'POST /rooms/:room/report']) expect(chat, route).toContain(`\`${route}\``);
    expect(chat).toContain('{ ok, hiddenIds }');
    expect(chat).toMatch(/must be `application\/json`/);
    expect(chat).toMatch(/A mute is silent/);
    expect(chat).toMatch(/A refused line is never echoed to anyone but its author/);
    expect(chat).toMatch(/with no seat, subject, key, hash or address/);
  });

  it('says what to do behind a proxy: no compression over the stream, buffering off, idle timeout above the heartbeat', () => {
    expect(chat).toMatch(/Do not put `compression` middleware over `text\/event-stream`/);
    expect(chat).toContain('x-accel-buffering: no');
    expect(chat).toMatch(/idle timeout must be longer than the heartbeat/);
  });

  it('advises one process per room (sticky rooms) and says no cross-process bus is shipped', () => {
    expect(chat).toMatch(/sticky rooms: route all of a room's connections to one process/);
    expect(chat).toMatch(/A pub\/sub hook between processes is not shipped/);
  });

  it('warns that name is a display name, not an identifier', () => {
    expect(chat).toMatch(/`name` is a display name, not an identifier/);
    expect(chat).toMatch(/returns an account id as the name has leaked it itself/);
  });

  it('states the byModerator caveat and the newer-core requirement', () => {
    expect(chat).toMatch(/a stored automatic chat timeout reads as a moderator's/);
    expect(chat).toContain('cw.chat.restrictedBySubject');
    expect(chat).toMatch(/from the same release/);
  });

  it('shows the Socket.IO sketch with the sink, and names ChatSink, ping and end', () => {
    expect(chat).toContain('io.on(\'connection\'');
    expect(chat).toContain('session.open({ write:');
    expect(chat).toMatch(/`ChatSink` \(`write`, and optionally `ping` and `end`\)/);
  });
});

// The init command and the fetch adapter, as the README says them (0.1.10). Names, flags, codes and snippets are read from the code, never retyped.
describe('packages/http/README.md, the init command', () => {
  const init = section(http, 'The init command');
  const flagLabel = (o: OptionSpec): string => (o.negatable ? `\`--${o.name}\`, \`--no-${o.name}\`` : `\`${o.short ? `-${o.short}, ` : ''}--${o.name}${o.type === 'string' ? ' <value>' : ''}\``);
  const expectedTable = (): string =>
    [
      '| Flag | Values | Default | What it does |',
      '| --- | --- | --- | --- |',
      ...OPTIONS.map((o) => `| ${flagLabel(o)} | ${o.values ? o.values.map((v) => `\`${v}\``).join(', ') : '-'} | ${o.default ?? o.defaultNote ?? '-'} | ${o.help} |`),
    ].join('\n');

  it('the flags table in the http README equals OPTIONS (generated)', () => {
    const between = init.slice(init.indexOf('<!-- flags:start -->') + '<!-- flags:start -->'.length, init.indexOf('<!-- flags:end -->')).trim();
    expect(between).toBe(expectedTable());
  });

  it('control: a table with a changed row or a missing flag is not the generated one', () => {
    const table = expectedTable();
    expect(table.replace('`--store <value>`', '`--stores <value>`')).not.toBe(table);
    expect(table.split('\n').slice(0, -1).join('\n')).not.toBe(table);
    expect(table.split('\n')).toHaveLength(OPTIONS.length + 2);
  });

  it('every documented option and flag exists: each --flag in the section is in OPTIONS (or --no-discord)', () => {
    const known = new Set([...OPTIONS.map((o) => `--${o.name}`), '--no-discord']);
    // `--env-file` is a flag of node, not of this command.
    const used = new Set((init.replaceAll('node --env-file=.env', '').match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []));
    expect(used.size).toBeGreaterThan(12);
    for (const flag of used) expect(known.has(flag), flag).toBe(true);
    // And the reverse: every flag is documented (the table does it, and the prose names the main ones).
    for (const o of OPTIONS) expect(init, `--${o.name}`).toContain(`--${o.name}`);
  });

  it('every `chatwarden init ...` command in a shell block parses', () => {
    const commands = [...init.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => (m[1] as string).split('\n')).map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l.includes('chatwarden init'));
    expect(commands.length).toBeGreaterThanOrEqual(1);
    for (const command of commands) {
      const argv = command.slice(command.indexOf('chatwarden init') + 'chatwarden'.length).trim().split(/\s+/).filter(Boolean);
      const parsed = parseCli(argv);
      expect('error' in parsed ? parsed.error : '', command).toBe('');
    }
  });

  it('the exit codes are the ones --help lists, and each is explained', () => {
    const table = rows(init.slice(init.indexOf('### Exit codes'), init.indexOf('### `--json`')));
    const codes = table.filter((r) => /^\d$/.test(r[0] as string)).map((r) => r[0]);
    const help = [...helpText().matchAll(/^ {2}(\d) {2}/gm)].map((m) => m[1]);
    expect(codes).toEqual(help);
    expect(codes).toEqual(['0', '1', '2', '3']);
  });

  it('--json names the keys of the real document, in order', () => {
    const real = Object.keys(JSON.parse(renderJson(buildPlan(answersOf(), VERSIONS, stubTemplates, PROJECT), { dryRun: false, files: [] }, '1.2.3')) as Record<string, unknown>);
    const text = init.slice(init.indexOf('### `--json`'), init.indexOf('### From your own code'));
    let from = 0;
    for (const key of real) {
      const at = text.indexOf(`\`${key}\``, from);
      expect(at, `the key ${key}, in order`).toBeGreaterThanOrEqual(from);
      from = at;
    }
  });

  it('says it never edits a file, never leaves the project, uses the network only with --install and writes no secret, and that .env is not loaded for you', () => {
    const doc = flat(init);
    for (const needle of ['never edits a file that exists', 'never writes outside the project folder', 'uses the network only with `--install`', 'never writes a secret', 'is not loaded for you', 'node --env-file=.env', 'TODO(auth)', 'TODO(identity)', 'TODO(terms)', 'CHATWARDEN_ADMIN_TOKEN', 'CHATWARDEN_SECRET', '--check']) {
      expect(doc, needle).toContain(needle);
    }
  });

  it('lists the @experimental names: runCli and CliEnv', () => {
    expect(flat(init)).toMatch(/`runCli`, `CliEnv`\) are `@experimental` until 0\.2/);
    expect(read('../src/cli/index.ts')).toMatch(/export async function runCli/);
    expect(read('../src/cli/index.ts')).toMatch(/export type \{ CliEnv \}/);
  });
});

describe('packages/http/README.md, Other servers: toFetch', () => {
  const doc = section(http, 'Other servers: `toFetch`');
  const fetchSource = read('../src/fetch.ts');

  it('lists the @experimental names, every one the entry exports', () => {
    const exported = [...fetchSource.matchAll(/^export (?:function|type|interface) (\w+)/gm)].map((m) => m[1] as string);
    expect(new Set(exported)).toEqual(new Set(['toFetch', 'Mounts', 'FetchOptions', 'FetchHandler']));
    for (const name of new Set(exported)) expect(doc, name).toContain(`\`${name}\``);
    expect(flat(doc)).toMatch(/@experimental` until 0\.2/);
  });

  it('documents every field of FetchOptions as a row of its options table', () => {
    const block = /export interface FetchOptions \{([\s\S]*?)\n\}/.exec(fetchSource)?.[1] ?? '';
    const fields = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    expect(fields).toEqual(['prefix', 'maxBody', 'remoteAddress', 'unmatched', 'logger']);
    const table = rows(doc).map((r) => r[0]);
    for (const field of fields) expect(table, field).toContain(`\`${field}\``);
  });

  it('the example compiles (scripts/readme.test.ts) and runs: the probes answer, the staff routes refuse without a login, an unknown path is the kit 404', async () => {
    const block = /```ts\n([\s\S]*?)```/.exec(doc)?.[1] as string;
    expect(block.startsWith("import { adminRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';\nimport { toFetch } from '@chatwarden/http/fetch';")).toBe(true);
    const body = block.split('\n').filter((l) => !l.startsWith('import ')).join('\n');
    const { createChatwarden } = await import('@chatwarden/core');
    const { MemoryStore } = await import('@chatwarden/store-memory');
    const cw = await createChatwarden({ store: new MemoryStore(), secret: 'readme-secret-0123456789', platform: { identify: (ctx) => ctx as never }, retention: false });
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    const make = new AsyncFunction('adminRoutes', 'healthRoutes', 'playerRoutes', 'toFetch', 'cw', 'authorize', `${body}\nreturn handle;`);
    const handle = (await make(adminRoutes, healthRoutes, playerRoutes, toFetch, cw, () => null)) as (request: Request) => Promise<Response>;
    expect((await handle(new Request('http://x.test/chatwarden/healthz'))).status).toBe(200);
    expect((await handle(new Request('http://x.test/chatwarden/admin/me'))).status).toBe(401);
    expect((await handle(new Request('http://x.test/chatwarden/nope'))).status).toBe(404);
    await cw.close();
  });

  it('says what the adapter does with a path no mount owns, a body over the cap and a stream', () => {
    const text = flat(doc);
    for (const needle of ["`unmatched: 'pass'`", "kit's 413", 'streaming `Response`', 'long-lived Node process', 'imports no Node module']) expect(text, needle).toContain(needle);
  });

  it('the intro and "Writing another adapter" name both adapters that ship', () => {
    expect(http).toContain('a **Web fetch adapter** (`toFetch`');
    expect(section(http, 'Writing another adapter')).toContain('`toExpress` and `toFetch` are the adapters that ship');
  });
});

describe('packages/http/README.md, Discord bot', () => {
  const doc = section(http, 'Discord bot');
  /** A README block is TypeScript; strip the types so it can run. */
  const js = (code: string): string => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  /** A `### ` subsection of the Discord bot section, up to the next `###`. */
  const sub = (heading: string): string => {
    const start = doc.indexOf(`\n### ${heading}\n`);
    expect(start, `subsection ${heading}`).toBeGreaterThanOrEqual(0);
    const next = doc.indexOf('\n### ', start + 1);
    return doc.slice(start, next === -1 ? undefined : next);
  };

  it('every documented option name exists, and every option is documented', () => {
    const source = read('../src/discord/options.ts');
    const block = /export interface DiscordBotOptions \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const fields = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    expect(fields.length).toBeGreaterThanOrEqual(14);
    const documented = rows(sub('Discord bot options')).map((r) => r[0] as string);
    const names = documented.flatMap((cell) => [...cell.matchAll(/`(\w+)`/g)].map((m) => m[1] as string));
    for (const field of fields) expect(names, field).toContain(field);
    for (const name of names) expect(fields, name).toContain(name);
  });

  it('the READMEs list the @experimental names, every one the entry exports', () => {
    const entry = read('../src/discord/index.ts');
    const exported = [...entry.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) => (m[1] as string).split(',').map((n) => n.trim()).filter(Boolean));
    expect(new Set(exported)).toEqual(
      new Set(['discordBot', 'DiscordBotOptions', 'DiscordActionRow', 'DiscordBot', 'DiscordButton', 'DiscordCommand', 'DiscordCommandOption', 'registerCommands', 'RegisterCommandsOptions', 'RegisterCommandsResult', 'verifyInteraction']),
    );
    for (const name of exported) expect(doc, name).toContain(`\`${name}\``);
    expect(flat(doc)).toMatch(/@experimental` until 0\.2/);
    // The feed's side.
    const feed = flat(discord);
    for (const needle of ['`components`', '@experimental', 'application-owned', '`chatwarden.discord_components_ignored`', '`bot.components`', 'Buttons']) expect(feed, needle).toContain(needle);
    expect(feed).not.toContain('has no buttons: a webhook can only write');
  });

  it('says the entry is not in the root, and sets up in order: application, bot, the exact curl for the webhook, roles, the route, the endpoint URL, the one-shot command', () => {
    expect(flat(doc)).toContain('not in the package root');
    const order = ['Make the application', 'Make the bot', 'Make the application-owned webhook', 'Copy the role ids', 'Add it to your server', 'Interactions Endpoint URL', 'Register the command, once', 'Try it'].map((needle) => doc.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(doc).toContain('curl -X POST "https://discord.com/api/v10/channels/$FORUM_CHANNEL_ID/webhooks"');
    expect(doc).toContain('Authorization: Bot $DISCORD_BOT_TOKEN');
    expect(doc).toContain('https://discord.com/api/webhooks/<id>/<token>');
    for (const needle of ['`bot` and', '`applications.commands`', 'Manage Webhooks']) expect(flat(doc), needle).toContain(needle);
  });

  it('says what each answer says: every fixed text the bot uses is written down', () => {
    const answers = read('../src/discord/answers.ts');
    const texts = [...(/export const TEXT = \{([\s\S]*?)\} as const;/.exec(answers)?.[1] ?? '').matchAll(/: '([^']+)'/g)].map((m) => m[1] as string);
    expect(texts.length).toBeGreaterThanOrEqual(10);
    // The refusals that name nothing are one row; every other text is quoted.
    const grouped = new Set(['You do not have a moderator role for this bot.', 'You do not have permission to do this.', 'Slow down.', 'This bot is not set up for this server.', 'Actions from Discord are turned off.', 'That is not available here.', 'Cancelled.']);
    for (const text of texts.filter((t) => !grouped.has(t))) expect(flat(doc), text).toContain(text);
    expect(flat(doc)).toContain('Already done');
    expect(flat(doc)).toContain('This report was already decided');
  });

  it('documents the roles map, the permissions each step needs, the deferred answer and the security notes (verify first, rate limit at the edge)', () => {
    const who = flat(sub('Who may do what'));
    for (const needle of ['`history.read`', '`history.view`', '`reports.read`', '`reports.decide`', '`sanctions.apply`', '`sanctions.apply.ban_permanent`', '`report.decide`', '`actorOf`', 'highest one']) expect(who, needle).toContain(needle);
    const slow = flat(sub('Slow work'));
    for (const needle of ['3 seconds', '`respondWithinMs`', 'type 5', 'type 6', '@original', 'no Authorization header', '429', 'never logged and never stored']) expect(slow, needle).toContain(needle);
    const notes = flat(sub('Discord bot: security notes'));
    for (const needle of ['Verify before parse', 'same `401', '`custom_id`', 'Rate-limit the route at your edge', 'bot token', '`chatwarden.discord_components_ignored`']) expect(notes, needle).toContain(needle);
  });

  it('the server block compiles (scripts/readme.test.ts) and runs against fakes: the route answers a signed PING, the feed carries the bot buttons, dispose is clean', async () => {
    const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(blocks).toHaveLength(2);
    const block = blocks[0] as string;
    expect(block.startsWith("import express from 'express';")).toBe(true);
    const body = block.split('\n').filter((l) => !l.startsWith('import ')).join('\n');
    const { createChatwarden } = await import('@chatwarden/core');
    const { MemoryStore } = await import('@chatwarden/store-memory');
    const { discordFeed } = await import('@chatwarden/discord');
    const { toExpress } = await import('../src/express.js');
    const { discordBot } = await import('../src/discord/index.js');
    const { default: express } = await import('express');
    const { fakeDiscordClient, APP_ID, GUILD_ID, ROLE_MOD, ROLE_OWNER, ROLE_SENIOR } = await import('./discord-world.js');
    const { createRouter } = await import('../src/router.js');
    const cw = await createChatwarden({ store: new MemoryStore(), secret: 'readme-secret-0123456789', platform: { identify: (ctx) => ctx as never }, retention: false, logger: { warn: () => undefined } });
    const client = fakeDiscordClient({ now: () => Date.now() });
    const env: Record<string, string> = {
      DISCORD_APP_ID: APP_ID,
      DISCORD_PUBLIC_KEY: client.publicKeyHex,
      DISCORD_GUILD_ID: GUILD_ID,
      DISCORD_ROLE_MODERATOR: ROLE_MOD,
      DISCORD_ROLE_SENIOR: ROLE_SENIOR,
      DISCORD_ROLE_OWNER: ROLE_OWNER,
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/tok_README-fake_123',
    };
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    // The block minus its shutdown lines, which are checked below and run by hand.
    const run = js(body.replace(/\n\/\/ on shutdown\n[\s\S]*$/, '\n'));
    const make = new AsyncFunction('express', 'discordFeed', 'toExpress', 'discordBot', 'cw', 'process', `${run}\nreturn { bot, feed, app };`);
    const out = (await make(express, discordFeed, toExpress, discordBot, cw, { env })) as { bot: ReturnType<typeof discordBot>; feed: { dispose(): void }; app: unknown };
    expect(Object.keys(out.bot.routes)).toEqual(['POST /discord/interactions']);
    expect(out.bot.components({ kind: 'report', reportId: 'ReportIdOneTwoThreeFour' })).toHaveLength(1);
    const res = await createRouter(out.bot.routes)(client.ping());
    expect(res).toMatchObject({ status: 200, body: { type: 1 } });
    expect(block).toMatch(/\/\/ on shutdown\nfeed\.dispose\(\);\nbot\.dispose\(\);/);
    out.feed.dispose();
    out.bot.dispose();
    expect((await createRouter(out.bot.routes)(client.ping())).status).toBe(401);
    await cw.close();
  });

  it('the registerCommands block runs against a fake fetch: it puts bot.commands() to the guild route and prints the count', async () => {
    const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    const block = blocks[1] as string;
    expect(block.startsWith("import { registerCommands } from '@chatwarden/http/discord';")).toBe(true);
    const { registerCommands, discordBot } = await import('../src/discord/index.js');
    const { fakeDiscordClient, APP_ID, GUILD_ID, ROLE_MOD } = await import('./discord-world.js');
    const { createChatwarden } = await import('@chatwarden/core');
    const { MemoryStore } = await import('@chatwarden/store-memory');
    const cw = await createChatwarden({ store: new MemoryStore(), secret: 'readme-secret-0123456789', platform: { identify: (ctx) => ctx as never }, retention: false, logger: { warn: () => undefined } });
    const client = fakeDiscordClient({ now: () => Date.now() });
    const bot = discordBot(cw, { applicationId: APP_ID, publicKey: client.publicKeyHex, guildId: GUILD_ID, roles: { moderator: [ROLE_MOD] }, hubLink: (_k, id) => `https://mod.example.test/${id}` });
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('[{"id":"1"}]', { status: 200 });
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const body = js(block.split('\n').filter((l) => !l.startsWith('import ')).join('\n').replace('commands: bot.commands(),', 'commands: bot.commands(), fetch: fakeFetch,'));
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    const make = new AsyncFunction('registerCommands', 'bot', 'process', 'console', 'fakeFetch', body);
    await make(registerCommands, bot, { env: { DISCORD_APP_ID: APP_ID, DISCORD_GUILD_ID: GUILD_ID, DISCORD_BOT_TOKEN: 'FAKE.readme-bot-token' } }, { log: (line: string) => void lines.push(line) }, fakeFetch);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`);
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual(bot.commands());
    expect(lines).toEqual(['registered 1 command(s)']);
    bot.dispose();
    await cw.close();
  });
});

describe('the Discord bot in the project docs', () => {
  const status = flat(read('../../../docs/status.md'));
  const follow = flat(read('../../../docs/plans/follow-ups.md'));

  it('the root README has the row and the package line; CLAUDE.md names the bot', () => {
    const rootText = flat(root);
    expect(rootText).toContain('`discordBot` from `@chatwarden/http/discord`');
    expect(rootText).toContain('Optional buttons on a report post');
    expect(flat(read('../../../CLAUDE.md'))).toContain('`@chatwarden/http/discord`');
  });

  it('status says what is built and what the owner checks; follow-ups tell the owner exactly what to do (task D10)', () => {
    for (const needle of ['Discord bot (built', '`chatwarden.discord_components_ignored`', 'No store change, no migration', "The owner's live check (K5 D10)"]) expect(status, needle).toContain(needle);
    for (const needle of ['the live Discord check (task D10)', 'throwaway server', 'Interactions Endpoint URL', '`registerCommands`', '1099511627776', 'respondWithinMs', 'bot-token post route']) {
      expect(follow, needle).toContain(needle);
    }
  });
});

describe('packages/http/README.md, Coop', () => {
  const doc = section(http, 'Coop');
  const js = (code: string): string => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const sub = (heading: string): string => {
    const start = doc.indexOf(`\n### ${heading}\n`);
    expect(start, `subsection ${heading}`).toBeGreaterThanOrEqual(0);
    const next = doc.indexOf('\n### ', start + 1);
    return doc.slice(start, next === -1 ? undefined : next);
  };

  it('every documented option exists, and every option is documented', () => {
    const source = read('../src/coop/options.ts');
    const block = /export interface CoopOptions \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const fields = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    expect(fields.length).toBeGreaterThanOrEqual(18);
    const names = rows(sub('Coop options')).flatMap((r) => [...(r[0] as string).matchAll(/`(\w+)`/g)].map((m) => m[1] as string));
    for (const field of fields) expect(names, field).toContain(field);
    for (const name of names) expect(fields, name).toContain(name);
  });

  it('the READMEs list the @experimental names, every one the entry exports', () => {
    const entry = read('../src/coop/index.ts');
    const exported = [
      ...[...entry.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) => (m[1] as string).split(',').map((n) => n.trim()).filter(Boolean)),
      ...[...entry.matchAll(/^export (?:interface|function) (\w+)/gm)].map((m) => m[1] as string),
    ];
    expect(new Set(exported)).toEqual(new Set(['coop', 'CoopAdapter', 'CoopOptions', 'CoopDecision', 'SweepResult', 'CoopChecklist', 'CoopChecklistItemType', 'CoopVerification']));
    for (const name of exported) expect(doc, name).toContain(`\`${name}\``);
    expect(flat(doc)).toMatch(/@experimental` until 0\.2/);
  });

  it('says the entry is not in the root, needs links, and sets up in order: run Coop, create by hand, copy ids, wire it, verify, file a test report', () => {
    expect(flat(doc)).toContain('not in the package root');
    expect(flat(doc)).toContain('`cw.links`');
    const order = ['Run Coop', 'Create things in Coop by hand', 'Copy the ids into the options', 'Add it to your server', 'Check it', 'File a test report'].map((needle) => doc.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const needle of ['user strikes off', '/coop/actions', 'Webhook Signature Verification Key']) expect(flat(doc), needle).toContain(needle);
  });

  it('documents the three item types with every field the builders send, and the action list with every shape the options accept', async () => {
    const { ITEM_FIELDS } = await import('../src/coop/wire.js');
    const items = sub('The three item types');
    for (const kind of ['line', 'report'] as const) {
      for (const f of ITEM_FIELDS[kind]) {
        const row = items.split('\n').find((l) => l.includes(`\`${f.name}\``));
        expect(row, f.name).toBeDefined();
        expect(row, f.name).toContain(`\`${f.type}\``);
        expect(row, f.name).toContain(f.required ? 'yes' : 'no');
      }
    }
    expect(flat(items)).toContain('never sets `csam`');
    const actions = flat(sub('Which Coop actions mean what'));
    for (const needle of ["verdict: 'upheld', kind: 'warning'", "verdict: 'upheld', kind: 'chat', durationMs", "verdict: 'noted'", "verdict: 'no_action'", "verdict: 'bad_faith'", 'coop:<the moderator', '`report.decide`', 'first of the callback']) {
      expect(actions, needle).toContain(needle);
    }
  });

  it('documents the callback steps, every answer and every ignore reason the code has', () => {
    const callback = flat(sub('The callback'));
    for (const needle of ['64 KiB', '`413`', '`rawBody`', 'Coop-Signature', 't=<time>,v1=<signature>', '`callbackAuth`', '`400`', '`503`', '`401 { "error": "unauthorized" }`', '"outcome": "ignored"', '`"applied"`', '`"replay"`', '`chatwarden.coop_callback_ignored`']) {
      expect(callback, needle).toContain(needle);
    }
    const reasons = /export type IgnoreReason = ([^;]+);/.exec(read('../src/coop/wire.ts'))?.[1] ?? '';
    const codes = [...reasons.matchAll(/'(\w+)'/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThanOrEqual(9);
    for (const code of codes) expect(callback, code).toContain(`\`${code}\``);
  });

  it('says the conflict rules in plain words: first decision wins, replays, nothing guessed, nothing unattended, Ignore sends nothing', () => {
    const rules = flat(sub('When two places decide'));
    for (const needle of ['The first decision wins', 'reason `closed`', 'A repeated callback is harmless', 'is not guessed', 'Nothing unattended', 'strike threshold', 'Ignore sends nothing', 'Dismiss action']) expect(rules, needle).toContain(needle);
  });

  it('documents the privacy switches, what is never sent, the replay posture and the log events', () => {
    const privacy = flat(sub('Privacy'));
    for (const needle of ['`evidence` (no default)', '`includeNote`', '`handles`', 'The room id, the seat ids, client keys and IP addresses are never sent', '`chatwarden.coop_failed`', '`chatwarden.coop_callback_ignored`', '`chatwarden.coop_dropped`', '`actorNote` and `decisionReason`']) {
      expect(privacy, needle).toContain(needle);
    }
    const notes = flat(sub('Coop: security notes'));
    for (const needle of ['Verify before parse', 'Replays', 'carries no time', 'rotate it in Coop', 'Rate-limit the routes at your edge', 'Redirects are never followed']) expect(notes, needle).toContain(needle);
  });

  it('documents the signal route: the scheme, the caps, the answers and that the plugin is a copy-in example', () => {
    const signal = flat(sub('The signal route (optional)'));
    for (const needle of ['`POST /coop/signal`', 'x-chatwarden-timestamp', 'x-chatwarden-signature', 'five minute window', 'At most 50 lines', '400 characters', '64 KiB', '`503` with an empty body', '`429`', '`retry-after`', 'examples/coop-signal', 'not published', 'No identifier']) {
      expect(signal, needle).toContain(needle);
    }
  });

  it('lists what is not confirmed yet', () => {
    const open = flat(sub('Not confirmed yet'));
    for (const needle of ['`t=...,v1=...`', 'Invalidate reports', '`creator`', '`datetime`', '@roostorg/coop-types', '@roostorg/types', 'Nothing has run against a real Coop']) expect(open, needle).toContain(needle);
  });

  it('the wiring block compiles (scripts/readme.test.ts) and runs against fakes: the route verifies a signed callback, the checklist prints, dispose is clean', async () => {
    const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(blocks).toHaveLength(2);
    const block = blocks[0] as string;
    expect(block.startsWith("import express from 'express';")).toBe(true);
    // The startup lines call Coop over the network: run everything but them, and check they are there.
    expect(block).toMatch(/\/\/ at startup\nconsole\.log\(adapter\.setup\.checklist\(\)\.toText\(\)\);.*\nadapter\.setup\.verify\(\)\.then\(.*\nvoid adapter\.sweep\(\);.*\n\n\/\/ on shutdown\nadapter\.dispose\(\);/);
    const body = block
      .split('\n')
      .filter((l) => !l.startsWith('import '))
      .join('\n')
      .replace(/\n\/\/ at startup\n[\s\S]*?\n\n\/\/ on shutdown\nadapter\.dispose\(\);\n?$/, '\n');
    const { createChatwarden } = await import('@chatwarden/core');
    const { MemoryStore, withMemoryLinks } = await import('@chatwarden/store-memory');
    const { toExpress } = await import('../src/express.js');
    const { coop } = await import('../src/coop/index.js');
    const { default: express } = await import('express');
    const { createRouter } = await import('../src/router.js');
    const { ITEM_TYPES, ACTION, sharedPair, newRsaPair, callbackBody, callbackRequest, COOP_URL, API_KEY } = await import('./coop-world.js');
    const cw = await createChatwarden({ store: withMemoryLinks(new MemoryStore()), secret: 'readme-secret-0123456789', platform: { identify: (ctx) => ctx as never }, retention: false, logger: { warn: () => undefined } });
    const env: Record<string, string> = {
      COOP_URL,
      COOP_API_KEY: API_KEY,
      COOP_WEBHOOK_KEY: sharedPair().publicPem,
      COOP_TYPE_USER: ITEM_TYPES.user,
      COOP_TYPE_LINE: ITEM_TYPES.line,
      COOP_TYPE_REPORT: ITEM_TYPES.report,
      COOP_ACTION_WARN: ACTION.warn,
      COOP_ACTION_CHAT_24H: ACTION.chat,
      COOP_ACTION_DISMISS: ACTION.dismiss,
      COOP_POLICY_HARASSMENT: 'policy-harass',
    };
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    const make = new AsyncFunction('express', 'coop', 'toExpress', 'cw', 'process', `${js(body)}\nreturn { adapter, app };`);
    const out = (await make(express, coop, toExpress, cw, { env })) as { adapter: ReturnType<typeof coop>; app: unknown };
    expect(Object.keys(out.adapter.routes)).toEqual(['POST /coop/actions']);
    const router = createRouter(out.adapter.routes);
    // A correctly signed callback for a report this kit does not have is acknowledged and ignored; a wrong key is the one 401.
    expect(await router(callbackRequest(callbackBody('no-such-report')))).toEqual({ status: 200, body: { ok: true, outcome: 'ignored' } });
    expect((await router(callbackRequest(callbackBody('no-such-report'), { pair: newRsaPair() }))).status).toBe(401);
    const list = out.adapter.setup.checklist();
    expect(list.toText()).toContain('Community Rule 1');
    expect(list.actions).toHaveLength(3);
    out.adapter.dispose();
    expect((await router(callbackRequest(callbackBody('no-such-report')))).status).toBe(401);
    await cw.close();
  });

  it('the signal block shows the option that adds the route', () => {
    const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    const block = blocks[1] as string;
    expect(block).toContain('signal: {');
    expect(block).toContain('secret: process.env.COOP_SIGNAL_SECRET!');
    expect(block).toContain('read: async (lines)');
  });
});

describe('Coop in the project docs', () => {
  const status = flat(read('../../../docs/status.md'));
  const follow = flat(read('../../../docs/plans/follow-ups.md'));

  it('the root README has the row; CLAUDE.md names the adapter and the example', () => {
    const rootText = flat(root);
    expect(rootText).toContain('`coop` from `@chatwarden/http/coop`');
    expect(rootText).toContain('Review in Coop');
    const claude = flat(read('../../../CLAUDE.md'));
    expect(claude).toContain('`@chatwarden/http/coop`');
    expect(claude).toContain('`examples/coop-signal`');
  });

  it('status says what is built and what the owner checks; follow-ups tell the owner exactly what to do (task C8)', () => {
    for (const needle of ['Coop (built', '`chatwarden.coop_callback_ignored`', 'Nothing has run against a real Coop', "The owner's live check (K5 C8)", '`examples/coop-signal`']) expect(status, needle).toContain(needle);
    for (const needle of ['the live Coop check (task C8)', 'docker compose', '`setup.checklist()`', '`setup.verify()`', 'Webhook Signature Verification Key', 'Ignore', 'Invalidate', '`datetime`', '`creator`', '@roostorg/coop-types', 'integrations.config.json', '`chatwarden.coop_failed`']) {
      expect(follow, needle).toContain(needle);
    }
  });
});

describe('packages/http/README.md, Epic Online Services', () => {
  const doc = section(http, 'Epic Online Services');
  const js = (code: string): string => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const sub = (heading: string): string => {
    const start = doc.indexOf(`\n### ${heading}\n`);
    expect(start, `subsection ${heading}`).toBeGreaterThanOrEqual(0);
    const next = doc.indexOf('\n### ', start + 1);
    return doc.slice(start, next === -1 ? undefined : next);
  };

  it('every documented option exists, and every option is documented', () => {
    const source = read('../src/eos/options.ts');
    const block = /export interface EosOptions \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const top = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1] as string);
    const nested = (name: string): string[] => {
      const inner = new RegExp(`^ {2}${name}\\?: \\{([\\s\\S]*?)\\n {2}\\};`, 'm').exec(block)?.[1] ?? '';
      return [...inner.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => `${name}.${m[1] as string}`);
    };
    const fields = [...top, ...nested('sanctions'), ...nested('reports')];
    expect(fields.length).toBeGreaterThanOrEqual(18);
    const names = rows(sub('Epic Online Services options')).flatMap((r) => [...(r[0] as string).matchAll(/`([\w.]+)`/g)].map((m) => m[1] as string));
    for (const field of fields) expect(names, field).toContain(field);
    for (const name of names) expect(fields, name).toContain(name);
  });

  it('the READMEs list the @experimental names, every one the entry exports', () => {
    const entry = read('../src/eos/index.ts');
    const exported = [
      ...[...entry.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) => (m[1] as string).split(',').map((n) => n.trim()).filter(Boolean)),
      ...[...entry.matchAll(/^export (?:interface|function) (\w+)/gm)].map((m) => m[1] as string),
    ];
    expect(new Set(exported)).toEqual(new Set(['eos', 'EosAdapter', 'EosOptions', 'EosKind', 'EosSeat', 'PollResult']));
    for (const name of exported) expect(doc, name).toContain(`\`${name}\``);
    expect(flat(doc)).toMatch(/@experimental` until 0\.2/);
  });

  it('says what EOS can and cannot do, that the entry is not in the root, and needs links', () => {
    const can = flat(sub("What EOS's API can and cannot do"));
    for (const needle of ['cannot list them all', 'no id, no room, no chat line', 'both** players in the **same room', 'The kit stores no EOS id']) expect(can, needle).toContain(needle);
    expect(flat(doc)).toContain('not in the package root');
    expect(flat(doc)).toContain('`cw.links`');
    expect(flat(doc)).toContain('The kit stays the source of truth');
  });

  it('lists the client policy actions the adapter calls, and sets up in order', () => {
    const setup = flat(sub('Set up, in order'));
    for (const needle of ['`sanctions:createSanction`', '`sanctions:deleteSanction`', '`sanctions:findSanctionsForAnyUser`', '`playerreports:findReportsForAnyUser`', 'sandbox', 'cw.people.accountIds']) {
      expect(setup, needle).toContain(needle);
    }
    const order = ['Make client credentials', 'Choose the action names', 'Write the two functions', 'Add it to your server', 'Check it by hand'].map((needle) => setup.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('documents the push and the pull steps, the limits in the code and what never leaves', () => {
    const push = flat(sub('The push: a kit sanction becomes an EOS sanction'));
    for (const needle of ['`cw_ref`', 'second sanction after a crash', 'at most 500', '`source` `chatwarden`', '`0` for a permanent ban and for a warning', '`Lifted: M-7K3Q9`', 'retry-after', 'What EOS never gets']) {
      expect(push, needle).toContain(needle);
    }
    const pull = flat(sub('The pull: an EOS report becomes a kit report'));
    for (const needle of ['20 at a time', '50 to a page', '10 minutes before the cursor', '`unseated`', '`different_room`', '`self`', '500 characters', '64 at most', 'now plus one minute', '`maxPerPoll`', '20 pages', 'The first poll starts from now', 'weak evidence']) {
      expect(pull, needle).toContain(needle);
    }
    // The numbers in the text are the numbers in the code.
    const reports = read('../src/eos/reports.ts');
    expect(reports).toMatch(/const PAGE = 50;/);
    expect(reports).toMatch(/const PAGES_MAX = 20;/);
    expect(reports).toMatch(/const PLAYERS_MAX = 500;/);
    expect(reports).toMatch(/const NOTE_MAX = 500;/);
    expect(reports).toMatch(/const OVERLAP_MS = 10 \* 60_000;/);
    expect(reports).toMatch(/const AHEAD_MS = 60_000;/);
    expect(read('../src/eos/sanctions.ts')).toMatch(/const LOOKUP_PAGES = 5;/);
    expect(read('../src/eos/sanctions.ts')).toMatch(/const PAGE = 100;/);
    expect(read('../src/eos/options.ts')).toMatch(/batch: batch \?\? 20/);
    // Every skip code the poll counts is documented.
    for (const code of ['unseated', 'different_room', 'self', 'malformed', 'seat_error']) expect(doc, code).toContain(`\`${code}\``);
    expect(flat(sub('What stays on the game client'))).toContain('EOS SDK call your game client makes');
  });

  it('documents every log event and every operation the code logs, and the security notes', () => {
    const logs = flat(sub('Logs'));
    for (const event of ['chatwarden.eos_failed', 'chatwarden.eos_dropped', 'chatwarden.eos_report_skipped']) expect(logs, event).toContain(`\`${event}\``);
    const ops = new Set(['eos/token.ts', 'eos/sanctions.ts', 'eos/reports.ts'].flatMap((f) => [...read(`../src/${f}`).matchAll(/\bop: '(\w+)'/g)].map((m) => m[1] as string)));
    expect(ops.size).toBeGreaterThanOrEqual(9);
    for (const op of ops) expect(logs, op).toContain(`\`${op}\``);
    for (const op of ['apply', 'revoke', 'enqueue']) expect(logs, op).toContain(`\`${op}\``);
    const notes = flat(sub('Epic Online Services: security notes'));
    for (const needle of ['The secret and the token stay in memory', 'Redirects are never followed', 'Reports are hostile input', 'No outside account id is stored', 'A line decides the person']) expect(notes, needle).toContain(needle);
  });

  it('lists what is not confirmed yet', () => {
    const open = flat(sub('Not confirmed yet'));
    for (const needle of ['`duration: 0`', '`reportedPlayerId`', 'rate limits', '`404`', '`automated`', "A restart between the kit's revoke and the delete", 'Nothing has run against the real EOS']) expect(open, needle).toContain(needle);
  });

  it('the wiring block compiles (scripts/readme.test.ts) and runs against the fake EOS: a sanction is pushed, a report is pulled, dispose is clean', async () => {
    const blocks = [...doc.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(blocks).toHaveLength(1);
    const block = blocks[0] as string;
    expect(block.startsWith("import { eos } from '@chatwarden/http/eos';")).toBe(true);
    expect(block).toMatch(/\/\/ at startup\nadapter\.start\(\);.*\n\n\/\/ on shutdown\nadapter\.dispose\(\);/);
    // The startup line starts a timer; the test polls by hand instead, and checks the line is there.
    const body = block
      .split('\n')
      .filter((l) => !l.startsWith('import '))
      .join('\n')
      .replace(/\n\/\/ at startup\n[\s\S]*?\n\n\/\/ on shutdown\nadapter\.dispose\(\);\n?$/, '\n');
    const { createChatwarden } = await import('@chatwarden/core');
    const { MemoryStore, withMemoryLinks } = await import('@chatwarden/store-memory');
    const { eos } = await import('../src/eos/index.js');
    const { fakeEos, DEPLOYMENT, CLIENT_ID, CLIENT_SECRET, until } = await import('./eos-world.js');
    const { vi } = await import('vitest');
    const cw = await createChatwarden({ store: withMemoryLinks(new MemoryStore()), secret: 'readme-secret-0123456789', platform: { identify: (ctx) => ctx as never }, retention: false, logger: { warn: () => undefined } });
    const fake = fakeEos();
    vi.stubGlobal('fetch', fake.fetch);
    try {
      const env: Record<string, string> = { EOS_DEPLOYMENT_ID: DEPLOYMENT, EOS_CLIENT_ID: CLIENT_ID, EOS_CLIENT_SECRET: CLIENT_SECRET };
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
      const make = new AsyncFunction('eos', 'cw', 'process', `${js(body)}\nreturn { adapter, productUserIdOfAccount, seatOfProductUserId };`);
      const out = (await make(eos, cw, { env })) as {
        adapter: ReturnType<typeof eos>;
        productUserIdOfAccount: Map<string, string>;
        seatOfProductUserId: Map<string, { roomId: string; seatId: string }>;
      };
      // A person with an account id, a sanction, and the push.
      cw.rooms.seat('readme-room', 'p1', { clientKey: 'raw-key-one', ip: '198.51.100.1', accountId: 'acct-one' }, 'One');
      cw.rooms.seat('readme-room', 'p2', { clientKey: 'raw-key-two', ip: '198.51.100.2', accountId: 'acct-two' }, 'Two');
      out.productUserIdOfAccount.set('acct-one', 'puid-readme-one');
      out.productUserIdOfAccount.set('acct-two', 'puid-readme-two');
      out.seatOfProductUserId.set('puid-readme-one', { roomId: 'readme-room', seatId: 'p1' });
      out.seatOfProductUserId.set('puid-readme-two', { roomId: 'readme-room', seatId: 'p2' });
      const subject = cw.rooms.subjectAt('readme-room', 'p2') as string;
      await cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: 86_400_000, reason: 'private', actor: 'ann', source: 'moderator', automated: false, rule: 1 });
      await until(() => fake.sanctions.length === 1, 'the push');
      expect(fake.sanctions[0]).toMatchObject({ productUserId: 'puid-readme-two', action: 'chatwarden-chat', source: 'chatwarden', duration: 86_400 });
      // A report between the two, pulled.
      fake.addReport({ reportingPlayerId: 'puid-readme-one', reportedPlayerId: 'puid-readme-two', reasonId: 4, time: new Date().toISOString(), message: 'zorbak' });
      expect(await out.adapter.pollReports()).toMatchObject({ seen: 1, filed: 1 });
      out.adapter.dispose();
      expect(await out.adapter.pollReports()).toEqual({ seen: 0, filed: 0, skipped: {}, refused: {} });
    } finally {
      vi.unstubAllGlobals();
      await cw.close();
    }
  });
});

describe('EOS in the project docs', () => {
  const status = flat(read('../../../docs/status.md'));
  const follow = flat(read('../../../docs/plans/follow-ups.md'));

  it('the root README has the row; CLAUDE.md names the adapter', () => {
    expect(flat(root)).toContain('`eos` from `@chatwarden/http/eos`');
    expect(flat(root)).toContain('Epic Online Services');
    expect(flat(read('../../../CLAUDE.md'))).toContain('`@chatwarden/http/eos`');
  });

  it('status says what is built and what the owner checks; follow-ups tell the owner exactly what to do (task E5)', () => {
    for (const needle of ['EOS (built', '`chatwarden.eos_failed`', 'Nothing has run against the real EOS', "The owner's sandbox check (K5 E5)", 'the Discord bot, Coop and EOS are built']) expect(status, needle).toContain(needle);
    for (const needle of ['the EOS sandbox check (task E5)', '**sandbox**', '`sanctions:createSanction`', '`playerreports:findReportsForAnyUser`', 'permanent ban', '`duration: 0`', '`reports.batch`', '429', 'a lost revoke', '`chatwarden.eos_report_skipped`']) {
      expect(follow, needle).toContain(needle);
    }
  });
});
