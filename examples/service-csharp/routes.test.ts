import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVICE_OPENAPI } from '../../packages/http/src/service/openapi.js';

// S6: the C# sample cannot be built in every contributor's environment (CI builds and runs it against a live service), so a local test checks it cannot drift: every path and method the client
// uses is in SERVICE_OPENAPI, every core route has a C# method, a path that is not in the spec fails, and the demo reads the same expectations file as conformance.mjs.

const DIR = fileURLToPath(new URL('.', import.meta.url));
const client = readFileSync(join(DIR, 'ChatwardenClient.cs'), 'utf8');
const program = readFileSync(join(DIR, 'Program.cs'), 'utf8');
const doc = SERVICE_OPENAPI as unknown as { paths: Record<string, Record<string, unknown>> };

/** `Send(HttpMethod.Put, $"/v1/rooms/{E(room)}/seats/{E(seat)}", ...)` as `PUT /v1/rooms/{room}/seats/{seat}`. */
function usedRoutes(source: string): Array<{ method: string; path: string }> {
  return [...source.matchAll(/HttpMethod\.(\w+),\s*\$?"([^"]+)"/g)].map((m) => ({ method: (m[1] as string).toLowerCase(), path: (m[2] as string).replace(/\{E\((\w+)\)\}/g, '{$1}') }));
}
const routes = usedRoutes(client);

describe('the C# client and the API description agree', () => {
  it('every path and method the client uses is in SERVICE_OPENAPI', () => {
    expect(routes.length).toBeGreaterThanOrEqual(12);
    for (const r of routes) {
      expect(doc.paths[r.path], `${r.method.toUpperCase()} ${r.path}`).toBeDefined();
      expect(Object.keys(doc.paths[r.path] ?? {}), `${r.method.toUpperCase()} ${r.path}`).toContain(r.method);
    }
  });

  it('every core route has a C# method: seat, unseat, lines, reports, notices pending, ack, restriction, doors check and names check, and mute', () => {
    const has = (method: string, path: string): boolean => routes.some((r) => r.method === method && r.path === path);
    expect(has('put', '/v1/rooms/{room}/seats/{seat}')).toBe(true);
    expect(has('delete', '/v1/rooms/{room}/seats/{seat}')).toBe(true);
    expect(has('post', '/v1/rooms/{room}/seats/{seat}/lines')).toBe(true);
    expect(has('post', '/v1/rooms/{room}/seats/{seat}/reports')).toBe(true);
    expect(has('post', '/v1/notices/pending')).toBe(true);
    expect(has('post', '/v1/notices/{id}/ack')).toBe(true);
    expect(has('post', '/v1/restriction')).toBe(true);
    expect(has('post', '/v1/doors/check')).toBe(true);
    expect(has('post', '/v1/names/check')).toBe(true);
    expect(has('put', '/v1/rooms/{room}/seats/{seat}/mutes/{target}')).toBe(true);
  });

  it('a path in the C# file that is not in the spec fails (the check above is not vacuous)', () => {
    const drifted = usedRoutes(`${client}\nSend(HttpMethod.Post, $"/v1/rooms/{E(room)}/not-a-route", null);`);
    const unknown = drifted.filter((r) => doc.paths[r.path] === undefined);
    expect(unknown).toEqual([{ method: 'post', path: '/v1/rooms/{room}/not-a-route' }]);
  });

  it('a path parameter is named as the spec names it (room, seat, target, id)', () => {
    for (const r of routes) for (const m of r.path.matchAll(/\{(\w+)\}/g)) expect(['room', 'seat', 'target', 'id']).toContain(m[1]);
  });
});

describe('what the C# client promises', () => {
  it('sends a bearer, an Idempotency-Key on lines and reports, honours retry-after on 429 and treats an unknown refusal reason as unknown', () => {
    expect(client).toContain('Authorization');
    expect(client).toContain('Bearer');
    expect(client).toContain('Idempotency-Key');
    expect(client).toMatch(/Retry-After|RetryAfter/);
    expect(client).toMatch(/"unknown"/);
  });

  it('a retry reuses the same Idempotency-Key: CheckLine and Report take an optional key, and the demo retries the refused line with the same one', () => {
    expect(client).toMatch(/CheckLine\(string room, string seat, string text, string\? idempotencyKey = null\)/);
    expect(client).toMatch(/Report\(string room, string seat, string target, string\? lineId = null, string\? reason = null, string\? idempotencyKey = null\)/);
    // Send uses a key it was given before it makes a fresh one
    expect(client).toMatch(/idempotencyKey \?\? Guid\.NewGuid\(\)/);
    const refused = program.match(/Step\("slur refused", await client\.CheckLine\(room, "alice", "[^"]+", (\w+)\)\)/);
    const retried = program.match(/Step\("slur retried", await client\.CheckLine\(room, "alice", "[^"]+", (\w+)\)\)/);
    expect(refused, 'the refused line passes a key').not.toBeNull();
    expect(retried, 'the retry passes a key').not.toBeNull();
    expect(retried?.[1]).toBe(refused?.[1]);
  });

  it('is about 200 lines over HttpClient and System.Text.Json, with no other dependency', () => {
    const lines = client.split('\n').length;
    expect(lines).toBeGreaterThan(80);
    expect(lines).toBeLessThan(320);
    expect(client).toContain('System.Text.Json');
    expect(client).toContain('HttpClient');
    const project = readFileSync(join(DIR, 'Chatwarden.Sample.csproj'), 'utf8');
    expect(project).toContain('net8.0');
    expect(project).not.toContain('PackageReference');
  });

  it('holds no key and no secret', () => {
    for (const text of [client, program]) {
      expect(text).not.toMatch(/Bearer [A-Za-z0-9_-]{16,}/);
      expect(text).not.toMatch(/[A-Za-z0-9+/=_-]{40,}/);
    }
  });
});

describe('the demo and the conformance script read the same expectations', () => {
  const expectations = JSON.parse(readFileSync(join(DIR, '..', 'service', 'expectations.json'), 'utf8')) as { steps: Array<{ name: string; expect: string[] }> };

  it('Program.cs reads expectations.json and names every step the file holds (and no other)', () => {
    expect(program).toContain('expectations.json');
    const named = [...program.matchAll(/Step\("([^"]+)"/g)].map((m) => m[1] as string);
    expect(named.sort()).toEqual(expectations.steps.map((s) => s.name).sort());
  });

  it('exits non-zero on any surprise: the demo returns 1 when a step fails', () => {
    expect(program).toMatch(/return 1;/);
    expect(program).toMatch(/return 0;/);
  });

  it('the folder holds the sources and the readme, and nothing that is built', () => {
    expect(readdirSync(DIR).sort()).toEqual(['Chatwarden.Sample.csproj', 'ChatwardenClient.cs', 'Program.cs', 'README.md', 'routes.test.ts']);
  });
});
