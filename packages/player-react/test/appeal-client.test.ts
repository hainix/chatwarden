import { describe, expect, it } from 'vitest';
import { createPlayerClient, PlayerError } from '../src/client.js';
import type { FileAppealOutcome } from '../src/client.js';
import { ALICE, BOB, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

// The client half of appeals: `appeals()` and `fileAppeal()` over the REAL routes (a refusal is the route's own answer), with the
// answers the real routes cannot give (extra fields, a bad shape, a dropped connection) put in by the test's intercept.

const FIELDS = ['createdAt', 'decidedAt', 'id', 'noticeId', 'status'];
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => () => ({ status, body, headers });

async function withNotice(opts: { appeals?: Record<string, unknown> } = {}) {
  const w = await playerWorld({ appeals: opts.appeals ?? {} });
  await w.warn(ALICE);
  return { w, noticeId: w.noticeOf(ALICE) };
}

function refused(res: FileAppealOutcome): { refused: string; retryAfter?: number } {
  if (res.ok) throw new Error('expected a refusal');
  return res;
}

describe('appeals()', () => {
  it('asks GET /appeals and keeps exactly the documented fields', async () => {
    const { w, noticeId } = await withNotice();
    expect(await w.client.appeals()).toEqual([]);
    const sent = await w.client.fileAppeal(noticeId, 'It was a joke.');
    expect(sent.ok).toBe(true);
    const list = await w.client.appeals();
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(FIELDS);
    expect(list[0]).toMatchObject({ noticeId, status: 'open', decidedAt: null });
    expect(w.sent.filter((r) => r.path === '/appeals').map((r) => r.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('drops a field the server was not documented to send, a row that is not an appeal, and a status it does not know', async () => {
    const { w } = await withNotice();
    const ok = { id: 'ap1', noticeId: 'n1', status: 'upheld', createdAt: 5, decidedAt: 9 };
    w.intercept.fn = answer(200, {
      appeals: [
        { ...ok, reason: 'private moderator reason', decidedBy: 'ann@example.test', groupId: 'g1', statement: 'my words', subject: 's_x' },
        { ...ok, id: 'ap2', status: 'moot' },
        { ...ok, id: 'ap3', status: 'something' },
        { ...ok, id: 7 },
        { ...ok, id: 'ap4', createdAt: 'x' },
        { ...ok, id: 'ap5', decidedAt: 'x' },
        { ...ok, id: 'ap6', status: 'open', decidedAt: null },
        'nope',
        null,
      ],
    });
    const list = await w.client.appeals();
    expect(list.map((a) => a.id)).toEqual(['ap1', 'ap6']);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(FIELDS);
    expect(JSON.stringify(list)).not.toMatch(/private moderator reason|ann@example|g1|my words|s_x/);
  });

  it.each([
    ['not an object', null],
    ['no appeals key', { notices: [] }],
    ['appeals that is not a list', { appeals: 'x' }],
  ])('a body that is %s is a bad_response', async (_n, body) => {
    const { w } = await withNotice();
    w.intercept.fn = answer(200, body);
    await expect(w.client.appeals()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('rejects with the status when appeals are off (404) and when the call fails', async () => {
    const off = await playerWorld();
    await expect(off.client.appeals()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const { w } = await withNotice();
    w.intercept.fn = answer(500, { error: 'internal', message: 'x' });
    await expect(w.client.appeals()).rejects.toBeInstanceOf(PlayerError);
  });
});

describe('fileAppeal()', () => {
  it('a filing is { ok: true, appeal } with the documented fields only, posted as { noticeId, statement } and nothing else', async () => {
    const { w, noticeId } = await withNotice();
    const res = await w.client.fileAppeal(noticeId, 'I did not mean it.');
    if (!res.ok) throw new Error('refused');
    expect(Object.keys(res.appeal).sort()).toEqual(FIELDS);
    expect(res.appeal).toMatchObject({ noticeId, status: 'open', decidedAt: null });
    const post = w.sent.find((r) => r.method === 'POST');
    expect(post?.path).toBe('/appeals');
    expect(post?.body).toEqual({ noticeId, statement: 'I did not mean it.' });
  });

  it('sends the statement as typed: spaces, line breaks and all (the server cleans it)', async () => {
    const { w, noticeId } = await withNotice();
    const typed = '  first line\r\n\r\n\r\nsecond   line \t ';
    await w.client.fileAppeal(noticeId, typed);
    expect((w.sent.find((r) => r.method === 'POST')?.body as { statement: string }).statement).toBe(typed);
  });

  it('keeps only the documented fields of the answer; an answer that is not an open appeal is a bad answer', async () => {
    const { w, noticeId } = await withNotice();
    w.intercept.fn = answer(200, { appeal: { id: 'a', noticeId, status: 'open', createdAt: 1, decidedAt: null, reason: 'x', subject: 's_y' }, extra: 1 });
    const res = await w.client.fileAppeal(noticeId, 'hi');
    expect(res).toEqual({ ok: true, appeal: { id: 'a', noticeId, status: 'open', createdAt: 1, decidedAt: null } });
    w.intercept.fn = answer(200, { appeal: { id: 'a', noticeId, status: 'moot', createdAt: 1, decidedAt: null } });
    await expect(w.client.fileAppeal(noticeId, 'hi')).rejects.toMatchObject({ code: 'bad_response' });
    w.intercept.fn = answer(200, { nothing: true });
    await expect(w.client.fileAppeal(noticeId, 'hi')).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('400 invalid_statement is statement_invalid (an empty statement, from the real route)', async () => {
    const { w, noticeId } = await withNotice();
    expect(await w.client.fileAppeal(noticeId, '   ')).toEqual({ ok: false, refused: 'statement_invalid' });
  });

  it('404 is not_found: a notice that is not yours, one that is gone, and appeals off, all the one answer', async () => {
    const { w, noticeId } = await withNotice();
    w.caller.key = BOB.key;
    expect(await w.client.fileAppeal(noticeId, 'hi')).toEqual({ ok: false, refused: 'not_found' });
    w.caller.key = ALICE.key;
    expect(await w.client.fileAppeal('no-such-notice', 'hi')).toEqual({ ok: false, refused: 'not_found' });
    const off = await playerWorld();
    await off.warn(ALICE);
    expect(await off.client.fileAppeal(off.noticeOf(ALICE), 'hi')).toEqual({ ok: false, refused: 'not_found' });
  });

  it('409 is already_appealed', async () => {
    const { w, noticeId } = await withNotice();
    expect((await w.client.fileAppeal(noticeId, 'first')).ok).toBe(true);
    expect(await w.client.fileAppeal(noticeId, 'second')).toEqual({ ok: false, refused: 'already_appealed' });
  });

  it('429 is rate with the wait in whole seconds; without a header there is no retryAfter at all', async () => {
    const { w, noticeId } = await withNotice({ appeals: { perPlayerPerWeek: 1 } });
    await w.warn(ALICE, { rule: 2 });
    expect((await w.client.fileAppeal(noticeId, 'first')).ok).toBe(true);
    const second = refused(await w.client.fileAppeal(w.noticeOf(ALICE, 1), 'second'));
    expect(second.refused).toBe('rate');
    expect(typeof second.retryAfter).toBe('number');
    expect(second.retryAfter).toBeGreaterThanOrEqual(1);
    w.intercept.fn = answer(429, { error: 'rate_limited', message: 'x' });
    const bare = refused(await w.client.fileAppeal(noticeId, 'x'));
    expect(bare).toEqual({ ok: false, refused: 'rate' });
    expect('retryAfter' in bare).toBe(false);
    w.intercept.fn = answer(429, { error: 'rate_limited', message: 'x' }, { 'retry-after': '120' });
    expect(await w.client.fileAppeal(noticeId, 'x')).toEqual({ ok: false, refused: 'rate', retryAfter: 120 });
  });

  it.each([
    ['401', 401, { error: 'unauthorized', message: 'x' }],
    ['403', 403, { error: 'forbidden', message: 'x' }],
    ['500', 500, { error: 'internal', message: 'x' }],
    ['400 with a code that is not invalid_statement', 400, { error: 'bad_request', message: 'x' }],
    ['a proxy page', 502, '<html>bad gateway</html>'],
  ])('%s rejects with a PlayerError (a failure, not a refusal)', async (_n, status, body) => {
    const { w, noticeId } = await withNotice();
    w.intercept.fn = answer(status, body);
    await expect(w.client.fileAppeal(noticeId, 'hi')).rejects.toMatchObject({ status });
  });

  it('a dropped connection rejects as network', async () => {
    const client = createPlayerClient({ transport: () => Promise.reject(new TypeError('failed')) });
    await expect(client.fileAppeal('n', 'hi')).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});

describe('the world helper (control)', () => {
  it('an appeal decided by a second moderator is read back as upheld or revoked, with a time', async () => {
    const pairs: Array<['uphold' | 'revoke', string]> = [
      ['uphold', 'upheld'],
      ['revoke', 'revoked'],
    ];
    for (const [outcome, status] of pairs) {
      const w: PlayerWorld = await playerWorld({ appeals: {} });
      await w.warn(ALICE);
      await w.client.fileAppeal(w.noticeOf(ALICE), 'it was a joke');
      await w.decideAppeal(ALICE, outcome);
      const list = await w.client.appeals();
      expect(list[0]?.status).toBe(status);
      expect(typeof list[0]?.decidedAt).toBe('number');
    }
  });
});
