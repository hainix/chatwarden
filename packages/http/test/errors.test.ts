import { describe, expect, it, vi } from 'vitest';
import {
  AuditQueryError,
  ExcerptError,
  ProfileError,
  ReportQueryError,
  RulesError,
  SanctionError,
} from '@chatwarden/core';
import { HttpError, NotFoundError, ValidationError, withErrors } from '@chatwarden/http';
import type { KitRequest, KitResponse } from '@chatwarden/http';

const req: KitRequest = { method: 'GET', path: '/x', query: {}, headers: {}, body: undefined };
const SECRET = 'zorbak-user-input-5551234';

const run = async (e: unknown, warn = vi.fn()): Promise<{ res: KitResponse; warn: ReturnType<typeof vi.fn> }> => {
  const h = withErrors(
    (r: KitRequest) => {
      void r;
      throw e;
    },
    { warn },
  );
  return { res: await h(req), warn };
};

describe('withErrors: mapping', () => {
  const cases: Array<[string, () => unknown, number, string]> = [
    ['ReportQueryError(status)', () => new ReportQueryError('status'), 400, 'invalid_query'],
    ['ReportQueryError(before)', () => new ReportQueryError('before'), 400, 'invalid_query'],
    ['ReportQueryError(person)', () => new ReportQueryError('person'), 400, 'invalid_query'],
    ['HttpError(already_decided)', () => new HttpError('already_decided'), 409, 'already_decided'],
    ['AuditQueryError(before)', () => new AuditQueryError('before'), 400, 'invalid_query'],
    ['AuditQueryError(action)', () => new AuditQueryError('action'), 400, 'invalid_query'],
    ['AuditQueryError(actor)', () => new AuditQueryError('actor'), 400, 'invalid_query'],
    ['RangeError', () => new RangeError(SECRET), 400, 'invalid_value'],
    ['ProfileError', () => new ProfileError(`profile.${SECRET}`, 'must be a number'), 400, 'invalid_profile'],
    ['SanctionError', () => new SanctionError(SECRET), 400, 'invalid_sanction'],
    ['RulesError', () => new RulesError(SECRET), 400, 'invalid_rules'],
    ['ExcerptError', () => new ExcerptError('foreign_line'), 400, 'invalid_excerpt'],
    ['ValidationError', () => new ValidationError(), 400, 'invalid_request'],
    ['NotFoundError', () => new NotFoundError(), 404, 'not_found'],
    ['HttpError(unauthorized)', () => new HttpError('unauthorized'), 401, 'unauthorized'],
    ['HttpError(forbidden)', () => new HttpError('forbidden'), 403, 'forbidden'],
    ['HttpError(payload_too_large)', () => new HttpError('payload_too_large'), 413, 'payload_too_large'],
    ['HttpError(invalid_json)', () => new HttpError('invalid_json'), 400, 'invalid_json'],
    ['HttpError(invalid_term)', () => new HttpError('invalid_term'), 400, 'invalid_term'],
    ['HttpError(invalid_gap_ref)', () => new HttpError('invalid_gap_ref'), 400, 'invalid_gap_ref'],
  ];

  it.each(cases)('%s -> %i %s with a fixed message', async (_n, make, status, code) => {
    const { res, warn } = await run(make());
    expect(res.status).toBe(status);
    const body = res.body as { error: string; message: string };
    expect(body.error).toBe(code);
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    // Only a RangeError is logged (its class), see the RangeError block below.
    if (code !== 'invalid_value') expect(warn).not.toHaveBeenCalled();
  });

  it('gives the same message for the same code whatever the input', async () => {
    const a = (await run(new SanctionError('one'))).res;
    const b = (await run(new SanctionError(SECRET))).res;
    expect(a).toEqual(b);
    const c = (await run(new RangeError('one'))).res;
    const d = (await run(new RangeError(SECRET))).res;
    expect(c).toEqual(d);
  });

  it('never echoes the error message or any field (profile path, query field)', async () => {
    const p = await run(new ProfileError('profile.repeat.windowDays', 'must be a whole number'));
    expect(JSON.stringify(p.res)).not.toContain('windowDays');
    const q = await run(new AuditQueryError('actor'));
    expect(JSON.stringify(q.res)).not.toContain('actor');
    const r = await run(new ReportQueryError('before'));
    expect(JSON.stringify(r.res)).not.toContain('before');
  });

  it('maps a subclass of a mapped class the same way', async () => {
    class Sub extends SanctionError {}
    expect((await run(new Sub('x'))).res.status).toBe(400);
  });
});

