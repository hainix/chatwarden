import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, dayOf, networkPrefix, purgeExpired } from '../src/counters.js';
import { DAY_MS, TODAY, makeInstallation, makeWorld, validBody, wordN, type Installation, type World } from './world.js';

// Invented words only. The limits of design 10.4: 20 a day per installation, 60 a day per network hash, a decline streak of 10 locks 7 days.

let w: World;
let inst: Installation;
beforeEach(async () => {
  w = await makeWorld();
  inst = await makeInstallation();
});
afterEach(() => w.restore());

const rows = async (sql: string) => (await w.db.prepare(sql).all<Record<string, unknown>>()).results;
const submit = (installation: Installation, n: number, ip?: string) => w.post({ installation, body: validBody({ term: wordN(n) }), ...(ip === undefined ? {} : { ip }) });

describe('limits: the 21st submission in a day by one installation is 429 with retry-after; the 61st by one network hash; a declined streak of 10 locks the installation for 7 days; counters older than two days are purged', () => {
  it('the limits are the design\u2019s numbers', () => {
    expect(LIMITS).toMatchObject({ perInstallationDaily: 20, perNetworkDaily: 60, pending: 200, lockStreak: 10, lockDays: 7, counterDays: 2 });
  });

  it('the 21st submission of one installation in a day is 429 with a retry-after to the next UTC midnight', async () => {
    for (let n = 0; n < 20; n += 1) expect((await submit(inst, n)).status, String(n)).toBe(202);
    const res = await submit(inst, 20);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('retry-after')).toBe(String(12 * 60 * 60)); // the clock is at noon
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await rows('SELECT id FROM submissions')).toHaveLength(20);
  });

  it('the count starts again on the next UTC day, and another installation is not held back', async () => {
    for (let n = 0; n < 21; n += 1) await submit(inst, n);
    const fresh = await makeInstallation();
    expect((await submit(fresh, 100)).status).toBe(202);
    w.clock.advance(DAY_MS);
    expect((await w.post({ installation: inst, body: validBody({ term: wordN(200), day: '2026-12-03' }) })).status).toBe(202);
  });

  it('driven by the real client: a 429 is rate_limited with the retry delay the service gave', async () => {
    const share = w.client(inst);
    for (let n = 0; n < 20; n += 1) expect((await share.share({ term: wordN(n), language: 'en', category: 'abuse' })).ok).toBe(true);
    const res = await share.share({ term: wordN(20), language: 'en', category: 'abuse' });
    expect(res).toEqual({ ok: false, code: 'rate_limited', retryAfterMs: 12 * 60 * 60 * 1000 });
  });

  it('a duplicate, an invalid body and a refused word all count: the limit is on requests that paid the stamp and signed', async () => {
    for (let n = 0; n < 7; n += 1) await w.post({ installation: inst, body: validBody({ term: 'zorbak1' }) });
    for (let n = 0; n < 13; n += 1) await submit(inst, 1);
    expect((await submit(inst, 2)).status).toBe(429);
  });

  it('the 61st submission from one network is 429, whichever keys it comes from; another network is not held back', async () => {
    for (let n = 0; n < 60; n += 1) expect((await submit(await makeInstallation(), n, '192.0.2.50')).status, String(n)).toBe(202);
    const res = await submit(await makeInstallation(), 61, '192.0.2.50');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await submit(await makeInstallation(), 62, '192.0.2.51')).status).toBe(202);
  });

  it('an IPv6 network is counted by its /64, so changing the low 64 bits does not dodge the limit', async () => {
    for (let n = 0; n < 60; n += 1) await submit(await makeInstallation(), n, `2001:db8:1:2:${n.toString(16)}::${n + 1}`);
    expect((await submit(await makeInstallation(), 70, '2001:db8:1:2:ffff:ffff:ffff:ffff')).status).toBe(429);
    expect((await submit(await makeInstallation(), 71, '2001:db8:1:3::1')).status).toBe(202);
  });

  it('a declined streak of 10 locks the installation for 7 days: 429 with the time left, then free again', async () => {
    const words = Array.from({ length: 10 }, (_v, i) => `glarn${'bcdfghjklm'[i]}`);
    await w.seedInnocent(words.map((k, i) => ['en', k, i + 1] as [string, string, number]));
    const share = w.client(inst);
    for (const term of words) expect(await share.share({ term, language: 'en', category: 'abuse' })).toMatchObject({ ok: true, status: 'received' });
    expect(await rows("SELECT id FROM submissions WHERE status = 'declined'")).toHaveLength(10);
    const locked = await submit(inst, 1);
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe(String(7 * 24 * 60 * 60));
    w.clock.advance(3 * DAY_MS);
    const later = await w.post({ installation: inst, body: validBody({ term: wordN(2), day: '2026-12-05' }) });
    expect(later.status).toBe(429);
    expect(later.headers.get('retry-after')).toBe(String(4 * 24 * 60 * 60));
    w.clock.advance(4 * DAY_MS + 1000);
    const free = await w.post({ installation: inst, body: validBody({ term: wordN(3), day: '2026-12-09' }) });
    expect(free.status).toBe(202);
  });

  it('nine declines, or ten with an accepted one among them, or ten of another installation, do not lock', async () => {
    const decide = (installation: string, status: string, n: number) =>
      w.db
        .prepare("INSERT INTO submissions (id, installation, word_key, term, language, category, status, received_day, decided_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(`sub_${installation.slice(0, 4)}${n}`, installation, `k${n}`, `k${n}`, 'en', 'slur', status, TODAY, `2026-12-02T10:${String(10 + n)}:00Z`)
        .run();
    const me = await inst.id();
    for (let n = 0; n < 9; n += 1) await decide(me, 'declined', n);
    expect((await submit(inst, 1)).status).toBe(202);
    await decide(me, 'accepted', 20); // the newest decision is an acceptance: the last 10 are not all declined
    expect((await submit(inst, 2)).status).toBe(202);
    for (let n = 30; n < 40; n += 1) await decide('f'.repeat(64), 'declined', n);
    expect((await submit(inst, 3)).status).toBe(202);
  });

  it('only decisions count towards the streak: undecided submissions neither lock nor reset it', async () => {
    const me = await inst.id();
    for (let n = 0; n < 10; n += 1) {
      await w.db
        .prepare("INSERT INTO submissions (id, installation, word_key, term, language, category, status, reason, received_day, decided_at) VALUES (?,?,?,?,?,?,'declined','other',?,?)")
        .bind(`sub_d${n}`, me, `d${n}`, `d${n}`, 'en', 'slur', TODAY, `2026-12-02T09:0${n}:00Z`)
        .run();
    }
    await w.db.prepare("INSERT INTO submissions (id, installation, word_key, term, language, category, status, received_day) VALUES ('sub_pending', ?, 'pk', 'pk', 'en', 'slur', 'received', ?)").bind(me, TODAY).run();
    expect((await submit(inst, 1)).status).toBe(429);
  });

  it('200 pending submissions of one installation is the cap: 429, and 199 is not', async () => {
    const me = await inst.id();
    const insert = (n: number) =>
      w.db.prepare("INSERT INTO submissions (id, installation, word_key, term, language, category, status, received_day) VALUES (?,?,?,?,?,?, 'in_review', ?)").bind(`sub_p${n}`, me, `p${n}`, `p${n}`, 'en', 'slur', TODAY);
    await w.db.batch(Array.from({ length: 199 }, (_v, n) => insert(n)));
    expect((await submit(inst, 1)).status).toBe(202);
    const res = await submit(inst, 2);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('requests refused before they are paid for (bad stamp, bad signature, wrong content type, too large) leave no counter and cannot exhaust anyone', async () => {
    for (let n = 0; n < 30; n += 1) {
      await w.post({ installation: inst, stamp: null });
      await w.post({ installation: inst, kind: 'report' });
      await w.post({ installation: inst, contentType: 'text/plain' });
    }
    expect(await rows('SELECT * FROM counters')).toHaveLength(0);
    expect((await submit(inst, 1)).status).toBe(202);
  });
});

describe('the counters', () => {
  it('are keyed by hashes: inst:<sha256 hex of the key> and net:<keyed hash>, never the address', async () => {
    await submit(inst, 1, '198.51.100.9');
    const keys = (await rows('SELECT key, day, n FROM counters ORDER BY key')).map((r) => r);
    const instKey = keys.find((k) => String(k.key).startsWith('inst:'));
    const netKey = keys.find((k) => String(k.key).startsWith('net:'));
    expect(instKey).toMatchObject({ key: `inst:${await inst.id()}`, day: TODAY, n: 1 });
    expect(String(netKey?.key)).toMatch(/^net:[0-9a-f]{32,64}$/);
    expect(JSON.stringify(keys)).not.toContain('198.51.100');
  });

  it('the network hash is stable within a day, different for another address, another day and another secret', async () => {
    const netOf = async (world: World, ip: string, advance = 0) => {
      world.clock.advance(advance);
      await world.db.prepare('DELETE FROM counters').run();
      await world.post({ installation: await makeInstallation(), body: validBody({ term: wordN(Math.floor(Math.random() * 1000)) }), ip });
      return String((await world.db.prepare("SELECT key FROM counters WHERE key LIKE 'net:%'").first<{ key: string }>())?.key);
    };
    const a1 = await netOf(w, '192.0.2.1');
    const a2 = await netOf(w, '192.0.2.1');
    const b = await netOf(w, '192.0.2.2');
    const nextDay = await netOf(w, '192.0.2.1', DAY_MS);
    const other = await makeWorld({ secret: 'a-different-test-secret' });
    try {
      const c = await netOf(other, '192.0.2.1');
      expect(a1).toBe(a2);
      expect(new Set([a1, b, nextDay, c]).size).toBe(4);
    } finally {
      other.restore();
    }
  });

  it('a request with no address still counts, in one shared bucket, and a service with no secret refuses to start', async () => {
    const res = await w.fetch(
      new Request('https://corpus.test/v1/submissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cw-key': inst.publicKey, 'x-cw-sig': 'x', 'x-cw-stamp': '0:0' },
        body: validBody(),
      }),
    );
    expect(res.status).toBe(400);
    await expect(makeWorld({ secret: '' })).rejects.toThrow(/secret/);
  });

  it('networkPrefix: an IPv4 address as it is, an IPv6 address as its /64, a mapped address as its IPv4, anything else as one bucket', () => {
    expect(networkPrefix('192.0.2.5')).toBe('192.0.2.5');
    expect(networkPrefix(' 192.0.2.5 ')).toBe('192.0.2.5');
    expect(networkPrefix('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2');
    expect(networkPrefix('2001:DB8:1:2::9')).toBe('2001:db8:1:2');
    expect(networkPrefix('2001:db8::1')).toBe('2001:db8:0:0');
    expect(networkPrefix('::1')).toBe('0:0:0:0');
    expect(networkPrefix('::ffff:192.0.2.5')).toBe('192.0.2.5');
    for (const odd of ['', 'unknown', '999.1.1.1', '1.2.3', 'zz::1', '1:2:3:4:5:6:7:8:9', 'a'.repeat(500), '<script>']) expect(networkPrefix(odd), odd).toBe('unknown');
    expect(networkPrefix(null)).toBe('unknown');
  });

  it('dayOf is the UTC day of a time', () => {
    expect(dayOf(Date.parse('2026-12-02T23:59:59Z'))).toBe('2026-12-02');
    expect(dayOf(Date.parse('2026-12-03T00:00:00Z'))).toBe('2026-12-03');
  });
});

