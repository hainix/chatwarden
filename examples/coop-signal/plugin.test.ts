import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { verify, ReplayCache, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../../packages/http/src/webhooks/sign.js';
import { coopWorld } from '../../packages/http/test/coop-world.js';
import { createSignals, manifest } from './src/index.js';
import type { PluginSignalContext } from './src/index.js';

// K5 C6: the Coop plugin example. The kit's signal route is the real one in the round trip; everywhere else the kit is a scripted `fetch`. No network.

const SECRET = 'snerp-signal-secret-0123456789abcdef';
const KIT = 'https://game.example.test';
const NOW = 1_800_000_000_000;
const ORG = 'org-fenrisk';

const context = (cfg: Record<string, unknown> | null = { kitUrl: KIT, secret: SECRET }): PluginSignalContext => ({ getCredential: async () => cfg });

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string | undefined;
}
/** A scripted kit: records each request and answers with `answer`. */
function fakeKit(answer: () => Response | Promise<Response> = () => new Response(JSON.stringify({ severity: 63 }), { status: 200 })) {
  const seen: Seen[] = [];
  const fn = ((url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])), body: String(init.body), redirect: init.redirect });
    return Promise.resolve(answer());
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const signalOf = (ctx: PluginSignalContext, fetchFn: typeof fetch) => {
  const entry = createSignals(ctx, { fetch: fetchFn, now: () => NOW })[0];
  if (entry === undefined) throw new Error('no signal');
  return entry.descriptor;
};

const message = (i: number, over: Record<string, unknown> = {}) => ({ id: `msg-${i}`, typeId: 'type-line', authorId: `player-${i}`, data: { text: `line ${i} zorbak`, author: i % 2 === 0 ? 'reporter' : 'reported' }, ...over });
const input = (count = 3, item = 'the reported line vlemmo') => ({
  orgId: ORG,
  item: { id: 'rpt-1', typeId: 'type-report', data: { text: item } },
  value: { type: 'STRING', value: item },
  context: { thread: { messages: Array.from({ length: count }, (_, i) => message(i)), truncated: false } },
});

