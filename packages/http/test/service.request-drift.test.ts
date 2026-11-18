import { describe, expect, it } from 'vitest';
import { SERVICE_OPENAPI } from '../src/service/openapi.js';
import { ROUTE_SPECS, SERVICE_SCHEMAS } from '../src/service/routes.js';
import type { RouteSpec } from '../src/service/routes.js';
import { check } from './schemaCheck.js';
import { serviceWorld } from './serviceWorld.js';
import type { ServiceWorld } from './serviceWorld.js';

// Review m6: the OpenAPI request schemas and the handlers that validate by hand must say the same thing. Every body below is judged twice, by the documented schema and by the live handler, and the two
// must agree: a body the schema accepts is never a 400, and a body the schema refuses always is. A generated client sends what the schema allows; this is what keeps that safe.

const DOC = { components: { schemas: SERVICE_SCHEMAS as never } };
const IDENTITY = { clientKey: 'raw-client-key-0001' };
const PARAMS: Record<string, string> = { ':room~room': 'drift-room', ':seat~room': 'a', ':target~room': 'b', ':id': 'n1' };

const pathOf = (spec: RouteSpec, overrides: Record<string, string> = {}): string => {
  let path = spec.path;
  for (const [token, value] of Object.entries({ ...PARAMS, ...overrides })) path = path.replace(token, value);
  return path;
};

interface Verdict {
  schema: boolean;
  server: boolean;
  status: number;
}

async function judge(w: ServiceWorld, spec: RouteSpec, body: unknown, path = pathOf(spec)): Promise<Verdict> {
  const schema = check(spec.request as never, body, DOC).length === 0;
  const res = await w.call(spec.method, path, { ...(body === undefined ? {} : { raw: JSON.stringify(body) }) });
  return { schema, server: res.status !== 400, status: res.status };
}

/** The service with the room's two seats filled, so a report or a line reaches the kit's own checks (an entity it refuses is then the 400 it is). */
async function driftWorld(): Promise<ServiceWorld> {
  const w = await serviceWorld();
  await w.seat('drift-room', 'a', 'plenk');
  await w.seat('drift-room', 'b', 'wumbo');
  return w;
}

const withRequest = ROUTE_SPECS.filter((s) => s.request !== undefined);
const byName = (name: string): RouteSpec => ROUTE_SPECS.find((s) => s.name === name) as RouteSpec;

describe('the documented example body of every route is accepted by both', () => {
  it('schema and handler agree on the example and answer it with something other than 400', async () => {
    const w = await driftWorld();
    for (const spec of withRequest) {
      const v = await judge(w, spec, spec.requestExample);
      expect(v, spec.name).toMatchObject({ schema: true, server: true });
    }
  });
});

describe('generated mutations of each example: schema and handler agree', () => {
  const BAD_VALUES: unknown[] = [null, 5, -1, 1.5, true, false, [], {}, [1], { a: 1 }, '', ' ', 'x', 'x'.repeat(65), 'x'.repeat(300), 'a b', '../x', 'a/b'];

  it('dropping a required key, adding an unknown key, and no body or a non-object body', async () => {
    const w = await driftWorld();
    for (const spec of withRequest) {
      const example = spec.requestExample as Record<string, unknown>;
      for (const key of (spec.request as { required: string[] }).required) {
        const rest = Object.fromEntries(Object.entries(example).filter(([k]) => k !== key));
        const v = await judge(w, spec, rest);
        expect(v, `${spec.name} without ${key}`).toMatchObject({ schema: false, server: false });
      }
      expect(await judge(w, spec, { ...example, surprise: 1 }), `${spec.name} unknown key`).toMatchObject({ schema: false, server: false });
      for (const body of [[], 'text', 5, null]) {
        const v = await judge(w, spec, body);
        expect(v.schema, `${spec.name} ${JSON.stringify(body)}`).toBe(false);
        expect(v.server, `${spec.name} ${JSON.stringify(body)}`).toBe(false);
      }
    }
  });

  for (const spec of withRequest) {
    it(`${spec.name}: every top-level field set to a range of wrong or edge values`, async () => {
      const w = await driftWorld();
      const example = spec.requestExample as Record<string, unknown>;
      const disagreements: string[] = [];
      for (const key of Object.keys(example)) {
        for (const bad of BAD_VALUES) {
          const body = { ...example, [key]: bad };
          const v = await judge(w, spec, body);
          if (v.schema !== v.server) disagreements.push(`${key}=${JSON.stringify(bad).slice(0, 40)} schema:${v.schema} server:${v.server} (${v.status})`);
        }
      }
      expect(disagreements).toEqual([]);
    });
  }
});