describe('purgeExpired: counters older than two days go, notes go 90 days after the decision', () => {
  const counter = (key: string, day: string) => w.db.prepare('INSERT INTO counters VALUES (?, ?, 1)').bind(key, day).run();

  it('deletes counter rows older than two days and keeps the rest', async () => {
    for (const day of ['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']) await counter('inst:a', day);
    const out = await purgeExpired(w.db, w.clock);
    expect((await rows('SELECT day FROM counters ORDER BY day')).map((r) => r.day)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02']);
    expect(out.counters).toBe(2);
  });

  it('removes a note 90 days after its decision and not before, never touches an undecided submission, and keeps the row', async () => {
    const add = (id: string, decided: string | null) =>
      w.db
        .prepare("INSERT INTO submissions (id, installation, word_key, term, language, category, note, status, received_day, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(id, 'i', id, id, 'en', 'slur', 'a note', decided === null ? 'received' : 'declined', TODAY, decided)
        .run();
    await add('sub_old', '2026-09-01T00:00:00Z'); // 92 days before
    await add('sub_edge', '2026-09-03T12:00:00Z'); // exactly 90 days before
    await add('sub_new', '2026-09-04T00:00:00Z'); // 89 days before
    await add('sub_open', null);
    const out = await purgeExpired(w.db, w.clock);
    expect(out.notes).toBe(2);
    const notes = Object.fromEntries((await rows('SELECT id, note FROM submissions')).map((r) => [r.id, r.note]));
    expect(notes).toEqual({ sub_old: null, sub_edge: null, sub_new: 'a note', sub_open: 'a note' });
  });

  it('is safe to run again and on an empty database', async () => {
    expect(await purgeExpired(w.db, w.clock)).toEqual({ counters: 0, notes: 0 });
    expect(await purgeExpired(w.db, w.clock)).toEqual({ counters: 0, notes: 0 });
  });

  it('runs from the worker\u2019s scheduled handler', async () => {
    await counter('inst:a', '2020-01-01');
    const { default: worker } = await import('../src/worker.js');
    const pending: Promise<unknown>[] = [];
    const env = { DB: w.db, COUNTER_SECRET: 'x', RELEASES: {} } as never;
    await worker.scheduled({ scheduledTime: w.clock.now(), cron: '17 3 * * *' }, env, { waitUntil: (p: Promise<unknown>) => void pending.push(p) });
    await Promise.all(pending);
    expect(await rows('SELECT * FROM counters')).toHaveLength(0);
  });
});