describe('the signal', () => {
  it('posts a correctly signed body to the kit and returns its severity as the score', async () => {
    const kit = fakeKit();
    const sig = signalOf(context(), kit.fn);
    const result = await sig.run(input());
    expect(result).toEqual({ outputType: { scalarType: 'NUMBER' }, score: 63 });
    expect(kit.seen).toHaveLength(1);
    const req = kit.seen[0]!;
    expect(req.url).toBe(`${KIT}/coop/signal`);
    expect(req.redirect).toBe('manual');
    expect(req.headers['content-type']).toBe('application/json');
    // The kit's own verifier accepts the plugin's independent HMAC.
    expect(verify(SECRET, req.headers, req.body, NOW, new ReplayCache())).toBe(true);
    expect(Number(req.headers[TIMESTAMP_HEADER])).toBe(Math.floor(NOW / 1000));
    expect(req.headers[SIGNATURE_HEADER]).toMatch(/^v1=[0-9a-f]{64}$/);
    // A flipped byte is refused.
    expect(verify(SECRET, req.headers, `${req.body} `, NOW, new ReplayCache())).toBe(false);
  });

  it('asks for the thread, and sends at most 20 labelled lines and no ids', async () => {
    const kit = fakeKit();
    const sig = signalOf(context(), kit.fn);
    expect(sig.contextNeeds).toEqual({ includeThread: true, maxThreadMessages: 20 });
    await sig.run(input(35));
    const body = JSON.parse(kit.seen[0]!.body) as { lines: Array<Record<string, unknown>>; item?: Record<string, unknown> };
    expect(body.lines).toHaveLength(20);
    // The newest twenty, in order.
    expect(body.lines[0]!['text']).toBe('line 15 zorbak');
    expect(body.lines[19]!['text']).toBe('line 34 zorbak');
    for (const l of body.lines) expect(Object.keys(l).sort()).toEqual(['label', 'text']);
    expect(body.lines.map((l) => l['label'])).toContain('reporter');
    expect(body.item).toEqual({ text: 'the reported line vlemmo' });
    const wire = kit.seen[0]!.body;
    for (const needle of ['msg-', 'player-', 'type-line', 'type-report', 'rpt-1', ORG, 'authorId']) expect(wire.includes(needle), needle).toBe(false);
  });

  it('with no thread the reported text goes as the one line, and with nothing to read it sends nothing', async () => {
    const kit = fakeKit();
    const sig = signalOf(context(), kit.fn);
    await sig.run({ ...input(0), context: {} });
    expect(JSON.parse(kit.seen[0]!.body)).toEqual({ lines: [{ label: 'reported', text: 'the reported line vlemmo' }] });
    const empty = await sig.run({ orgId: ORG });
    expect(kit.seen).toHaveLength(1);
    expect(empty).toMatchObject({ disabled: true });
    expect(empty).not.toHaveProperty('score');
  });

  it('a label that is not a short string becomes other, and a text is cut', async () => {
    const kit = fakeKit();
    const sig = signalOf(context(), kit.fn);
    const messages = [message(0, { data: { text: 'a'.repeat(900), author: { id: 'player-9' } } }), message(1, { data: { text: 5 } }), message(2, { data: { text: 'ok', author: 'reporter' } })];
    await sig.run({ ...input(0), context: { thread: { messages, truncated: false } } });
    const body = JSON.parse(kit.seen[0]!.body) as { lines: Array<{ label: string; text: string }> };
    expect(body.lines).toEqual([
      { label: 'other', text: 'a'.repeat(400) },
      { label: 'reporter', text: 'ok' },
    ]);
    expect(kit.seen[0]!.body).not.toContain('player-9');
  });

  it('a kit 503, a 401, a redirect, a network error and a bad answer produce no score', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response('', { status: 503 }),
      () => new Response('{}', { status: 401 }),
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } }),
      () => Promise.reject(new TypeError('connect ECONNREFUSED')),
      () => new Response('not json', { status: 200 }),
      () => new Response('[]', { status: 200 }),
      () => new Response('{}', { status: 200 }),
      () => new Response(JSON.stringify({ severity: '63' }), { status: 200 }),
      () => new Response(JSON.stringify({ severity: null }), { status: 200 }),
      () => new Response('{"severity": 1e999}', { status: 200 }),
      () => new Response('x'.repeat(100_000), { status: 200 }),
    ];
    for (const answer of answers) {
      const kit = fakeKit(answer);
      const result = await signalOf(context(), kit.fn).run(input());
      expect(result).toMatchObject({ disabled: true });
      expect(result).not.toHaveProperty('score');
      expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|snerp|game\.example/);
    }
  });

  it('a score outside 0 to 100 is clamped', async () => {
    for (const [given, expected] of [[150, 100], [-3, 0], [0, 0], [100, 100], [12.5, 12.5]] as const) {
      const kit = fakeKit(() => new Response(JSON.stringify({ severity: given }), { status: 200 }));
      expect(await signalOf(context(), kit.fn).run(input())).toEqual({ outputType: { scalarType: 'NUMBER' }, score: expected });
    }
  });

  it('missing or bad configuration produces no score and no request', async () => {
    const configs: Array<Record<string, unknown> | null> = [
      null,
      {},
      { kitUrl: KIT },
      { secret: SECRET },
      { kitUrl: KIT, secret: 'short' },
      { kitUrl: 'http://game.example.test', secret: SECRET },
      { kitUrl: 'ftp://game.example.test', secret: SECRET },
      { kitUrl: 'https://user:pass@game.example.test', secret: SECRET },
      { kitUrl: 'not a url', secret: SECRET },
      { kitUrl: 5, secret: SECRET },
    ];
    for (const cfg of configs) {
      const kit = fakeKit();
      const result = await signalOf(context(cfg), kit.fn).run(input());
      expect(result, JSON.stringify(cfg)).toMatchObject({ disabled: true });
      expect(kit.seen).toHaveLength(0);
    }
    const kit = fakeKit();
    const throwing: PluginSignalContext = { getCredential: () => Promise.reject(new Error('vault down')) };
    expect(await signalOf(throwing, kit.fn).run(input())).toMatchObject({ disabled: true });
    expect(kit.seen).toHaveLength(0);
  });

  it('http is allowed for localhost only, and a trailing slash on the kit URL is fine', async () => {
    const kit = fakeKit();
    await signalOf(context({ kitUrl: 'http://localhost:3000/', secret: SECRET }), kit.fn).run(input());
    expect(kit.seen[0]!.url).toBe('http://localhost:3000/coop/signal');
  });

  it('the descriptor is a numeric signal that names its type and is listed in the manifest', () => {
    const entry = createSignals(context())[0]!;
    expect(entry.descriptor.outputType).toEqual({ scalarType: 'NUMBER' });
    expect(entry.descriptor.eligibleInputs).toEqual(expect.arrayContaining(['STRING']));
    expect(manifest.signalTypeIds).toContain(entry.signalTypeId);
    expect(entry.descriptor.id).toEqual({ type: entry.signalTypeId });
  });
});

