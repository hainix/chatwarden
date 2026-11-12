import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as http from '../src/index.js';
import type { CompiledRoutes, KitResponse, KitStream, RouteTable } from '../src/index.js';
import type { KitStream as AdminKitStream } from '../src/admin-entry.js';
import type { KitStream as DeclaredKitStream } from '../src/types.js';
import * as wire from '../src/chat/wire.js';
import { compileRoutes } from '../src/router.js';
import { RETRY_AFTER_CAP_MS, RETRY_AFTER_FLOOR_MS } from '../src/webhooks/out.js';

const ok = (): KitResponse => ({ status: 200, headers: {}, body: '{}' }) as unknown as KitResponse;

describe('the public exports an adapter author needs', () => {
  it('matchRoute is exported and is the compiler the Express adapter uses', () => {
    expect(typeof http.matchRoute).toBe('function');
    expect(http.matchRoute).toBe(compileRoutes);
  });

  it('matchRoute(table) gives run and matches, per its contract', async () => {
    const table: RouteTable = { 'GET /things/:id': ok };
    const compiled: CompiledRoutes = http.matchRoute(table);
    expect(compiled.matches('/things/7')).toBe(true);
    expect(compiled.matches('/things/7?x=1')).toBe(true); // the query string is ignored
    expect(compiled.matches('/elsewhere')).toBe(false); // not this table's: hand it on
    expect(compiled.matches('/things')).toBe(false);
    expect(compiled.matches('/things/7', 'POST')).toBe(true); // other method: run answers 405, so it is still this table's
    expect(compiled.matches('/things/7', 'OPTIONS')).toBe(false); // a preflight is the app's CORS middleware's, unless a route answers OPTIONS
    const hit = await compiled.run({ method: 'GET', path: '/things/7', headers: {}, body: undefined } as never);
    expect(hit.status).toBe(200);
    const miss = await compiled.run({ method: 'GET', path: '/elsewhere', headers: {}, body: undefined } as never);
    expect(miss.status).toBe(404);
    const wrong = await compiled.run({ method: 'DELETE', path: '/things/7', headers: {}, body: undefined } as never);
    expect(wrong.status).toBe(405);
  });

  it('matchRoute rejects a malformed route key with a RangeError, like createRouter', () => {
    expect(() => http.matchRoute({ nope: ok })).toThrow(RangeError);
    expect(() => http.matchRoute({ 'GET /a': ok, 'GET /a ': ok })).toThrow(RangeError);
  });

  it('createRouter and matchRoute stay in step: the same table answers the same request the same way', async () => {
    const table: RouteTable = { 'GET /a/:id': ok };
    const req = { method: 'GET', path: '/a/1', headers: {}, body: undefined } as never;
    expect((await http.createRouter(table)(req)).status).toBe((await http.matchRoute(table).run(req)).status);
  });

  it('RETRY_AFTER_FLOOR_MS is exported, is one second, and sits below the cap', () => {
    expect(http.RETRY_AFTER_FLOOR_MS).toBe(RETRY_AFTER_FLOOR_MS);
    expect(http.RETRY_AFTER_FLOOR_MS).toBe(1000);
    expect(http.RETRY_AFTER_FLOOR_MS).toBeLessThan(http.RETRY_AFTER_CAP_MS);
    expect(http.RETRY_AFTER_CAP_MS).toBe(RETRY_AFTER_CAP_MS);
  });

  it('keeps compileRoutes internal: the old name is not part of the public surface', () => {
    expect('compileRoutes' in http).toBe(false);
  });

  it('exports: KitStream is a type export of the root and of /admin', () => {
    expectTypeOf<KitStream>().toEqualTypeOf<DeclaredKitStream>();
    expectTypeOf<AdminKitStream>().toEqualTypeOf<DeclaredKitStream>();
    expectTypeOf<KitResponse['stream']>().toEqualTypeOf<KitStream | undefined>();
    expectTypeOf<KitStream['start']>().toEqualTypeOf<(sink: { write(chunk: string): boolean; end(): void }) => () => void>();
    // a type has no run-time binding in either entry
    expect('KitStream' in http).toBe(false);
    for (const entry of ['../src/index.ts', '../src/admin-entry.ts']) {
      const text = readFileSync(new URL(entry, import.meta.url), 'utf8');
      expect(text).toMatch(/export type \{[^}]*KitStream[^}]*\} from '\.\/types\.js'/);
    }
  });

  it('exports: the chat wire types, the broadcaster and the chat routes are on the root', () => {
    expect(http.CHAT_WIRE_VERSION).toBe(1);
    expect(http.CHAT_WIRE_VERSION).toBe(wire.CHAT_WIRE_VERSION);
    expectTypeOf<http.ChatFrame>().toEqualTypeOf<wire.ChatFrame>();
    expectTypeOf<http.WireLine>().toEqualTypeOf<wire.WireLine>();
    expectTypeOf<http.WireRestriction>().toEqualTypeOf<wire.WireRestriction>();
    expectTypeOf<http.WireMuted>().toEqualTypeOf<wire.WireMuted>();
    expectTypeOf<http.WireRefusal>().toEqualTypeOf<wire.WireRefusal>();
    expectTypeOf<http.SendResult>().toEqualTypeOf<wire.SendResult>();
    expectTypeOf<http.MuteTarget>().toEqualTypeOf<wire.MuteTarget>();
    expectTypeOf<http.MuteResult>().toEqualTypeOf<wire.MuteResult>();
    expectTypeOf<wire.MuteResult>().toEqualTypeOf<{ ok: boolean; hiddenIds: string[] }>();
    expectTypeOf<http.ReportOutcome>().toEqualTypeOf<wire.ReportOutcome>();
    // types have no run-time binding
    for (const name of ['ChatFrame', 'WireLine', 'WireRestriction', 'WireMuted', 'WireRefusal', 'SendResult', 'MuteTarget', 'MuteResult', 'ReportOutcome']) {
      expect(name in http).toBe(false);
    }
    for (const name of ['chatRoutes', 'createRoomBroadcaster', 'encodeFrame', 'HEARTBEAT', 'refusalOf', 'ROOM_BROADCASTER_DEFAULTS']) {
      expect(typeof (http as Record<string, unknown>)[name], name).not.toBe('undefined');
    }
  });
});