describe('who: a person is named by a client key or an account id; an address alone names nobody', () => {
  const WHO_CASES: Array<[string, unknown]> = [
    ['client key', { clientKey: 'k' }],
    ['account id', { accountId: 'a' }],
    ['both', { clientKey: 'k', accountId: 'a' }],
    ['client key and address', { clientKey: 'k', ip: '203.0.113.9' }],
    ['all three', { clientKey: 'k', accountId: 'a', ip: '203.0.113.9' }],
    ['address alone', { ip: '203.0.113.9' }],
    ['empty', {}],
    ['256 characters', { clientKey: 'k'.repeat(256) }],
    ['257 characters', { clientKey: 'k'.repeat(257) }],
    ['empty value', { clientKey: '' }],
    ['unknown key', { clientKey: 'k', extra: 'x' }],
    ['null value', { clientKey: null }],
    ['number value', { clientKey: 5 }],
    ['not an object', 'k'],
    ['array', [{ clientKey: 'k' }]],
    ['null', null],
  ];
  for (const name of ['notices_pending', 'notices_ack', 'record', 'restriction', 'doors_check']) {
    it(`${name} agrees on every shape of who`, async () => {
      const w = await driftWorld();
      const spec = byName(name);
      for (const [label, who] of WHO_CASES) {
        const v = await judge(w, spec, { ...(spec.requestExample as object), who });
        expect(v.schema, `${name}: ${label}`).toBe(v.server);
      }
    });
  }

  it('blocks_between agrees on who and on every entry of others', async () => {
    const w = await driftWorld();
    const spec = byName('blocks_between');
    for (const [label, who] of WHO_CASES) {
      const v = await judge(w, spec, { who, others: [IDENTITY] });
      expect(v.schema, `who ${label}`).toBe(v.server);
      const o = await judge(w, spec, { who: IDENTITY, others: [who] });
      expect(o.schema, `other ${label}`).toBe(o.server);
    }
    for (const others of [[], Array.from({ length: 50 }, () => IDENTITY), Array.from({ length: 51 }, () => IDENTITY), [null], 'x', {}]) {
      const v = await judge(w, spec, { who: IDENTITY, others });
      expect(v.schema, JSON.stringify(others).slice(0, 40)).toBe(v.server);
    }
  });

  it('names_check is the one route where an address alone is enough', async () => {
    const w = await driftWorld();
    const spec = byName('names_check');
    for (const [label, who] of WHO_CASES) {
      const v = await judge(w, spec, { name: 'Plenk', who });
      expect(v.schema, label).toBe(v.server);
    }
    expect((await judge(w, spec, { name: 'Plenk', who: { ip: '203.0.113.9' } })).schema).toBe(true);
  });

  it('seat needs a client key or an account id too', async () => {
    const w = await driftWorld();
    const spec = byName('seat');
    for (const [label, who] of WHO_CASES) {
      const v = await judge(w, spec, { who, handle: 'Plenk' });
      expect(v.schema, label).toBe(v.server);
    }
  });
});

