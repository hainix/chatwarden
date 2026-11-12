import { describe, expect, it } from 'vitest';
import { createHubClient, fetchAll, HubError, toHubError } from '../src/client.js';
import type { Transport, TransportResponse } from '../src/transport.js';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { hubWorld } from './world.js';

const fake = (res: Partial<TransportResponse> | Error): Transport => () =>
  res instanceof Error ? Promise.reject(res) : Promise.resolve({ status: 200, headers: {}, body: null, ...res });

describe('HubError', () => {
  it('carries status, code, message and an optional retryAfter, and is an Error', () => {
    const e = new HubError({ status: 429, code: 'rate_limited', message: 'Slow down.', retryAfter: 7 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('HubError');
    expect([e.status, e.code, e.message, e.retryAfter]).toEqual([429, 'rate_limited', 'Slow down.', 7]);
    expect(new HubError({ status: 404, code: 'not_found', message: 'x' }).retryAfter).toBeUndefined();
  });

  it('carries who holds the case and until when, for a claimed error only', () => {
    const e = new HubError({ status: 409, code: 'claimed', message: 'm', heldBy: 'maya@example.test', heldUntil: 1234 });
    expect([e.heldBy, e.heldUntil]).toEqual(['maya@example.test', 1234]);
    const plain = new HubError({ status: 409, code: 'already_decided', message: 'm' });
    expect([plain.heldBy, plain.heldUntil]).toEqual([undefined, undefined]);
  });
});

describe('decide with keepalive', () => {
  it('passes keepalive to the transport only when asked', async () => {
    const seen: Array<boolean | undefined> = [];
    const spy: Transport = (req) => {
      seen.push(req.keepalive);
      return Promise.resolve({ status: 200, headers: {}, body: { ok: true, replay: false, groups: [] } });
    };
    const c = createHubClient(spy);
    const input = { verdict: 'no_action' as const, reason: 'fine', actions: [] };
    await c.decide('r1', input);
    await c.decide('r1', input, { keepalive: true });
    await c.decide('r1', input, { keepalive: false });
    expect(seen).toEqual([undefined, true, undefined]);
  });
});

describe('errors from the transport', () => {
  const get = (t: Transport) => createHubClient(t).me();

  it('turns a kit error body into a HubError', async () => {
    const err = await get(fake({ status: 403, body: { error: 'forbidden', message: 'You cannot do that.' } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'You cannot do that.' });
  });

  it('reads retry-after (seconds) on a 429', async () => {
    const err = await get(fake({ status: 429, headers: { 'retry-after': '12' }, body: { error: 'rate_limited', message: 'Slow down.' } })).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 12 });
  });

  it('ignores a retry-after that is not a whole number of seconds', async () => {
    for (const value of ['soon', '-3', '1.5', '']) {
      const err = (await get(fake({ status: 429, headers: { 'retry-after': value }, body: { error: 'rate_limited', message: 'm' } })).catch((e: unknown) => e)) as HubError;
      expect(err.retryAfter, value).toBeUndefined();
    }
  });

  it('reads by and until from a claimed error, and ignores them when they are not the right type', async () => {
    const ok = (await get(fake({ status: 409, body: { error: 'claimed', message: 'm', by: 'maya@example.test', until: 99 } })).catch((e: unknown) => e)) as HubError;
    expect([ok.code, ok.heldBy, ok.heldUntil]).toEqual(['claimed', 'maya@example.test', 99]);
    const bad = (await get(fake({ status: 409, body: { error: 'claimed', message: 'm', by: 5, until: 'soon' } })).catch((e: unknown) => e)) as HubError;
    expect([bad.code, bad.heldBy, bad.heldUntil]).toEqual(['claimed', undefined, undefined]);
    const other = (await get(fake({ status: 409, body: { error: 'already_decided', message: 'm', by: 'x', until: 1 } })).catch((e: unknown) => e)) as HubError;
    expect([other.heldBy, other.heldUntil]).toEqual([undefined, undefined]);
  });

  it('names an error with a body that is not the kit shape by its status', async () => {
    const e1 = (await get(fake({ status: 502, body: '<html>bad gateway</html>' })).catch((e: unknown) => e)) as HubError;
    expect([e1.status, e1.code]).toEqual([502, 'http_502']);
    expect(e1.message).not.toContain('<html>');
    const e2 = (await get(fake({ status: 500, body: null })).catch((e: unknown) => e)) as HubError;
    expect([e2.status, e2.code]).toEqual([500, 'http_500']);
    const e3 = (await get(fake({ status: 400, body: { error: 5 } })).catch((e: unknown) => e)) as HubError;
    expect(e3.code).toBe('http_400');
  });

  it('turns a dropped connection into status 0, code network', async () => {
    const err = (await get(fake(new TypeError('fetch failed'))).catch((e: unknown) => e)) as HubError;
    expect(err).toBeInstanceOf(HubError);
    expect([err.status, err.code]).toEqual([0, 'network']);
  });

  it('rejects a 200 whose body is not an object where one is expected', async () => {
    const err = (await get(fake({ status: 200, body: 'oops' })).catch((e: unknown) => e)) as HubError;
    expect(err).toBeInstanceOf(HubError);
    expect(err.code).toBe('bad_response');
  });

  it('toHubError keeps a HubError and wraps anything else as unexpected', () => {
    const e = new HubError({ status: 404, code: 'not_found', message: 'x' });
    expect(toHubError(e)).toBe(e);
    const wrapped = toHubError(new RangeError('boom'));
    expect([wrapped.status, wrapped.code]).toEqual([0, 'unexpected']);
    expect(toHubError('string').code).toBe('unexpected');
  });

  it('real routes: 401 with nobody signed in, 403 below the role, 404 unknown id, 400 bad query', async () => {
    const w = await hubWorld({ role: null });
    expect(await w.client.me().catch((e: unknown) => e)).toMatchObject({ status: 401, code: 'unauthorized' });
    w.session.who = { actor: 'm@example.test', role: 'moderator' };
    expect(await w.client.listAudit().catch((e: unknown) => e)).toMatchObject({ status: 403, code: 'forbidden' });
    expect(await w.client.getReport('nope').catch((e: unknown) => e)).toMatchObject({ status: 404, code: 'not_found' });
    expect(await w.client.listSanctions({ source: 'nobody' as never }).catch((e: unknown) => e)).toMatchObject({ status: 400, code: 'invalid_query' });
  });
});

describe('every staff route has a client method', () => {
  /** The route key 'POST /reports/:id/decide' as a method and a matcher for a concrete path. */
  const matcher = (key: string): { method: string; re: RegExp } => {
    const [method, pattern] = key.split(' ') as [string, string];
    const source = pattern
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return { method, re: new RegExp(`^${source}$`) };
  };

  /** The world every route is exercised in: appeals and renames are on, so their routes answer instead of 404. */
  const world = () => appealsHub({ role: 'owner', ai: { level: 2 }, names: { renames: true } });

  async function exercise(w: AppealsHub) {
    const { id, person } = await w.file({ target: 'Mallory', reporter: 'Rita' });
    await w.aiIdle();
    const aiRead = (await w.client.getReport(id)).ai;
    const { groupId } = await w.sanction(person, 'chat');
    const gap = await w.sanction(person, 'warning', 'uncovered');
    const termId = w.live.rows.terms[0]!.id;
    const c = w.client;
    const newTerm = await c.addTerm({ term: 'quibblex', language: 'en', note: 'n' });
    const newExc = await c.addException({ phrase: 'quibblexes', language: 'en' });
    const reasonId = (await w.direct.addReason({ label: 'Repeat', text: 'Again after a warning.' })).reason.id;
    // An appeal filed by a player against a moderator's decision (another moderator than the signed-in owner), and a person to ask for a new name.
    const filed = await w.appeal({ target: 'Appellant' });
    const renamed = await w.file({ target: 'Mallory2', reporter: 'Rita2' });

    type Expect = { method: string; path: string; query?: Record<string, string | number>; body?: unknown };
    const calls: Array<[string, () => Promise<unknown>, Expect]> = [
      ['me', () => c.me(), { method: 'GET', path: '/me' }],
      ['listReports', () => c.listReports({ status: 'open', limit: 5 }), { method: 'GET', path: '/reports', query: { status: 'open', limit: 5 } }],
      ['listReports no filter', () => c.listReports(), { method: 'GET', path: '/reports' }],
      ['getReport', () => c.getReport(id, { level: 'rude' }), { method: 'GET', path: `/reports/${id}`, query: { level: 'rude' } }],
      ['suggest', () => c.suggest(id, { level: 'hostile', rule: 1 }), { method: 'POST', path: `/reports/${id}/suggest`, body: { level: 'hostile', rule: 1 } }],
      ['personHistory', () => c.personHistory(person, { limit: 3 }), { method: 'GET', path: `/people/${person}/history`, query: { limit: 3 } }],
      ['listSanctions', () => c.listSanctions({ limit: 10, source: 'moderator' }), { method: 'GET', path: '/sanctions', query: { limit: 10, source: 'moderator' } }],
      [
        'applySanction',
        () => c.applySanction({ subject: person, kind: 'warning', durationMs: null, rule: 1, reason: 'again' }),
        { method: 'POST', path: '/sanctions', body: { subject: person, kind: 'warning', durationMs: null, rule: 1, reason: 'again' } },
      ],
      ['revokeSanction', () => c.revokeSanction(groupId, 'mistake'), { method: 'POST', path: `/sanctions/${groupId}/revoke`, body: { reason: 'mistake' } }],
      ['listGaps', () => c.listGaps(), { method: 'GET', path: '/gaps' }],
      ['closeGap ruled', () => c.closeGap(gap.groupId, { status: 'ruled', ref: 2 }), { method: 'POST', path: `/gaps/${gap.groupId}/close`, body: { status: 'ruled', ref: 2 } }],
      ['listTerms', () => c.listTerms(), { method: 'GET', path: '/terms' }],
      ['checkTerm', () => c.checkTerm({ term: 'abcdef', language: 'en' }), { method: 'POST', path: '/terms/check', body: { term: 'abcdef', language: 'en' } }],
      ['testText', () => c.testText('hello'), { method: 'POST', path: '/terms/test', body: { text: 'hello' } }],
      ['updateTerm', () => c.updateTerm(newTerm.id, { note: 'changed' }), { method: 'PATCH', path: `/terms/${newTerm.id}`, body: { note: 'changed' } }],
      ['setTermActive', () => c.setTermActive(termId, false), { method: 'POST', path: `/terms/${encodeURIComponent(termId)}/active`, body: { active: false } }],
      ['updateException', () => c.updateException(newExc.id, { note: 'changed' }), { method: 'PATCH', path: `/exceptions/${newExc.id}`, body: { note: 'changed' } }],
      ['setExceptionActive', () => c.setExceptionActive(newExc.id, false), { method: 'POST', path: `/exceptions/${newExc.id}/active`, body: { active: false } }],
      ['listBlocked', () => c.listBlocked({ days: 30 }), { method: 'GET', path: '/blocked', query: { days: 30 } }],
      ['policy', () => c.policy({ format: 'text' }), { method: 'GET', path: '/policy', query: { format: 'text' } }],
      ['policy without two sections', () => c.policy({ format: 'markdown', omit: ['rules', 'ladder'] }), { method: 'GET', path: '/policy', query: { format: 'markdown', omit: 'rules,ladder' } }],
      ['policy with an empty omit sends none', () => c.policy({ omit: [] }), { method: 'GET', path: '/policy' }],
      ['policyProfile', () => c.policyProfile(), { method: 'GET', path: '/policy/profile' }],
      ['previewPolicyProfile', () => c.previewPolicyProfile({ layer: { customDuration: false }, rule: 2 }), { method: 'POST', path: '/policy/profile/preview', body: { layer: { customDuration: false }, rule: 2 } }],
      ['savePolicyProfile', () => c.savePolicyProfile({ layer: { customDuration: false }, version: 0, reason: 'Fewer lengths' }), { method: 'PUT', path: '/policy/profile', body: { layer: { customDuration: false }, version: 0, reason: 'Fewer lengths' } }],
      ['resetPolicyProfile one section', () => c.resetPolicyProfile({ section: 'customDuration', reason: 'Back' }), { method: 'DELETE', path: '/policy/profile', query: { section: 'customDuration' }, body: { reason: 'Back' } }],
      ['resetPolicyProfile everything', () => c.resetPolicyProfile({ reason: 'Back' }), { method: 'DELETE', path: '/policy/profile', body: { reason: 'Back' } }],
      ['aiStatus', () => c.aiStatus(), { method: 'GET', path: '/ai/status' }],
      ['readAgain', () => c.readAgain(id), { method: 'POST', path: `/reports/${id}/ai/read` }],
      ['listAudit', () => c.listAudit({ limit: 5, action: 'report.view' }), { method: 'GET', path: '/audit', query: { limit: 5, action: 'report.view' } }],
      ['changes without a token', () => c.changes(), { method: 'GET', path: '/changes' }],
      ['changes since a token', () => c.changes('0'), { method: 'GET', path: '/changes', query: { since: '0' } }],
      ['claimCase', () => c.claimCase(person), { method: 'POST', path: `/cases/${person}/claim` }],
      ['claimCase takeOver', () => c.claimCase(person, { takeOver: true }), { method: 'POST', path: `/cases/${person}/claim`, body: { takeOver: true } }],
      ['viewing', () => c.viewing(person), { method: 'POST', path: `/cases/${person}/viewing` }],
      ['releaseCase', () => c.releaseCase(person), { method: 'POST', path: `/cases/${person}/release` }],
      ['takeNext', () => c.takeNext(), { method: 'POST', path: '/cases/next' }],
      ['takeNext for a reason', () => c.takeNext({ reason: 'spam' }), { method: 'POST', path: '/cases/next', body: { reason: 'spam' } }],
      ['takeNext for no reason', () => c.takeNext({ reason: null }), { method: 'POST', path: '/cases/next', body: { reason: 'none' } }],
      ['takeNext for both', () => c.takeNext({ category: 'spam', reason: 'spam' }), { method: 'POST', path: '/cases/next', body: { category: 'spam', reason: 'spam' } }],
      ['takeNext in a category', () => c.takeNext({ category: 'harassment' }), { method: 'POST', path: '/cases/next', body: { category: 'harassment' } }],
      ['listReasons', () => c.listReasons(), { method: 'GET', path: '/reasons' }],
      ['addReason', () => c.addReason({ label: 'Slur', text: 'A slur aimed at a person.' }), { method: 'POST', path: '/reasons', body: { label: 'Slur', text: 'A slur aimed at a person.' } }],
      ['updateReason', () => c.updateReason(reasonId, { label: 'Slur attempt' }), { method: 'PATCH', path: `/reasons/${reasonId}`, body: { label: 'Slur attempt' } }],
      ['setReasonActive', () => c.setReasonActive(reasonId, false), { method: 'POST', path: `/reasons/${reasonId}/active`, body: { active: false } }],
      [
        'dismissOpen preview',
        () => c.dismissOpen({ scope: 'person', ref: person, dryRun: true }),
        { method: 'POST', path: '/reports/dismiss-open', body: { scope: 'person', ref: person, dryRun: true } },
      ],
      [
        'decide',
        () => c.decide(id, { verdict: 'upheld', reason: 'clear', actions: [{ subject: person, kind: 'warning', durationMs: null, rule: 1 }] }),
        { method: 'POST', path: `/reports/${id}/decide`, body: { verdict: 'upheld', reason: 'clear', actions: [{ subject: person, kind: 'warning', durationMs: null, rule: 1 }] } },
      ],
      [
        'dontTeach',
        () => c.dontTeach(id),
        { method: 'POST', path: `/reports/${id}/ai/dont-teach` },
      ],
      ['appeals', () => c.appeals({ status: 'open', limit: 5 }), { method: 'GET', path: '/appeals', query: { status: 'open', limit: 5 } }],
      ['appeals no filter', () => c.appeals(), { method: 'GET', path: '/appeals' }],
      ['appealStats', () => c.appealStats({ days: 30 }), { method: 'GET', path: '/appeals/stats', query: { days: 30 } }],
      ['appeal', () => c.appeal(filed.appealId), { method: 'GET', path: `/appeals/${filed.appealId}` }],
      [
        'decideAppeal',
        () => c.decideAppeal(filed.appealId, { outcome: 'uphold', reason: 'It stands.' }),
        { method: 'POST', path: `/appeals/${filed.appealId}/decide`, body: { outcome: 'uphold', reason: 'It stands.' } },
      ],
      [
        'rename',
        () => c.rename(renamed.person, { reason: 'Please choose another name.' }),
        { method: 'POST', path: `/people/${renamed.person}/rename`, body: { reason: 'Please choose another name.' } },
      ],
    ];
    expect(aiRead).not.toBeNull();
    const results: unknown[] = [];
    for (const [name, call, want] of calls) {
      const before = w.sent.length;
      results.push(await call().catch((e: unknown) => `${name} threw ${String(e)}`));
      const req = w.sent[before]!;
      expect(req, name).toMatchObject({ method: want.method, path: want.path });
      expect(req.query ?? {}, name).toEqual(want.query ?? {});
      if (want.body === undefined) expect(req.body, name).toBeUndefined();
      else expect(req.body, name).toEqual(want.body);
    }
    return { results, calls };
  }

  it('sends the right method, path, query and body for each method, and each succeeds against the real routes', async () => {
    const w = await world();
    const { results } = await exercise(w);
    // exercise() turns a thrown error into a string naming the call, so any string here is a failed call.
    expect(results.filter((r) => typeof r === 'string')).toEqual([]);
  });

  it('covers every route the staff API mounts', async () => {
    const w = await world();
    await exercise(w);
    const keys = Object.keys(w.routes);
    expect(keys.length).toBeGreaterThanOrEqual(26);
    const missing = keys.filter((key) => {
      const { method, re } = matcher(key.replace(/~ref/g, ''));
      return !w.sent.some((r) => r.method === method && re.test(r.path));
    });
    expect(missing).toEqual([]);
  });

  it('encodes an id so it cannot add a path segment or a query', async () => {
    const w = await hubWorld({ role: 'owner' });
    await w.client.getReport('a/b?x=1#y').catch(() => undefined);
    await w.client.personHistory('../audit').catch(() => undefined);
    await w.client.revokeSanction('a b', 'r').catch(() => undefined);
    expect(w.sent.map((r) => r.path)).toEqual(['/reports/a%2Fb%3Fx%3D1%23y', '/people/..%2Faudit/history', '/sanctions/a%20b/revoke']);
    expect(w.sent.every((r) => r.query === undefined || Object.keys(r.query).length === 0)).toBe(true);
  });

  it('typed: me() answers who is signed in and what they can do', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const me = await w.client.me();
    expect(me.role).toBe('moderator');
    expect(me.can['reports.read']).toBe(true);
    expect(me.can['audit.read']).toBe(false);
    expect(me.can['gaps.close']).toBe(false);
  });
});

