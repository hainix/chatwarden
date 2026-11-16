import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseCli } from '../../packages/http/src/cli/args.js';
import { resolveAnswers } from '../../packages/http/src/cli/answers.js';
import { buildPlan } from '../../packages/http/src/cli/plan.js';
import { renderAll } from '../../packages/http/src/cli/templates/index.js';
import { VERSION } from '../../packages/http/src/index.js';
import { CASES, renderCase } from './cases.js';
import { BLOCKED_WORD, LONG_TOKEN, ROOM, SECRET, hasHello, keyOf, listen, settle, withEnv } from './harness.js';
import type { Listening } from './harness.js';
import * as route from './cases/next-sqlite-box-react/app/chatwarden/[...path]/route.js';
import { getKit } from './cases/next-sqlite-box-react/chatwarden/handler.js';

// The generated Next.js recipe, run without Next: the route file's exports are called with Web Requests, as Next calls them.

const ORIGIN = 'http://localhost:3000';
const call = (name: keyof typeof route & string, path: string, init: RequestInit = {}): Promise<Response> =>
  (route[name as 'GET'] as (request: Request) => Promise<Response>)(new Request(`${ORIGIN}${path}`, { method: name, ...init }));
const as = (name: string, extra: Record<string, string> = {}): Record<string, string> => ({ 'x-chatwarden-key': keyOf(name), ...extra });
const fetchRoute = (url: string, init?: RequestInit): Promise<Response> => route.GET(new Request(url, init));
const streams: Listening[] = [];

let restoreEnv = (): void => undefined;
beforeAll(() => {
  restoreEnv = withEnv({ CHATWARDEN_SECRET: SECRET, CHATWARDEN_ADMIN_TOKEN: LONG_TOKEN, CHATWARDEN_DB: ':memory:', NODE_ENV: 'test', CHATWARDEN_TRUST_PROXY: undefined });
});
afterEach(() => {
  for (const s of streams.splice(0)) s.stop();
});
afterAll(async () => {
  await (await getKit()).close();
  restoreEnv();
});

describe('the route file', () => {
  it('exports GET POST PUT PATCH DELETE HEAD, runtime nodejs and dynamic force-dynamic', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const) expect(typeof route[method], method).toBe('function');
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});

