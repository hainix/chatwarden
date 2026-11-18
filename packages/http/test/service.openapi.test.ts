import { describe, expect, it } from 'vitest';
import { SERVICE_OPENAPI, buildServiceOpenApi } from '../src/service/openapi.js';
import { ROUTE_SPECS, SERVICE_SCHEMAS } from '../src/service/routes.js';
import { check } from './schemaCheck.js';
import { serviceWorld } from './serviceWorld.js';

// S2: SERVICE_OPENAPI is built from the same route descriptions the table is built from.

const doc = SERVICE_OPENAPI as unknown as {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { summary: string; operationId?: string; requestBody?: unknown; responses: Record<string, { content?: Record<string, { schema: unknown }> }>; security?: unknown }>>;
  components: { securitySchemes: Record<string, Record<string, unknown>>; schemas: Record<string, unknown> };
  security: Array<Record<string, unknown>>;
};

describe('openapi', () => {
  it('every route in the table has a description and the reverse', async () => {
    const w = await serviceWorld();
    const keys = Object.keys(w.routes).sort();
    expect(keys).toEqual(ROUTE_SPECS.map((s) => `${s.method} ${s.path}`).sort());
    expect(new Set(ROUTE_SPECS.map((s) => s.name)).size).toBe(ROUTE_SPECS.length);
    for (const s of ROUTE_SPECS) {
      expect(s.summary.length, s.name).toBeGreaterThan(10);
      expect(s.openapiPath.startsWith('/'), s.name).toBe(true);
    }
  });

  it('SERVICE_OPENAPI parses as OpenAPI 3.1 structure: paths, operations, the bearer security scheme', () => {
    const parsed = JSON.parse(JSON.stringify(SERVICE_OPENAPI)) as typeof doc;
    expect(parsed.openapi).toMatch(/^3\.1\.\d+$/);
    expect(typeof parsed.info.title).toBe('string');
    expect(typeof parsed.info.version).toBe('string');
    expect(parsed.components.securitySchemes.bearer).toEqual({ type: 'http', scheme: 'bearer' });
    expect(parsed.security).toEqual([{ bearer: [] }]);
    for (const s of ROUTE_SPECS) {
      const op = parsed.paths[`/v1${s.openapiPath === '/' ? '' : s.openapiPath}`]?.[s.method.toLowerCase()];
      expect(op, s.name).toBeDefined();
      expect(op!.summary).toBe(s.summary);
      expect(op!.responses['200']?.content?.['application/json']?.schema, s.name).toBeDefined();
      for (const code of ['400', '401', '429']) expect(op!.responses[code], `${s.name} ${code}`).toBeDefined();
      expect(Boolean(op!.requestBody), s.name).toBe(s.request !== undefined);
    }
    // the path items hold only HTTP methods
    for (const item of Object.values(parsed.paths)) for (const key of Object.keys(item)) expect(['get', 'put', 'post', 'delete']).toContain(key);
  });

  it('documents the answers the bridge and the router send: 404 (an id it refuses), 405, 408 (a body that did not arrive), 500, and invalid_value in the 400 text', () => {
    const parsed = JSON.parse(JSON.stringify(SERVICE_OPENAPI)) as { paths: Record<string, Record<string, { responses: Record<string, { description?: string }> }>> };
    for (const s of ROUTE_SPECS) {
      const op = parsed.paths[`/v1${s.openapiPath === '/' ? '' : s.openapiPath}`]![s.method.toLowerCase()]!;
      expect(op.responses['405'], `${s.name} 405`).toBeDefined();
      expect(op.responses['500'], `${s.name} 500`).toBeDefined();
      expect(op.responses['500']?.description, s.name).toContain('internal');
      expect(Boolean(op.responses['404']), `${s.name} 404`).toBe(s.openapiPath.includes('{'));
      expect(Boolean(op.responses['408']), `${s.name} 408`).toBe(s.request !== undefined);
      if (s.request !== undefined) expect(op.responses['408']?.description, s.name).toContain('request_timeout');
      expect(op.responses['400']?.description, s.name).toContain('invalid_value');
    }
  });

  it('paths use {braces} for params and every param name is the table\'s', () => {
    for (const s of ROUTE_SPECS) {
      const names = [...s.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
      const braces = [...s.openapiPath.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
      expect(braces, s.name).toEqual(names);
      expect(s.openapiPath, s.name).not.toContain(':');
    }
  });

  it('each documented example answer validates against the answer schema', () => {
    for (const s of ROUTE_SPECS) {
      expect(s.examples.length, s.name).toBeGreaterThan(0);
      for (const example of s.examples) expect(check(s.answer as never, example, { components: { schemas: SERVICE_SCHEMAS as never } }), `${s.name}: ${JSON.stringify(example)}`).toEqual([]);
    }
  });

  it('the checker is not vacuous: a wrong answer fails the schema of the handshake and of a line', () => {
    const handshake = ROUTE_SPECS.find((s) => s.name === 'handshake');
    const lines = ROUTE_SPECS.find((s) => s.name === 'lines');
    expect(handshake && lines).toBeTruthy();
    const doc = { components: { schemas: SERVICE_SCHEMAS as never } };
    expect(check(handshake!.answer as never, { api: '1' }, doc)).not.toEqual([]);
    expect(check(lines!.answer as never, { ok: true }, doc)).not.toEqual([]);
    expect(check(lines!.answer as never, { ok: false, refused: { reason: 5 } }, doc)).not.toEqual([]);
  });

  it('the request schemas accept the documented example bodies and refuse an unknown key', () => {
    for (const s of ROUTE_SPECS) {
      if (s.request === undefined) continue;
      expect(s.requestExample, s.name).toBeDefined();
      expect(check(s.request as never, s.requestExample, { components: { schemas: SERVICE_SCHEMAS as never } }), s.name).toEqual([]);
      expect(check(s.request as never, { ...(s.requestExample as object), surprise: 1 }, { components: { schemas: SERVICE_SCHEMAS as never } }), `${s.name} unknown key`).not.toEqual([]);
    }
  });

  it('the idempotent routes are the lines, the reports and (with phrases) the phrases, and say so in the document', () => {
    const idempotent = ROUTE_SPECS.filter((s) => s.idempotent === true).map((s) => s.name);
    expect(idempotent).toContain('lines');
    expect(idempotent).toContain('reports');
    for (const s of ROUTE_SPECS) {
      const op = doc.paths[`/v1${s.openapiPath === '/' ? '' : s.openapiPath}`]![s.method.toLowerCase()] as { parameters?: Array<{ name: string; in: string }> };
      const hasHeader = (op.parameters ?? []).some((p) => p.in === 'header' && p.name === 'Idempotency-Key');
      expect(hasHeader, s.name).toBe(s.idempotent === true);
    }
  });

  it('the document is deterministic: built twice it is byte for byte the same, and the export is that document', () => {
    expect(JSON.stringify(buildServiceOpenApi())).toBe(JSON.stringify(buildServiceOpenApi()));
    expect(JSON.stringify(SERVICE_OPENAPI)).toBe(JSON.stringify(buildServiceOpenApi()));
    expect(JSON.stringify(SERVICE_OPENAPI)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('the document names no key, no host and no real value; the examples hold only synthetic text', () => {
    const text = JSON.stringify(SERVICE_OPENAPI);
    expect(text).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(text).not.toMatch(/https?:\/\/(?!json-schema|spec\.openapis)/);
  });
});