describe('the team methods', () => {
  it('claim, heartbeat and release against the real routes', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test' });
    const { person } = await w.file({ target: 'Mallory' });
    const first = await w.client.claimCase(person);
    expect(first.claim.by).toBe('ann@example.test');
    expect(first.tookOverFrom).toBeNull();
    w.clock.t += 60_000;
    const beat = await w.client.claimCase(person);
    expect(beat.claim.since).toBe(first.claim.since);
    expect(beat.claim.until).toBeGreaterThan(first.claim.until);
    expect(await w.client.releaseCase(person)).toEqual({ released: true });
    expect(await w.client.releaseCase(person)).toEqual({ released: false });
  });

  it('another moderator gets claimed with who and until; a 404 for a person with no open case', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test' });
    const { person } = await w.file({ target: 'Mallory' });
    await w.client.claimCase(person);
    const maya = w.clientFor('maya@example.test', 'moderator');
    const err = (await maya.claimCase(person).catch((e: unknown) => e)) as HubError;
    expect([err.status, err.code, err.heldBy]).toEqual([409, 'claimed', 'ann@example.test']);
    expect(err.heldUntil).toBeGreaterThan(w.now());
    expect(await maya.claimCase('nobody-here').catch((e: unknown) => e)).toMatchObject({ status: 404 });
  });

  it('takeNext hands out the oldest unclaimed case, then null when none is left', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test' });
    const a = await w.file({ target: 'First' });
    await w.file({ target: 'Second' });
    const got = await w.client.takeNext();
    expect(got.case?.person).toBe(a.person);
    expect(got.case?.reportId).toBe(a.id);
    expect((await w.client.takeNext()).case?.person).not.toBe(a.person);
    expect(await w.client.takeNext()).toEqual({ case: null });
  });

  it('changes: the token is stable until something happens, then reports changed', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const first = await w.client.changes();
    expect(first.changed).toBe(true);
    expect(await w.client.changes(first.token)).toEqual({ token: first.token, changed: false });
    await w.file({ target: 'Mallory' });
    const after = await w.client.changes(first.token);
    expect(after.changed).toBe(true);
    expect(after.token).not.toBe(first.token);
  });

  it('viewing lists the other staff with the case open', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test' });
    const { person } = await w.file({ target: 'Mallory' });
    const maya = w.clientFor('maya@example.test', 'moderator');
    expect((await maya.viewing(person)).viewers).toEqual([]);
    expect((await w.client.viewing(person)).viewers).toEqual(['maya@example.test']);
  });

  it('reasons: a senior adds, edits and switches one off; a moderator reads them', async () => {
    const w = await hubWorld({ role: 'senior' });
    const { reason } = await w.client.addReason({ label: 'Threat', text: 'A threat against a person.' });
    expect(reason).toMatchObject({ label: 'Threat', active: true });
    await w.client.updateReason(reason.id, { text: 'A threat.' });
    await w.client.setReasonActive(reason.id, false);
    const list = await w.client.listReasons();
    expect(list.reasons).toEqual([{ id: reason.id, label: 'Threat', text: 'A threat.', active: false }]);
    w.session.who = { actor: 'ann@example.test', role: 'moderator' };
    expect((await w.client.listReasons()).reasons).toHaveLength(1);
    expect(await w.client.addReason({ label: 'x', text: 'y' }).catch((e: unknown) => e)).toMatchObject({ status: 403 });
  });

  it('encodes a ref so it cannot add a path segment', async () => {
    const w = await hubWorld({ role: 'moderator' });
    await w.client.claimCase('a/b?x=1').catch(() => undefined);
    await w.client.viewing('../audit').catch(() => undefined);
    await w.client.releaseCase('a b').catch(() => undefined);
    expect(w.sent.map((r) => r.path)).toEqual(['/cases/a%2Fb%3Fx%3D1/claim', '/cases/..%2Faudit/viewing', '/cases/a%20b/release']);
  });
});