describe('the exported handlers answer Web Requests', () => {
  it('/admin/me is 401 without a token or with a short or wrong one, and owner with the long one', async () => {
    expect((await call('GET', '/chatwarden/admin/me')).status).toBe(401);
    expect((await call('GET', '/chatwarden/admin/me', { headers: { 'x-admin-token': 'short' } })).status).toBe(401);
    expect((await call('GET', '/chatwarden/admin/me', { headers: { 'x-admin-token': `${LONG_TOKEN}x` } })).status).toBe(401);
    const ok = await call('GET', '/chatwarden/admin/me', { headers: { 'x-admin-token': LONG_TOKEN } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ role: 'owner' });
  });

  it('a blocked line is refused with rule 1 and reaches no other stream', async () => {
    const a = await listen(fetchRoute, `${ORIGIN}/chatwarden/chat/rooms/${ROOM}/stream`, as('alice'));
    const b = await listen(fetchRoute, `${ORIGIN}/chatwarden/chat/rooms/${ROOM}/stream`, as('bob'));
    streams.push(a, b);
    await a.until(hasHello);
    await b.until(hasHello);
    const post = (name: string, text: string): Promise<Response> =>
      call('POST', `/chatwarden/chat/rooms/${ROOM}/lines`, { headers: as(name, { 'content-type': 'application/json' }), body: JSON.stringify({ text }) });
    expect(await (await post('alice', 'hello bob')).json()).toMatchObject({ ok: true });
    await b.until((f) => f.some((x) => x.type === 'line'));
    const refused = await (await post('alice', `no ${BLOCKED_WORD}`)).json();
    expect(refused).toMatchObject({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    await settle();
    expect(a.text()).not.toContain(BLOCKED_WORD);
    expect(b.text()).not.toContain(BLOCKED_WORD);
    expect(a.frames()[0]).toMatchObject({ type: 'hello' });
    expect(a.text()).not.toContain(keyOf('alice'));
  });

  it('HEAD answers the GET status and headers with no body, and does not open a stream', async () => {
    const kit = await getKit();
    const before = kit.chat.stats().streams;
    const probe = await call('HEAD', '/chatwarden/healthz');
    expect(probe.status).toBe(200);
    expect(await probe.text()).toBe('');
    const stream = await call('HEAD', `/chatwarden/chat/rooms/${ROOM}/stream`, { headers: as('alice') });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(await stream.text()).toBe('');
    await settle(50);
    expect(kit.chat.stats().streams).toBe(before);
  });

  it('a body over the cap is 413 and a form content type is 400', async () => {
    const big = await call('POST', `/chatwarden/chat/rooms/${ROOM}/lines`, { headers: as('erin', { 'content-type': 'application/json' }), body: JSON.stringify({ text: 'x'.repeat(70_000) }) });
    expect(big.status).toBe(413);
    const form = await call('POST', `/chatwarden/chat/rooms/${ROOM}/lines`, { headers: as('erin', { 'content-type': 'application/x-www-form-urlencoded' }), body: 'text=hi' });
    expect(form.status).toBe(400);
  });

  it("an abort cancels the stream and stats().streams returns to 0", async () => {
    const kit = await getKit();
    const l = await listen(fetchRoute, `${ORIGIN}/chatwarden/chat/rooms/${ROOM}/stream`, as('cara'));
    await l.until(hasHello);
    expect(kit.chat.stats().streams).toBeGreaterThan(0);
    l.stop();
    const deadline = Date.now() + 3000;
    while (kit.chat.stats().streams > 0 && Date.now() < deadline) await settle(25);
    expect(kit.chat.stats().streams).toBe(0);
  });

  it('an unknown path under the prefix is the kit 404 and the same handler answers every method', async () => {
    const res = await call('GET', '/chatwarden/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
    expect((await call('DELETE', '/chatwarden/healthz')).status).toBe(405);
  });

  it('with no trust switch the address comes from the adapter (absent), not a header: a forged x-forwarded-for does not change who the player is', async () => {
    const a = await listen(fetchRoute, `${ORIGIN}/chatwarden/chat/rooms/${ROOM}/stream`, as('dina', { 'x-forwarded-for': '203.0.113.7' }));
    streams.push(a);
    await a.until(hasHello);
    expect(a.status).toBe(200);
    expect(a.text()).not.toContain('203.0.113.7');
  });
});

describe('the kit is built once', () => {
  it('across two imports of the module (a counter on the store opener)', async () => {
    const opened: string[] = [];
    vi.resetModules();
    vi.doMock('@chatwarden/store-memory', async (original) => {
      const real = await original<typeof import('@chatwarden/store-memory')>();
      return { ...real, createMemoryStore: (...args: Parameters<typeof real.createMemoryStore>) => (opened.push('open'), real.createMemoryStore(...args)) };
    });
    const slot = Symbol.for('chatwarden.ready');
    const holder = globalThis as unknown as Record<symbol, unknown>;
    const saved = holder[slot];
    delete holder[slot];
    try {
      const first = await import('./cases/next-memory-minimal/chatwarden/handler.js');
      vi.resetModules();
      const second = await import('./cases/next-memory-minimal/chatwarden/handler.js');
      expect(second).not.toBe(first);
      await Promise.all([first.handler(new Request(`${ORIGIN}/chatwarden/healthz`)), second.handler(new Request(`${ORIGIN}/chatwarden/healthz`)), first.getKit()]);
      expect(opened).toEqual(['open']);
      expect(await first.getKit()).toBe(await second.getKit());
      await (await first.getKit()).close();
    } finally {
      vi.doUnmock('@chatwarden/store-memory');
      holder[slot] = saved;
    }
  });
});

describe('the file list and the plan', () => {
  const project = { manager: 'npm' as const, react: true };
  const answersOf = (flags: string[]) => {
    const parsed = parseCli(['init', '--yes', ...flags.filter((flag) => flag !== '--src')]);
    if (parsed.command !== 'init') throw new Error('expected init');
    const answers = resolveAnswers(parsed, { frameworks: ['next'], react: true, socketio: false, manager: 'npm', ts: true, moduleType: 'module', srcDir: flags.includes('--src'), hasDir: false });
    if ('error' in answers) throw new Error(answers.error);
    return answers;
  };

  it('the file list for next is exactly kit, auth, terms, handler, HubPage, ChatPanel, .env.example under the dir plus the route and the page', () => {
    const recipe = CASES.find((c) => c.name === 'next-sqlite-box-react')!;
    const paths = renderCase(recipe).map((f) => f.path);
    expect(paths).toEqual(
      [
        'chatwarden/.env.example',
        'chatwarden/ChatPanel.tsx',
        'chatwarden/HubPage.tsx',
        'chatwarden/auth.ts',
        'chatwarden/handler.ts',
        'chatwarden/kit.ts',
        'chatwarden/terms.ts',
        'app/chatwarden/[...path]/route.ts',
        'app/chatwarden/mod/page.tsx',
      ].sort(),
    );
  });

  it('with src/app the route lands under src/app, and a custom base moves the route with it', () => {
    const src = renderAll({ ...answersOf(['--framework', 'next', '--hub', 'react', '--src']), dir: 'src/chatwarden' }, { chatwarden: VERSION }).map((f) => f.path);
    expect(src).toContain('src/app/chatwarden/[...path]/route.ts');
    expect(src).toContain('src/app/chatwarden/mod/page.tsx');
    expect(src.some((p) => p.startsWith('app/'))).toBe(false);
    const based = renderAll({ ...answersOf(['--framework', 'next', '--hub', 'react']), base: '/vlemmo/quissel' }, { chatwarden: VERSION }).map((f) => f.path);
    expect(based).toContain('app/vlemmo/quissel/[...path]/route.ts');
    // The route imports the handler by a relative specifier that climbs out of the route folder, with no extension.
    const route = renderAll({ ...answersOf(['--framework', 'next', '--hub', 'react']), base: '/vlemmo/quissel' }, { chatwarden: VERSION }).find((f) => f.path.endsWith('route.ts'))!;
    expect(route.content).toContain("from '../../../../chatwarden/handler'");
  });

  it('next with --hub element is a usage error naming the flag', () => {
    const parsed = parseCli(['init', '--yes', '--framework', 'next', '--hub', 'element']);
    if (parsed.command !== 'init') throw new Error('expected init');
    const answers = resolveAnswers(parsed, { frameworks: [], react: true, socketio: false, manager: 'npm', ts: true, moduleType: 'module', srcDir: false, hasDir: false });
    expect('error' in answers && answers.error).toMatch(/--hub element.*Next/s);
  });

  it('the next-steps text says "Node process, not serverless"', () => {
    const plan = buildPlan(answersOf(['--framework', 'next', '--hub', 'react']), { chatwarden: VERSION }, renderAll, project);
    expect(plan.nextSteps.join('\n')).toContain('Node process, not serverless');
    const express = buildPlan({ ...answersOf(['--framework', 'next', '--hub', 'react']), framework: 'express', hub: 'none' }, { chatwarden: VERSION }, renderAll, project);
    expect(express.nextSteps.join('\n')).not.toContain('serverless');
  });

  it('imports are extensionless (bundler resolution) in every Next file, JS included', () => {
    for (const lang of ['ts', 'js'] as const) {
      const files = renderAll({ ...answersOf(['--framework', 'next', '--hub', 'react', '--chat', 'box']), lang }, { chatwarden: VERSION }, { moduleType: 'commonjs' });
      for (const file of files) expect(file.content, file.path).not.toMatch(/from '\.{1,2}\/[^']*\.m?js'/);
      expect(files.map((f) => f.path).filter((p) => /\.(js|jsx)$/.test(p)).length).toBe(lang === 'js' ? 8 : 0);
      expect(files.some((f) => f.path.endsWith('.mjs'))).toBe(false);
    }
  });

  it('the client components say use client, the server files do not', () => {
    const files = renderCase(CASES.find((c) => c.name === 'next-sqlite-box-react')!);
    for (const path of ['chatwarden/HubPage.tsx', 'chatwarden/ChatPanel.tsx']) expect(files.find((f) => f.path === path)!.content.startsWith("'use client';")).toBe(true);
    for (const path of ['chatwarden/kit.ts', 'chatwarden/handler.ts', 'app/chatwarden/[...path]/route.ts']) expect(files.find((f) => f.path === path)!.content).not.toContain('use client');
  });
});
