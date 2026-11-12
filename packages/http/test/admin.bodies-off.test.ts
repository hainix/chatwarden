import { describe, expect, it } from 'vitest';
import { world } from './world.js';

// With pacing off and no signal feed set, every body this release touches is what 0.1.6 sent: the same keys at every depth, and none of
// the new ones. A kit that declares signal kinds (but no feed) answers the same way as one that declares nothing.

/** The shape of a body: every value replaced by its type, and a subject id used as a key by `s_*`, so ids and times do not matter. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0])];
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [/^s_/.test(k) ? 's_*' : k, shape(x)]).sort(([a], [b]) => String(a).localeCompare(String(b))));
  return v === null ? 'null' : typeof v;
}

async function run(declare: boolean) {
  const w = await world(declare ? { overrides: { signals: { kinds: { muted_by_player: { label: 'Muted by other players', polarity: 'negative' } } } } as never } : {});
  const f = await w.file();
  const by = w.person();
  if (declare) w.cw.signals.record({ kind: 'muted_by_player', subject: f.target, by });
  const get = async (method: string, path: string, o: Record<string, unknown> = {}) => (await w.call(method, path, o as never)).body;
  return {
    list: await get('GET', '/reports'),
    one: await get('GET', `/reports/${f.id}`, { query: { level: 'rude' } }),
    suggest: await get('POST', `/reports/${f.id}/suggest`, { body: { level: 'rude' } }),
    history: await get('GET', `/people/${f.target}/history`),
    next: await get('POST', '/cases/next', { body: {} }),
    policy: await get('GET', '/policy/profile'),
  };
}

describe('bodies are byte-identical with everything off', () => {
  it('the 0.1.6 shape: no signals, boosted, signalBoost or dropped key anywhere', async () => {
    const a = await run(false);
    // The policy body carries the profile, which has its own `signals` section; every other body may not.
    const others = JSON.stringify({ list: a.list, one: a.one, suggest: a.suggest, history: a.history, next: a.next });
    for (const key of ['"signals"', '"boosted"', '"signalBoost"', '"dropped"']) expect(others, key).not.toContain(key);
    expect(others.length).toBeGreaterThan(100);
    expect(Object.keys(a.history as object).sort()).toEqual(['asReporter', 'handle', 'history', 'reports', 'sanctions']);
    expect(Object.keys(a.suggest as object).sort()).toEqual(['label', 'outcome', 'why']);
    expect(Object.keys((a.list as { items: object[] }).items[0]!).sort()).toEqual(
      ['actionedAt', 'actionedBy', 'ai', 'badFaith', 'category', 'claim', 'createdAt', 'id', 'reportedReason', 'reportedReasonLabel', 'reporterAccuracy', 'reporterHandle', 'reporterPerson', 'roomId', 'status', 'tags', 'targetHandle', 'targetPerson', 'viewing'],
    );
    expect(Object.keys((a.next as { case: object }).case).sort()).toEqual(['claim', 'person', 'reportId']);
    expect(Object.keys(a.policy as object).sort()).toEqual(['base', 'canSave', 'effective', 'layer', 'version']);
  });

  it('declaring kinds without any feed changes no body shape (the same shapes as declaring nothing)', async () => {
    const a = await run(false);
    const b = await run(true);
    for (const key of ['list', 'one', 'suggest', 'history', 'next'] as const) expect(shape(b[key]), key).toEqual(shape(a[key]));
  });
});