describe('seat tags: the key grammar and the cap of 8', () => {
  const tags = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
  const CASES: Array<[string, unknown]> = [
    ['none', undefined],
    ['empty', {}],
    ['a good tag', { mode: 'ranked' }],
    ['8 tags', tags(8)],
    ['9 tags', tags(9)],
    ['an upper-case key', { Mode: 'ranked' }],
    ['a key starting with a digit', { '1mode': 'x' }],
    ['a key with a dash', { 'a-b': 'x' }],
    ['24-character key', { [`a${'b'.repeat(23)}`]: 'x' }],
    ['25-character key', { [`a${'b'.repeat(24)}`]: 'x' }],
    ['an empty key', { '': 'x' }],
    ['an empty value', { mode: '' }],
    ['a 64-character value', { mode: 'v'.repeat(64) }],
    ['a 65-character value', { mode: 'v'.repeat(65) }],
    ['a number value', { mode: 5 }],
    ['a null value', { mode: null }],
    ['a list', ['a']],
    ['null', null],
    ['a string', 'x'],
  ];
  it('schema and handler agree on every case', async () => {
    const w = await driftWorld();
    const spec = byName('seat');
    let n = 0;
    for (const [label, value] of CASES) {
      const body = { who: IDENTITY, handle: 'Plenk', ...(value === undefined ? {} : { tags: value }) };
      // a room of its own each time: tags merge into a room's, and the room holds at most 8
      n += 1;
      const v = await judge(w, spec, body, pathOf(spec, { ':room~room': `tag-room-${n}` }));
      expect(v.schema, label).toBe(v.server);
    }
  });
});

describe('report fields: line id, reason, note, entity', () => {
  const zero = String.fromCharCode(0);
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);
  const zwnj = String.fromCharCode(0x200c);
  const zwj = String.fromCharCode(0x200d);
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['a good line id', { lineId: 'l_1-A' }],
    ['a 64-character line id', { lineId: 'l'.repeat(64) }],
    ['a 65-character line id', { lineId: 'l'.repeat(65) }],
    ['a line id with a dot', { lineId: 'l.1' }],
    ['a line id with a space', { lineId: 'l 1' }],
    ['a line id with a colon', { lineId: 'l:1' }],
    ['a line id with a slash', { lineId: 'l/1' }],
    ['an empty line id', { lineId: '' }],
    ['null line id', { lineId: null }],
    ['null reason', { reason: null }],
    ['null note', { note: null }],
    ['a 500-character note', { note: 'n'.repeat(500) }],
    ['a 501-character note', { note: 'n'.repeat(501) }],
    ['a good entity', { entity: { kind: 'clan', ref: 'clan-42', label: 'Example Clan' } }],
    ['null entity', { entity: null }],
    ['an entity kind with a capital', { entity: { kind: 'Clan', ref: 'x', label: 'L' } }],
    ['an entity kind with a digit', { entity: { kind: 'clan2', ref: 'x', label: 'L' } }],
    ['a 24-character kind', { entity: { kind: 'k'.repeat(24), ref: 'x', label: 'L' } }],
    ['a 25-character kind', { entity: { kind: 'k'.repeat(25), ref: 'x', label: 'L' } }],
    ['an entity ref with a space', { entity: { kind: 'clan', ref: 'a b', label: 'L' } }],
    ['an entity ref with a colon', { entity: { kind: 'clan', ref: 'a:b', label: 'L' } }],
    ['an entity ref with a dot', { entity: { kind: 'clan', ref: 'a.b', label: 'L' } }],
    ['a 64-character ref', { entity: { kind: 'clan', ref: 'r'.repeat(64), label: 'L' } }],
    ['a 65-character ref', { entity: { kind: 'clan', ref: 'r'.repeat(65), label: 'L' } }],
    ['a 64-character label', { entity: { kind: 'clan', ref: 'x', label: 'L'.repeat(64) } }],
    ['a 65-character label', { entity: { kind: 'clan', ref: 'x', label: 'L'.repeat(65) } }],
    ['a whitespace-only label', { entity: { kind: 'clan', ref: 'x', label: '   ' } }],
    ['a label with a control character', { entity: { kind: 'clan', ref: 'x', label: `a${zero}b` } }],
    ['a label with a newline', { entity: { kind: 'clan', ref: 'x', label: 'a\nb' } }],
    ['a label with a direction override', { entity: { kind: 'clan', ref: 'x', label: `a${rlo}b` } }],
    ['a label with a zero-width space', { entity: { kind: 'clan', ref: 'x', label: `a${zwsp}b` } }],
    ['a label with a ZWNJ between two letters', { entity: { kind: 'clan', ref: 'x', label: `a${zwnj}b` } }],
    ['a label with a ZWJ between two letters', { entity: { kind: 'clan', ref: 'x', label: `a${zwj}b` } }],
    ['a label with a ZWNJ at the start', { entity: { kind: 'clan', ref: 'x', label: `${zwnj}ab` } }],
    ['a label with a ZWJ at the end', { entity: { kind: 'clan', ref: 'x', label: `ab${zwj}` } }],
    ['an entity with an extra key', { entity: { kind: 'clan', ref: 'x', label: 'L', owner: 's' } }],
    ['an entity without a label', { entity: { kind: 'clan', ref: 'x' } }],
    ['an entity that is a list', { entity: [] }],
    ['an entity that is a string', { entity: 'clan' }],
  ];
  it('schema and handler agree on every case', async () => {
    const w = await driftWorld();
    const spec = byName('reports');
    for (const [label, extra] of CASES) {
      const v = await judge(w, spec, { target: 'b', ...extra });
      expect(v.schema, label).toBe(v.server);
    }
  });
});

