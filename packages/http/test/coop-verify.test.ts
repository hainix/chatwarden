import { describe, expect, it } from 'vitest';
import { verifyCoopSignature } from '../src/coop/verify.js';
import { newRsaPair, rsaSign, sharedPair } from './coop-world.js';

// K5 C3: the callback signature. RSASSA-PKCS1-v1_5 over SHA-256 of the raw body, base64 in `Coop-Signature`; also the `t=<ts>,v1=<sig>` shape the docs' other page shows.

const BODY = JSON.stringify({ item: { id: 'rpt0001' }, action: { id: 'action-warn' }, note: 'zorbak vlemmo' });
const pair = sharedPair();
const check = (headers: Record<string, string | undefined>, body = BODY, pem: unknown = pair.publicPem): boolean => verifyCoopSignature(pem as string, headers as Record<string, string>, body);

describe('verify', () => {
  it('a valid body-only signature passes', () => {
    expect(check({ 'coop-signature': rsaSign(pair, BODY) })).toBe(true);
  });

  it('a wrong key, a flipped body byte, a signature from another key and a signature of another body fail', () => {
    const sig = rsaSign(pair, BODY);
    expect(check({ 'coop-signature': sig }, BODY, newRsaPair().publicPem)).toBe(false);
    expect(check({ 'coop-signature': sig }, `${BODY} `)).toBe(false);
    expect(check({ 'coop-signature': sig }, BODY.replace('zorbak', 'zorbaK'))).toBe(false);
    expect(check({ 'coop-signature': rsaSign(newRsaPair(), BODY) })).toBe(false);
    expect(check({ 'coop-signature': rsaSign(pair, `${BODY}x`) })).toBe(false);
  });

  it('an empty, missing, non-base64, over-long or odd header fails', () => {
    const sig = rsaSign(pair, BODY);
    for (const h of ['', ' ', '!!!!', 'not base64 at all', 'A'.repeat(2000), sig.slice(0, 40), `${sig}${sig}`, `${sig}!`, `"${sig}"`, 'null']) {
      expect(check({ 'coop-signature': h }), h.slice(0, 20)).toBe(false);
    }
    expect(check({})).toBe(false);
    expect(check({ 'coop-signature': undefined })).toBe(false);
    expect(check({ 'x-other': sig })).toBe(false);
  });

  it('the header name is read case-insensitively', () => {
    const sig = rsaSign(pair, BODY);
    expect(check({ 'Coop-Signature': sig })).toBe(true);
    expect(check({ 'COOP-SIGNATURE': sig })).toBe(true);
  });

  it('the t=,v1= shape passes for the body and for t.body, and fails for a wrong v1', () => {
    const t = '1800000000';
    expect(check({ 'coop-signature': `t=${t},v1=${rsaSign(pair, BODY)}` })).toBe(true);
    expect(check({ 'coop-signature': `t=${t},v1=${rsaSign(pair, `${t}.${BODY}`)}` })).toBe(true);
    expect(check({ 'coop-signature': `t=${t},v1=${rsaSign(pair, `${t}.${BODY}`)},v0=junk` })).toBe(true);
    // The signature of the body under another timestamp is not the signature of this t.
    expect(check({ 'coop-signature': `t=1800000001,v1=${rsaSign(pair, `${t}.${BODY}`)}` })).toBe(false);
    expect(check({ 'coop-signature': `t=${t},v1=${rsaSign(newRsaPair(), BODY)}` })).toBe(false);
    expect(check({ 'coop-signature': `t=${t},v1=${rsaSign(pair, 'another body')}` })).toBe(false);
    for (const h of [`t=${t}`, `t=${t},v1=`, `t=${t},v1=!!!`, `v1=${rsaSign(pair, 'x')}`, `t=abc,v1=${rsaSign(pair, BODY)}`, `t=,v1=${rsaSign(pair, BODY)}`, `t=${t},v1=${'A'.repeat(1500)}`]) {
      expect(check({ 'coop-signature': h }), h.slice(0, 30)).toBe(false);
    }
  });

  it('a hex v1 is read too (the docs do not say which encoding the t= shape uses)', () => {
    const t = '1800000000';
    const hex = Buffer.from(rsaSign(pair, BODY), 'base64').toString('hex');
    expect(check({ 'coop-signature': `t=${t},v1=${hex}` })).toBe(true);
  });

  it('a bad key, a non-string body or a non-string header never throws and never passes', () => {
    const sig = rsaSign(pair, BODY);
    for (const pem of ['', 'garbage', undefined, null, 5, {}]) expect(verifyCoopSignature(pem as unknown as string, { 'coop-signature': sig }, BODY)).toBe(false);
    expect(verifyCoopSignature(pair.publicPem, { 'coop-signature': sig }, undefined as unknown as string)).toBe(false);
    expect(verifyCoopSignature(pair.publicPem, { 'coop-signature': 5 as unknown as string }, BODY)).toBe(false);
    expect(verifyCoopSignature(pair.publicPem, undefined as unknown as Record<string, string>, BODY)).toBe(false);
  });

  it('the body is verified as its exact UTF-8 bytes', () => {
    const body = JSON.stringify({ text: '\u00e9\u4e2d\u{1f600}' });
    expect(check({ 'coop-signature': rsaSign(pair, body) }, body)).toBe(true);
    expect(check({ 'coop-signature': rsaSign(pair, body) }, body.replace('\u00e9', 'e'))).toBe(false);
  });
});
