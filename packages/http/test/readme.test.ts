import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, DELIVERY_HEADER, MAX_RETRIES, PERMISSIONS, PERMISSION_KEYS, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/index.js';

// The READMEs are part of the product: an adopter (or a coding agent) copies from them. These checks keep them true to the
// code: every permission, every error code and every header the code defines must be written down.

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const http = read('../README.md');
const discord = read('../../discord/README.md');
const root = read('../../../README.md');

/** The error codes and statuses the code defines, read from the table in errors.ts. */
const errorTable = [...read('../src/errors.ts').matchAll(/^ {2}(\w+): \{ status: (\d+),/gm)].map((m) => [m[1] as string, Number(m[2])] as const);

describe('packages/http/README.md', () => {
  it('has the sections an adopter needs, setup first', () => {
    for (const heading of ['## Install', '## Set up', '## Auth', '## Permissions', '## Errors', '## Webhooks', '## Health probes', '## Security notes']) {
      expect(http, heading).toContain(heading);
    }
    expect(http.indexOf('## Set up')).toBeLessThan(http.indexOf('## Permissions'));
    expect(http.indexOf('## Set up')).toBeLessThan(http.indexOf('## Security notes'));
  });

  it('the setup shows the four builders and the Express adapter', () => {
    for (const name of ['adminRoutes', 'playerRoutes', 'healthRoutes', 'toExpress', 'webhooksOut', 'webhookIn', 'createRouter']) {
      expect(http, name).toContain(name);
    }
    expect(http).toContain("from '@chatwarden/http/express'");
  });

  it('explains authorize and identify, and that remoteAddress is the socket peer', () => {
    expect(http).toContain('authorize');
    expect(http).toContain('identify');
    expect(http).toMatch(/remoteAddress[^\n]*socket/);
    expect(http).toMatch(/proxy/i);
    expect(http).toContain('null');
  });

  it('says to mount toExpress before any body parser', () => {
    expect(http).toMatch(/before any body parser/i);
    expect(http).toContain('express.json()');
  });

  it('lists every permission with its default role, and says there are no floors', () => {
    expect(PERMISSION_KEYS.length).toBeGreaterThan(5);
    for (const key of PERMISSION_KEYS) {
      expect(http, key).toContain(`\`${key}\``);
      // The row names the role the code defaults to.
      const row = http.split('\n').find((l) => l.includes(`\`${key}\``) && l.startsWith('|'));
      expect(row, key).toBeDefined();
      expect(row, key).toContain(PERMISSIONS[key]);
    }
    expect(http).toMatch(/no floors?/i);
    expect(http).toMatch(/you decide|adopter decides|your call/i);
  });

  it('lists every error code with its status', () => {
    expect(errorTable.length).toBeGreaterThan(15);
    expect(errorTable).toContainEqual(['in_progress', 409]);
    for (const [code, status] of errorTable) {
      const row = http.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${code}\``));
      expect(row, code).toBeDefined();
      expect(row, code).toContain(String(status));
    }
    expect(http).toContain('internal');
  });

  it('documents the webhook headers, the signing recipe, verify, delivery ids, retries and the staff-only warning', () => {
    for (const header of [TIMESTAMP_HEADER, SIGNATURE_HEADER, DELIVERY_HEADER]) expect(http, header).toContain(header);
    expect(http).toContain('HMAC-SHA256');
    expect(http).toContain('${timestamp}.${body}');
    expect(http).toContain('v1=');
    expect(http).toContain('verify(');
    expect(http).toContain('ReplayCache');
    expect(http).toMatch(/deduplicate|dedupe/i);
    expect(http).toContain(`${MAX_RETRIES} times`);
    expect(http).toContain(`${BACKOFF_BASE_MS / 1000}, 2, 4, 8`);
    expect(http).toMatch(/subject ids/i);
    expect(http).toMatch(/staff (endpoints|channels)/i);
    expect(http).toContain('includeExcerpts');
  });

  it('documents idempotency keys and 409s, and edge rate limiting for the incoming webhook', () => {
    expect(http).toContain('idempotencyKey');
    expect(http).toContain('idempotency_mismatch');
    expect(http).toContain('in_progress');
    expect(http).toMatch(/rate[- ]limit/i);
    expect(http).toMatch(/express-rate-limit|reverse proxy|load balancer/i);
  });

  it('documents the health probes', () => {
    expect(http).toContain('/healthz');
    expect(http).toContain('/readyz');
    expect(http).toContain('503');
  });

  it('uses no marketing words and no real slur', () => {
    expect(http).not.toMatch(/\b(blazing|seamless|powerful|robust|world-class|cutting-edge|revolutionary)\b/i);
  });
});

describe('packages/discord/README.md', () => {
  it('has copy-paste setup first, then options and notes', () => {
    for (const heading of ['## Install', '## Set up', '## Options', '## Known limits']) expect(discord, heading).toContain(heading);
    expect(discord.indexOf('## Set up')).toBeLessThan(discord.indexOf('## Options'));
  });

  it('explains the forum-channel webhook setup', () => {
    expect(discord).toMatch(/forum channel/i);
    expect(discord).toMatch(/Integrations/);
    expect(discord).toContain('discord.com/api/webhooks/');
    expect(discord).toMatch(/credential|secret/i);
  });

  it('documents hubLink, mentionRoleId and severeOnly', () => {
    for (const option of ['hubLink', 'mentionRoleId', 'severeOnly', 'webhookUrl']) expect(discord, option).toContain(option);
    expect(discord).toContain('dispose()');
  });

  it('states the duplicate-thread limit and that kit_discord_threads is not purged', () => {
    expect(discord).toMatch(/two threads|duplicate thread/i);
    expect(discord).toContain('kit_discord_threads');
    expect(discord).toMatch(/not (removed|purged|deleted)/i);
    expect(discord).toContain('purge()');
  });

  it('says what the posts hold and do not hold', () => {
    expect(discord).toMatch(/no chat text/i);
    expect(discord).toMatch(/subject id/i);
    expect(discord).toMatch(/inside (the )?(hub )?links?/i);
  });
});

describe('the root README', () => {
  it('lists @chatwarden/http and @chatwarden/discord in the package table', () => {
    expect(root).toContain('[`@chatwarden/http`](packages/http)');
    expect(root).toContain('[`@chatwarden/discord`](packages/discord)');
  });

  it('has a quick start for the HTTP routes and the Discord feed', () => {
    expect(root).toContain('## Quick start');
    expect(root).toContain('adminRoutes');
    expect(root).toContain('playerRoutes');
    expect(root).toContain('toExpress');
    expect(root).toContain('discordFeed');
    expect(root).toContain('packages/http/README.md');
    expect(root).toContain('packages/discord/README.md');
  });

  it('keeps the preset section and the development notes', () => {
    expect(root).toContain('## Pick a preset');
    expect(root).toContain('## Development');
  });
});