describe('path parameters: the documented pattern is what the handler enforces', () => {
  const idParam = (openapiPath: string, name: string): RegExp => {
    const doc = SERVICE_OPENAPI as unknown as { paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string; schema: { pattern: string } }> }>> };
    const item = Object.entries(doc.paths).find(([key]) => key === `/v1${openapiPath}`)?.[1] ?? {};
    const op = Object.values(item)[0];
    const param = (op?.parameters ?? []).find((p) => p.in === 'path' && p.name === name);
    if (param === undefined) throw new Error(`no parameter ${name}`);
    return new RegExp(param.schema.pattern);
  };

  it('the notice id in an ack: 1 to 64 characters of A-Za-z0-9_- and nothing else (anything else is a 404 from the router)', async () => {
    const w = await driftWorld();
    const spec = byName('notices_ack');
    const pattern = idParam(spec.openapiPath, 'id');
    for (const id of ['n1', 'a_b-C', 'x'.repeat(64), 'x'.repeat(65), 'a.b', 'a:b', 'a@b', 'a~b', 'a%20b', '..', '-', '_']) {
      const res = await w.call('POST', `/notices/${id}/ack`, { body: { who: IDENTITY } });
      // an id that cannot be the kit's is turned away by the router (404, so ids cannot be probed); one that can is answered 200, found or not
      expect(pattern.test(id), id).toBe(res.status === 200);
    }
  });

  it('a room or seat id: 1 to 128 characters of A-Za-z0-9_.:@~- and not only dots', async () => {
    const w = await driftWorld();
    const spec = byName('unseat');
    const pattern = idParam(spec.openapiPath, 'room');
    for (const id of ['r', 'a_b.c:d@e~f-g', 'r'.repeat(128), 'r'.repeat(129), 'a%20b', 'a%2Fb', 'a b', 'a!b', 'a*b', '.', '..']) {
      const res = await w.call('DELETE', `/rooms/${id}`);
      const decoded = decodeURIComponent(id);
      const documented = pattern.test(decoded) && !/^\.+$/.test(decoded);
      expect(documented, id).toBe(res.status !== 400);
    }
  });
});
