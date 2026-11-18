import { describe, expect, it } from 'vitest';
import type { KitResponse } from '../src/index.js';
import { errorOf, world } from './world.js';
import type { WorldOptions } from './world.js';

// M3: GET /policy/contexts (the read-only list behind Settings > Advanced and the case chip) and the room's context on a report. Contexts are declared in code; the route shows names, labels
// and which sections each overrides, never a value (no word list, no pace number).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: KitResponse): Record<string, any> => res.body as Record<string, any>;

const CONTEXTS: NonNullable<NonNullable<WorldOptions['overrides']>['contexts']> = {
  kids: { label: 'Kids rooms', profanity: { mode: 'refuse', add: ['snerp'] }, pace: { slowModeMs: 3000 }, chat: { minAccountAgeDays: 7 } },
  ranked: { profanity: { mode: 'allow' } },
  plain: {},
  filtered: { label: 'Links off', filters: { links: { action: 'refuse' } } },
};

describe('GET /policy/contexts', () => {
  it('lists the declared contexts in declaration order with their label and the sections they override, and no value', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    const res = await w.call('GET', '/policy/contexts');
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({
      contexts: [
        { name: 'kids', label: 'Kids rooms', overrides: ['profanity', 'pace', 'chat'] },
        { name: 'ranked', label: 'ranked', overrides: ['profanity'] },
        { name: 'plain', label: 'plain', overrides: [] },
        { name: 'filtered', label: 'Links off', overrides: ['filters'] },
      ],
    });
    const text = JSON.stringify(res.body);
    for (const value of ['snerp', '3000', 'refuse', '"allow"', 'minAccountAgeDays']) expect(text, value).not.toContain(value);
  });

  it('is an empty list when none is declared', async () => {
    const w = await world();
    const res = await w.call('GET', '/policy/contexts');
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ contexts: [] });
  });

  it('needs policy.read: a moderator by default, raised to senior it is 403 below, 401 without a caller', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    expect((await w.call('GET', '/policy/contexts', { role: 'moderator' })).status).toBe(200);
    expect((await w.call('GET', '/policy/contexts', { role: null })).status).toBe(401);
    const raised = await world({ overrides: { contexts: CONTEXTS }, permissions: { 'policy.read': 'senior' } });
    const low = await raised.call('GET', '/policy/contexts', { role: 'moderator' });
    expect(low.status).toBe(403);
    expect(errorOf(low)).toBe('forbidden');
    expect((await raised.call('GET', '/policy/contexts', { role: 'senior' })).status).toBe(200);
  });

  it('is 403 for a scoped caller (not scope-aware)', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    const res = await w.call('GET', '/policy/contexts', { role: 'senior', scope: ['creator:alice'] });
    expect(res.status).toBe(403);
  });

  it('is no-store, writes no audit row and reads the profile live (it is the code\'s, so a stored layer never changes it)', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    const res = await w.call('GET', '/policy/contexts');
    expect(res.headers?.['cache-control']).toBe('no-store');
    expect(w.routeAudit()).toEqual([]);
    expect(w.cw.policy.save({ pace: { slowModeMs: 9000 } }, { version: 0, actor: 'owner_ann', reason: 'tuning' }).ok).toBe(true);
    expect(body(await w.call('GET', '/policy/contexts')).contexts).toHaveLength(4);
  });

  it('a label is text, never markup (it is sent as written)', async () => {
    const w = await world({ overrides: { contexts: { kids: { label: '<b>Kids</b>' } } } });
    expect(body(await w.call('GET', '/policy/contexts')).contexts[0].label).toBe('<b>Kids</b>');
  });
});

describe('the room\'s context on a report', () => {
  const fileIn = async (w: Awaited<ReturnType<typeof world>>, tags: Record<string, string> | undefined, n: number) => {
    const room = `ctx-room-${n}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: `ctx-rep-${n}-aaaaaaaaaa` }, 'Rep', tags);
    w.cw.rooms.seat(room, 'p2', { clientKey: `ctx-tgt-${n}-aaaaaaaaaa` }, 'Tgt');
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!res.ok) throw new Error('refused');
    return res.reportId;
  };

  it('the report detail carries context for a tagged room and null otherwise', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    const kids = await fileIn(w, { context: 'kids' }, 1);
    const none = await fileIn(w, undefined, 2);
    const other = await fileIn(w, { mode: 'ranked' }, 3);
    expect(body(await w.call('GET', `/reports/${kids}`)).report.context).toBe('kids');
    expect(body(await w.call('GET', `/reports/${none}`)).report.context).toBeNull();
    expect(body(await w.call('GET', `/reports/${other}`)).report.context).toBeNull();
  });

  it('an undeclared context name is carried as written (the chip shows it)', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    const typo = await fileIn(w, { context: 'kidz' }, 1);
    expect(body(await w.call('GET', `/reports/${typo}`)).report.context).toBe('kidz');
  });

  it('the queue row carries context only for a tagged room', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    const kids = await fileIn(w, { context: 'kids' }, 1);
    const none = await fileIn(w, undefined, 2);
    const rows = Object.fromEntries(body(await w.call('GET', '/reports')).items.map((i: { id: string }) => [i.id, i]));
    expect(rows[kids].context).toBe('kids');
    expect('context' in rows[none]).toBe(false);
  });

  it('a scoped caller reads the same context on a report in scope', async () => {
    const w = await world({ overrides: { contexts: CONTEXTS } });
    const id = await fileIn(w, { context: 'kids', scope: 'creator:alice' }, 1);
    expect(body(await w.call('GET', `/reports/${id}`, { scope: ['creator:alice'] })).report.context).toBe('kids');
    expect((await w.call('GET', `/reports/${id}`, { scope: ['creator:bob'] })).status).toBe(404);
  });

  it('with no contexts declared a tagged report still carries its tag (the server does not judge it)', async () => {
    const w = await world();
    const id = await fileIn(w, { context: 'kids' }, 1);
    expect(body(await w.call('GET', `/reports/${id}`)).report.context).toBe('kids');
  });
});