describe('the manifest', () => {
  it('has the required fields and the secret field is a password input', () => {
    expect(manifest.id).toBe('CHATWARDEN_AI_READ');
    for (const key of ['id', 'name', 'version', 'requiresConfig', 'configurationFields', 'signalTypeIds'] as const) expect(manifest[key], key).toBeDefined();
    expect(manifest.requiresConfig).toBe(true);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    const fields = Object.fromEntries(manifest.configurationFields.map((f) => [f.key, f]));
    expect(Object.keys(fields).sort()).toEqual(['kitUrl', 'secret']);
    expect(fields['secret']).toMatchObject({ required: true, inputType: 'password' });
    expect(fields['kitUrl']).toMatchObject({ required: true, inputType: 'text' });
    // Coop's documented limits on a field: a key of letters, digits and underscores that starts with a letter (64 at most), a label of 200 at most.
    for (const f of manifest.configurationFields) {
      expect(f.key).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
      expect(f.label.length).toBeLessThanOrEqual(200);
      expect((f.placeholder ?? '').length).toBeLessThanOrEqual(500);
    }
    expect(manifest.configurationFields.length).toBeLessThanOrEqual(50);
  });

  it('has no secret in it', () => {
    expect(JSON.stringify(manifest)).not.toMatch(/snerp|0123456789abcdef/);
  });
});

describe('the file', () => {
  const source = readFileSync(new URL('./src/index.ts', import.meta.url), 'utf8');

  it('depends on no @roostorg package at run time: the types it needs are declared in the file and the two package names are in a comment', () => {
    expect(source).not.toMatch(/from\s+['"]@roostorg\//);
    expect(source).not.toMatch(/import\(['"]@roostorg/);
    expect(source).toContain('@roostorg/coop-types');
    expect(source).toContain('@roostorg/types');
    expect(source).toMatch(/UNVERIFIED/);
  });

  it('is about 120 lines or fewer of code and uses only node:crypto', () => {
    expect(source.split('\n').length).toBeLessThan(260);
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:crypto']);
  });
});

describe('against the real adapter route', () => {
  it('the round trip works: the plugin signs, the adapter verifies, read answers, the plugin returns the score', async () => {
    const reads: Array<ReadonlyArray<{ label: string; text: string }>> = [];
    const c = await coopWorld({
      options: {
        signal: {
          secret: SECRET,
          read: (lines: ReadonlyArray<{ label: string; text: string }>) => {
            reads.push(lines);
            return 71.5;
          },
        },
      },
    });
    const viaAdapter = (async (url: string, init: RequestInit) => {
      expect(new URL(url).pathname).toBe('/coop/signal');
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const res = await c.send({ method: 'POST', path: '/coop/signal', query: {}, headers, body: undefined, rawBody: String(init.body) });
      return new Response(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof fetch;
    // The plugin signs with the world's clock: the adapter's 5 minute window is checked against it.
    const entry = createSignals(context(), { fetch: viaAdapter, now: () => c.w.clock.now() })[0]!;
    const result = await entry.descriptor.run(input(4));
    expect(result).toEqual({ outputType: { scalarType: 'NUMBER' }, score: 71.5 });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.map((l) => l.text)).toEqual(['line 0 zorbak', 'line 1 zorbak', 'line 2 zorbak', 'line 3 zorbak', 'the reported line vlemmo']);
    expect(reads[0]!.slice(0, 4).map((l) => l.label)).toEqual(['reporter', 'reported', 'reporter', 'reported']);

    // A wrong secret in the plugin's config is a refusal by the adapter, so no score.
    const wrong = createSignals(context({ kitUrl: KIT, secret: 'a-completely-different-secret-0123456789' }), { fetch: viaAdapter, now: () => c.w.clock.now() })[0]!;
    expect(await wrong.descriptor.run(input())).toMatchObject({ disabled: true });
    expect(reads).toHaveLength(1);
    c.adapter.dispose();
  });

  it('an adapter whose read fails answers 503 and the plugin returns no score', async () => {
    const c = await coopWorld({ options: { signal: { secret: SECRET, read: () => Promise.reject(new Error('ai down')) } } });
    const viaAdapter = (async (_url: string, init: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const res = await c.send({ method: 'POST', path: '/coop/signal', query: {}, headers, body: undefined, rawBody: String(init.body) });
      return new Response(typeof res.body === 'string' ? res.body : JSON.stringify(res.body), { status: res.status });
    }) as unknown as typeof fetch;
    const entry = createSignals(context(), { fetch: viaAdapter, now: () => c.w.clock.now() })[0]!;
    const result = await entry.descriptor.run(input());
    expect(result).toMatchObject({ disabled: true });
    expect(result).not.toHaveProperty('score');
    c.adapter.dispose();
  });

  it('does not touch the network at import or construction', () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    createSignals(context());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
