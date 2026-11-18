import { describe, expect, it } from 'vitest';
import { ServiceError, createServiceClient } from '../src/service/client.js';
import type { Appeal } from '../src/service/client.js';
import { KEY_A } from './serviceKit.js';

// The typed client's three appeal methods (0.2.1): appealLink, fileAppeal, appeals. A refusal is an answer (returned); a 4xx is thrown; a refusal reason the client does not know is returned as
// `unknown` with the original in `rawRefused`. Filing is not retried blindly: a 5xx may have filed, so the client sends no Idempotency-Key and the kit's own `already_appealed` settles a repeat.

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function scripted(replies: Response[], retries = 3) {
  const sent: Sent[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ method: String(init.method), url, headers, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const next = replies[Math.min(i, replies.length - 1)] as Response;
    i += 1;
    return next.clone();
  }) as unknown as typeof fetch;
  const client: ReturnType<typeof createServiceClient> = createServiceClient({ baseUrl: 'https://svc.test/', key: KEY_A, fetch: fetchImpl, sleep: async () => undefined, retries });
  return { client, sent };
}

const WHO = { clientKey: 'client-key-0001' };
const APPEAL: Appeal = { id: 'ap1', noticeId: 'n1', status: 'open', createdAt: 1_800_000_000_000, decidedAt: null };

describe('appealLink', () => {
  it('POSTs { noticeId } to /v1/appeals/link with the bearer and answers { url }', async () => {
    const { client, sent } = scripted([json({ url: 'https://game.example/appeal?t=abc' })]);
    expect(await client.appealLink('n1')).toEqual({ url: 'https://game.example/appeal?t=abc' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://svc.test/v1/appeals/link', body: { noticeId: 'n1' } });
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(sent[0]?.headers['idempotency-key']).toBeUndefined();
  });

  it('{ url: null } is an answer', async () => {
    const { client } = scripted([json({ url: null })]);
    expect(await client.appealLink('n1')).toEqual({ url: null });
  });

  it('a 400 is thrown as a ServiceError with the code and no retry', async () => {
    const { client, sent } = scripted([json({ error: 'invalid_request', message: 'x' }, 400)]);
    await expect(client.appealLink('')).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(client.appealLink('')).rejects.toBeInstanceOf(ServiceError);
    expect(sent).toHaveLength(2);
  });
});

describe('fileAppeal', () => {
  it('POSTs { who, noticeId, statement } to /v1/appeals and returns the appeal', async () => {
    const { client, sent } = scripted([json({ ok: true, appeal: APPEAL })]);
    expect(await client.fileAppeal(WHO, 'n1', 'It was not me.')).toEqual({ ok: true, appeal: APPEAL });
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://svc.test/v1/appeals', body: { who: WHO, noticeId: 'n1', statement: 'It was not me.' } });
    expect(sent[0]?.headers['idempotency-key']).toBeUndefined();
  });

  it('a refusal is returned, not thrown: rate keeps its retryAfterMs, the others are as the service sent them', async () => {
    for (const body of [
      { ok: false, refused: 'rate', retryAfterMs: 5000 },
      { ok: false, refused: 'already_appealed' },
      { ok: false, refused: 'statement_invalid' },
      { ok: false, refused: 'not_found' },
      { ok: false, refused: 'not_appealable' },
      { ok: false, refused: 'off' },
    ]) {
      const { client, sent } = scripted([json(body)]);
      expect(await client.fileAppeal(WHO, 'n1', 'x')).toEqual(body);
      expect(sent).toHaveLength(1);
    }
  });

  it('a refusal the client does not know is "unknown" with the original in rawRefused', async () => {
    const { client } = scripted([json({ ok: false, refused: 'brand_new_reason' })]);
    expect(await client.fileAppeal(WHO, 'n1', 'x')).toEqual({ ok: false, refused: 'unknown', rawRefused: 'brand_new_reason' });
  });

  it('a 5xx is retried like the other calls (the kit refuses a second filing as already_appealed), a 4xx never', async () => {
    const { client, sent } = scripted([json({ error: 'internal' }, 500), json({ ok: true, appeal: APPEAL })]);
    expect(await client.fileAppeal(WHO, 'n1', 'x')).toMatchObject({ ok: true });
    expect(sent).toHaveLength(2);
    const four = scripted([json({ error: 'invalid_request', message: 'x' }, 400)]);
    await expect(four.client.fileAppeal(WHO, 'n1', 'x')).rejects.toMatchObject({ status: 400 });
    expect(four.sent).toHaveLength(1);
  });
});

describe('appeals', () => {
  it('POSTs { who } to /v1/appeals/mine and returns the list', async () => {
    const { client, sent } = scripted([json({ appeals: [APPEAL, { ...APPEAL, id: 'ap2', status: 'revoked', decidedAt: 1_800_000_100_000 }] })]);
    const res = await client.appeals(WHO);
    expect(res.appeals.map((a) => a.id)).toEqual(['ap1', 'ap2']);
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://svc.test/v1/appeals/mine', body: { who: WHO } });
  });

  it('an empty list is an answer', async () => {
    const { client } = scripted([json({ appeals: [] })]);
    expect(await client.appeals(WHO)).toEqual({ appeals: [] });
  });
});

describe('the other answers carry appealUrl', () => {
  it('a door refusal and a notice keep the appealUrl the service sent', async () => {
    const refusal = { kind: 'ban', until: null, refCode: 'M-ABCDE', noticeId: 'n1', appealUrl: 'https://game.example/appeal?t=abc' };
    const door = scripted([json({ ok: false, refusal })]);
    expect(await door.client.checkDoor('join', WHO)).toEqual({ ok: false, refusal });
    const notice = { id: 'n1', kind: 'ban', rule: 2, ruleLabel: 'x', until: null, refCode: 'M-ABCDE', excerpt: [], createdAt: 1, mustAcknowledge: false, appealUrl: 'https://game.example/appeal?t=abc' };
    const pending = scripted([json({ notices: [notice] })]);
    expect((await pending.client.pendingNotices(WHO)).notices[0]?.appealUrl).toBe('https://game.example/appeal?t=abc');
  });
});
