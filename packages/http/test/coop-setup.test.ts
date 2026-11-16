import { defineRules } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { ACTION, API_KEY, DOCUMENTED_FIELDS, ITEM_TYPES, TYPE_LINE, TYPE_REPORT, TYPE_USER, coopWorld, sharedPair } from './coop-world.js';
import type { CoopWorld } from './coop-world.js';

// K5 C4: Coop has no write API for item types, policies or actions, so setup is a checklist the adopter follows by hand, and `verify` is a read-only self-check.

const schemaOf = (kind: 'user' | 'line' | 'report', drop: string[] = []) => DOCUMENTED_FIELDS[kind].filter((f) => !drop.includes(f.name));

/** What a correctly set up Coop would list. */
const fullCoop = (over: { itemTypes?: unknown } = {}) => ({
  policies: [
    { id: 'policy-harass', name: 'Harassment' },
    { id: 'policy-spam', name: 'Spam' },
  ],
  actions: Object.values(ACTION).map((id): { id: string; name: string } => ({ id, name: id })),
  itemTypes: (over.itemTypes ?? [
    { id: TYPE_USER, name: 'User', kind: 'USER', schema: schemaOf('user') },
    { id: TYPE_LINE, name: 'Line', kind: 'CONTENT', schema: schemaOf('line') },
    { id: TYPE_REPORT, name: 'Report', kind: 'CONTENT', schema: schemaOf('report') },
  ]) as never,
});

const GET_ONLY = (c: CoopWorld) => c.fake.calls.every((call) => call.method === 'GET') && c.fake.refused.length === 0;

describe('setup.checklist', () => {
  it('lists one policy per active Community Rule with its text, the three item types with the field names buildReport uses, and says not to use Ignore', async () => {
    const rules = defineRules([
      { number: 1, title: 'Respect others', text: 'Do not zorbak other players.' },
      { number: 2, title: 'No spam', text: 'Do not vlemmo the chat.' },
      { number: 3, title: 'Old rule', text: 'Retired rule text.', retired: true },
      { number: 4, title: 'No cheating', text: 'Do not quissel the game.' },
    ]);
    const c = await coopWorld({ world: { rules }, fake: fullCoop() });
    const list = c.adapter.setup.checklist();
    expect(list.policies).toEqual([
      { name: 'Community Rule 1: Respect others', policyText: 'Do not zorbak other players.' },
      { name: 'Community Rule 2: No spam', policyText: 'Do not vlemmo the chat.' },
      { name: 'Community Rule 4: No cheating', policyText: 'Do not quissel the game.' },
    ]);
    expect(list.itemTypes.map((t) => [t.key, t.fields.map((f) => f.name)])).toEqual([
      ['user', DOCUMENTED_FIELDS.user.map((f) => f.name)],
      ['line', DOCUMENTED_FIELDS.line.map((f) => f.name)],
      ['report', DOCUMENTED_FIELDS.report.map((f) => f.name)],
    ]);
    expect(list.itemTypes.map((t) => t.fields)).toEqual([DOCUMENTED_FIELDS.user, DOCUMENTED_FIELDS.line, DOCUMENTED_FIELDS.report]);
    expect(list.notes.join(' ')).toMatch(/Ignore/);
    expect(list.notes.join(' ')).toMatch(/Dismiss/i);
    c.adapter.dispose();
  });

  it('lists one action per configured meaning, each with the callback URL and strikes off', async () => {
    const c = await coopWorld({ fake: fullCoop() });
    const list = c.adapter.setup.checklist();
    expect(list.actions).toHaveLength(7);
    for (const a of list.actions) {
      expect(a.callbackUrl).toBe('<your public URL>/coop/actions');
      expect(a.strikes).toBe(false);
      expect(a.name.length).toBeGreaterThan(2);
    }
    const names = list.actions.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('Warn');
    expect(names).toContain('Dismiss');
    c.adapter.dispose();
  });

  it('toText is plain text with every policy, every item type field, every action and the notes', async () => {
    const c = await coopWorld({ fake: fullCoop() });
    const list = c.adapter.setup.checklist();
    const text = list.toText();
    expect(typeof text).toBe('string');
    for (const p of list.policies) expect(text).toContain(p.name);
    for (const t of list.itemTypes) for (const f of t.fields) expect(text).toContain(f.name);
    for (const a of list.actions) expect(text).toContain(a.name);
    for (const n of list.notes) expect(text).toContain(n);
    expect(text).toContain('<your public URL>/coop/actions');
    expect(text).not.toMatch(/\r/);
    c.adapter.dispose();
  });

  it('carries no secret and no id of the kit: not the api key, the public key, a callback header value or a report', async () => {
    const c = await coopWorld({ options: { callbackAuth: { header: 'x-callback-key', value: 'snerp-callback-value-1' } } });
    await c.w.file('harassment');
    const text = JSON.stringify(c.adapter.setup.checklist()) + c.adapter.setup.checklist().toText();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(sharedPair().publicPem.split('\n')[1] as string);
    expect(text).not.toContain('snerp-callback-value-1');
    expect(text).toContain('x-callback-key');
    c.adapter.dispose();
  });
});

