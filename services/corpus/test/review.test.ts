import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, sha256Hex } from './world.js';
import { ALICE, BOB, CARA, DAN, EVE, makeReviewWorld, withReviewers, type ReviewWorld } from './review-world.js';

// The review queue (design 10.3). Invented words only; reviewers are made up; the tokens are signed by an RSA key generated per run.

let rw: ReviewWorld;
beforeEach(async () => {
  rw = await makeReviewWorld();
  await withReviewers(rw);
});
afterEach(() => rw.restore());

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const post = (path: string, who: string, body: unknown = {}) => rw.admin(path, { method: 'POST', body, who });
const approve = (id: string, who: string, body: unknown = {}) => post(`/admin/api/submissions/${id}/approve`, who, body);
const term = async (id: string) => (await rw.rows('SELECT * FROM terms WHERE id = ?', id))[0];
const audits = () => rw.rows('SELECT actor, action, subject FROM audit ORDER BY id');

describe('no JWT, a wrong audience, an expired token, a token for a non-reviewer: 401 or 403', () => {
  const routes: [string, string][] = [
    ['GET', '/admin'],
    ['GET', '/admin/'],
    ['GET', '/admin/page.js'],
    ['GET', '/admin/page.css'],
    ['GET', '/admin/api/me'],
    ['GET', '/admin/api/queue'],
    ['GET', '/admin/api/terms'],
    ['POST', '/admin/api/submissions/sub_x/reveal'],
    ['POST', '/admin/api/submissions/sub_x/approve'],
    ['POST', '/admin/api/submissions/sub_x/decline'],
    ['POST', '/admin/api/terms/CWT-2026-00001/reveal'],
    ['POST', '/admin/api/terms/CWT-2026-00001/dispute'],
    ['POST', '/admin/api/terms/CWT-2026-00001/restore'],
    ['POST', '/admin/api/terms/CWT-2026-00001/negative'],
    ['GET', '/admin/anything-else'],
  ];

  it.each(routes)('%s %s refuses a request with no token', async (method, path) => {
    const res = await rw.admin(path, { method, token: null, ...(method === 'POST' ? { body: {} } : {}) });
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'unauthorized' });
  });

  it.each(routes)('%s %s refuses a wrong audience, an expired token and a non-reviewer', async (method, path) => {
    const body = method === 'POST' ? { body: {} } : {};
    const wrongAud = await rw.access.token({ claims: { aud: ['someone-elses-app'] } });
    const expired = await rw.access.token({ claims: { exp: Math.floor(rw.clock.now() / 1000) - 5 } });
    expect((await rw.admin(path, { method, token: wrongAud, ...body })).status).toBe(401);
    expect((await rw.admin(path, { method, token: expired, ...body })).status).toBe(401);
    expect((await rw.admin(path, { method, who: 'mallory@example.test', ...body })).status).toBe(403);
  });

  it('a deactivated reviewer is 403, an email in another case is still the reviewer, and the cookie is not a token', async () => {
    await rw.addReviewer('frank@example.test', ['en'], false);
    expect((await rw.admin('/admin/api/me', { who: 'frank@example.test' })).status).toBe(403);
    await rw.w.db.prepare("INSERT INTO reviewers (email, fluent) VALUES ('Grace@Example.TEST', '[\"en\"]')").run();
    expect((await rw.admin('/admin/api/me', { who: 'grace@example.test' })).status).toBe(200);
    const cookieOnly = await rw.admin('/admin/api/me', { token: null, headers: { cookie: `CF_Authorization=${await rw.access.token()}` } });
    expect(cookieOnly.status).toBe(401);
  });

  it('is not there at all when Access is not configured', async () => {
    const bare = await makeReviewWorld({ access: undefined });
    try {
      expect((await bare.admin('/admin/api/me')).status).toBe(404);
      expect((await bare.admin('/admin')).status).toBe(404);
    } finally {
      bare.restore();
    }
  });

  it('answers who the reviewer is, with the languages they are fluent in', async () => {
    const res = await rw.admin('/admin/api/me', { who: DAN });
    expect(await json(res)).toEqual({ email: DAN, fluent: ['en', 'es'] });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('an unknown path under /admin is 404 once authenticated, and a wrong method is 405', async () => {
    expect((await rw.admin('/admin/nothing')).status).toBe(404);
    expect((await rw.admin('/admin/api/nothing')).status).toBe(404);
    const wrong = await rw.admin('/admin/api/queue', { method: 'POST', body: {} });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
  });
});