describe('withErrors: RangeError logging', () => {
  it('still answers 400 and logs the class name only', async () => {
    const { res, warn } = await run(new RangeError(SECRET));
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('chatwarden.http_range_error', { error: 'RangeError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it('does not log the other 400s or an HttpError', async () => {
    for (const e of [new SanctionError('x'), new ValidationError(), new NotFoundError(), new AuditQueryError('actor')]) {
      expect((await run(e)).warn).not.toHaveBeenCalled();
    }
  });

  it('survives a throwing logger on the RangeError path', async () => {
    const h = withErrors(
      (r: KitRequest) => {
        void r;
        throw new RangeError('x');
      },
      {
        warn: () => {
          throw new Error('log down');
        },
      },
    );
    expect((await h(req)).status).toBe(400);
  });
});

describe('withErrors: method_not_allowed thrown by a handler', () => {
  it('passes the headers of the HttpError through', async () => {
    const { res } = await run(new HttpError('method_not_allowed', { allow: 'GET, POST' }));
    expect(res.status).toBe(405);
    expect(res.headers).toEqual({ allow: 'GET, POST' });
    expect(res.body).toEqual({ error: 'method_not_allowed', message: 'Method not allowed.' });
  });

  it('is still a valid 405 (an allow header) with no headers given', async () => {
    const { res } = await run(new HttpError('method_not_allowed'));
    expect(res.status).toBe(405);
    expect(res.headers).toEqual({ allow: '' });
  });

  it('does not add headers to other codes, and does not share the headers object', async () => {
    expect((await run(new HttpError('forbidden'))).res.headers).toBeUndefined();
    const headers = { allow: 'GET' };
    const { res } = await run(new HttpError('method_not_allowed', headers));
    expect(res.headers).not.toBe(headers);
  });
});

describe('withErrors: 500', () => {
  it('answers { error: "internal" } only and logs the class name only', async () => {
    class DbBoom extends Error {
      override name = 'DbBoom';
    }
    const { res, warn } = await run(new DbBoom(`select * where user=${SECRET}`));
    expect(res).toEqual({ status: 500, body: { error: 'internal' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('chatwarden.http_error', { error: 'DbBoom' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it('handles a thrown string, number, null, undefined and plain object', async () => {
    for (const v of [SECRET, 42, null, undefined, { message: SECRET }]) {
      const { res, warn } = await run(v);
      expect(res).toEqual({ status: 500, body: { error: 'internal' } });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    }
  });

  it('catches an async rejection', async () => {
    const warn = vi.fn();
    const h = withErrors(
      async (r: KitRequest) => {
        void r;
        await Promise.resolve();
        throw new TypeError(SECRET);
      },
      { warn },
    );
    expect(await h(req)).toEqual({ status: 500, body: { error: 'internal' } });
    expect(warn).toHaveBeenCalledWith('chatwarden.http_error', { error: 'TypeError' });
  });

  it('survives a logger that throws or rejects', async () => {
    const h1 = withErrors(
      (r: KitRequest) => {
        void r;
        throw new Error('x');
      },
      {
        warn: () => {
          throw new Error('log down');
        },
      },
    );
    expect((await h1(req)).status).toBe(500);
    const h2 = withErrors(
      (r: KitRequest) => {
        void r;
        throw new Error('x');
      },
      { warn: () => Promise.reject(new Error('log down')) as never },
    );
    expect((await h2(req)).status).toBe(500);
  });

  it('works without a logger', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = withErrors((r: KitRequest) => {
      void r;
      throw new Error('x');
    });
    expect((await h(req)).status).toBe(500);
    expect(spy).toHaveBeenCalledWith('chatwarden.http_error', { error: 'Error' });
    spy.mockRestore();
  });
});

describe('withErrors: pass-through', () => {
  it('returns the handler response untouched', async () => {
    const res: KitResponse = { status: 201, headers: { 'x-a': 'b' }, body: { id: 1 } };
    const h = withErrors((r: KitRequest) => (void r, res));
    expect(await h(req)).toBe(res);
  });

  it('forwards all arguments to the handler', async () => {
    const inner = vi.fn((_r: KitRequest, p: Record<string, string>): KitResponse => ({ status: 200, body: p }));
    const h = withErrors(inner);
    expect((await h(req, { id: 'a' })).body).toEqual({ id: 'a' });
    expect(inner).toHaveBeenCalledWith(req, { id: 'a' });
  });
});
