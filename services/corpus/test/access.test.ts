import { webcrypto } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccessVerifier, type AccessVerifier } from '../src/access.js';
import type { LogEvent } from '../src/deps.js';
import { AUD, TEAM, makeAccess, makeRsaKey, type AccessKey, type FakeAccess } from './access-world.js';
import { makeClock, type TestClock } from './world.js';

// The Cloudflare Access JWT of the review page (design 10.3): RS256 against the team's JWKS, issuer and audience checked, expiry enforced.

let clock: TestClock;
let access: FakeAccess;
let verifier: AccessVerifier;
let logs: LogEvent[];
let spare: AccessKey;
beforeAll(async () => {
  spare = await makeRsaKey('kid-spare');
});
beforeEach(async () => {
  clock = makeClock('2026-12-02T12:00:00Z');
  access = await makeAccess(clock);
  logs = [];
  verifier = createAccessVerifier(access.config, clock, (e) => void logs.push(e));
});

const refused = async (token: string | null) => {
  const res = await verifier.verify(token);
  expect(res.ok).toBe(false);
  return res;
};
const b64u = (s: string) => Buffer.from(s).toString('base64url');

describe('a good token', () => {
  it('is accepted and gives the email, lower-cased and trimmed', async () => {
    expect(await verifier.verify(await access.token())).toEqual({ ok: true, email: 'alice@example.test' });
    expect(await verifier.verify(await access.token({ claims: { email: ' Alice@Example.TEST ' } }))).toEqual({ ok: true, email: 'alice@example.test' });
  });

  it('accepts the audience as a string or as a list that holds ours', async () => {
    expect((await verifier.verify(await access.token({ claims: { aud: AUD } }))).ok).toBe(true);
    expect((await verifier.verify(await access.token({ claims: { aud: ['other', AUD] } }))).ok).toBe(true);
  });

  it('asks for the team\u2019s certs once and reuses them', async () => {
    await verifier.verify(await access.token());
    await verifier.verify(await access.token());
    await verifier.verify(await access.token());
    expect(access.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });
});

describe('no JWT, a wrong audience, an expired token, a token for a non-reviewer: refused at the token', () => {
  it('a missing, empty or malformed token', async () => {
    for (const t of [null, '', 'abc', 'a.b', 'a.b.c.d', '..', 'a.b.', '.b.c', 'x'.repeat(9000)]) await refused(t);
  });

  it('a wrong audience, a missing audience, an empty list, an audience that merely contains ours', async () => {
    for (const aud of ['other-app', [], ['other'], AUD + 'x', 'x' + AUD, undefined, 7, null]) await refused(await access.token({ claims: { aud } }));
  });

  it('a wrong issuer: another team, http, a trailing slash, none', async () => {
    for (const iss of ['https://other.cloudflareaccess.com', `http://${TEAM}`, `https://${TEAM}/`, undefined, 5]) await refused(await access.token({ claims: { iss } }));
  });

  it('an expired token, and one that expires this second', async () => {
    const now = Math.floor(clock.now() / 1000);
    await refused(await access.token({ claims: { exp: now - 1 } }));
    await refused(await access.token({ claims: { exp: now } }));
    expect((await verifier.verify(await access.token({ claims: { exp: now + 1 } }))).ok).toBe(true);
    await refused(await access.token({ claims: { exp: undefined } }));
    await refused(await access.token({ claims: { exp: 'tomorrow' } }));
  });

  it('a token that is not valid yet', async () => {
    const now = Math.floor(clock.now() / 1000);
    await refused(await access.token({ claims: { nbf: now + 60 } }));
  });

  it('a token with no email, as a service token has (it names no person)', async () => {
    await refused(await access.token({ claims: { email: undefined, common_name: 'svc' } }));
    await refused(await access.token({ claims: { email: '' } }));
    await refused(await access.token({ claims: { email: 42 } }));
  });

  it('a token that expires with the clock', async () => {
    const token = await access.token({ claims: { exp: Math.floor(clock.now() / 1000) + 30 } });
    expect((await verifier.verify(token)).ok).toBe(true);
    clock.advance(31_000);
    await refused(token);
  });
});

describe('the signature and the algorithm', () => {
  it('refuses alg none, HS256 keyed with the public key (algorithm confusion), and any other algorithm', async () => {
    const claims = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: 'alice@example.test', exp: 9_999_999_999 }));
    await refused(`${b64u(JSON.stringify({ alg: 'none', kid: 'kid-one' }))}.${claims}.`);
    await refused(`${b64u(JSON.stringify({ alg: 'none', kid: 'kid-one' }))}.${claims}.AAAA`);
    const mac = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(JSON.stringify(access.keys[0]?.jwk)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const head = b64u(JSON.stringify({ alg: 'HS256', kid: 'kid-one' }));
    const sig = Buffer.from(new Uint8Array(await webcrypto.subtle.sign('HMAC', mac, new TextEncoder().encode(`${head}.${claims}`)))).toString('base64url');
    await refused(`${head}.${claims}.${sig}`);
    for (const alg of ['RS384', 'RS512', 'PS256', 'ES256', 'rs256', '']) await refused(await access.token({ header: { alg } }));
  });

  it('refuses a token signed by another key under our kid, a flipped signature byte, and a tampered payload', async () => {
    await refused(await access.token({ key: { ...spare, kid: 'kid-one' } }));
    const good = await access.token();
    const [h, p, s] = good.split('.') as [string, string, string];
    await refused(`${h}.${p}.${s.slice(0, -4)}${s.endsWith('AAAA') ? 'BBBB' : 'AAAA'}`);
    const forged = b64u(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), email: 'mallory@example.test' }));
    await refused(`${h}.${forged}.${s}`);
    await refused(`${h}.${p}.${s.slice(0, 50)}`);
    await refused(`${h}.${p}.not base64 !!`);
  });

  it('refuses a token with no kid, a kid that is not ours, and a kid that is not a string', async () => {
    for (const kid of [undefined, 'kid-unknown', 7, '', null]) await refused(await access.token({ header: { kid } }));
  });

  it('a key that rotated: an unknown kid makes one more fetch, then the new key works and the old one still does', async () => {
    const newer = await makeRsaKey('kid-two');
    await verifier.verify(await access.token());
    access.keys = [newer, ...access.keys];
    expect((await verifier.verify(await access.token({ key: newer }))).ok).toBe(true);
    expect(access.calls).toHaveLength(2);
    expect((await verifier.verify(await access.token({ key: access.keys[1] }))).ok).toBe(true);
    expect(access.calls).toHaveLength(2);
  });

  it('an attacker\u2019s stream of unknown kids cannot make the service fetch more than once a minute', async () => {
    await verifier.verify(await access.token());
    for (let i = 0; i < 20; i += 1) await refused(await access.token({ header: { kid: `guess-${i}` } }));
    expect(access.calls.length).toBeLessThanOrEqual(2);
    clock.advance(61_000);
    await refused(await access.token({ header: { kid: 'guess-again' } }));
    expect(access.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('the certs endpoint', () => {
  it('a failing fetch refuses the token (fail closed) and logs a closed code, never the token', async () => {
    access.failing = true;
    const token = await access.token();
    await refused(token);
    expect(logs).toContainEqual({ stage: 'access', code: 'jwks' });
    expect(JSON.stringify(logs)).not.toContain(token.slice(0, 20));
  });

  it('recovers when the endpoint comes back, and keeps the keys it has while it is down', async () => {
    const token = await access.token();
    expect((await verifier.verify(token)).ok).toBe(true);
    access.failing = true;
    clock.advance(2 * 60 * 60 * 1000); // past the cache life, with the endpoint down
    const fresh = await access.token();
    expect((await verifier.verify(fresh)).ok).toBe(true); // the keys it already holds still verify
    access.failing = false;
    expect((await verifier.verify(await access.token())).ok).toBe(true);
  });

  it('refuses a response that is not a JWKS: no keys, a key of another type, an oversized body, an error status', async () => {
    for (const serve of [{ keys: [] }, { keys: [{ kid: 'kid-one', kty: 'oct', k: 'AAAA' }] }, { keys: 'x' }, { nothing: true }] as unknown as { keys: unknown[] }[]) {
      access = await makeAccess(clock);
      access.serve = serve;
      verifier = createAccessVerifier(access.config, clock);
      await refused(await access.token());
    }
    const big = createAccessVerifier({ ...access.config, fetch: (() => Promise.resolve(new Response('x'.repeat(200_000)))) as typeof fetch }, clock);
    expect((await big.verify(await access.token())).ok).toBe(false);
    const bad = createAccessVerifier({ ...access.config, fetch: (() => Promise.resolve(new Response('{}', { status: 500 }))) as typeof fetch }, clock);
    expect((await bad.verify(await access.token())).ok).toBe(false);
  });
});

describe('the configuration', () => {
  it('needs a team domain that is a cloudflareaccess.com host and an audience tag', () => {
    for (const teamDomain of ['', 'evil.example', 'https://x.cloudflareaccess.com', 'x.cloudflareaccess.com/path', 'x.cloudflareaccess.com.evil.example', 'a b.cloudflareaccess.com']) {
      expect(() => createAccessVerifier({ teamDomain, aud: AUD }, clock), teamDomain).toThrow(/teamDomain/);
    }
    expect(() => createAccessVerifier({ teamDomain: TEAM, aud: '' }, clock)).toThrow(/aud/);
    expect(() => createAccessVerifier({ teamDomain: TEAM, aud: AUD }, clock)).not.toThrow();
  });
});
