import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import { serveHelpText } from '../src/cli/args.js';
import { ServeError, resolveServeConfig, startService } from '../src/service/serve.js';
import type { RunningService, ServeDeps } from '../src/service/serve.js';
import type { ServeFlags } from '../src/cli/args.js';
import { KEY_A, KEY_B } from './serviceKit.js';

// `chatwarden serve` with the appeal landing page and the delivery webhook (0.2.1): the four environment variables, what startup refuses (one sentence that names the variable and never a value),
// the page it serves, and a delivery that reaches a local receiver with a signature that verifies. Every call is to an ephemeral loopback port; no key or secret in this file is real.

const SECRET = 'serve-landing-secret-0123456789abcdef01';
const ADMIN = 'serve-landing-admin-token-0123456789';
const DELIVERY_SECRET = 'serve-landing-delivery-secret-0123456789abc';
const BASE_ENV = { CHATWARDEN_SECRET: SECRET, CHATWARDEN_SERVICE_KEYS: `${KEY_A},${KEY_B}` };
const FLAGS: ServeFlags = { printOpenapi: false, port: '0', host: '127.0.0.1', db: ':memory:', hub: 'none' };

const cleanups: Array<() => Promise<void> | void> = [];

/** A profile file that turns appeals on (they are off until a profile says so). */
function appealsOn(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-serve-landing-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'profile.json');
  writeFileSync(file, JSON.stringify({ appeals: { enabled: true } }));
  return file;
}
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      /* gone */
    }
  }
});

interface Started {
  service: RunningService;
  base: string;
  raw: string[];
  cw: () => Chatwarden;
}

/** Start the service, keeping hold of the kit it creates (the test plays the game server through it). */
async function start(env: Record<string, string | undefined> = {}, deps: ServeDeps = {}): Promise<Started> {
  const raw: string[] = [];
  let kit: Chatwarden | undefined;
  const importer = async (name: string): Promise<unknown> => {
    const mod = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
    if (name !== '@chatwarden/core') return mod;
    return {
      ...mod,
      createChatwarden: async (options: unknown) => {
        kit = await (mod.createChatwarden as (o: unknown) => Promise<Chatwarden>)(options);
        return kit;
      },
    };
  };
  const config = resolveServeConfig(FLAGS, { ...BASE_ENV, ...env });
  const service = await startService(config, { log: (line) => void raw.push(line), importer, ...deps });
  cleanups.push(() => service.close());
  return { service, base: `http://127.0.0.1:${service.port}`, raw, cw: () => kit as Chatwarden };
}