describe('a request from another site cannot act as the reviewer (the Access cookie rides along with it)', () => {
  it('refuses a state change from another origin or a cross-site fetch, and a body that is not JSON', async () => {
    const id = await rw.seed();
    const path = `/admin/api/submissions/${id}/approve`;
    expect((await rw.admin(path, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await rw.admin(path, { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await rw.admin(path, { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    expect((await rw.admin(path, { method: 'POST', rawBody: '{}', contentType: 'text/plain' })).status).toBe(400);
    expect((await rw.admin(path, { method: 'POST', rawBody: 'a=b', contentType: 'application/x-www-form-urlencoded' })).status).toBe(400);
    expect(await rw.rows('SELECT * FROM terms')).toHaveLength(0);
    expect((await rw.admin(path, { method: 'POST', body: {}, headers: { origin: 'https://corpus.test', 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });
});

describe('one approval makes provisional; a second by the same reviewer is refused; a second by another makes accepted only if one approver is fluent', () => {
  it('the first approval creates the term, provisional, with the next public id', async () => {
    const id = await rw.seed({ note: 'a note' });
    const res = await approve(id, ALICE);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: 'provisional', termId: 'CWT-2026-00001', approvals: 1 });
    expect(await term('CWT-2026-00001')).toMatchObject({
      word_key: 'zorbak',
      term: 'zorbak',
      languages: '["en"]',
      category: 'abuse',
      target: 'none',
      status: 'provisional',
      approvals: 1,
      default_active: 1,
      collides_with: '[]',
      since: null,
    });
    expect((await rw.rows('SELECT status, term_id FROM submissions WHERE id = ?', id))[0]).toEqual({ status: 'in_review', term_id: 'CWT-2026-00001' });
    expect((await rw.rows('SELECT verdict, fluent, reviewer FROM reviews'))[0]).toEqual({ verdict: 'approve', fluent: 1, reviewer: ALICE });
  });

  it('a second approval by the same reviewer is refused and changes nothing', async () => {
    const id = await rw.seed();
    await approve(id, ALICE);
    const again = await approve(id, ALICE);
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: 'already_reviewed' });
    expect((await term('CWT-2026-00001'))?.approvals).toBe(1);
    expect(await rw.rows('SELECT id FROM reviews')).toHaveLength(1);
  });

  it('a second approval by another reviewer makes it accepted when one of the two is fluent', async () => {
    const id = await rw.seed();
    await approve(id, ALICE); // fluent in en
    const res = await approve(id, BOB); // not fluent
    expect(await json(res)).toEqual({ status: 'accepted', termId: 'CWT-2026-00001', approvals: 2 });
    expect((await term('CWT-2026-00001'))?.status).toBe('accepted');
    expect((await rw.rows('SELECT status FROM submissions WHERE id = ?', id))[0]?.status).toBe('accepted');
  });

  it('the order does not matter: the fluent approval can come second', async () => {
    const id = await rw.seed();
    await approve(id, BOB);
    expect((await json(await approve(id, ALICE))).status).toBe('accepted');
  });

  it('two approvals with no fluent reviewer stay provisional; a fluent third makes it accepted', async () => {
    const id = await rw.seed({ language: 'en' });
    await approve(id, BOB);
    const second = await approve(id, CARA); // fluent in es, not en
    expect(await json(second)).toEqual({ status: 'provisional', termId: 'CWT-2026-00001', approvals: 2 });
    expect((await term('CWT-2026-00001'))?.status).toBe('provisional');
    expect((await rw.rows('SELECT fluent FROM reviews WHERE reviewer = ?', CARA))[0]?.fluent).toBe(0);
    const third = await approve(id, DAN);
    expect(await json(third)).toEqual({ status: 'accepted', termId: 'CWT-2026-00001', approvals: 3 });
  });

  it('fluency is in the term\u2019s own language: a Spanish term needs a Spanish reviewer, a Portuguese one a Portuguese reviewer', async () => {
    const es = await rw.seed({ language: 'es', term: 'vlemmo' });
    await approve(es, ALICE);
    expect((await json(await approve(es, BOB))).status).toBe('provisional');
    expect((await json(await approve(es, CARA))).status).toBe('accepted');
    const pt = await rw.seed({ language: 'pt', term: 'quissel' });
    await approve(pt, EVE);
    expect((await json(await approve(pt, ALICE))).status).toBe('accepted');
  });

  it('once accepted, a further approval is refused (nothing is left to decide)', async () => {
    const id = await rw.seed();
    await approve(id, ALICE);
    await approve(id, BOB);
    const res = await approve(id, DAN);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'closed' });
  });

  it('an approval can set the severity and the target, and nothing else about the term', async () => {
    const id = await rw.seed({ category: 'slur', target: 'none' });
    await approve(id, ALICE, { target: 'religion', severity: 'hostile' });
    expect(await term('CWT-2026-00001')).toMatchObject({ target: 'religion', severity: 'hostile', term: 'zorbak', category: 'slur' });
  });

  it('gives each kind of term its default severity', async () => {
    const sev = async (category: string, term: string) => {
      const id = await rw.seed({ category, term, target: category === 'slur' ? 'other' : 'none' });
      const res = await json(await approve(id, ALICE));
      return (await rw.rows('SELECT severity FROM terms WHERE id = ?', res.termId as string))[0]?.severity;
    };
    expect(await sev('slur', 'vlemmo')).toBe('severe');
    expect(await sev('abuse', 'quissel')).toBe('hostile');
    expect(await sev('sexual', 'drakkuun')).toBe('hostile');
    expect(await sev('other', 'fenrisk')).toBe('rude');
  });
});

describe('a slur without a target cannot be approved', () => {
  it('is 422 target_required for a slur whose target is none, and nothing is made', async () => {
    const id = await rw.seed({ category: 'slur', target: 'none' });
    const res = await approve(id, ALICE);
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({ error: 'target_required' });
    expect(await rw.rows('SELECT id FROM terms')).toHaveLength(0);
    expect(await rw.rows('SELECT id FROM reviews')).toHaveLength(0);
    expect((await approve(id, ALICE, { target: 'none' })).status).toBe(422);
  });

  it('is fine once the reviewer names a target, or when the submission came with one, and not asked of other categories', async () => {
    const a = await rw.seed({ category: 'slur', target: 'none', term: 'zorbak' });
    expect((await approve(a, ALICE, { target: 'ethnicity' })).status).toBe(200);
    const b = await rw.seed({ category: 'slur', target: 'gender', term: 'vlemmo' });
    expect((await approve(b, ALICE)).status).toBe(200);
    for (const [i, category] of ['abuse', 'sexual', 'other'].entries()) expect((await approve(await rw.seed({ category, term: `snerp${'abc'[i]}` }), ALICE)).status).toBe(200);
  });

  it('refuses a target outside the closed list, and a severity outside it', async () => {
    const id = await rw.seed({ category: 'slur' });
    expect((await approve(id, ALICE, { target: 'race' })).status).toBe(400);
    expect((await approve(id, ALICE, { target: 'religion', severity: 'banter' })).status).toBe(400);
    expect((await approve(id, ALICE, { target: 7 })).status).toBe(400);
  });
});

describe('a reviewer cannot approve a submission from a key registered to them', () => {
  it('is 403 for approve and decline, even for a reviewer who is fluent; another reviewer is not held back', async () => {
    const mine = await sha256Hex(new TextEncoder().encode('alice-installation'));
    await rw.w.db.prepare('INSERT INTO reviewer_installations VALUES (?, ?)').bind(ALICE, mine).run();
    const id = await rw.seed({ installation: mine });
    const a = await approve(id, ALICE);
    expect(a.status).toBe(403);
    expect(await json(a)).toEqual({ error: 'own_submission' });
    expect((await post(`/admin/api/submissions/${id}/decline`, ALICE, { reason: 'other' })).status).toBe(403);
    expect(await rw.rows('SELECT id FROM reviews')).toHaveLength(0);
    expect((await approve(id, BOB)).status).toBe(200);
  });

  it('does not show the installation anywhere in the queue, a detail or a reveal', async () => {
    const mine = await sha256Hex(new TextEncoder().encode('bob-installation'));
    const id = await rw.seed({ installation: mine });
    const text = (await (await rw.admin('/admin/api/queue')).text()) + (await (await post(`/admin/api/submissions/${id}/reveal`, ALICE)).text());
    expect(text).not.toContain(mine);
    expect(text).not.toMatch(/installation/i);
  });
});

describe('a gate failure holds the term with a code', () => {
  it('a word that became a top-ranked ordinary word is held known_innocent: 409, no term, the code on the submission, an audit row', async () => {
    const id = await rw.seed({ term: 'glarn' });
    await rw.w.seedInnocent([['en', 'glarn', 40]]);
    const res = await approve(id, ALICE);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'held', code: 'known_innocent' });
    expect(await rw.rows('SELECT id FROM terms')).toHaveLength(0);
    expect((await rw.rows('SELECT held, status FROM submissions WHERE id = ?', id))[0]).toEqual({ held: 'known_innocent', status: 'received' });
    expect(await audits()).toContainEqual({ actor: ALICE, action: 'review.hold', subject: id });
    const queue = await json(await rw.admin('/admin/api/queue?status=held'));
    expect((queue.items as { id: string; held: string }[]).map((i) => [i.id, i.held])).toEqual([[id, 'known_innocent']]);
  });

  it('a reviewer can override it on purpose, and the hold is cleared', async () => {
    const id = await rw.seed({ term: 'glarn' });
    await rw.w.seedInnocent([['en', 'glarn', 40]]);
    await approve(id, ALICE);
    const res = await approve(id, ALICE, { overrideInnocent: true });
    expect(res.status).toBe(200);
    expect((await rw.rows('SELECT held FROM submissions WHERE id = ?', id))[0]?.held).toBeNull();
    expect(await audits()).toContainEqual({ actor: ALICE, action: 'review.override', subject: id });
  });

  it('a submission the arrival gate declined as known_innocent comes back only with the override', async () => {
    const id = await rw.seed({ term: 'glarn', status: 'declined', reason: 'known_innocent' });
    await rw.w.seedInnocent([['en', 'glarn', 3]]);
    const refused = await approve(id, ALICE);
    expect(refused.status).toBe(409);
    expect(await json(refused)).toEqual({ error: 'held', code: 'known_innocent' });
    const ok = await approve(id, ALICE, { overrideInnocent: true });
    expect(ok.status).toBe(200);
    expect((await rw.rows('SELECT status, reason, decided_at FROM submissions WHERE id = ?', id))[0]).toEqual({ status: 'in_review', reason: null, decided_at: null });
  });

  it('a submission declined for any other reason is closed', async () => {
    const id = await rw.seed({ status: 'declined', reason: 'not_a_term' });
    expect(await json(await approve(id, ALICE))).toEqual({ error: 'closed' });
  });

  it('a word that is already a term is refused as known, with no second term', async () => {
    const id = await rw.seed({ term: 'vlemmo' });
    await rw.w.addTerm('CWT-2026-00009', 'vlemo', 'accepted');
    const res = await approve(id, ALICE);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'known' });
    expect(await rw.rows('SELECT id FROM terms')).toHaveLength(1);
  });

  it('records the languages in which the spelling is an ordinary word, so the loader can turn the row off', async () => {
    await rw.w.seedInnocent([
      ['es', 'glarn', 900],
      ['pt', 'glarn', null],
      ['en', 'snerp', 5],
    ]);
    const id = await rw.seed({ term: 'glarn' });
    await approve(id, ALICE);
    expect((await term('CWT-2026-00001'))?.collides_with).toBe('["es","pt"]');
  });
});

describe('term ids', () => {
  it('count up within a year, and are never reused: a withdrawn term keeps its number', async () => {
    await rw.w.addTerm('CWT-2026-00005', 'tarvo', 'withdrawn');
    const a = await json(await approve(await rw.seed({ term: 'zorbak' }), ALICE));
    const b = await json(await approve(await rw.seed({ term: 'vlemmo' }), ALICE));
    expect([a.termId, b.termId]).toEqual(['CWT-2026-00006', 'CWT-2026-00007']);
  });

  it('start again at 00001 in a new year, from the injected clock', async () => {
    await rw.w.addTerm('CWT-2026-00042', 'tarvo', 'accepted');
    rw.clock.set('2027-01-02T10:00:00Z');
    const res = await json(await approve(await rw.seed({ term: 'zorbak' }), ALICE));
    expect(res.termId).toBe('CWT-2027-00001');
  });

  it('are not made twice when two reviewers approve the same new submission at once', async () => {
    const id = await rw.seed();
    const [a, b] = await Promise.all([approve(id, ALICE), approve(id, BOB)]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    expect(await rw.rows('SELECT id FROM terms')).toHaveLength(1);
    expect((await term('CWT-2026-00001'))?.approvals).toBe(2);
  });
});

describe('decline', () => {
  it.each(['known_innocent', 'not_a_term', 'duplicate', 'needs_context', 'other'])('declines with the closed reason %s', async (reason) => {
    const id = await rw.seed();
    const res = await post(`/admin/api/submissions/${id}/decline`, ALICE, { reason });
    expect(await json(res)).toEqual({ status: 'declined', reason });
    expect((await rw.rows('SELECT status, reason, decided_at FROM submissions WHERE id = ?', id))[0]).toEqual({ status: 'declined', reason, decided_at: '2026-12-02T12:00:00Z' });
    expect((await rw.rows('SELECT verdict FROM reviews'))[0]?.verdict).toBe('decline');
  });

  it('refuses a reason outside the closed list, a missing reason, free text, and extra keys', async () => {
    const id = await rw.seed();
    for (const body of [{}, { reason: 'because' }, { reason: '' }, { reason: 7 }, { reason: 'other', text: 'free text' }, { reason: ['other'] }]) {
      expect((await post(`/admin/api/submissions/${id}/decline`, ALICE, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await rw.rows('SELECT status FROM submissions WHERE id = ?', id))[0]?.status).toBe('received');
  });

  it('is refused once a term exists (a reviewer who disagrees disputes the term), and once decided', async () => {
    const id = await rw.seed();
    await approve(id, ALICE);
    const res = await post(`/admin/api/submissions/${id}/decline`, BOB, { reason: 'other' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'has_term' });
    const other = await rw.seed({ term: 'vlemmo' });
    await post(`/admin/api/submissions/${other}/decline`, ALICE, { reason: 'other' });
    expect(await json(await post(`/admin/api/submissions/${other}/decline`, BOB, { reason: 'other' }))).toEqual({ error: 'closed' });
  });

  it('a declined submission counts towards the decline streak that locks a sender (it has a decision time)', async () => {
    const id = await rw.seed();
    rw.clock.advance(5 * 60 * 1000);
    await post(`/admin/api/submissions/${id}/decline`, ALICE, { reason: 'not_a_term' });
    expect((await rw.rows('SELECT decided_at FROM submissions WHERE id = ?', id))[0]?.decided_at).toBe('2026-12-02T12:05:00Z');
  });
});

describe('dispute and restore: one reviewer disputes, two restore', () => {
  const accepted = async () => {
    const id = await rw.seed();
    await approve(id, ALICE);
    await approve(id, BOB);
    return 'CWT-2026-00001';
  };

  it('one reviewer\u2019s word marks a term disputed', async () => {
    const t = await accepted();
    const res = await post(`/admin/api/terms/${t}/dispute`, CARA);
    expect(await json(res)).toEqual({ status: 'disputed' });
    expect((await term(t))?.status).toBe('disputed');
    expect(await audits()).toContainEqual({ actor: CARA, action: 'review.dispute', subject: t });
  });

  it('restoring needs two other reviewers, and the one who disputed cannot be one of them', async () => {
    const t = await accepted();
    await post(`/admin/api/terms/${t}/dispute`, CARA);
    const mine = await post(`/admin/api/terms/${t}/restore`, CARA);
    expect(mine.status).toBe(409);
    expect(await json(mine)).toEqual({ error: 'already_reviewed' });
    const first = await post(`/admin/api/terms/${t}/restore`, ALICE);
    expect(await json(first)).toEqual({ status: 'disputed', votes: 1 });
    expect((await term(t))?.status).toBe('disputed');
    expect((await post(`/admin/api/terms/${t}/restore`, ALICE)).status).toBe(409);
    const second = await post(`/admin/api/terms/${t}/restore`, BOB);
    expect(await json(second)).toEqual({ status: 'accepted' });
    expect((await term(t))?.status).toBe('accepted');
  });

  // A race, made deterministic: the other request's vote is already stored, but this request's "has this reviewer voted?" read ran before it
  // landed, so it sees nothing. The UNIQUE constraint is then the only thing between the second vote and a 500.
  const blindToVotes = (): void => {
    const real = rw.w.deps.db;
    rw.w.deps.db = {
      batch: (statements) => real.batch(statements),
      prepare: (sql) => {
        const stmt = real.prepare(sql);
        if (!sql.includes('SELECT verdict FROM reviews')) return stmt;
        const blind = { bind: () => blind, first: () => Promise.resolve(null), all: () => stmt.all(), run: () => stmt.run() };
        return blind as unknown as ReturnType<typeof real.prepare>;
      },
    };
  };

  it('a dispute vote that loses a race to the same reviewer\u2019s other vote answers 409 already_reviewed, never 500, and writes nothing', async () => {
    const t = await accepted();
    await rw.rows("INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES ('term', ?, ?, 'dispute', 0, 'x') RETURNING id", t, ALICE);
    blindToVotes();
    const res = await post(`/admin/api/terms/${t}/dispute`, ALICE);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'already_reviewed' });
    expect((await term(t))?.status).toBe('accepted');
    expect(await rw.rows("SELECT * FROM audit WHERE action = 'review.dispute'")).toEqual([]);
  });

  it('a restore vote that loses a race answers 409 already_reviewed, never 500, and counts once', async () => {
    const t = await accepted();
    await post(`/admin/api/terms/${t}/dispute`, CARA);
    await post(`/admin/api/terms/${t}/restore`, ALICE);
    blindToVotes();
    const res = await post(`/admin/api/terms/${t}/restore`, ALICE);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: 'already_reviewed' });
    expect(await rw.rows("SELECT * FROM reviews WHERE verdict = 'restore'")).toHaveLength(1);
    expect((await term(t))?.status).toBe('disputed');
  });

  it('the second restore vote that loses a race leaves the term disputed, not half restored', async () => {
    const t = await accepted();
    await post(`/admin/api/terms/${t}/dispute`, CARA);
    await post(`/admin/api/terms/${t}/restore`, ALICE);
    await rw.rows("INSERT INTO reviews (subject_kind, subject_id, reviewer, verdict, fluent, at) VALUES ('term', ?, ?, 'restore', 0, 'x') RETURNING id", t, BOB);
    blindToVotes();
    // BOB's vote is already stored, so this is a would-be second vote (count says 2 with it): the term must still end up in one state.
    const res = await post(`/admin/api/terms/${t}/restore`, BOB);
    expect(res.status).toBe(409);
    expect((await term(t))?.status).toBe('disputed');
  });

  it('restores to provisional when the approvals were not enough for accepted, and can be disputed again afterwards', async () => {
    const id = await rw.seed({ term: 'vlemmo' });
    await approve(id, BOB); // one approval: provisional
    const t = 'CWT-2026-00001';
    await post(`/admin/api/terms/${t}/dispute`, ALICE);
    await post(`/admin/api/terms/${t}/restore`, BOB);
    expect(await json(await post(`/admin/api/terms/${t}/restore`, CARA))).toEqual({ status: 'provisional' });
    expect((await post(`/admin/api/terms/${t}/dispute`, ALICE)).status).toBe(200);
    expect((await term(t))?.status).toBe('disputed');
  });

  it('refuses to dispute what is disputed or withdrawn, and to restore what is not disputed', async () => {
    const t = await accepted();
    expect((await post(`/admin/api/terms/${t}/restore`, ALICE)).status).toBe(409);
    await post(`/admin/api/terms/${t}/dispute`, CARA);
    expect((await post(`/admin/api/terms/${t}/dispute`, ALICE)).status).toBe(409);
    await rw.w.addTerm('CWT-2026-00077', 'tarvo', 'withdrawn');
    expect((await post('/admin/api/terms/CWT-2026-00077/dispute', ALICE)).status).toBe(409);
    expect((await post('/admin/api/terms/CWT-2026-00099/dispute', ALICE)).status).toBe(404);
  });
});

describe('add negative line', () => {
  const add = (line: unknown, who = ALICE, t = 'CWT-2026-00001') => post(`/admin/api/terms/${t}/negative`, who, { line });

  beforeEach(async () => {
    await rw.w.addTerm('CWT-2026-00001', 'zorbak', 'accepted');
  });

  it('adds a line a reviewer wrote, once, and says so', async () => {
    expect(await json(await add('the zorbakian garden is lovely'))).toEqual({ added: true });
    expect(await json(await add('the zorbakian garden is lovely', BOB))).toEqual({ added: false });
    expect(await rw.rows('SELECT term_id, kind, line, origin FROM term_lines')).toEqual([{ term_id: 'CWT-2026-00001', kind: 'negative', line: 'the zorbakian garden is lovely', origin: 'reviewer' }]);
    expect(await audits()).toContainEqual({ actor: ALICE, action: 'review.negative', subject: 'CWT-2026-00001' });
  });

  it('refuses a line that is empty, over 200 characters, holds a URL, an @, a long digit run, a control character, or is not a string', async () => {
    for (const line of ['', '   ', 'x'.repeat(201), 'see http://example.test', 'mail a@b', 'ref 123456', 'a\u0007b', 5, null, ['x']]) {
      expect((await add(line)).status, String(line)).toBe(400);
    }
    expect(await rw.rows('SELECT line FROM term_lines')).toHaveLength(0);
  });

  it('is 404 for a term that does not exist and 400 for extra keys', async () => {
    expect((await add('fine line', ALICE, 'CWT-2026-00042')).status).toBe(404);
    expect((await post('/admin/api/terms/CWT-2026-00001/negative', ALICE, { line: 'fine', origin: 'template' })).status).toBe(400);
  });
});

describe('every action writes an audit row', () => {
  it('writes one row per action with the actor, the action and the id, and never a word, a note or a line', async () => {
    const a = await rw.seed({ note: 'spy note text', term: 'zorbak' });
    const b = await rw.seed({ term: 'vlemmo' });
    await post(`/admin/api/submissions/${a}/reveal`, ALICE);
    await approve(a, ALICE);
    await approve(a, BOB);
    await post(`/admin/api/submissions/${b}/decline`, ALICE, { reason: 'needs_context' });
    await post('/admin/api/terms/CWT-2026-00001/negative', ALICE, { line: 'spy line text' });
    await post('/admin/api/terms/CWT-2026-00001/reveal', ALICE);
    await post('/admin/api/terms/CWT-2026-00001/dispute', CARA);
    await post('/admin/api/terms/CWT-2026-00001/restore', ALICE);
    await post('/admin/api/terms/CWT-2026-00001/restore', BOB);
    const rows = await audits();
    expect(rows).toEqual([
      { actor: ALICE, action: 'review.reveal', subject: a },
      { actor: ALICE, action: 'review.approve', subject: a },
      { actor: BOB, action: 'review.approve', subject: a },
      { actor: ALICE, action: 'review.decline', subject: b },
      { actor: ALICE, action: 'review.negative', subject: 'CWT-2026-00001' },
      { actor: ALICE, action: 'review.reveal', subject: 'CWT-2026-00001' },
      { actor: CARA, action: 'review.dispute', subject: 'CWT-2026-00001' },
      { actor: ALICE, action: 'review.restore', subject: 'CWT-2026-00001' },
      { actor: BOB, action: 'review.restore', subject: 'CWT-2026-00001' },
    ]);
    const all = JSON.stringify(await rw.rows('SELECT * FROM audit'));
    expect(all).not.toMatch(/zorbak|vlemmo|spy/);
  });

  it('writes nothing for a refused action, and nothing for a read of the masked lists', async () => {
    const id = await rw.seed({ category: 'slur' });
    await approve(id, ALICE); // 422
    await post(`/admin/api/submissions/${id}/decline`, ALICE, { reason: 'nope' }); // 400
    await rw.admin('/admin/api/queue');
    await rw.admin('/admin/api/terms');
    await rw.admin('/admin/api/me');
    expect(await audits()).toEqual([]);
  });

  it('the action and its audit row land together: when the audit write fails, the action does not happen', async () => {
    const id = await rw.seed();
    await rw.w.db.prepare('DROP TABLE audit').run();
    const res = await approve(id, ALICE);
    expect(res.status).toBe(500);
    expect(await rw.rows('SELECT id FROM terms')).toHaveLength(0);
    expect(await rw.rows('SELECT id FROM reviews')).toHaveLength(0);
    expect(JSON.stringify(rw.w.logs)).not.toMatch(/audit|zorbak/);
  });
});

describe('the lists and the reveal keep terms masked', () => {
  it('the queue lists newest first with category, language and counts, and holds no term, note or installation', async () => {
    const ids: string[] = [];
    for (const t of ['zorbak', 'vlemmo', 'quissel']) ids.push(await rw.seed({ term: t, note: `note about ${t}`, category: 'slur', target: 'gender' }));
    await approve(ids[0] as string, ALICE);
    const res = await rw.admin('/admin/api/queue', { who: BOB });
    const body = await json(res);
    const items = body.items as Record<string, unknown>[];
    expect(items.map((i) => i.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(items[2]).toEqual({ id: ids[0], status: 'in_review', language: 'en', category: 'slur', target: 'gender', receivedDay: '2026-12-02', held: null, approvals: 1, mine: null });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/zorbak|vlemmo|quissel|note about/);
    const mine = (await json(await rw.admin('/admin/api/queue', { who: ALICE }))).items as { id: string; mine: string }[];
    expect(mine.find((i) => i.id === ids[0])?.mine).toBe('approve');
  });

  it('filters by status, refuses a status it does not know, and caps the page', async () => {
    const a = await rw.seed({ term: 'zorbak' });
    await post(`/admin/api/submissions/${a}/decline`, ALICE, { reason: 'other' });
    await rw.seed({ term: 'vlemmo' });
    const ids = async (q: string) => ((await json(await rw.admin(`/admin/api/queue${q}`))).items as { id: string }[]).length;
    expect(await ids('')).toBe(1);
    expect(await ids('?status=declined')).toBe(1);
    expect(await ids('?status=open')).toBe(1);
    expect((await rw.admin('/admin/api/queue?status=everything')).status).toBe(400);
    expect((await rw.admin('/admin/api/queue?limit=0')).status).toBe(400);
    expect((await rw.admin('/admin/api/queue?limit=1000')).status).toBe(400);
    expect(await ids('?status=declined&limit=1')).toBe(1);
  });

  it('the term list holds ids, status and category, never the word', async () => {
    await rw.w.addTerm('CWT-2026-00001', 'zorbak', 'accepted');
    await rw.w.addTerm('CWT-2026-00002', 'vlemo', 'disputed');
    const res = await json(await rw.admin('/admin/api/terms?status=disputed'));
    expect(res.items).toEqual([{ id: 'CWT-2026-00002', status: 'disputed', languages: ['en'], category: 'slur', target: 'none', severity: 'severe', approvals: 0 }]);
    expect(JSON.stringify(await json(await rw.admin('/admin/api/terms?status=accepted')))).not.toContain('zorbak');
    expect((await rw.admin('/admin/api/terms?status=nope')).status).toBe(400);
  });

  it('a reveal shows the word, the note, the dictionary hits and the cross-language collisions, and says nothing of who sent it', async () => {
    await rw.w.seedInnocent([
      ['en', 'zorbakian', 10],
      ['es', 'zorbak', 20],
      ['en', 'snerp', 1],
    ]);
    const id = await rw.seed({ note: 'seen in the lobby', category: 'slur', target: 'religion' });
    const res = await post(`/admin/api/submissions/${id}/reveal`, BOB);
    expect(await json(res)).toEqual({
      id,
      term: 'zorbak',
      note: 'seen in the lobby',
      language: 'en',
      category: 'slur',
      target: 'religion',
      held: null,
      knownInnocent: false,
      collidesWith: ['es'],
      dictionary: ['zorbak', 'zorbakian'],
      reveals: 1,
      breakReminder: false,
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a reveal of a term shows the word and the reviewers\u2019 negative lines', async () => {
    await rw.w.addTerm('CWT-2026-00001', 'zorbak', 'accepted');
    await rw.w.db.prepare("INSERT INTO term_lines VALUES ('CWT-2026-00001', 'negative', 'a fine line', 'reviewer'), ('CWT-2026-00001', 'negative', 'a template line', 'dictionary'), ('CWT-2026-00001', 'positive', 'you zorbak', 'template')").run();
    const res = await json(await post('/admin/api/terms/CWT-2026-00001/reveal', ALICE));
    expect(res).toMatchObject({ id: 'CWT-2026-00001', term: 'zorbak', status: 'accepted', languages: ['en'], category: 'slur', negatives: ['a fine line'], reveals: 1, breakReminder: false });
  });

  it('a break reminder comes with the 20th reveal of the day, and every 20th after, counted per reviewer', async () => {
    const id = await rw.seed();
    const reveal = async (who: string) => json(await post(`/admin/api/submissions/${id}/reveal`, who));
    const seen: boolean[] = [];
    for (let n = 1; n <= 41; n += 1) seen.push((await reveal(ALICE)).breakReminder as boolean);
    expect(seen.map((b, i) => (b ? i + 1 : 0)).filter(Boolean)).toEqual([20, 40]);
    expect((await reveal(BOB)).reveals).toBe(1);
    rw.clock.advance(DAY_MS);
    expect((await reveal(ALICE)).reveals).toBe(1);
  });

  it('refuses a reveal of what does not exist, and an id that is not an id', async () => {
    expect((await post('/admin/api/submissions/sub_nope/reveal', ALICE)).status).toBe(404);
    expect((await post('/admin/api/terms/CWT-2026-00001/reveal', ALICE)).status).toBe(404);
    for (const bad of ['..', 'a%2Fb', 'x y', '-x']) expect((await post(`/admin/api/submissions/${bad}/reveal`, ALICE)).status, bad).toBe(404);
  });
});

describe('bodies', () => {
  it('a body that is not JSON, not an object, over 4 KiB, or has an unknown key is 400', async () => {
    const id = await rw.seed();
    const path = `/admin/api/submissions/${id}/approve`;
    for (const rawBody of ['not json', '[]', 'null', '"x"', JSON.stringify({ overrideInnocent: false, extra: 1 }), JSON.stringify({ target: 'none', pad: 'x'.repeat(5000) }), JSON.stringify({ overrideInnocent: 'yes' })]) {
      expect((await rw.admin(path, { method: 'POST', rawBody })).status, rawBody.slice(0, 30)).toBe(400);
    }
    expect(await rw.rows('SELECT id FROM terms')).toHaveLength(0);
  });

  it('an action with no body at all is read as an empty object', async () => {
    const id = await rw.seed();
    const res = await rw.admin(`/admin/api/submissions/${id}/approve`, { method: 'POST', who: ALICE, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
  });

  it('an unknown submission is 404', async () => {
    expect((await approve('sub_missing000', ALICE)).status).toBe(404);
    expect((await post('/admin/api/submissions/sub_missing000/decline', ALICE, { reason: 'other' })).status).toBe(404);
  });
});

describe('the logs of the review hold codes, never a word', () => {
  it('logs stage and code only, through the whole flow', async () => {
    const id = await rw.seed({ note: 'spy note', term: 'drakkuun' });
    await approve(id, ALICE);
    await approve(id, BOB);
    await rw.admin('/admin/api/queue', { token: null });
    const logged = JSON.stringify(rw.w.logs) + rw.w.consoleOutput.join('');
    expect(logged).not.toMatch(/drakkuun|drakun|spy note|alice@|bob@/);
  });
});
