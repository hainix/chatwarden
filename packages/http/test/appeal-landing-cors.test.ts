import { describe, expect, it } from 'vitest';
import { ORIGIN, landingWorld } from './landingWorld.js';
import type { LandingWorld } from './landingWorld.js';
import type { KitResponse } from '@chatwarden/http';

// CORS on the landing routes: only an origin the game listed (exact string match, the kit's one list `cw.appeals.landingOrigins()`) may read /appeal/case from a
// browser page. Never `*`, never credentials. The page itself (GET /appeal) is a document, not an API: it never carries a CORS header.

const cors = (res: KitResponse): Record<string, string> =>
  Object.fromEntries(Object.entries(res.headers ?? {}).filter(([k]) => k.toLowerCase().startsWith('access-control-')));

async function allFour(w: LandingWorld, token: string, origin: string | undefined) {
  const headers: Record<string, string> = origin === undefined ? {} : { origin };
  return {
    get: await w.page(token, { headers }),
    json: await w.caseJson(token, { headers }),
    post: await w.postJson({ t: token, statement: '' }, { headers }),
    options: await w.options(origin),
  };
}

describe('a listed origin', () => {
  it('OPTIONS answers with the allow-origin equal to it, the methods, the headers, max-age and vary', async () => {
    const w = await landingWorld();
    const res = await w.options(ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers).toMatchObject({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'origin',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    });
    expect(Object.keys(res.headers ?? {})).not.toContain('access-control-allow-credentials');
    expect(w.identifyCalls).toEqual([]);
  });

  it('GET and POST /appeal/case carry the allow-origin, vary, and never allow-credentials; errors carry it too', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const a = await allFour(w, s.token, ORIGIN);
    for (const [name, res] of [['json', a.json], ['post', a.post]] as const) {
      expect(res.headers?.['access-control-allow-origin'], name).toBe(ORIGIN);
      expect(res.headers?.vary, name).toBe('origin');
      expect(Object.keys(res.headers ?? {}), name).not.toContain('access-control-allow-credentials');
    }
    expect(a.json.status).toBe(200);
    expect(a.post.status).toBe(400); // an empty statement: an error answer still carries the header, so the page can read it
    const bad = await w.caseJson('forged.token', { headers: { origin: ORIGIN } });
    expect(bad.status).toBe(404);
    expect(bad.headers?.['access-control-allow-origin']).toBe(ORIGIN);
    // never a wildcard anywhere
    for (const res of Object.values(a)) expect(Object.values(res.headers ?? {})).not.toContain('*');
  });

  it('with several listed origins each is answered with its own value', async () => {
    const w = await landingWorld({ landing: { landingUrl: 'https://game.example/appeal', landingOrigins: ['https://game.example', 'https://www.game.example', 'http://localhost:5173'] } });
    for (const origin of ['https://game.example', 'https://www.game.example', 'http://localhost:5173']) {
      expect((await w.options(origin)).headers?.['access-control-allow-origin']).toBe(origin);
    }
  });
});

describe('an origin that is not listed', () => {
  it('none of a missing origin, the string "null", a different port, scheme, case or a trailing slash gets an allow-origin on any route; the OPTIONS answer has no CORS header; vary is still origin', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    const origins: Array<string | undefined> = [
      undefined,
      'null',
      'https://game.example:8443',
      'http://game.example',
      'https://game.example/',
      'https://GAME.example',
      'https://evil.example',
      'https://game.example.evil.example',
      'https://sub.game.example',
      '*',
      '',
    ];
    for (const origin of origins) {
      const a = await allFour(w, s.token, origin);
      for (const [name, res] of Object.entries(a)) {
        expect(cors(res), `${String(origin)} ${name}`).toEqual({});
      }
      expect(a.options.status, String(origin)).toBe(200);
      expect(a.json.headers?.vary, String(origin)).toBe('origin');
      expect(a.post.headers?.vary, String(origin)).toBe('origin');
      expect(a.options.headers?.vary, String(origin)).toBe('origin');
    }
  });

  it('the same status for a listed and an unlisted preflight (it does not reveal the list)', async () => {
    const w = await landingWorld();
    expect((await w.options(ORIGIN)).status).toBe((await w.options('https://evil.example')).status);
  });
});

describe('the page is not an api', () => {
  it('GET /appeal never carries a CORS header, even for a listed origin, and no vary: origin', async () => {
    const w = await landingWorld();
    const s = await w.sanctioned();
    for (const token of [s.token, 'forged.token']) {
      const res = await w.page(token, { headers: { origin: ORIGIN } });
      expect(cors(res)).toEqual({});
      expect(res.headers?.vary).toBeUndefined();
    }
  });
});

describe('the list comes from createChatwarden options', () => {
  it('landingOrigins is cw.appeals.landingOrigins(): the route uses the kit list', async () => {
    const w = await landingWorld({ landing: { landingUrl: 'https://game.example/appeal', landingOrigins: ['https://one.example'] } });
    expect([...w.cw.appeals.landingOrigins()]).toEqual(['https://one.example']);
    expect((await w.options('https://one.example')).headers?.['access-control-allow-origin']).toBe('https://one.example');
    expect(cors(await w.options(ORIGIN))).toEqual({});
  });

  it('an empty list, and no landing origins at all, let no origin through', async () => {
    const lists: Array<{ landingUrl: string; landingOrigins?: string[] }> = [{ landingUrl: 'https://game.example/appeal', landingOrigins: [] }, { landingUrl: 'https://game.example/appeal' }];
    for (const landing of lists) {
      const w = await landingWorld({ landing });
      const s = await w.sanctioned();
      const a = await allFour(w, s.token, ORIGIN);
      for (const [name, res] of Object.entries(a)) expect(cors(res), name).toEqual({});
    }
    // no landing options at all: no link can be made, and the routes still answer without a CORS header
    const none = await landingWorld({ landing: false });
    expect(none.cw.appeals.landingOrigins()).toEqual([]);
    expect(cors(await none.options(ORIGIN))).toEqual({});
    expect(cors(await none.caseJson('forged.token', { headers: { origin: ORIGIN } }))).toEqual({});
  });
});