const refusal = async (env: Record<string, string | undefined>): Promise<string> => {
  const config = resolveServeConfig(FLAGS, env);
  try {
    const service = await startService(config, { log: () => undefined });
    await service.close();
  } catch (err) {
    expect(err).toBeInstanceOf(ServeError);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('the configuration', () => {
  it('reads the four variables; an empty one is not set', () => {
    const env = { CHATWARDEN_PUBLIC_URL: 'https://game.example', CHATWARDEN_LANDING_ORIGINS: 'https://game.example,https://www.game.example', CHATWARDEN_DELIVERY_URL: 'https://hooks.example/notices', CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET };
    expect(resolveServeConfig(FLAGS, env)).toMatchObject({ publicUrl: 'https://game.example', landingOrigins: 'https://game.example,https://www.game.example', deliveryUrl: 'https://hooks.example/notices', deliverySecret: DELIVERY_SECRET });
    const none = resolveServeConfig(FLAGS, { CHATWARDEN_PUBLIC_URL: '', CHATWARDEN_LANDING_ORIGINS: '', CHATWARDEN_DELIVERY_URL: '', CHATWARDEN_DELIVERY_SECRET: '' });
    for (const key of ['publicUrl', 'landingOrigins', 'deliveryUrl', 'deliverySecret'] as const) expect(none[key], key).toBeUndefined();
    const bare = resolveServeConfig(FLAGS, {});
    for (const key of ['publicUrl', 'landingOrigins', 'deliveryUrl', 'deliverySecret'] as const) expect(Object.hasOwn(bare, key), key).toBe(false);
  });

  it('there are no flags for them (a secret is never a flag; the others are environment only)', () => {
    const text = serveHelpText();
    for (const flag of ['--public-url', '--landing-origins', '--delivery-url', '--delivery-secret']) expect(text).not.toContain(flag);
  });
});

describe('--help lists the four variables', () => {
  it('each with a line, and what "set together" means', () => {
    const text = serveHelpText();
    for (const name of ['CHATWARDEN_PUBLIC_URL', 'CHATWARDEN_LANDING_ORIGINS', 'CHATWARDEN_DELIVERY_URL', 'CHATWARDEN_DELIVERY_SECRET']) {
      const line = text.split('\n').find((l) => l.includes(name));
      expect(line, name).toBeDefined();
      expect((line as string).length, name).toBeGreaterThan(name.length + 20);
    }
    expect(text).toMatch(/set together|together/);
    expect(text).toMatch(/\/appeal/);
  });
});

describe('startup refusals: one sentence, the variable named, no value repeated', () => {
  it('a public url with a query, a fragment, credentials, a non-http scheme, no scheme or over 1900 characters', async () => {
    const bad = [
      'https://game.example/?q=SEEDED-VALUE',
      'https://game.example/#SEEDED-VALUE',
      'https://user:SEEDED-VALUE@game.example',
      'ftp://game.example/SEEDED-VALUE',
      'game.example/SEEDED-VALUE',
      `https://game.example/${'a'.repeat(1900)}SEEDED-VALUE`,
      'https://',
    ];
    for (const value of bad) {
      const message = await refusal({ ...BASE_ENV, CHATWARDEN_PUBLIC_URL: value });
      expect(message, value.slice(0, 40)).toMatch(/CHATWARDEN_PUBLIC_URL/);
      expect(message).not.toContain('SEEDED-VALUE');
      expect(message.includes('\n')).toBe(false);
    }
  });

  it('a landing origin with a path, a trailing slash, a wildcard, "null" or a scheme that is not http(s), a bad item among good ones, and more than 20', async () => {
    const bad = ['https://game.example/path', 'https://game.example/', '*', 'null', 'ftp://game.example', 'https://ok.example,https://bad.example/SEEDED-VALUE', Array.from({ length: 21 }, (_, i) => `https://g${i}.example`).join(',')];
    for (const value of bad) {
      const message = await refusal({ ...BASE_ENV, CHATWARDEN_LANDING_ORIGINS: value });
      expect(message, value.slice(0, 40)).toMatch(/CHATWARDEN_LANDING_ORIGINS/);
      expect(message).not.toContain('SEEDED-VALUE');
      expect(message).not.toContain('game.example');
    }
  });

  it('a delivery url without the secret, and the secret without the url, name both variables', async () => {
    for (const env of [{ CHATWARDEN_DELIVERY_URL: 'https://hooks.example/n' }, { CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET }]) {
      const message = await refusal({ ...BASE_ENV, ...env });
      expect(message).toBe('CHATWARDEN_DELIVERY_URL and CHATWARDEN_DELIVERY_SECRET must be set together.');
    }
  });

  it('a delivery secret under 32 characters, or the same as CHATWARDEN_SECRET, a service key or the admin token, is refused', async () => {
    const url = 'https://hooks.example/n';
    const cases: Array<[string, Record<string, string>]> = [
      ['short-SEEDED', {}],
      ['x'.repeat(31), {}],
      [SECRET, {}],
      [KEY_A, {}],
      [KEY_B, {}],
      [ADMIN, { CHATWARDEN_ADMIN_TOKEN: ADMIN }],
    ];
    for (const [secret, extra] of cases) {
      const message = await refusal({ ...BASE_ENV, ...extra, CHATWARDEN_DELIVERY_URL: url, CHATWARDEN_DELIVERY_SECRET: secret });
      expect(message, secret.slice(0, 12)).toBe('CHATWARDEN_DELIVERY_SECRET must be its own secret of at least 32 characters.');
      expect(message).not.toContain(secret);
    }
  });

  it('a delivery url that is http to a remote host, has credentials or is not a url is refused by the webhook rule, without the value', async () => {
    for (const value of ['http://hooks.example/n', 'https://u:SEEDED-VALUE@hooks.example/n', 'not a url SEEDED-VALUE', 'ftp://hooks.example/SEEDED-VALUE']) {
      const message = await refusal({ ...BASE_ENV, CHATWARDEN_DELIVERY_URL: value, CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET });
      expect(message, value).toMatch(/CHATWARDEN_DELIVERY_URL/);
      expect(message).not.toContain('SEEDED-VALUE');
      expect(message).not.toContain('hooks.example');
    }
  });

  it('the order: the admin token comes first, then these, then the files', async () => {
    const files = { CHATWARDEN_PUBLIC_URL: 'https://game.example/?q=1' };
    expect(await refusal({ ...BASE_ENV, ...files, CHATWARDEN_ADMIN_TOKEN: 'short' })).toMatch(/CHATWARDEN_ADMIN_TOKEN/);
    const config = resolveServeConfig({ ...FLAGS, profileFile: '/nowhere/profile.json' }, { ...BASE_ENV, ...files });
    await expect(startService(config, { log: () => undefined })).rejects.toThrow(/CHATWARDEN_PUBLIC_URL/);
  });

  it('good values start: https and loopback http delivery urls, a public url with a path and a trailing slash, 20 origins', async () => {
    for (const env of [
      { CHATWARDEN_PUBLIC_URL: 'https://game.example/', CHATWARDEN_LANDING_ORIGINS: 'https://game.example' },
      { CHATWARDEN_PUBLIC_URL: 'https://game.example/play//', CHATWARDEN_LANDING_ORIGINS: Array.from({ length: 20 }, (_, i) => `https://g${i}.example`).join(',') },
      { CHATWARDEN_DELIVERY_URL: 'https://hooks.example/n', CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET },
      { CHATWARDEN_DELIVERY_URL: 'http://127.0.0.1:9/n', CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET },
      { CHATWARDEN_LANDING_ORIGINS: ' https://game.example , https://www.game.example ' },
    ]) {
      const s = await start(env);
      expect(s.service.port).toBeGreaterThan(0);
    }
  });
});

describe('a started service', () => {
  it('serves GET /appeal: the invalid page (404, with the page headers) for no token, and the other landing routes answer', async () => {
    const s = await start({ CHATWARDEN_PROFILE_FILE: appealsOn() });
    const res = await fetch(`${s.base}/appeal`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('This link is no longer valid.');
    expect((await fetch(`${s.base}/appeal/case?t=forged`)).status).toBe(404);
    // the health routes are still there beside them
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${s.base}/nowhere`)).status).toBe(404);
  });

  it('appeals are off by default: /appeal answers the 404 invalid page like any other bad link', async () => {
    const s = await start();
    expect(s.cw().appeals.enabled()).toBe(false);
    const res = await fetch(`${s.base}/appeal/case?t=anything`);
    expect(res.status).toBe(404);
  });

  it('says once, with no value, that no link can be made when there is no CHATWARDEN_PUBLIC_URL; and not when there is', async () => {
    const without = await start();
    expect(without.raw.map((l) => JSON.parse(l) as { event: string }).filter((l) => l.event === 'chatwarden.serve_no_public_url')).toEqual([{ event: 'chatwarden.serve_no_public_url' }]);
    const withUrl = await start({ CHATWARDEN_PUBLIC_URL: 'https://game.example' });
    expect(withUrl.raw.join('\n')).not.toContain('serve_no_public_url');
    expect(withUrl.raw.join('\n')).not.toContain('game.example');
  });

  it('with CHATWARDEN_PUBLIC_URL a link the kit mints starts with that url and /appeal; without it no link is minted', async () => {
    const s = await start({ CHATWARDEN_PUBLIC_URL: 'https://game.example/play/', CHATWARDEN_PROFILE_FILE: appealsOn() });
    const noticeId = await sanctionedNotice(s.cw());
    const url = s.cw().appeals.link(noticeId);
    expect(url?.startsWith('https://game.example/play/appeal?t=')).toBe(true);
    const bare = await start({ CHATWARDEN_PROFILE_FILE: appealsOn() });
    const other = await sanctionedNotice(bare.cw());
    expect(bare.cw().appeals.link(other)).toBeNull();
  });

  it('a link opens the page over the socket, and the landing origins are the kit list for CORS', async () => {
    const s = await start({ CHATWARDEN_PUBLIC_URL: 'https://game.example', CHATWARDEN_LANDING_ORIGINS: 'https://game.example', CHATWARDEN_PROFILE_FILE: appealsOn() });
    const cw = s.cw();
    const noticeId = await sanctionedNotice(cw);
    const token = new URL(cw.appeals.link(noticeId) as string).searchParams.get('t') as string;
    const page = await fetch(`${s.base}/appeal?t=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post" action="appeal/case">');
    const json = await fetch(`${s.base}/appeal/case?t=${token}`, { headers: { origin: 'https://game.example' } });
    expect(json.status).toBe(200);
    expect(json.headers.get('access-control-allow-origin')).toBe('https://game.example');
    const stranger = await fetch(`${s.base}/appeal/case?t=${token}`, { headers: { origin: 'https://evil.example' } });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await fetch(`${s.base}/appeal/case`, { method: 'OPTIONS', headers: { origin: 'https://game.example' } });
    expect(pre.status).toBe(200);
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    // the form post over the socket: 303 back to the page
    const form = await fetch(`${s.base}/appeal/case`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: token, statement: 'It was not me.' }).toString(), redirect: 'manual' });
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe(`../appeal?t=${token}&lang=en`);
  });
});