describe('setup.verify', () => {
  it('a correct Coop is complete: nothing missing, nothing written', async () => {
    const c = await coopWorld({ fake: fullCoop() });
    const res = await c.adapter.setup.verify();
    expect(res).toEqual({
      ok: true,
      complete: true,
      policies: { missing: [] },
      actions: { missing: [], unmapped: [] },
      itemTypes: { missing: [], fieldProblems: [] },
    });
    expect(c.fake.calls.map((x) => `${x.method} ${x.path.replace(/\/+$/, '')}`).sort()).toEqual(['GET /api/v1/actions', 'GET /api/v1/item_types', 'GET /api/v1/policies']);
    expect(GET_ONLY(c)).toBe(true);
    c.adapter.dispose();
  });

  it('reports a configured policy id that Coop does not list, an action id that is not there, a Coop action with no mapping and an item type missing a field', async () => {
    const fake = fullCoop({
      itemTypes: [
        { id: TYPE_USER, name: 'User', kind: 'USER', schema: [] },
        { id: TYPE_REPORT, name: 'Report', kind: 'CONTENT', schema: schemaOf('report', ['creator', 'room']) },
      ],
    });
    fake.policies = [{ id: 'policy-harass', name: 'Harassment' }];
    fake.actions = [{ id: ACTION.warn, name: 'Warn' }, { id: 'action-extra', name: 'Something else' }];
    const c = await coopWorld({ fake, options: { policies: { byReason: { harassment: 'policy-by-reason' }, byRule: { '2': 'policy-by-rule' } } } });
    const res = await c.adapter.setup.verify();
    expect(res).toMatchObject({ ok: true, complete: false });
    if (!res.ok) throw new Error('unreachable');
    expect(res.policies.missing.sort()).toEqual(['policy-by-reason', 'policy-by-rule', 'policy-spam']);
    expect(res.actions.missing.sort()).toEqual([ACTION.badFaith, ACTION.banPerm, ACTION.ban7, ACTION.chat, ACTION.dismiss, ACTION.note].sort());
    expect(res.actions.unmapped).toEqual(['action-extra']);
    expect(res.itemTypes.missing).toEqual(['line']);
    expect(res.itemTypes.fieldProblems.sort()).toEqual(['report: field creator is missing', 'report: field room is missing']);
    expect(GET_ONLY(c)).toBe(true);
    c.adapter.dispose();
  });

  it('a built-in Coop action or a custom one with no mapping does not make a correct setup read as incomplete (K5d review)', async () => {
    const fake = fullCoop();
    fake.actions = [
      ...fake.actions,
      { id: 'builtin-ignore', name: 'Ignore', actionType: 'IGNORE' } as never,
      { id: 'builtin-enqueue', name: 'Enqueue to NCMEC', actionType: 'ENQUEUE_TO_NCMEC' } as never,
      { id: 'action-extra', name: 'Something else', actionType: 'CUSTOM_ACTION' } as never,
      { id: 'action-shapeless', name: 'No type given' },
    ];
    const c = await coopWorld({ fake });
    const res = await c.adapter.setup.verify();
    expect(res).toMatchObject({ ok: true, complete: true, actions: { missing: [] } });
    if (!res.ok) throw new Error('unreachable');
    // Still reported, as information, and never a built-in.
    expect(res.actions.unmapped.sort()).toEqual(['action-extra', 'action-shapeless']);
    c.adapter.dispose();
  });

  it('verify reads each answer with a byte cap: a huge answer is not buffered and reads as a bad answer', async () => {
    const pulled = { n: 0 };
    const huge = (() => {
      const chunk = new TextEncoder().encode('x'.repeat(8192));
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled.n += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
    })();
    const c = await coopWorld({ options: { fetch: (() => Promise.resolve(new Response(huge, { status: 200 }))) as unknown as typeof fetch } });
    const res = await c.adapter.setup.verify();
    expect(res).toEqual({ ok: false, error: 'BadAnswer' });
    // The list cap is 1 MB: about that much is pulled, never the whole endless body.
    expect(pulled.n).toBeLessThan(1_100_000);
    c.adapter.dispose();
  });

  it('a field Coop requires that the kit does not send is a problem', async () => {
    const extra = { name: 'region', type: 'STRING', required: true };
    const fake = fullCoop({
      itemTypes: [
        { id: TYPE_USER, name: 'User', kind: 'USER', schema: [extra] },
        { id: TYPE_LINE, name: 'Line', kind: 'CONTENT', schema: [...schemaOf('line'), { name: 'optional_extra', type: 'STRING', required: false }] },
        { id: TYPE_REPORT, name: 'Report', kind: 'CONTENT', schema: schemaOf('report') },
      ],
    });
    const c = await coopWorld({ fake });
    const res = await c.adapter.setup.verify();
    if (!res.ok) throw new Error('unreachable');
    expect(res.itemTypes.fieldProblems).toEqual(['user: field region is required and the kit never sends it']);
    c.adapter.dispose();
  });

  it('makes only GETs (the fake refuses any other method) and sends the key as the header', async () => {
    const c = await coopWorld({ fake: fullCoop() });
    await c.adapter.setup.verify();
    expect(c.fake.calls).toHaveLength(3);
    for (const call of c.fake.calls) {
      expect(call.method).toBe('GET');
      expect(call.headers['x-api-key']).toBe(API_KEY);
      expect(call.redirect).toBe('manual');
      expect(call.body).toBeUndefined();
    }
    expect(c.fake.refused).toEqual([]);
    c.adapter.dispose();
  });

  it('a 401 is reported by status; the key never appears in the result or a log', async () => {
    const c = await coopWorld({ options: { apiKey: 'quissel-wrong-key-12345' }, fake: fullCoop() });
    const res = await c.adapter.setup.verify();
    expect(res).toEqual({ ok: false, status: 401 });
    expect(JSON.stringify(res)).not.toContain('quissel');
    expect(JSON.stringify(c.logged)).not.toContain('quissel');
    expect(c.logged).toEqual([['chatwarden.coop_failed', { op: 'verify', status: 401 }]]);
    c.adapter.dispose();
  });

  it('a 500, a network failure and an answer that is not the documented shape are not ok, by status or class', async () => {
    const down = await coopWorld({ options: { fetch: () => Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.1 with key quissel')) } });
    expect(await down.adapter.setup.verify()).toEqual({ ok: false, error: 'TypeError' });
    expect(JSON.stringify(down.logged)).not.toMatch(/quissel|ECONNREFUSED|10\.0\.0\.1/);
    down.adapter.dispose();

    const five = await coopWorld({ options: { fetch: () => Promise.resolve(new Response('{}', { status: 502 })) } });
    expect(await five.adapter.setup.verify()).toEqual({ ok: false, status: 502 });
    five.adapter.dispose();

    for (const body of ['not json', '[]', '{"policies": "no"}', 'null', '{"policies": [], "actions": []}']) {
      const odd = await coopWorld({ options: { fetch: () => Promise.resolve(new Response(body, { status: 200 })) } });
      expect(await odd.adapter.setup.verify(), body).toEqual({ ok: false, error: 'BadAnswer' });
      odd.adapter.dispose();
    }
  });

  it('a redirect is not followed and is reported by status', async () => {
    const c = await coopWorld({ options: { fetch: () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example.test/' } })) } });
    expect(await c.adapter.setup.verify()).toEqual({ ok: false, status: 302 });
    c.adapter.dispose();
  });

  it('a request that hangs is aborted after the time limit and reported', async () => {
    const timers: Array<() => void> = [];
    const c = await coopWorld({
      options: {
        schedule: (run: () => void) => {
          timers.push(run);
          return () => undefined;
        },
        fetch: (_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
      },
    });
    const pending = c.adapter.setup.verify();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(timers.length).toBeGreaterThan(0);
    for (const run of timers) run();
    expect(await pending).toEqual({ ok: false, error: 'AbortError' });
    c.adapter.dispose();
  });

  it('the item type ids it checks are the configured ones', async () => {
    const c = await coopWorld({ fake: fullCoop(), options: { itemTypes: { user: 'other-user', line: TYPE_LINE, report: TYPE_REPORT } } });
    const res = await c.adapter.setup.verify();
    if (!res.ok) throw new Error('unreachable');
    expect(res.itemTypes.missing).toEqual(['user']);
    expect(ITEM_TYPES.user).toBe(TYPE_USER);
    c.adapter.dispose();
  });
});
