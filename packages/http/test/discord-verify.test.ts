import { describe, expect, it } from 'vitest';
import { verifyInteraction } from '../src/discord/verify.js';
import { ReplayCache } from '../src/webhooks/sign.js';
import { NOW, fakeDiscordClient, newPair } from './discord-world.js';

// The Ed25519 check over timestamp + raw body (K5 D3, Review Focus 1): every refusal is just `false`; nothing is recorded for a refusal.

const clock = { t: NOW, now: () => clock.t };
const TOL = 300_000;
const SEC = Math.floor(NOW / 1000);

const setup = () => {
  const client = fakeDiscordClient({ now: clock.now });
  const body = JSON.stringify({ type: 1, id: '1' });
  return { client, body, replay: new ReplayCache() };
};
const check = (client: { publicKeyHex: string }, req: { headers: Record<string, string>; rawBody?: string }, replay: ReplayCache, now = NOW, tol = TOL, key?: string) =>
  verifyInteraction(key ?? client.publicKeyHex, req.headers, req.rawBody as string, now, tol, replay);

describe('verify: signature and body', () => {
  it('a valid signature passes', () => {
    const { client, body, replay } = setup();
    expect(check(client, client.raw(body), replay)).toBe(true);
  });

  it('a wrong key, a flipped body byte, a flipped timestamp byte and a body re-serialised with other spacing are refused', () => {
    const { client, body, replay } = setup();
    expect(check({ publicKeyHex: newPair().publicKeyHex }, client.raw(body), replay)).toBe(false);
    expect(check(client, client.raw(body, { sendRaw: body.replace('"id":"1"', '"id":"2"') }), replay)).toBe(false);
    expect(check(client, client.raw(body, { sendRaw: `${body} ` }), replay)).toBe(false);
    expect(check(client, client.raw(body, { sendRaw: JSON.stringify(JSON.parse(body), null, 1) }), replay)).toBe(false);
    // the timestamp header is not the one that was signed
    expect(check(client, client.raw(body, { signedTimestamp: String(SEC - 1) }), replay)).toBe(false);
    expect(replay.size).toBe(0);
  });

  it('a key from a different pair never verifies, whichever way the request is signed', () => {
    const { client, body, replay } = setup();
    const other = fakeDiscordClient({ now: clock.now });
    expect(check(client, other.raw(body), replay)).toBe(false);
    expect(check(client, client.raw(body, { pair: other.pair }), replay)).toBe(false);
  });

  it('a missing header is refused', () => {
    const { client, body, replay } = setup();
    expect(check(client, client.raw(body, { headers: { 'x-signature-ed25519': undefined } }), replay)).toBe(false);
    expect(check(client, client.raw(body, { headers: { 'x-signature-timestamp': undefined } }), replay)).toBe(false);
    expect(verifyInteraction(client.publicKeyHex, {}, body, NOW, TOL, replay)).toBe(false);
  });

  it('a 127 or a 129 character signature, non-hex and a signature of the wrong type are refused', () => {
    const { client, body, replay } = setup();
    const good = client.raw(body).headers['x-signature-ed25519'] as string;
    expect(good).toHaveLength(128);
    for (const sig of [good.slice(1), `${good}0`, `${good.slice(0, 127)}g`, ` ${good.slice(1)}`, '', 'zz'.repeat(64)]) {
      expect(check(client, client.raw(body, { headers: { 'x-signature-ed25519': sig } }), replay), String(sig.length)).toBe(false);
    }
    expect(verifyInteraction(client.publicKeyHex, { 'x-signature-ed25519': 5 as never, 'x-signature-timestamp': String(SEC) }, body, NOW, TOL, replay)).toBe(false);
    expect(replay.size).toBe(0);
  });

  it('upper-case hex is accepted', () => {
    const { client, body, replay } = setup();
    const req = client.raw(body);
    req.headers['x-signature-ed25519'] = (req.headers['x-signature-ed25519'] as string).toUpperCase();
    expect(check(client, req, replay)).toBe(true);
  });

  it('a public key as upper-case hex works the same', () => {
    const { client, body, replay } = setup();
    expect(check(client, client.raw(body), replay, NOW, TOL, client.publicKeyHex.toUpperCase())).toBe(true);
  });

  it('a public key of the wrong shape is refused, never thrown', () => {
    const { client, body, replay } = setup();
    for (const key of ['', 'zz', client.publicKeyHex.slice(2), `${client.publicKeyHex}00`, 5 as never, undefined as never]) {
      expect(verifyInteraction(key as string, client.raw(body).headers, body, NOW, TOL, replay)).toBe(false);
    }
  });

  it('a non-string body is refused', () => {
    const { client, replay } = setup();
    expect(verifyInteraction(client.publicKeyHex, client.raw('{}').headers, undefined as never, NOW, TOL, replay)).toBe(false);
  });

  it('an empty body can be signed and verified like any other', () => {
    const { client, replay } = setup();
    expect(check(client, client.raw(''), replay)).toBe(true);
  });
});

