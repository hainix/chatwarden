import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveServeConfig, startService } from '../../packages/http/src/service/serve.js';
import type { RunningService } from '../../packages/http/src/service/serve.js';

// S6: conformance.mjs is curl.sh as a Node script that exits non-zero on any surprise. It runs here against a started `serve` (in this process, on an ephemeral loopback port); in CI the same script
// can run against the built bin. A language-neutral expectations file (expectations.json) holds the strings each step's answer must contain; the C# sample reads the same file.

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(DIR, 'conformance.mjs');
const KEY = `conformance-key-${'0123456789abcdef'.repeat(2)}`;
const SECRET = 'conformance-secret-0123456789abcdef0123';

const running: RunningService[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

async function serve(): Promise<string> {
  const config = resolveServeConfig({ printOpenapi: false, port: '0', host: '127.0.0.1', db: ':memory:', hub: 'none' }, { CHATWARDEN_SECRET: SECRET, CHATWARDEN_SERVICE_KEYS: KEY });
  const service = await startService(config, { log: () => undefined });
  running.push(service);
  return `http://127.0.0.1:${service.port}`;
}

function run(env: Record<string, string>, args: string[] = []): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('conformance.mjs', () => {
  it('runs against a started serve process on an ephemeral port and exits 0, naming each step it passed', async () => {
    const base = await serve();
    const res = await run({ BASE: base, KEY });
    expect(res.err).toBe('');
    expect(res.code).toBe(0);
    const steps = (JSON.parse(readFileSync(join(DIR, 'expectations.json'), 'utf8')) as { steps: Array<{ name: string }> }).steps;
    for (const step of steps) expect(res.out, step.name).toContain(step.name);
    expect(res.out).not.toContain(KEY);
  }, 30_000);

  it('runs twice against one server (it names its rooms and players afresh each time)', async () => {
    const base = await serve();
    expect((await run({ BASE: base, KEY })).code).toBe(0);
    expect((await run({ BASE: base, KEY })).code).toBe(0);
  }, 30_000);

  it('with a wrong key it exits 1 and says unauthorized, without printing either key', async () => {
    const base = await serve();
    const wrong = 'wrong-key-0123456789abcdef0123456789abcdef';
    const res = await run({ BASE: base, KEY: wrong });
    expect(res.code).toBe(1);
    expect(`${res.out}${res.err}`).toMatch(/unauthorized/i);
    expect(`${res.out}${res.err}`).not.toContain(wrong);
    expect(`${res.out}${res.err}`).not.toContain(KEY);
  }, 30_000);

  it('with no server there it exits 1 and says it could not reach it; with no KEY it exits 1 and says so', async () => {
    const down = await run({ BASE: 'http://127.0.0.1:1', KEY });
    expect(down.code).toBe(1);
    expect(`${down.out}${down.err}`).toMatch(/could not reach|unreachable|ECONNREFUSED|fetch failed/i);
    const none = await run({ BASE: 'http://127.0.0.1:1' });
    expect(none.code).toBe(1);
    expect(`${none.out}${none.err}`).toMatch(/KEY/);
  }, 30_000);

  it('a surprise is a failure: the same script against a server whose answers differ (a plain 200 with {}) exits 1 naming the step', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await run({ BASE: `http://127.0.0.1:${port}`, KEY });
      expect(res.code).toBe(1);
      expect(`${res.out}${res.err}`).toMatch(/handshake/);
    } finally {
      server.close();
    }
  }, 30_000);
});
