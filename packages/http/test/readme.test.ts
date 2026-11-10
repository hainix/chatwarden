import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, DELIVERY_HEADER, MAX_RETRIES, PERMISSIONS, PERMISSION_KEYS, RETRY_AFTER_CAP_MS, RETRY_AFTER_FLOOR_MS, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/index.js';

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

const MARKETING = /\b(blazing|seamless|powerful|robust|world-class|cutting-edge|revolutionary)\b/i;

describe('packages/http/README.md', () => {
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
    expect(find('/decide')).toMatch(/\{ verdict, reason, actions, evidence\? \}/);
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