describe('verify: the timestamp', () => {
  it('300 s old and 300 s ahead are accepted; 301 s either way is refused', () => {
    const { client, body } = setup();
    expect(check(client, client.raw(body, { timestamp: SEC - 300 }), new ReplayCache())).toBe(true);
    expect(check(client, client.raw(body, { timestamp: SEC + 300 }), new ReplayCache())).toBe(true);
    expect(check(client, client.raw(body, { timestamp: SEC - 301 }), new ReplayCache())).toBe(false);
    expect(check(client, client.raw(body, { timestamp: SEC + 301 }), new ReplayCache())).toBe(false);
  });

  it('a non-numeric, a negative, a decimal and a 16 digit timestamp are refused even when correctly signed', () => {
    const { client, body } = setup();
    for (const ts of ['abc', '-5', '1.5', '', ' 1800000000', '1800000000 ', '1'.repeat(16), '0x10', '1e9']) {
      expect(check(client, client.raw(body, { timestamp: ts }), new ReplayCache()), ts).toBe(false);
    }
  });

  it('the tolerance option is honoured, both ways', () => {
    const { client, body } = setup();
    const req = client.raw(body, { timestamp: SEC - 20 });
    expect(check(client, req, new ReplayCache(), NOW, 19_999)).toBe(false);
    expect(check(client, req, new ReplayCache(), NOW, 20_000)).toBe(true);
    expect(check(client, client.raw(body, { timestamp: SEC - 400 }), new ReplayCache(), NOW, 600_000)).toBe(true);
  });

  it('a non-finite clock or tolerance fails closed', () => {
    const { client, body } = setup();
    const req = client.raw(body);
    expect(check(client, req, new ReplayCache(), Number.NaN)).toBe(false);
    expect(check(client, req, new ReplayCache(), NOW, Number.NaN)).toBe(false);
  });
});

describe('verify: replay', () => {
  it('a replayed signature is refused the second time', () => {
    const { client, body, replay } = setup();
    const req = client.raw(body);
    expect(check(client, req, replay)).toBe(true);
    expect(check(client, req, replay)).toBe(false);
    expect(check(client, req, replay, NOW + 1000)).toBe(false);
    expect(replay.size).toBe(1);
  });

  it('is accepted again once the window has passed (the cache forgets it)', () => {
    const { client, body, replay } = setup();
    const req = client.raw(body, { timestamp: SEC - 10 });
    expect(check(client, req, replay, NOW, 20_000)).toBe(true);
    expect(check(client, req, replay, NOW, 20_000)).toBe(false);
    // after the entry's own window (its timestamp plus the tolerance it was taken under) it is forgotten; a looser caller can then take it
    expect(check(client, req, replay, NOW + 11_000, 60_000)).toBe(true);
  });

  it('two different bodies are two signatures', () => {
    const { client, replay } = setup();
    expect(check(client, client.raw('{"a":1}'), replay)).toBe(true);
    expect(check(client, client.raw('{"a":2}'), replay)).toBe(true);
  });

  it('upper and lower case of one signature are the same signature', () => {
    const { client, body, replay } = setup();
    const req = client.raw(body);
    expect(check(client, req, replay)).toBe(true);
    const upper = { ...req, headers: { ...req.headers, 'x-signature-ed25519': (req.headers['x-signature-ed25519'] as string).toUpperCase() } };
    expect(check(client, upper, replay)).toBe(false);
  });

  it('a refused request records nothing, so a bad request cannot fill the cache', () => {
    const { client, body, replay } = setup();
    for (let i = 0; i < 20; i++) check(client, client.raw(body, { sendRaw: `${body}${i}` }), replay);
    expect(replay.size).toBe(0);
  });
});
