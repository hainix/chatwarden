import { describe, expect, it } from 'vitest';
import { world } from './world.js';

// With appeals and names left at their defaults (off), the existing staff bodies are what 0.1.7 sent: the same keys, and none of the
// new ones (`features`, `appeals`, `renames`, `handleFlagged`). A kit that sets the settings to false says the same as one that sets nothing.

const NEW_KEYS = ['"features"', '"appeals"', '"renames"', '"handleFlagged"', '"statementFlagged"'];

async function bodies(over: Parameters<typeof world>[0] = {}) {
  const w = await world(over);
  const f = await w.file();
  await w.cw.decide({
    reportId: f.id,
    verdict: 'upheld',
    actor: 'mod_ann',
    reason: 'private reason',
    actions: [{ subject: f.target, kind: 'chat', durationMs: 3_600_000, rule: 2, lineIds: [] }],
  } as never);
  const get = async (path: string, role: 'moderator' | 'senior' | 'owner' = 'moderator') => (await w.call('GET', path, { role })).body;
  return {
    me: await get('/me'),
    meOwner: await get('/me', 'owner'),
    changes: await get('/changes'),
    history: await get(`/people/${f.target}/history`),
    reports: await get('/reports'),
    one: await get(`/reports/${f.id}`),
    sanctions: await get('/sanctions'),
    blocked: await get('/blocked'),
  };
}

/** The shape of a body: every number, long id and reference code replaced by its type, so times and random ids do not matter. */
const shape = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' || (typeof x === 'string' && /^([A-Za-z0-9_-]{16,}|[A-Z]-[A-Z0-9]{5})$/.test(x)) ? typeof x : x));

describe('appeals off: 404 on every route and GET /me, GET /changes, GET /people/:ref/history are byte-identical to 0.1.7', () => {
  it('GET /me is { actor, role, can } and nothing else', async () => {
    const b = await bodies();
    expect(Object.keys(b.me as object).sort()).toEqual(['actor', 'can', 'role']);
    expect(Object.keys(b.meOwner as object).sort()).toEqual(['actor', 'can', 'role']);
  });

  it('GET /changes is exactly { token, changed }, in that order', async () => {
    const b = await bodies();
    const c = b.changes as { token: string; changed: boolean };
    expect(JSON.stringify(c)).toBe(JSON.stringify({ token: c.token, changed: true }));
  });

  it('GET /people/:ref/history keeps exactly its 0.1.7 keys', async () => {
    const b = await bodies();
    expect(Object.keys(b.history as object).sort()).toEqual(['asReporter', 'handle', 'history', 'reports', 'sanctions']);
  });

  it('no body anywhere carries a new key, and an explicit false says the same as the default', async () => {
    const plain = await bodies();
    const explicit = await bodies({ overrides: { appeals: { enabled: false }, names: { renames: false } } });
    for (const key of ['me', 'meOwner', 'history', 'reports', 'one', 'sanctions', 'blocked'] as const) {
      const text = JSON.stringify(plain[key]);
      for (const k of NEW_KEYS) expect(text, `${key} ${k}`).not.toContain(k);
    }
    for (const key of ['me', 'changes', 'history', 'reports', 'sanctions', 'blocked'] as const) expect(shape(explicit[key]), key).toBe(shape(plain[key]));
  });
});
