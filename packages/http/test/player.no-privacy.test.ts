import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Chatwarden } from '@chatwarden/core';
import { createRouter, playerRoutes } from '@chatwarden/http';
import { ALICE, identifyFromHeaders, playerWorld } from './playerWorld.js';

// No player route reaches `cw.privacy` or `cw.legal` (design 9): erase, export and the hold are staff and owner tools. A table of every player route, each called with a
// spy kit that records every read of those two members; and a source check that nothing outside the admin routes names them.

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (p.endsWith('.ts')) yield p;
  }
}

describe('player routes never touch cw.privacy or cw.legal', () => {
  it('every route of the player table, called with a spy kit, reads neither member', async () => {
    const w = await playerWorld({ names: { renames: true } });
    const touched: string[] = [];
    const spy = new Proxy(w.cw, {
      get(target, prop, receiver) {
        if (prop === 'privacy' || prop === 'legal') touched.push(String(prop));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Chatwarden;
    const routes = playerRoutes(spy, { identify: identifyFromHeaders, now: () => w.clock.t });
    const router = createRouter(routes);
    const names = Object.keys(routes);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      const [method, template] = name.split(' ') as [string, string];
      const path = template.replace(/:[A-Za-z]+/g, 'x');
      const body = method === 'GET' ? undefined : JSON.stringify({ noticeId: 'x', statement: 'a statement', name: 'x' });
      const res = await router({
        method,
        path,
        query: {},
        headers: { 'x-key': ALICE.clientKey as string },
        body: undefined,
        ...(body === undefined ? {} : { rawBody: body }),
      });
      expect(res.status, name).toBeLessThan(600);
    }
    expect(touched).toEqual([]);
  });

  it('no player-side route is named like a privacy or hold route', () => {
    const w = playerWorld({});
    return w.then((x) => {
      for (const name of Object.keys(x.routes)) expect(name.toLowerCase(), name).not.toMatch(/privacy|erase|export|hold|bundle|legal/);
    });
  });

  it('nothing outside the admin routes names cw.privacy or cw.legal (a source scan)', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const rel = file.slice(SRC.length).replaceAll('\\', '/');
      if (rel.startsWith('admin/')) continue;
      const text = readFileSync(file, 'utf8');
      if (/\bcw\.(privacy|legal)\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the admin routes that use them are the privacy and legal route files and the report body (its hold key)', () => {
    const users: string[] = [];
    for (const file of sources(join(SRC, 'admin'))) {
      const text = readFileSync(file, 'utf8');
      if (/\bcw\.(privacy|legal)\b/.test(text)) users.push(file.slice(SRC.length).replaceAll('\\', '/'));
    }
    expect(users.sort()).toEqual(['admin/legal.ts', 'admin/privacy.ts', 'admin/reports.ts']);
  });
});