describe('CHATWARDEN_TRUST_PROXY', () => {
  it('is read as given, an empty one is not set, and it has no flag', () => {
    expect(resolveServeConfig(FLAGS, { CHATWARDEN_TRUST_PROXY: '1' })).toMatchObject({ trustProxy: '1' });
    expect(Object.hasOwn(resolveServeConfig(FLAGS, { CHATWARDEN_TRUST_PROXY: '' }), 'trustProxy')).toBe(false);
    expect(Object.hasOwn(resolveServeConfig(FLAGS, {}), 'trustProxy')).toBe(false);
    expect(serveHelpText()).not.toContain('--trust-proxy');
  });

  it('--help lists it with what a number means', () => {
    const line = serveHelpText().split('\n').find((l) => l.includes('CHATWARDEN_TRUST_PROXY'));
    expect(line).toBeDefined();
    expect(serveHelpText()).toMatch(/X-Forwarded-For/i);
  });

  it('refuses anything but a whole number from 0 to 10, in one sentence that names the variable and never repeats the value', async () => {
    for (const value of ['-1', '11', '1.5', 'yes', 'true', '1,2', ' 1x', '99999', 'SEEDED-VALUE']) {
      const message = await refusal({ ...BASE_ENV, CHATWARDEN_TRUST_PROXY: value });
      expect(message, value).toMatch(/CHATWARDEN_TRUST_PROXY/);
      expect(message).not.toContain('SEEDED-VALUE');
      expect(message.includes('\n')).toBe(false);
    }
  });

  it('with 1, the landing limits are per client behind a proxy: one forwarded client over the read limit, another still served', async () => {
    const s = await start({ CHATWARDEN_PUBLIC_URL: 'https://game.example', CHATWARDEN_PROFILE_FILE: appealsOn(), CHATWARDEN_TRUST_PROXY: '1' });
    const get = (client: string) => fetch(`${s.base}/appeal`, { headers: { 'x-forwarded-for': client } });
    for (let i = 0; i < 60; i++) expect((await get('203.0.113.1')).status).toBe(404);
    expect((await get('203.0.113.1')).status).toBe(429);
    expect((await get('203.0.113.2')).status).toBe(404);
  });

  it('with 0 or unset, the header is ignored and a loopback socket peer (a local test, or your own proxy) is not an address bucket: per-token limits only', async () => {
    for (const env of [{ CHATWARDEN_TRUST_PROXY: '0' }, {}]) {
      const s = await start({ CHATWARDEN_PUBLIC_URL: 'https://game.example', CHATWARDEN_PROFILE_FILE: appealsOn(), ...env });
      // no token: nothing to limit by, so 100 reads are all answered (never one bucket for everyone behind the proxy)
      for (let i = 0; i < 100; i++) expect((await fetch(`${s.base}/appeal`, { headers: { 'x-forwarded-for': `203.0.113.${i}` } })).status, `read ${i}`).toBe(404);
      // a well-formed token is limited per token, whatever the header says
      for (let i = 0; i < 60; i++) await fetch(`${s.base}/appeal?t=abc.def`, { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
      expect((await fetch(`${s.base}/appeal?t=abc.def`, { headers: { 'x-forwarded-for': '203.0.113.200' } })).status).toBe(429);
    }
  });
});

describe('the delivery webhook', () => {
  /** A local receiver that records what it is sent. */
  async function receiver(status = 200) {
    const got: Array<{ headers: Record<string, string>; body: string }> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        got.push({ headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
    const port = (server.address() as { port: number }).port;
    return { got, url: `http://127.0.0.1:${port}/hook` };
  }
  const waitFor = async (check: () => boolean, ms = 3000): Promise<void> => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise<void>((r) => setTimeout(r, 10));
  };

  it('a sanction notice for a person with an account reaches a local receiver with a signature that verifies; the delivery header is the notice id', async () => {
    const r = await receiver();
    const s = await start({ CHATWARDEN_PUBLIC_URL: 'https://game.example', CHATWARDEN_PROFILE_FILE: appealsOn(), CHATWARDEN_DELIVERY_URL: r.url, CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET });
    const noticeId = await sanctionedNotice(s.cw(), { account: 'acct-serve-0001' });
    await waitFor(() => r.got.length > 0);
    expect(r.got).toHaveLength(1);
    const hit = r.got[0] as { headers: Record<string, string>; body: string };
    expect(hit.headers['x-chatwarden-signature']).toBe(`sha256=${createHmac('sha256', DELIVERY_SECRET).update(hit.body, 'utf8').digest('hex')}`);
    expect(hit.headers['x-chatwarden-delivery']).toBe(noticeId);
    expect(hit.headers['content-type']).toBe('application/json');
    const body = JSON.parse(hit.body) as Record<string, unknown>;
    expect(body).toMatchObject({ noticeId, kind: 'sanction', to: { accountId: 'acct-serve-0001' } });
    expect(String(body.text)).toContain('https://game.example/appeal?t=');
  });

  it('a person with no account is delivered nothing; a start without the two variables sets no hook', async () => {
    const r = await receiver();
    const s = await start({ CHATWARDEN_DELIVERY_URL: r.url, CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET });
    await sanctionedNotice(s.cw());
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(r.got).toEqual([]);
    const quiet = await receiver();
    const none = await start();
    await sanctionedNotice(none.cw(), { account: 'acct-serve-0002' });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(quiet.got).toEqual([]);
  });

  it('close disposes cleanly: a delivery that is failing does not keep the process or fire again after close', async () => {
    const r = await receiver(500);
    const s = await start({ CHATWARDEN_DELIVERY_URL: r.url, CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET });
    await sanctionedNotice(s.cw(), { account: 'acct-serve-0003' });
    await waitFor(() => r.got.length > 0);
    expect(r.got).toHaveLength(1);
    const started = Date.now();
    await s.service.close();
    expect(Date.now() - started).toBeLessThan(5000);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(r.got).toHaveLength(1);
  });

  it('the logs of a failing delivery hold the class and the status only', async () => {
    const r = await receiver(400);
    const s = await start({ CHATWARDEN_DELIVERY_URL: r.url, CHATWARDEN_DELIVERY_SECRET: DELIVERY_SECRET });
    await sanctionedNotice(s.cw(), { account: 'acct-serve-0004' });
    await waitFor(() => s.raw.some((l) => l.includes('delivery_webhook_failed')));
    const line = s.raw.find((l) => l.includes('delivery_webhook_failed'));
    expect(JSON.parse(line as string)).toEqual({ event: 'chatwarden.delivery_webhook_failed', status: 400, attempts: 1 });
    const all = s.raw.join('\n');
    for (const secret of [DELIVERY_SECRET, r.url, 'acct-serve-0004']) expect(all).not.toContain(secret);
  });
});

/** Sanction a player through a real decision on the kit and return the notice id. `account` seats the person with that account id. */
async function sanctionedNotice(cw: Chatwarden, o: { account?: string } = {}): Promise<string> {
  const n = Math.random().toString(36).slice(2, 10);
  const room = `room-${n}`;
  cw.rooms.seat(room, 'a', { clientKey: `serve-target-${n}-0001`, ...(o.account === undefined ? {} : { accountId: o.account }) }, 'Target');
  cw.rooms.seat(room, 'b', { clientKey: `serve-reporter-${n}-0001` }, 'Reporter');
  cw.chat.accept(room, 'a', 'a line from the target');
  const filed = await cw.reports.submit({ roomId: room, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  if (!filed.ok) throw new Error('report refused');
  const res = await cw.decide({
    reportId: filed.reportId,
    verdict: 'upheld',
    actor: 'mod_ann',
    reason: 'private reason',
    actions: [{ subject: cw.rooms.subjectAt(room, 'a') as string, kind: 'chat', durationMs: 6 * 3_600_000, rule: 2, lineIds: [] }],
  } as never);
  if (!res.ok) throw new Error('decision refused');
  const noticeId = res.groups[0]?.noticeId;
  if (typeof noticeId !== 'string') throw new Error('expected a notice');
  return noticeId;
}
