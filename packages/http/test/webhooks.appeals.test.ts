import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import { webhooksOut } from '../src/webhooks/out.js';
import type { WebhookEndpoint } from '../src/webhooks/out.js';
import { DELIVERY_HEADER, ReplayCache, SIGNATURE_HEADER, TIMESTAMP_HEADER, sign, verify } from '../src/webhooks/sign.js';
import { appealsWorld } from './appealsWorld.js';

// The two appeal events and `rename.required` over a webhook. They carry ids, codes and times and never a statement, a reason or a handle;
// `includeAccounts` (off by default) adds the game's own account ids to `rename.required` only, fetched when the event is raised.

const NOW = 1_800_000_000_000;
const SECRET = 'outgoing-secret-at-least-32-characters-long';
const SECRET_B = 'second-endpoint-secret-also-32-characters-ok';
const URL_A = 'https://hooks.example.test/chatwarden/ingest?token=URL-TOKEN-XYZ';
const URL_B = 'https://other.example.test/hook';
const STATEMENT = 'STATEMENT-TEXT i was only joking';
const REASON = 'PRIVATE-DECIDING-REASON';
const HANDLE = 'TargetName';
const ACCOUNT = 'acct-secret-12345';

afterEach(() => vi.useRealTimers());

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string>; body: string };
}

function fakeFetch() {
  const calls: Call[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init as Call['init'] });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}
const bodyOf = (c: Call) => JSON.parse(c.init.body) as { id: string; type: string; at: number; data: Record<string, unknown> };
const clock = { now: () => NOW };

/** A fake kit with only what webhooksOut uses: events can be raised at will, and the accounts the kit holds are a list the test changes. */
function fakeKit(accounts: { current: string[] | Error } = { current: [ACCOUNT] }) {
  const listeners = new Set<(e: KitEvent) => unknown>();
  const asked: string[] = [];
  const kit = {
    on: (_type: string, fn: (e: KitEvent) => unknown) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    reports: { get: () => null },
    people: {
      accountIds: (subject: string) => {
        asked.push(subject);
        if (accounts.current instanceof Error) throw accounts.current;
        return [...accounts.current];
      },
    },
  } as unknown as Pick<Chatwarden, 'on' | 'reports' | 'people'>;
  return { kit, asked, emit: (e: KitEvent) => void [...listeners].forEach((l) => void l(e)) };
}

const appealCreated: KitEvent = { type: 'appeal.created', appealId: 'ap1', createdAt: NOW, target: 's_target_000000000000000', kind: 'chat', rule: 2 };
const appealDecided: KitEvent = { type: 'appeal.decided', appealId: 'ap1', at: NOW, target: 's_target_000000000000000', outcome: 'reduce', rule: 2 };
const renameRequired = (n = 0): KitEvent => ({ type: 'rename.required', at: NOW + n, target: 's_target_000000000000000', rule: 1 });
const reportClosed: KitEvent = { type: 'report.closed', reportId: 'r1', verdict: 'upheld', at: NOW };

const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ url: URL_A, secret: SECRET, events: '*', ...over });
const wait = (f: ReturnType<typeof fakeFetch>, n: number) => vi.waitFor(() => expect(f.calls.length).toBeGreaterThanOrEqual(n));