describe('fetchAll (cursor helper)', () => {
  const pages = <T,>(all: T[][]) => {
    const asked: Array<string | undefined> = [];
    const load = (cursor?: string) => {
      asked.push(cursor);
      const i = cursor === undefined ? 0 : Number(cursor);
      return Promise.resolve({ items: all[i] ?? [], next: i + 1 < all.length ? String(i + 1) : null });
    };
    return { load, asked };
  };

  it('follows next until it is null and concatenates the pages in order', async () => {
    const { load, asked } = pages([[1, 2], [3], [4, 5]]);
    expect(await fetchAll(load)).toEqual({ items: [1, 2, 3, 4, 5], next: null });
    expect(asked).toEqual([undefined, '1', '2']);
  });

  it('stops at maxPages and says where to go on', async () => {
    const { load, asked } = pages([[1], [2], [3], [4]]);
    expect(await fetchAll(load, { maxPages: 2 })).toEqual({ items: [1, 2], next: '2' });
    expect(asked).toHaveLength(2);
  });

  it('handles an empty first page and a single page', async () => {
    expect(await fetchAll(pages<number>([[]]).load)).toEqual({ items: [], next: null });
    expect(await fetchAll(pages([[7]]).load)).toEqual({ items: [7], next: null });
  });

  it('stops when a cursor repeats (a server that never ends)', async () => {
    const load = () => Promise.resolve({ items: [1], next: 'same' });
    const out = await fetchAll(load, { maxPages: 50 });
    expect(out.items.length).toBeLessThanOrEqual(2);
  });

  it('lets an error through, and the caller keeps what it had', async () => {
    let n = 0;
    const load = () => (++n === 1 ? Promise.resolve({ items: [1], next: 'x' }) : Promise.reject(new HubError({ status: 500, code: 'internal', message: 'm' })));
    await expect(fetchAll(load)).rejects.toMatchObject({ code: 'internal' });
  });

  it('works on the real queue: 3 reports at limit 1 come back in 3 pages', async () => {
    const w = await hubWorld({ role: 'moderator' });
    for (let i = 0; i < 3; i += 1) await w.file({ target: `T${i}` });
    const all = await fetchAll((cursor) => w.client.listReports({ status: 'open', limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
    expect(all.items).toHaveLength(3);
    expect(all.next).toBeNull();
    expect(new Set(all.items.map((r) => r.id)).size).toBe(3);
  });
});

describe('dismissOpen (POST /reports/dismiss-open)', () => {
  it('posts JSON and returns the typed result', async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const answer = { ok: true, dryRun: false, open: 3, dismissed: 3, replayed: 0, skipped: { claimed: 0, decided: 0 }, more: false };
    const spy: Transport = (req) => {
      seen.push({ method: req.method, path: req.path, body: req.body });
      return Promise.resolve({ status: 200, headers: {}, body: answer });
    };
    const result = await createHubClient(spy).dismissOpen({ scope: 'reporter', ref: 'rep-ref', takeOver: false });
    expect(result).toEqual(answer);
    expect(seen).toEqual([{ method: 'POST', path: '/reports/dismiss-open', body: { scope: 'reporter', ref: 'rep-ref', takeOver: false } }]);
  });

  it('sends exactly the fields it was given: no reason key, ever', async () => {
    const bodies: unknown[] = [];
    const spy: Transport = (req) => {
      bodies.push(req.body);
      return Promise.resolve({ status: 200, headers: {}, body: { ok: true } });
    };
    const c = createHubClient(spy);
    await c.dismissOpen({ scope: 'person', ref: 'a' });
    await c.dismissOpen({ scope: 'person', ref: 'a', takeOver: true, dryRun: true });
    expect(bodies).toEqual([{ scope: 'person', ref: 'a' }, { scope: 'person', ref: 'a', takeOver: true, dryRun: true }]);
    expect(JSON.stringify(bodies)).not.toContain('reason');
  });

  it('really dismisses the open reports of a person through the real route', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const a = await w.file({ target: 'Mallory', reporter: 'Rita' });
    const b = await w.file({ target: 'Mallory', reporter: 'Sam' });
    const preview = await w.client.dismissOpen({ scope: 'person', ref: a.person, dryRun: true });
    expect(preview).toMatchObject({ ok: true, dryRun: true, open: 2, dismissed: 0 });
    expect((await w.client.getReport(a.id)).report.status).toBe('open');
    const done = await w.client.dismissOpen({ scope: 'person', ref: a.person });
    expect(done).toMatchObject({ ok: true, dryRun: false, open: 2, dismissed: 2, more: false });
    for (const id of [a.id, b.id]) expect((await w.client.getReport(id)).report.status).toBe('dismissed');
  });

  it('a server refusal is a HubError with its code (403 below the permission, 409 claimed)', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'ann@example.test', permissions: { 'reports.decide.bulk': 'senior' } });
    const { person } = await w.file({ target: 'Mallory' });
    expect(await w.client.dismissOpen({ scope: 'person', ref: person }).catch((e: unknown) => e)).toMatchObject({ status: 403, code: 'forbidden' });
    const open = await hubWorld({ role: 'moderator', actor: 'ann@example.test' });
    const held = await open.file({ target: 'Mallory' });
    await open.clientFor('maya@example.test', 'moderator').claimCase(held.person);
    const err = (await open.client.dismissOpen({ scope: 'person', ref: held.person }).catch((e: unknown) => e)) as HubError;
    expect(err).toBeInstanceOf(HubError);
    expect(err).toMatchObject({ status: 409, code: 'claimed', heldBy: 'maya@example.test' });
  });
});