describe('webhooksOut accepts the three types, signs them, and never adds a statement, reason or handle; includeAccounts is false by default, adds accounts only to rename.required, never to another type', () => {
  it('accepts appeal.created, appeal.decided and rename.required in events, alone or together, and "*"', () => {
    for (const events of [['appeal.created'], ['appeal.decided'], ['rename.required'], ['appeal.created', 'appeal.decided', 'rename.required'], '*'] as const) {
      const k = fakeKit();
      const out = webhooksOut(k.kit, { endpoints: [endpoint({ events })], fetch: fakeFetch().fetch, clock });
      out.dispose();
    }
  });

  it('delivers each as { id, type, at, data }, signed, with the event as data and nothing added', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint({ events: ['appeal.created', 'appeal.decided', 'rename.required'] })], fetch: f.fetch, clock });
    for (const e of [appealCreated, appealDecided, renameRequired(), reportClosed]) k.emit(e);
    await wait(f, 3);
    expect(f.calls).toHaveLength(3);
    const seen = new ReplayCache();
    const bodies = f.calls.map(bodyOf);
    expect(bodies.map((b) => b.type)).toEqual(['appeal.created', 'appeal.decided', 'rename.required']);
    expect(bodies.map((b) => b.data)).toEqual([appealCreated, appealDecided, renameRequired()]);
    for (const [i, call] of f.calls.entries()) {
      const b = bodies[i] as (typeof bodies)[number];
      expect(Object.keys(b).sort()).toEqual(['at', 'data', 'id', 'type']);
      expect(call.init.headers[DELIVERY_HEADER]).toBe(b.id);
      expect(call.init.headers[SIGNATURE_HEADER]).toBe(sign(SECRET, NOW / 1000, call.init.body));
      expect(call.init.headers[TIMESTAMP_HEADER]).toBe(String(NOW / 1000));
      expect(verify(SECRET, call.init.headers, call.init.body, NOW, seen)).toBe(true);
    }
  });

  it('a kit\'s real events never carry a statement, a reason, a handle or an account: filed, decided and renamed end to end', async () => {
    const w = await appealsWorld({ names: { renames: true } });
    const f = fakeFetch();
    const out = webhooksOut(w.cw, { endpoints: [endpoint({ events: ['appeal.created', 'appeal.decided', 'rename.required'] })], fetch: f.fetch });
    const a = await w.appeal({ statement: STATEMENT });
    await w.cw.appeals.decide({ appealId: a.appealId, outcome: 'uphold', actor: 'senior_bea', reason: REASON });
    const asked = await w.file();
    w.cw.rooms.seat('rename-room', 'p1', { clientKey: 'raw-client-key-rename', accountId: ACCOUNT }, 'RenameHandle');
    await w.cw.flush();
    const subject = w.cw.rooms.subjectAt('rename-room', 'p1') as string;
    expect(w.cw.names.requireRename({ subject, actor: 'mod_ann', reason: REASON })).toMatchObject({ ok: true });
    void asked;
    await wait(f, 3);
    expect(f.calls.map((c) => bodyOf(c).type)).toEqual(['appeal.created', 'appeal.decided', 'rename.required']);
    const text = f.calls.map((c) => c.init.body).join('\n');
    for (const v of [STATEMENT, REASON, HANDLE, 'RenameHandle', ACCOUNT, 'accounts', 'mod_ann', 'senior_bea']) expect(text, v).not.toContain(v);
    const decided = bodyOf(f.calls[1] as Call).data;
    expect(Object.keys(decided).sort()).toEqual(['appealId', 'at', 'outcome', 'rule', 'target', 'type']);
    out.dispose();
  });

  it('includeAccounts is false by default: a rename.required carries no accounts, and the kit is not even asked', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint(), endpoint({ url: URL_B, secret: SECRET_B, includeAccounts: false })], fetch: f.fetch, clock });
    k.emit(renameRequired());
    await wait(f, 2);
    for (const c of f.calls) expect(bodyOf(c).data).toEqual(renameRequired());
    expect(f.calls.map((c) => c.init.body).join('')).not.toContain(ACCOUNT);
    expect(k.asked).toEqual([]);
  });

  it('includeAccounts true adds data.accounts to rename.required, from cw.people.accountIds of the event\'s target', async () => {
    const k = fakeKit({ current: ['acct-b', 'acct-a'] });
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint({ events: ['rename.required'], includeAccounts: true })], fetch: f.fetch, clock });
    k.emit(renameRequired());
    await wait(f, 1);
    expect(bodyOf(f.calls[0] as Call).data).toEqual({ ...renameRequired(), accounts: ['acct-b', 'acct-a'] });
    expect(k.asked).toEqual(['s_target_000000000000000']);
    expect(verify(SECRET, (f.calls[0] as Call).init.headers, (f.calls[0] as Call).init.body, NOW, new ReplayCache())).toBe(true);
  });

  it('a guest has no account: accounts is an empty list, not an absent key', async () => {
    const k = fakeKit({ current: [] });
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint({ includeAccounts: true })], fetch: f.fetch, clock });
    k.emit(renameRequired());
    await wait(f, 1);
    expect(bodyOf(f.calls[0] as Call).data.accounts).toEqual([]);
  });

  it('never adds accounts to another type, whatever the flag: the appeal events, the report events, and the kit is not asked', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint({ includeAccounts: true, includeExcerpts: true })], fetch: f.fetch, clock });
    for (const e of [appealCreated, appealDecided, reportClosed, { type: 'report.created', reportId: 'r1', createdAt: NOW, category: 'harassment', roomTags: {} } as KitEvent]) k.emit(e);
    await wait(f, 4);
    for (const c of f.calls) expect(Object.keys(bodyOf(c).data), bodyOf(c).type).not.toContain('accounts');
    expect(f.calls.map((c) => c.init.body).join('')).not.toContain(ACCOUNT);
    expect(k.asked).toEqual([]);
  });

  it('is per endpoint: one receiver the game controls gets the accounts, another does not', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    webhooksOut(k.kit, { endpoints: [endpoint({ includeAccounts: true }), endpoint({ url: URL_B, secret: SECRET_B })], fetch: f.fetch, clock });
    k.emit(renameRequired());
    await wait(f, 2);
    const by = (url: string) => bodyOf(f.calls.find((c) => c.url === url) as Call).data;
    expect(by(URL_A).accounts).toEqual([ACCOUNT]);
    expect(Object.keys(by(URL_B))).not.toContain('accounts');
  });

  it('includeAccounts must be a boolean (RangeError, naming the field and never the value)', () => {
    for (const bad of ['yes', 1, null, [], {}]) {
      const build = () => webhooksOut(fakeKit().kit, { endpoints: [endpoint({ includeAccounts: bad as never })], fetch: fakeFetch().fetch });
      expect(build, String(bad)).toThrow(RangeError);
      expect(build, String(bad)).toThrow(/includeAccounts/);
    }
  });

  it('the endpoint config is copied: changing includeAccounts afterwards changes nothing', async () => {
    const k = fakeKit();
    const f = fakeFetch();
    const config = endpoint({ includeAccounts: true });
    webhooksOut(k.kit, { endpoints: [config], fetch: f.fetch, clock });
    (config as { includeAccounts?: boolean }).includeAccounts = false;
    k.emit(renameRequired());
    await wait(f, 1);
    expect(bodyOf(f.calls[0] as Call).data.accounts).toEqual([ACCOUNT]);
  });
});

describe('an unknown event type in events is still refused', () => {
  it('RangeError for a type the kit does not have, including near misses, with the list otherwise valid', () => {
    for (const bad of ['appeal.filed', 'appeal.decide', 'rename.requested', 'rename.required ', 'APPEAL.CREATED', 'appeal', '']) {
      const build = () => webhooksOut(fakeKit().kit, { endpoints: [endpoint({ events: ['appeal.created', bad] as never })], fetch: fakeFetch().fetch });
      expect(build, bad).toThrow(RangeError);
    }
    expect(() => webhooksOut(fakeKit().kit, { endpoints: [endpoint({ events: [] as never })], fetch: fakeFetch().fetch })).toThrow(RangeError);
  });
});

describe('accounts are fetched when the event is raised, not cached', () => {
  it('each rename.required asks the kit afresh: an account added between two events shows on the second only', async () => {
    const accounts = { current: ['acct-one'] as string[] | Error };
    const k = fakeKit(accounts);
    const f = fakeFetch();
    const out = webhooksOut(k.kit, { endpoints: [endpoint({ events: ['rename.required'], includeAccounts: true })], fetch: f.fetch, clock });
    expect(k.asked).toEqual([]); // not at construction
    k.emit(renameRequired(1));
    await wait(f, 1);
    accounts.current = ['acct-one', 'acct-two'];
    k.emit(renameRequired(2));
    await wait(f, 2);
    expect(f.calls.map((c) => bodyOf(c).data.accounts)).toEqual([['acct-one'], ['acct-one', 'acct-two']]);
    expect(k.asked).toHaveLength(2);
    out.dispose();
  });

  it('the body is fixed when the event is raised: a retry sends the same accounts even if they changed since', async () => {
    const accounts = { current: ['acct-one'] as string[] | Error };
    const k = fakeKit(accounts);
    const calls: Call[] = [];
    let n = 0;
    const flaky = ((url: string, init: Call['init']) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(null, { status: n++ === 0 ? 500 : 200 }));
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    webhooksOut(k.kit, { endpoints: [endpoint({ events: ['rename.required'], includeAccounts: true })], fetch: flaky, clock: { now: () => Date.now() }, random: () => 0.5 });
    k.emit(renameRequired());
    await vi.advanceTimersByTimeAsync(0);
    accounts.current = ['acct-changed'];
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
    expect(bodyOf(calls[1] as Call).data.accounts).toEqual(['acct-one']);
    expect(k.asked).toHaveLength(1);
  });

  it('a kit that cannot answer sends the event without accounts and logs the error class only', async () => {
    const k = fakeKit({ current: new TypeError(`boom ${ACCOUNT}`) });
    const f = fakeFetch();
    const logged: Array<[string, Record<string, unknown> | undefined]> = [];
    webhooksOut(k.kit, { endpoints: [endpoint({ includeAccounts: true })], fetch: f.fetch, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
    k.emit(renameRequired());
    await wait(f, 1);
    expect(bodyOf(f.calls[0] as Call).data).toEqual(renameRequired());
    expect(logged).toEqual([['chatwarden.webhook_accounts_failed', { error: 'TypeError' }]]);
    expect(JSON.stringify(logged)).not.toContain(ACCOUNT);
  });

  it('no account id, statement or handle is ever logged, on a failed delivery either', async () => {
    const k = fakeKit();
    const logged: Array<[string, Record<string, unknown> | undefined]> = [];
    const failing = (() => Promise.resolve(new Response(null, { status: 400 }))) as unknown as typeof fetch;
    webhooksOut(k.kit, { endpoints: [endpoint({ includeAccounts: true })], fetch: failing, clock, logger: { warn: (e, d) => void logged.push([e, d]) } });
    k.emit(renameRequired());
    await vi.waitFor(() => expect(logged.length).toBeGreaterThan(0));
    expect(logged[0]?.[0]).toBe('chatwarden.webhook_failed');
    expect(JSON.stringify(logged)).not.toContain(ACCOUNT);
    expect(JSON.stringify(logged)).not.toContain('s_target');
  });
});