describe('listReports passes reporterAccuracy through', () => {
  it('an open row carries reporterAccuracy as the server sent it, and a row from an older server has none', async () => {
    const accuracy = { decided: 6, unfounded: 5, falseRate: 5 / 6, habitual: true };
    const row = { id: 'r1', status: 'open', reporterAccuracy: accuracy };
    const older = { id: 'r2', status: 'open' };
    const spy: Transport = () => Promise.resolve({ status: 200, headers: {}, body: { items: [row, older], next: null } });
    const page = await createHubClient(spy).listReports({ status: 'open' });
    expect(page.items[0]?.reporterAccuracy).toEqual(accuracy);
    expect(page.items[1]?.reporterAccuracy).toBeUndefined();
  });

  it('against the real route: a moderator (history.read) gets the figure for a reporter with decided reports, else null', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const open = await w.file({ target: 'Mallory', reporter: 'Rita' });
    const page = await w.client.listReports({ status: 'open' });
    const row = page.items.find((i) => i.id === open.id);
    expect(row).toBeDefined();
    expect(row?.reporterAccuracy ?? null).toBeNull();
  });
});

describe('the AI methods', () => {
  const body = (status: number, b: unknown, headers: Record<string, string> = {}): Transport => () => Promise.resolve({ status, headers, body: b as never });

  it('readAgain: 200 ready carries the read, 202 pending carries nothing else', async () => {
    const ready = { status: 'ready', ai: { id: 'a1' } };
    expect(await createHubClient(body(200, ready)).readAgain('r1')).toEqual(ready);
    expect(await createHubClient(body(202, { status: 'pending' })).readAgain('r1')).toEqual({ status: 'pending' });
  });

  it('readAgain: 409 ai_final, 409 ai_off, 429 ai_budget and 503 ai_unavailable are HubErrors with their codes', async () => {
    const cases: Array<[number, string]> = [
      [409, 'ai_final'],
      [409, 'ai_off'],
      [429, 'ai_budget'],
      [503, 'ai_unavailable'],
    ];
    for (const [status, code] of cases) {
      const err = await createHubClient(body(status, { error: code, message: 'm' })).readAgain('r1').catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(HubError);
      expect(err, code).toMatchObject({ status, code });
    }
  });

  it('readAgain: a 503 says how long to wait, from the header', async () => {
    const err = (await createHubClient(body(503, { error: 'ai_unavailable', message: 'm', retryAfterMs: 4000 }, { 'retry-after': '4' })).readAgain('r1').catch((e: unknown) => e)) as HubError;
    expect(err.retryAfter).toBe(4);
  });

  it('readAgain encodes the id', async () => {
    const seen: string[] = [];
    const spy: Transport = (req) => {
      seen.push(`${req.method} ${req.path}`);
      return Promise.resolve({ status: 202, headers: {}, body: { status: 'pending' } });
    };
    await createHubClient(spy).readAgain('a/b?x');
    expect(seen).toEqual(['POST /reports/a%2Fb%3Fx/ai/read']);
  });

  it('aiStatus and dontTeach are plain calls', async () => {
    const seen: string[] = [];
    const spy: Transport = (req) => {
      seen.push(`${req.method} ${req.path} ${String(req.body)}`);
      return Promise.resolve({ status: 200, headers: {}, body: { ok: true } });
    };
    const c = createHubClient(spy);
    await c.aiStatus();
    await c.dontTeach('r 1');
    expect(seen).toEqual(['GET /ai/status undefined', 'POST /reports/r%201/ai/dont-teach undefined']);
  });

  it('a 404 from an older server (no AI routes) is a HubError the screens can read as "not set up"', async () => {
    const err = await createHubClient(body(404, { error: 'not_found', message: 'm' })).aiStatus().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('against the real routes: status of a kit with no adapter says so, with the AI off', async () => {
    const w = await hubWorld({ role: 'owner' });
    const status = await w.client.aiStatus();
    expect(status).toMatchObject({ available: false, level: 0, state: 'off' });
    expect(status.stats).toBeDefined();
    expect(await w.client.readAgain((await w.file()).id).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ai_off' });
  });

  it('against the real routes: a read lands on the case page and read again says ready while nothing changed', async () => {
    const w = await hubWorld({ role: 'owner', ai: { level: 2 } });
    const f = await w.file();
    await w.aiIdle();
    const detail = await w.client.getReport(f.id);
    expect(detail.ai).toMatchObject({ severity: 'rude', stale: false });
    expect(detail.ai?.recommendation).toMatchObject({ verdict: 'upheld' });
    const again = await w.client.readAgain(f.id);
    expect(again.status).toBe('ready');
    const status = await w.client.aiStatus();
    expect(status).toMatchObject({ available: true, level: 2, state: 'ok' });
    expect(typeof status.capCalls).toBe('number');
  });

  it('decide carries the ai echo in its body, and only when given', async () => {
    const sent: unknown[] = [];
    const spy: Transport = (req) => {
      sent.push(req.body);
      return Promise.resolve({ status: 200, headers: {}, body: { ok: true, replay: false, groups: [] } });
    };
    const c = createHubClient(spy);
    await c.decide('r1', { verdict: 'no_action', actions: [] });
    await c.decide('r1', { verdict: 'no_action', actions: [], ai: { readId: 'a1', accepted: true, severity: 'rude' } });
    expect(sent).toEqual([{ verdict: 'no_action', actions: [] }, { verdict: 'no_action', actions: [], ai: { readId: 'a1', accepted: true, severity: 'rude' } }]);
  });

  it('against the real routes: the echo is accepted and the server records the outcome', async () => {
    const w = await hubWorld({ role: 'owner', ai: { level: 2 } });
    const f = await w.file();
    await w.aiIdle();
    const read = (await w.client.getReport(f.id)).ai;
    const res = await w.client.decide(f.id, { verdict: 'no_action', actions: [], ai: { readId: read!.id, accepted: false } });
    expect(res.ok).toBe(true);
    expect((await w.client.aiStatus()).stats.decided).toBe(1);
    expect(await w.client.dontTeach(f.id)).toEqual({ ok: true });
  });
});
